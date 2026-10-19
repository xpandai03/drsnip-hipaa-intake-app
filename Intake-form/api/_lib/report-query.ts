// Every console report query goes through here (Train 4, after the 2026-10-19
// outage).
//
// A reporting query once ran for 30 minutes on the 256 MB production database
// and took it down. The planner had estimated 3.4 M rows, so PostgreSQL 17
// JIT-compiled it with LLVM and starved the machine of memory. A function's own
// `SET statement_timeout` did not stop it: that clause does not re-arm the timer
// of a statement that is already running.
//
// So the limit is set where it binds, per transaction, before the query starts:
//   * statement_timeout 5s — a slow report fails fast with an error and never
//     holds the database;
//   * jit off — the reports are small; JIT only ever costs memory here.
// SET LOCAL ends with the transaction, so a pooled connection never carries
// these settings into the intake write path.

import { db, sql } from "@workspace/db";

export const REPORT_STATEMENT_TIMEOUT = "5s";

type ReportSql = Parameters<typeof db.execute>[0];

export async function reportQuery<T extends Record<string, unknown> = Record<string, unknown>>(query: ReportSql) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${REPORT_STATEMENT_TIMEOUT}'`));
    await tx.execute(sql.raw("SET LOCAL jit = off"));
    return tx.execute<T>(query);
  });
}
