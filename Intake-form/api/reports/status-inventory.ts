// GET /api/reports/status-inventory
//
// The practice's actual status vocabulary, from BOTH sources, kept apart.
//
// THIS IS NOT THE ATTENDANCE METRIC. It counts APPOINTMENTS, it covers every
// stored intake-linked appointment with no cohort and no window, and its rows
// OVERLAP — one visit passes through several statuses. It does not sum to
// anything and must never be read as a patient figure. See `unit` in the
// payload and the note rendered beside the table.
//
// SCOPE, stated because it is easy to assume otherwise: these are appointments
// for patients linked to an intake submission and retrieved into our store.
// They are not necessarily every appointment in the practice.
//
// Suppression happens inside `drsnip_status_inventory()` (migration 0020), in
// the database, before anything reaches this file.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { db, sql } from "@workspace/db";
import { requireAuth } from "../_lib/auth";
import { displayLabel, labelKey, normalizedKey } from "../../lib/metrics/attendance-contract";
import { getApproved, getDraft } from "../_lib/attendance-store";
import { canEditDefinitionDraft, canApproveDefinitions } from "../_lib/permissions";

type Row = {
  source_column: "current_status" | "transition";
  raw_label: string | null;
  is_null_label: boolean;
  normalized_key: string | null;
  appointments: number | null;
  transitions: number | null;
  offices: number | null;
  providers: number | null;
  first_seen_at: string | null;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    // Keep the observed inventory current. Additive: a label that stops
    // occurring is still one the clinic used and may have classified.
    await db.execute(sql`SELECT public.drsnip_refresh_status_labels()`);

    const r = await db.execute<Row>(sql`SELECT * FROM public.drsnip_status_inventory()`);
    const [approved, draft] = await Promise.all([getApproved(), getDraft()]);

    const decided = new Map<string, { classification: string; procedure_signal: boolean }>();
    for (const l of draft?.labels ?? approved?.labels ?? []) {
      decided.set(`${l.source_column}|${labelKey(l.raw_label)}`, {
        classification: l.classification,
        procedure_signal: l.procedure_signal,
      });
    }

    // Group by normalised key ONLY to show a human that two labels look alike.
    // Nothing is merged: two labels differing by a space may be two different
    // front-desk habits, and each is classified on its own.
    const nearDuplicates = new Map<string, number>();
    for (const row of r.rows) {
      const k = `${row.source_column}|${row.normalized_key ?? "\u0001null"}`;
      nearDuplicates.set(k, (nearDuplicates.get(k) ?? 0) + 1);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      unit: "appointments",
      overlapping: true,
      note:
        "These are appointments, not patients, and they overlap — one visit passes through " +
        "several statuses. They do not add up to a total.",
      scope_note:
        "Appointments for patients linked to an intake submission, as stored here. Not " +
        "necessarily every appointment in the practice.",
      suppression: {
        threshold: 5,
        note:
          "A status covering fewer than five appointments is withheld, along with its other " +
          "counts. Rows overlap, so no total is published that a withheld row could be " +
          "recovered from.",
      },
      mapping: {
        state: approved ? "approved" : draft ? "draft" : "unconfigured",
        has_draft: Boolean(draft),
        draft_revision: draft?.revision ?? null,
        approved_version: approved?.version ?? null,
        confirmed_by_name: approved?.confirmed_by_name ?? null,
        confirmed_by_role: approved?.confirmed_by_role ?? null,
        confirmed_on: approved?.confirmed_on ?? null,
        confirmed_via: approved?.confirmed_via ?? null,
        confirmed_scope: approved?.confirmed_scope ?? null,
      },
      can: {
        edit_draft: canEditDefinitionDraft(auth.user.role),
        approve: canApproveDefinitions(auth.user),
      },
      labels: r.rows.map((row) => {
        const key = `${row.source_column}|${labelKey(row.raw_label)}`;
        const nk = `${row.source_column}|${row.normalized_key ?? "\u0001null"}`;
        return {
          source_column: row.source_column,
          raw_label: row.raw_label,
          display: displayLabel(row.raw_label),
          // Sent so the client can key rows NULL-safely without re-deriving it.
          key,
          normalized_key: row.normalized_key ?? normalizedKey(row.raw_label),
          has_near_duplicate: (nearDuplicates.get(nk) ?? 0) > 1,
          appointments: row.appointments,
          transitions: row.transitions,
          offices: row.offices,
          providers: row.providers,
          first_seen_at: row.first_seen_at,
          // "New" means APPEARED SINCE THE APPROVAL, not "seen recently". With
          // no approval nothing is new — on a fresh install every label would
          // otherwise be flagged, which tells the reviewer nothing.
          is_new: Boolean(
            approved?.approved_at && row.first_seen_at &&
            new Date(row.first_seen_at) > new Date(approved.approved_at),
          ),
          classification: decided.get(key)?.classification ?? "undecided",
          procedure_signal: decided.get(key)?.procedure_signal ?? false,
        };
      }),
    });
  } catch (err) {
    console.error("[reports/status-inventory] failed", (err as { code?: string })?.code ?? "unknown");
    return res.status(500).json({ error: "status inventory unavailable" });
  }
}
