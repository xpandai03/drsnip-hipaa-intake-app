// GET /api/registration-partials/export — CSV of registration drop-offs.
// Admin only. Pacific time, date + time split into separate columns (Train 1
// convention). Respects the same grace/location filters as the list.
//
// HIPAA: every export is audit-logged (ts, actor, row_count) — no PHI in the log.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  and,
  db,
  desc,
  eq,
  lte,
  registrationPartials,
  sql,
} from "@workspace/db";
import { requireAdmin } from "../_lib/auth";
import { isAllowedLocation } from "../_lib/location";
import { toPacificParts } from "../_lib/datetime";
import { purgeExpiredPartials } from "../_lib/partials";

function firstOf(v: unknown): string | undefined {
  if (Array.isArray(v)) return v[0] as string | undefined;
  if (typeof v === "string") return v;
  return undefined;
}

function csvEscape(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

type Row = typeof registrationPartials.$inferSelect;

const COLUMNS: { header: string; get: (r: Row) => string }[] = [
  { header: "First Name", get: (r) => r.firstName ?? "" },
  { header: "Last Name", get: (r) => r.lastName ?? "" },
  { header: "Email", get: (r) => r.email ?? "" },
  { header: "Phone", get: (r) => r.phone ?? "" },
  { header: "Location", get: (r) => r.officeLocation ?? "" },
  { header: "Furthest Step", get: (r) => (r.furthestStep == null ? "" : String(r.furthestStep)) },
  { header: "Furthest Step Label", get: (r) => r.furthestStepLabel ?? "" },
  { header: "Started Date (PT)", get: (r) => toPacificParts(r.createdAt).date },
  { header: "Started Time (PT)", get: (r) => toPacificParts(r.createdAt).time },
  { header: "Last Active Date (PT)", get: (r) => toPacificParts(r.updatedAt).date },
  { header: "Last Active Time (PT)", get: (r) => toPacificParts(r.updatedAt).time },
  { header: "Source", get: (r) => r.source ?? "" },
  { header: "UTM Source", get: (r) => r.utmSource ?? "" },
  { header: "UTM Medium", get: (r) => r.utmMedium ?? "" },
  { header: "UTM Campaign", get: (r) => r.utmCampaign ?? "" },
  { header: "Click ID", get: (r) => r.clickId ?? "" },
  { header: "Click ID Type", get: (r) => r.clickIdType ?? "" },
];

export function buildPartialsCsv(rows: Row[]): string {
  const lines = [COLUMNS.map((c) => csvEscape(c.header)).join(",")];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvEscape(c.get(r))).join(","));
  return lines.join("\r\n") + "\r\n";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  await purgeExpiredPartials();

  const includeRecent = firstOf(req.query.include_recent) === "1";
  const locationParam = firstOf(req.query.location);
  const filters = [];
  if (!includeRecent) {
    filters.push(lte(registrationPartials.updatedAt, sql`now() - interval '24 hours'`));
  }
  if (isAllowedLocation(locationParam)) {
    filters.push(eq(registrationPartials.officeLocation, locationParam));
  }
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = (await db
    .select()
    .from(registrationPartials)
    .where(where)
    .orderBy(desc(registrationPartials.updatedAt))) as Row[];

  console.log(
    "[registration-partials.export] " +
      JSON.stringify({
        ts: new Date().toISOString(),
        actor: auth.user.email,
        row_count: rows.length,
      }),
  );

  const csv = buildPartialsCsv(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="registration-dropoffs.csv"',
  );
  return res.status(200).send(csv);
}
