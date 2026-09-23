// Reading and writing the attendance mapping. The only place that touches
// `attendance_mappings`, so the lifecycle rules live in one file.
//
// The published metric does NOT come through here — migration 0020's
// `drsnip_attendance_metric()` resolves the approved mapping inside the
// database. That is deliberate: if the API could hand a label set to the
// published calculation, "approved" would be advisory.

import { db, sql } from "@workspace/db";
import {
  type LabelDecision,
  type Provenance,
  decidedLabels,
  summariseLabels,
} from "../../lib/metrics/attendance-contract";

export const SCOPE = "practice";

export type MappingRow = {
  id: string;
  scope: string;
  state: "draft" | "approved" | "superseded";
  version: number | null;
  revision: number;
  labels: LabelDecision[];
  approved_at: string | null;
  confirmed_by_name: string | null;
  confirmed_by_role: string | null;
  confirmed_via: string | null;
  confirmed_on: string | null;
  confirmed_scope: string | null;
  note: string | null;
  withdrawn_reason: string | null;
  updated_at: string;
};

export async function getDraft(): Promise<MappingRow | null> {
  const r = await db.execute<MappingRow>(sql`
    SELECT * FROM attendance_mappings WHERE state = 'draft' AND scope = ${SCOPE} LIMIT 1`);
  return r.rows[0] ?? null;
}

export async function getApproved(): Promise<MappingRow | null> {
  const r = await db.execute<MappingRow>(sql`
    SELECT * FROM attendance_mappings WHERE state = 'approved' AND scope = ${SCOPE} LIMIT 1`);
  return r.rows[0] ?? null;
}

/**
 * Create or update the draft, with an optimistic revision check.
 *
 * `expectedRevision` is what the client last saw. If the stored revision has
 * moved, somebody else edited in the meantime and this write is refused — it is
 * not merged, because merging two people's opinions about what a status means
 * would produce a mapping neither of them agreed to.
 */
export async function saveDraft(
  labels: LabelDecision[],
  expectedRevision: number | null,
  userId: string,
): Promise<{ ok: true; row: MappingRow } | { ok: false; conflict: MappingRow }> {
  const existing = await getDraft();

  if (!existing) {
    const r = await db.execute<MappingRow>(sql`
      INSERT INTO attendance_mappings (scope, state, revision, labels, created_by_user_id)
      VALUES (${SCOPE}, 'draft', 1, ${JSON.stringify(labels)}::jsonb, ${userId}::uuid)
      RETURNING *`);
    await audit("draft_saved", userId, r.rows[0].id, 1, summariseLabels(labels));
    return { ok: true, row: r.rows[0] };
  }

  if (expectedRevision === null || expectedRevision !== existing.revision) {
    return { ok: false, conflict: existing };
  }

  const r = await db.execute<MappingRow>(sql`
    UPDATE attendance_mappings
       SET labels = ${JSON.stringify(labels)}::jsonb,
           revision = revision + 1,
           updated_at = now()
     WHERE id = ${existing.id}::uuid AND revision = ${expectedRevision}
    RETURNING *`);
  if (!r.rows[0]) {
    const fresh = await getDraft();
    return { ok: false, conflict: fresh! };
  }
  await audit("draft_saved", userId, r.rows[0].id, r.rows[0].revision, summariseLabels(labels));
  return { ok: true, row: r.rows[0] };
}

/**
 * Approve the draft at exactly the revision the approver previewed.
 *
 * ATOMIC, in one statement per step inside one transaction:
 *   1. supersede the current approved row, if any
 *   2. promote the draft, stamping version and provenance
 *
 * The partial unique index on (scope) WHERE state = 'approved' is what actually
 * guarantees one active mapping — not this code. If two approvals race, the
 * database refuses the second.
 *
 * Only DECIDED labels are stored. "Undecided" is the absence of a decision, and
 * freezing it into an approval would make a later reviewer think it was one.
 */
export async function approveDraft(
  expectedRevision: number,
  prov: Provenance,
  note: string | null,
  userId: string,
): Promise<
  | { ok: true; row: MappingRow }
  | { ok: false; reason: "conflict"; conflict: MappingRow | null }
  | { ok: false; reason: "nothing_decided" }
> {
  const draft = await getDraft();
  if (!draft || draft.revision !== expectedRevision) {
    return { ok: false, reason: "conflict", conflict: draft };
  }
  const decided = decidedLabels(draft.labels ?? []);
  if (decided.length === 0) return { ok: false, reason: "nothing_decided" };

  const out = await db.transaction(async (tx) => {
    const cur = await tx.execute<{ version: number | null }>(sql`
      SELECT version FROM attendance_mappings
       WHERE state = 'approved' AND scope = ${SCOPE} FOR UPDATE`);
    const nextVersion = (cur.rows[0]?.version ?? 0) + 1;

    await tx.execute(sql`
      UPDATE attendance_mappings SET state = 'superseded', updated_at = now()
       WHERE state = 'approved' AND scope = ${SCOPE}`);

    const r = await tx.execute<MappingRow>(sql`
      UPDATE attendance_mappings
         SET state = 'approved',
             version = ${nextVersion},
             labels = ${JSON.stringify(decided)}::jsonb,
             approved_by_user_id = ${userId}::uuid,
             approved_at = now(),
             confirmed_by_name = ${prov.confirmed_by_name},
             confirmed_by_role = ${prov.confirmed_by_role},
             confirmed_via = ${prov.confirmed_via},
             confirmed_on = ${prov.confirmed_on}::date,
             confirmed_scope = ${prov.confirmed_scope},
             note = ${note},
             evidence_as_of = (
               SELECT greatest(
                 (SELECT max(w.completed_at) FROM appointment_sync_windows w
                   WHERE w.strategy = 'patient_history' AND w.state = 'complete'),
                 (SELECT st.watermark FROM appointment_sync_state st
                   WHERE st.scope_key = 'practice_incremental'))),
             updated_at = now()
       WHERE id = ${draft.id}::uuid AND revision = ${expectedRevision}
      RETURNING *`);
    return r.rows[0] ?? null;
  });

  if (!out) return { ok: false, reason: "conflict", conflict: await getDraft() };
  await audit("approved", userId, out.id, expectedRevision, {
    version: out.version,
    ...summariseLabels(decided),
  });
  return { ok: true, row: out };
}

/** Withdraw the active approval. A reason is required and is shown on the page. */
export async function withdrawApproved(
  reason: string,
  userId: string,
): Promise<MappingRow | null> {
  const r = await db.execute<MappingRow>(sql`
    UPDATE attendance_mappings
       SET state = 'superseded', withdrawn_reason = ${reason}, updated_at = now()
     WHERE state = 'approved' AND scope = ${SCOPE}
    RETURNING *`);
  const row = r.rows[0] ?? null;
  if (row) await audit("withdrawn", userId, row.id, row.revision, { version: row.version });
  return row;
}

export async function history(): Promise<MappingRow[]> {
  const r = await db.execute<MappingRow>(sql`
    SELECT * FROM attendance_mappings
     WHERE state IN ('approved', 'superseded') AND scope = ${SCOPE}
     ORDER BY coalesce(version, 0) DESC, updated_at DESC LIMIT 50`);
  return r.rows;
}

/** Counters and states only. Never a label's text, never a count of people. */
export async function audit(
  event: "draft_saved" | "preview" | "approved" | "withdrawn",
  userId: string,
  mappingId: string | null,
  revision: number | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO attendance_review_audit (event, actor_user_id, mapping_id, revision, detail)
    VALUES (${event}, ${userId}::uuid, ${mappingId}::uuid, ${revision}, ${JSON.stringify(detail)}::jsonb)`);
}
