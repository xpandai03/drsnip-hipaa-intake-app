// Appointment sync logic — synthetic fixtures only. No PHI, no DB, no network.
//
// Exercises lib/sync/n8n-appointment-sync.code.js, which is the single source
// of truth and is pasted verbatim into the n8n workflow's Code node. Testing
// that exact file (rather than a re-implementation) is the point.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const S = require_("../../lib/sync/n8n-appointment-sync.code.js");

// --- synthetic appointment factory -----------------------------------------
// Ids are obviously fake. Nothing here resembles a real patient.
function appt(over: Record<string, unknown> = {}) {
  return {
    id: 900001,
    patient: 700001,
    doctor: 800001,
    office: 345000,
    profile: 585000,
    created_at: "2026-07-01T10:00:00",
    scheduled_time: "2026-07-20T09:00:00",
    updated_at: "2026-07-02T11:00:00",
    status: "Complete",
    deleted_flag: false,
    ...over,
  };
}
function trans(over: Record<string, unknown> = {}) {
  return { appointment: 900001, datetime: "2026-07-20T09:05:00", from_status: "Confirmed", to_status: "Checked In", ...over };
}

describe("field policy — clinical content never reaches a row", () => {
  it("projects only the whitelisted columns", () => {
    const row = S.projectAppointment(appt({
      clinical_note: "SECRET NOTE", vitals: { bp: "120/80" }, custom_vitals: {},
      reminders: [1], reason: "free text a human typed", notes: "more text",
      ins1_status: "Payer Acknowledged", icd10_codes: ["Z30.2"], telehealth_url: "https://x",
    }));
    assert.ok(row);
    for (const f of S.FORBIDDEN_FIELDS) {
      assert.ok(!(f in row!), `projected row must not carry ${f}`);
    }
    assert.equal(S.hasForbiddenField(row), false);
  });

  it("hasForbiddenField detects a raw payload that still carries clinical fields", () => {
    assert.equal(S.hasForbiddenField(appt({ clinical_note: "x" })), true);
    assert.equal(S.hasForbiddenField(appt({ vitals: {} })), true);
    assert.equal(S.hasForbiddenField(appt()), false);
  });

  it("the whitelist does not include reason, notes or any clinical field", () => {
    for (const f of ["reason", "notes", "clinical_note", "vitals", "ins1_status"]) {
      assert.ok(!S.SNAPSHOT_FIELDS.includes(f), `${f} must not be whitelisted`);
    }
  });
});

describe("projection", () => {
  it("keeps source ids as TEXT, never coerced to a number", () => {
    const row = S.projectAppointment(appt({ id: 99999999999999999999n.toString(), patient: "700001" }))!;
    assert.equal(typeof row.source_appointment_id, "string");
    assert.equal(row.source_appointment_id, "99999999999999999999");
    assert.equal(typeof row.patient_source_id, "string");
  });

  it("maps `profile` as the appointment-type field", () => {
    const row = S.projectAppointment(appt({ profile: 585137 }))!;
    assert.equal(row.profile_source_id, "585137");
  });

  it("discards an appointment with no patient rather than storing it", () => {
    assert.equal(S.projectAppointment(appt({ patient: null })), null);
    assert.equal(S.projectAppointment(appt({ id: null })), null);
    assert.equal(S.projectAppointment(null), null);
  });

  it("preserves the blank-vs-absent status distinction", () => {
    // '' is the majority case in this practice and must NOT become null.
    assert.equal(S.projectAppointment(appt({ status: "" }))!.status, "");
    const { status, ...noStatus } = appt();
    assert.equal(S.projectAppointment(noStatus as never)!.status, null);
    assert.equal(S.projectAppointment(appt({ status: null }))!.status, null);
  });

  it("keeps deleted and cancelled records — ingestion destroys no evidence", () => {
    const del = S.projectAppointment(appt({ deleted_flag: true, status: "Cancelled" }))!;
    assert.equal(del.deleted_flag, true);
    assert.equal(del.status, "Cancelled");
  });

  it("tolerates unparseable timestamps without throwing", () => {
    const row = S.projectAppointment(appt({ created_at: "not-a-date", scheduled_time: "" }))!;
    assert.equal(row.source_created_at, null);
    assert.equal(row.scheduled_time, null);
  });

  it("handles an appointment created at or after its scheduled time", () => {
    // 28% of the sampled practice data looks like this. Ingestion stores both
    // timestamps faithfully and draws no conclusion.
    const row = S.projectAppointment(appt({ created_at: "2026-07-20T09:30:00", scheduled_time: "2026-07-20T09:00:00" }))!;
    assert.ok(new Date(row.source_created_at!) > new Date(row.scheduled_time!));
  });
});

describe("status transitions", () => {
  it("stores custom vocabulary verbatim", () => {
    const { rows } = S.extractTransitions(appt({
      status_transitions: [
        trans({ to_status: "MD In" }),
        trans({ datetime: "2026-07-20T09:40:00", from_status: "MD In", to_status: "Late Cancel within 48 hrs" }),
      ],
    }));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].to_status, "MD In");
    assert.equal(rows[1].to_status, "Late Cancel within 48 hrs");
  });

  it("no arrival/attendance classification happens at ingestion", () => {
    const src = require_("node:fs").readFileSync(
      new URL("../../lib/sync/n8n-appointment-sync.code.js", import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1 ");
    for (const banned of ["ARRIVAL_SET", "attended", "isAttended", "arrivalSet"]) {
      assert.ok(!code.includes(banned), `ingestion must not classify: found ${banned}`);
    }
  });

  it("de-duplicates repeats inside one response", () => {
    const { rows } = S.extractTransitions(appt({ status_transitions: [trans(), trans(), trans()] }));
    assert.equal(rows.length, 1);
  });

  it("distinguishes an ABSENT transitions field from an empty one", () => {
    // Absent must never be read as "this appointment has no history".
    assert.equal(S.extractTransitions(appt()).present, false);
    const empty = S.extractTransitions(appt({ status_transitions: [] }));
    assert.equal(empty.present, true);
    assert.equal(empty.rows.length, 0);
    assert.equal(S.extractTransitions(appt({ status_transitions: null })).present, false);
  });

  it("builds a deterministic dedupe key", () => {
    const a = S.transitionDedupeKey("900001", "2026-07-20T09:05:00Z", "Confirmed", "Checked In");
    const b = S.transitionDedupeKey("900001", "2026-07-20T09:05:00.000Z", "Confirmed", "Checked In");
    assert.equal(a, b, "equivalent instants must produce the same key");
    const c = S.transitionDedupeKey("900001", "2026-07-20T09:05:00Z", "Confirmed", "In Room");
    assert.notEqual(a, c);
  });

  it("treats null and missing statuses consistently in the key", () => {
    assert.equal(
      S.transitionDedupeKey("1", null, null, "Scheduled"),
      S.transitionDedupeKey("1", null, undefined, "Scheduled"),
    );
  });

  it("carries a source transition id when one exists", () => {
    const { rows } = S.extractTransitions(appt({ status_transitions: [trans({ id: 5551 })] }));
    assert.equal(rows[0].source_transition_id, "5551");
    const { rows: none } = S.extractTransitions(appt({ status_transitions: [trans()] }));
    assert.equal(none[0].source_transition_id, null);
  });

  it("skips malformed entries instead of throwing", () => {
    const { rows } = S.extractTransitions(appt({ status_transitions: [null, 7, "x", trans()] }));
    assert.equal(rows.length, 1);
  });
});

describe("staleness — an older response must not clobber a newer snapshot", () => {
  it("newer wins", () => {
    assert.equal(S.shouldOverwrite("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"), true);
  });
  it("older loses", () => {
    assert.equal(S.shouldOverwrite("2026-07-02T00:00:00Z", "2026-07-01T00:00:00Z"), false);
  });
  it("equal overwrites, so provenance refreshes on a replay", () => {
    assert.equal(S.shouldOverwrite("2026-07-02T00:00:00Z", "2026-07-02T00:00:00Z"), true);
  });
  it("an incoming row with no timestamp cannot displace a timestamped one", () => {
    assert.equal(S.shouldOverwrite("2026-07-02T00:00:00Z", null), false);
    assert.equal(S.shouldOverwrite(null, null), true);
    assert.equal(S.shouldOverwrite(null, "2026-07-02T00:00:00Z"), true);
  });
  it("garbage timestamps do not win", () => {
    assert.equal(S.shouldOverwrite("2026-07-02T00:00:00Z", "nonsense"), false);
  });
});

describe("linkage — unrelated patients are discarded before persistence", () => {
  const linked = new Set(["700001", "700002"]);

  it("keeps only intake-linked patients", () => {
    const rows = [
      S.projectAppointment(appt({ id: 1, patient: 700001 })),
      S.projectAppointment(appt({ id: 2, patient: 999999 })),
      S.projectAppointment(appt({ id: 3, patient: 700002 })),
    ];
    const { keep, discarded } = S.partitionByLinkage(rows, linked);
    assert.equal(keep.length, 2);
    assert.equal(discarded, 1);
    assert.ok(!keep.some((k: { patient_source_id: string }) => k.patient_source_id === "999999"));
  });

  it("compares as text, so numeric vs string ids still match", () => {
    const rows = [S.projectAppointment(appt({ patient: 700001 }))];
    assert.equal(S.partitionByLinkage(rows, ["700001"]).keep.length, 1);
  });

  it("a late-arriving link changes nothing retroactively — it needs a catch-up", () => {
    const rows = [S.projectAppointment(appt({ patient: 700003 }))];
    assert.equal(S.partitionByLinkage(rows, linked).keep.length, 0);
    const later = new Set([...linked, "700003"]);
    assert.equal(S.partitionByLinkage(rows, later).keep.length, 1);
  });
});

describe("rate budget — spacing alone is not a budget", () => {
  it("a 2s delay alone would exceed the hourly limit, so a counter is required", () => {
    assert.ok(3600 / 2 > 500, "1800 req/hr at 2s spacing exceeds DrChrono's 500/hr");
  });

  it("stops at the sustained cap", () => {
    const b = S.createRateBudget({ maxRequests: 3, minSpacingMs: 0, maxInBurstWindow: 99 });
    let t = 0;
    for (let i = 0; i < 3; i += 1) { assert.equal(b.check(t).ok, true); b.record(t); t += 10; }
    const r = b.check(t);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "budget_exhausted");
    assert.equal(b.remaining, 0);
  });

  it("enforces the rolling burst window independently", () => {
    const b = S.createRateBudget({ maxRequests: 100, minSpacingMs: 0, maxInBurstWindow: 2, burstWindowMs: 1000 });
    b.record(0); b.record(10);
    const blocked = b.check(20);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "burst_window_full");
    assert.ok(blocked.retryAfterMs! > 0);
    assert.equal(b.check(1100).ok, true, "window should clear");
  });

  it("enforces minimum spacing", () => {
    const b = S.createRateBudget({ maxRequests: 10, minSpacingMs: 2000, maxInBurstWindow: 99 });
    b.record(0);
    assert.equal(b.check(500).reason, "too_soon");
    assert.equal(b.check(2000).ok, true);
  });

  it("defaults reserve headroom for the five intake workflows", () => {
    const b = S.createRateBudget({});
    assert.ok(b.remaining <= 200, "sync must not claim the whole 500/hr budget");
  });
});

describe("HTTP handling", () => {
  it("classifies outcomes", () => {
    assert.equal(S.classifyHttp(200), "ok");
    assert.equal(S.classifyHttp(401), "auth_failure");
    assert.equal(S.classifyHttp(403), "permission_failure");
    assert.equal(S.classifyHttp(429), "rate_limited");
    assert.equal(S.classifyHttp(503), "transient");
  });

  it("stops rather than looping on a persistent permission failure", () => {
    assert.deepEqual(S.retryPolicy("permission_failure", 1, 4), { action: "stop", outcome: "failed" });
    assert.deepEqual(S.retryPolicy("auth_failure", 1, 4), { action: "stop", outcome: "failed" });
  });

  it("retries transient failures with bounded exponential backoff", () => {
    const r1 = S.retryPolicy("rate_limited", 1, 4);
    const r2 = S.retryPolicy("rate_limited", 3, 4);
    assert.equal(r1.action, "retry");
    assert.ok(r2.backoffMs! > r1.backoffMs!);
    assert.ok(r2.backoffMs! <= 60_000, "backoff is capped");
  });

  it("never retries indefinitely — it degrades to partial", () => {
    assert.deepEqual(S.retryPolicy("rate_limited", 4, 4), { action: "stop", outcome: "partial" });
  });

  it("honours Retry-After in seconds and as a date", () => {
    assert.equal(S.retryAfterMs("30", 1000), 30_000);
    assert.equal(S.retryAfterMs(null, 1234), 1234);
    assert.ok(S.retryAfterMs(new Date(Date.now() + 5000).toUTCString(), 0) > 0);
  });

  it("sanitizes errors — no ids, no emails, bounded length", () => {
    const out = S.sanitizeError("failed for patient 123456789 (nobody@example.invalid) " + "x".repeat(500));
    assert.ok(!out!.includes("123456789"));
    assert.ok(!out!.includes("nobody@example.invalid"));
    assert.ok(out!.length <= 300);
    assert.equal(S.sanitizeError(null), null);
  });
});

describe("timestamps and the incremental cursor", () => {
  it("renders `since` in DrChrono's documented no-timezone ISO shape", () => {
    assert.equal(S.toDrChronoStamp("2026-07-02T11:00:00.000Z"), "2026-07-02T11:00:00");
    assert.equal(S.toDrChronoStamp("nope"), null);
  });

  it("preserves underlying UTC while staying Pacific-reportable", () => {
    // 10 PM Pacific on 6 Aug is 2026-08-07T05:00Z. The stored instant is UTC;
    // the Pacific day is derived at report time, never baked in here.
    const iso = S.toIsoOrNull("2026-08-07T05:00:00Z")!;
    assert.equal(iso, "2026-08-07T05:00:00.000Z");
    const pacificDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date(iso));
    assert.equal(pacificDay, "2026-08-06");
  });

  it("rewinds by an overlap so a boundary record cannot be missed", () => {
    const since = S.sinceWithOverlap("2026-09-19T12:00:00Z", 120)!;
    assert.equal(since, "2026-09-19T10:00:00.000Z");
  });

  it("returns null when there is no completed run yet", () => {
    assert.equal(S.sinceWithOverlap(null, 120), null);
  });
});

describe("run finalization — a partial run must not advance the cursor", () => {
  const cutoff = "2026-09-19T12:00:00Z";

  it("a complete run advances and publishes a generation", () => {
    const r = S.finalizeRun({ completedScope: true, runCutoff: cutoff, generation: 7, coverage: "incremental_window" });
    assert.equal(r.outcome, "success");
    assert.equal(r.complete, true);
    assert.equal(r.watermark_after, cutoff);
    assert.equal(r.committed_generation, 7);
  });

  it("a failed middle page leaves the watermark alone", () => {
    const r = S.finalizeRun({ completedScope: false, hadUnrecoveredFailure: true, runCutoff: cutoff, generation: 8 });
    assert.equal(r.outcome, "failed");
    assert.equal(r.complete, false);
    assert.equal(r.watermark_after, null);
    assert.equal(r.committed_generation, null);
  });

  it("budget exhaustion is resumable, not a completion", () => {
    const r = S.finalizeRun({ completedScope: false, budgetExhausted: true, runCutoff: cutoff });
    assert.equal(r.outcome, "budget_exhausted");
    assert.equal(r.complete, false);
    assert.equal(r.watermark_after, null);
  });

  it("a contended lock is reported, not silently treated as success", () => {
    assert.equal(S.finalizeRun({ lockContended: true, runCutoff: cutoff }).outcome, "lock_contended");
  });

  it("a bounded pilot can never claim historical coverage", () => {
    const r = S.finalizeRun({ completedScope: true, runCutoff: cutoff, generation: 1, coverage: "bounded_pilot" });
    assert.equal(r.coverage, "bounded_pilot");
    assert.notEqual(r.coverage, "historical_complete");
  });
});

describe("backfill cannot inherit a pilot watermark", () => {
  it("refuses to start without an explicit floor", () => {
    const r = S.backfillStartFloor({ watermark: "2026-09-19T00:00:00Z", history_complete: false }, null);
    assert.equal(r.floor, null);
    assert.match(r.reason, /REFUSED/);
  });

  it("accepts an explicit floor", () => {
    const r = S.backfillStartFloor({ watermark: "2026-09-19T00:00:00Z" }, "2020-01-01T00:00:00Z");
    assert.equal(r.floor, "2020-01-01T00:00:00Z");
  });

  it("only reuses a watermark once history is genuinely complete", () => {
    const r = S.backfillStartFloor({ watermark: "2026-09-19T00:00:00Z", history_complete: true }, null);
    assert.equal(r.floor, "2026-09-19T00:00:00Z");
  });
});

describe("end-to-end page processing (synthetic)", () => {
  it("replaying the same page produces identical rows — idempotent by construction", () => {
    const page = [appt({ id: 1, status_transitions: [trans({ appointment: 1 })] }),
                  appt({ id: 2, patient: 700002, status_transitions: [trans({ appointment: 2 })] })];
    const run = () => page.map((a) => ({
      snap: S.projectAppointment(a),
      trans: S.extractTransitions(a).rows,
    }));
    assert.deepEqual(run(), run());
    const keys = run().flatMap((r) => r.trans.map((t: { dedupe_key: string }) => t.dedupe_key));
    assert.equal(new Set(keys).size, keys.length, "dedupe keys are unique per transition");
  });

  it("the same appointment appearing on two pages collapses to one row", () => {
    const p1 = S.projectAppointment(appt({ updated_at: "2026-07-02T11:00:00" }))!;
    const p2 = S.projectAppointment(appt({ updated_at: "2026-07-03T11:00:00" }))!;
    assert.equal(p1.source_appointment_id, p2.source_appointment_id);
    assert.equal(S.shouldOverwrite(p1.source_updated_at, p2.source_updated_at), true);
    assert.equal(S.shouldOverwrite(p2.source_updated_at, p1.source_updated_at), false);
  });

  it("a blank current status with rich transitions survives intact", () => {
    const a = appt({ status: "", status_transitions: [
      trans({ from_status: "", to_status: "Scheduled" }),
      trans({ datetime: "2026-07-20T09:10:00", from_status: "Scheduled", to_status: "MD Out" }),
    ]});
    const snap = S.projectAppointment(a)!;
    const { rows } = S.extractTransitions(a);
    assert.equal(snap.status, "");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].to_status, "MD Out");
  });
});

describe("the n8n Code node is generated from the tested module", () => {
  it("the committed generated file is not stale", async () => {
    // The whole point of the generated file is that the code running inside
    // n8n is the code these tests cover. If someone edits the module and
    // forgets to regenerate, this fails here rather than silently in n8n.
    const { build, GENERATED } = await import("../../lib/sync/build-code-node.mjs");
    const onDisk = require_("node:fs").readFileSync(GENERATED, "utf8");
    assert.equal(onDisk, build(),
      "run `node lib/sync/build-code-node.mjs` and re-paste into the n8n Code node");
  });

  it("the generated file has no module.exports — a Code node has no `module`", async () => {
    const { GENERATED } = await import("../../lib/sync/build-code-node.mjs");
    const src = require_("node:fs").readFileSync(GENERATED, "utf8");
    assert.ok(!/module\.exports/.test(src));
  });

  it("the glue never emits zero items", async () => {
    const { GENERATED } = await import("../../lib/sync/build-code-node.mjs");
    const src = require_("node:fs").readFileSync(GENERATED, "utf8");
    assert.match(src, /if \(out\.length === 0\)/,
      "an empty page must still emit a sentinel or n8n skips the finish/release nodes");
  });
});
