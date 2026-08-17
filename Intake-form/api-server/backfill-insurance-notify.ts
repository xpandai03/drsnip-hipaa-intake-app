// One-shot, OFF-by-default backfill for the insurance staff notification —
// bundled to dist/backfill-insurance-notify.cjs (esbuild, self-contained) and
// run MANUALLY (never in the release chain). It exists so Raunek can send a
// catch-up doorbell email for the insurance submissions that arrived between
// the Aug 12 embed go-live and this deploy, when nothing notified the team.
//
// SAFETY — this defaults to a DRY RUN. It queries the rows and prints the
// backlog (id · name · submitted date PT) and SENDS NOTHING. It only sends when
// BACKFILL_SEND=true is set explicitly AND the notify webhook is configured.
// The dry run doubles as the backlog report for the CHANGES summary.
//
//   Dry run (report only, safe):
//     fly ssh console -a drsnip-intake-demo -C "node dist/backfill-insurance-notify.cjs"
//
//   Actually send the catch-up emails (Raunek's explicit call):
//     fly ssh console -a drsnip-intake-demo -C \
//       "sh -c 'BACKFILL_SEND=true node dist/backfill-insurance-notify.cjs'"
//
//   Optional: BACKFILL_SINCE=YYYY-MM-DD overrides the Aug 12 cutoff.
//
// HIPAA: logs id · name · submitted date only (the same doorbell-light fields
// the email itself carries) — never carrier/policy/DOB/medical data.

import { pool } from "@workspace/db";
import {
  notifyInsuranceSubmission,
  formatPacific,
} from "../lib/n8n/insurance-notify";

const SINCE = (process.env.BACKFILL_SINCE ?? "2026-08-12").trim();
const SEND = process.env.BACKFILL_SEND === "true";

async function main(): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, first_name, last_name, created_at,
            raw_payload->>'officeLocation' AS office
       FROM submissions
      WHERE form_type = 'insurance'
        AND created_at >= $1
      ORDER BY created_at ASC`,
    [SINCE],
  );

  console.log(
    `[backfill-insurance] ${rows.length} insurance submission(s) since ${SINCE} ` +
      `(mode=${SEND ? "SEND" : "DRY-RUN"})`,
  );
  // The backlog list — always printed, in both modes.
  for (const r of rows) {
    const name = `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim();
    console.log(
      `[backfill-insurance]   ${r.id} | ${name} | ${formatPacific(new Date(r.created_at))}`,
    );
  }

  if (!SEND) {
    console.log(
      "[backfill-insurance] DRY-RUN — no emails sent. Set BACKFILL_SEND=true to send.",
    );
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    const ok = await notifyInsuranceSubmission({
      submissionId: r.id,
      name: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim(),
      office: typeof r.office === "string" ? r.office : "",
      submittedAt: new Date(r.created_at),
    });
    if (ok) sent++;
    else failed++;
  }
  console.log(`[backfill-insurance] done — sent=${sent} failed=${failed}`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error(
      "[backfill-insurance] fatal",
      err instanceof Error ? err.message : String(err),
    );
    await pool.end().catch(() => {});
    process.exit(1);
  });
