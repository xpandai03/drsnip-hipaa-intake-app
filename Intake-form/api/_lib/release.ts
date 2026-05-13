// Shared release-flow helper for the hold-valve feature.
//
// Single source of truth for the held → releasing → sent (or rollback to
// held) state transition. Used by both the per-row release endpoint
// (api/submissions/[id]/release.ts) and the bulk release endpoint
// (api/submissions/release-all.ts), so behavior is identical regardless
// of entry point.
//
// Idempotency: the held → releasing transition is row-level atomic via
// `UPDATE ... WHERE id=:id AND sf_status='held'`. A concurrent second
// release attempt finds 0 rows and returns 'not_held' — no duplicate
// Salesforce Lead is created. Residual risk (handler crashes mid-flight)
// is documented in reports/timetap-routing-audit.md and the feature plan.

import { and, db, eq, sql, submissions } from "@workspace/db";
import { SalesforceCreateLeadError, createLead } from "./sf";
import {
  buildSalesforceFields,
  type LeadFieldsInput,
  type SourceKey,
} from "./lead-fields";

export type ReleaseOutcome =
  | { kind: "released"; sfLeadId: string }
  | { kind: "not_held" }
  | { kind: "invalid_row"; message: string }
  | { kind: "sf_failed"; message: string };

function isSourceKey(v: string): v is SourceKey {
  return v === "federal" || v === "internal" || v === "fnn";
}

export async function releaseHeldSubmission(
  submissionId: string,
  actorEmail: string,
): Promise<ReleaseOutcome> {
  // 1) Atomic claim: only transitions if the row is currently 'held'.
  // RETURNING gives us the full row to reconstruct the SF payload without
  // a second SELECT.
  const now = new Date();
  const claimed = await db
    .update(submissions)
    .set({
      sfStatus: "releasing",
      sfLastAttemptAt: now,
      sfAttempts: sql`${submissions.sfAttempts} + 1`,
    })
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.sfStatus, "held"),
      ),
    )
    .returning();
  const row = claimed[0];
  if (!row) {
    return { kind: "not_held" };
  }

  if (!isSourceKey(row.source)) {
    // Defensive: should be impossible — source is validated at submit time.
    // Roll back to 'held' so the row doesn't get stuck in 'releasing'.
    await db
      .update(submissions)
      .set({
        sfStatus: "held",
        sfError: `release: invalid source '${row.source}'`,
      })
      .where(eq(submissions.id, submissionId));
    return { kind: "invalid_row", message: `Invalid source: ${row.source}` };
  }

  // 2) Reconstruct the LeadFieldsInput. Survey-answer columns use `q*`
  // names in the DB schema; the SF payload builder reads them as Form-Body
  // names. Map deliberately rather than relying on shape inference so a
  // future column rename doesn't silently break the SF payload.
  const input: LeadFieldsInput = {
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    stateResidence: row.stateResidence,
    leadSource: row.leadSource,
    surveyDetail: row.surveyDetail,
    yearsToRetire: row.qYearsToRetire ?? undefined,
    age: row.qAge ?? undefined,
    separating: row.qSeparating ?? undefined,
    maritalStatus: row.qMaritalStatus ?? undefined,
    maxingTsp: row.qMaxingTsp ?? undefined,
    tspContributionPct: row.qTspContributionPct ?? undefined,
    externalInvestments: row.qExternalInvestments ?? undefined,
    tspBalance: row.qTspBalance ?? undefined,
    areasOfConcern: row.qAreasOfConcern ?? undefined,
  };
  const sfFields = buildSalesforceFields(
    input,
    row.source,
    row.federalAgency,
    row.rank ?? undefined,
    row.leadScore ?? undefined,
  );

  // 3) Hit Salesforce.
  try {
    const sfResult = await createLead(sfFields);
    await db
      .update(submissions)
      .set({
        sfStatus: "sent",
        sfLeadId: sfResult.id,
        sfError: null,
        releasedBy: actorEmail,
        releasedAt: new Date(),
      })
      .where(eq(submissions.id, submissionId));
    return { kind: "released", sfLeadId: sfResult.id };
  } catch (err) {
    const message =
      err instanceof SalesforceCreateLeadError
        ? `sf:${err.status}:${err.errors[0]?.statusCode ?? "unknown"}`
        : err instanceof Error
          ? err.message
          : String(err);
    // Roll back to 'held' so the admin can retry. Keep sfAttempts +
    // sfLastAttemptAt from the claim phase (they accumulate across retries).
    await db
      .update(submissions)
      .set({
        sfStatus: "held",
        sfError: message,
      })
      .where(eq(submissions.id, submissionId));
    return { kind: "sf_failed", message };
  }
}

export type DiscardOutcome =
  | { kind: "discarded" }
  | { kind: "not_held" };

export async function discardHeldSubmission(
  submissionId: string,
  actorEmail: string,
): Promise<DiscardOutcome> {
  const now = new Date();
  const rows = await db
    .update(submissions)
    .set({
      sfStatus: "discarded",
      discardedBy: actorEmail,
      discardedAt: now,
    })
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.sfStatus, "held"),
      ),
    )
    .returning({ id: submissions.id });
  if (rows.length === 0) return { kind: "not_held" };
  return { kind: "discarded" };
}
