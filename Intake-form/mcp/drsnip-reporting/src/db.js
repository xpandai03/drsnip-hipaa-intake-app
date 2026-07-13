// Read-only access to the DrSnip intake Postgres (Fly, app `drsnip-intake-db`,
// database `drsnip_intake_demo`).
//
// TWO layers of read-only enforcement:
//   1. The connection role (DRSNIP_INTAKE_DATABASE_URL = drsnip_reporting_ro)
//      has SELECT on the PHI-free `drsnip_reporting_view` ONLY — no access to
//      `submissions` or any base table. The DB physically cannot return PHI.
//   2. Every query still runs inside a `BEGIN READ ONLY` transaction that is
//      always ROLLED BACK, with a statement timeout. Postgres rejects any
//      write (SQLSTATE 25006). Defense in depth.
//
// IMPORTANT: this module reads ONLY DRSNIP_INTAKE_DATABASE_URL. It deliberately
// does NOT fall back to DATABASE_URL — that is the app's full-access (PHI)
// connection and must never be used by the reporting MCP.
import pg from "pg";

const { Pool } = pg;

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DRSNIP_INTAKE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Reporting DB not configured: set DRSNIP_INTAKE_DATABASE_URL to the " +
        "read-only drsnip_reporting_ro connection string (the PHI-free view role). " +
        "Do NOT use the app's DATABASE_URL.",
    );
  }
  pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  return pool;
}

/**
 * Run a single SELECT (or WITH…SELECT) read-only. Params are bound via pg's
 * parameterized queries ($1, $2…) — never string-interpolated. Executes in a
 * read-only, statement-timeout-bounded transaction that is rolled back.
 */
export async function readQuery(sql, params = []) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 15000");
    const res = await client.query(sql, params);
    await client.query("ROLLBACK");
    return res.rows;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
