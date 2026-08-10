// Train 1 tests: Pacific export formatting (DST-aware), the location-filter
// whitelist, the clinic-literal drift guard, and the consultation location-join
// ALGORITHM (a reference resolver that mirrors resolvedLocationSql — the SQL
// itself is verified live post-deploy, since the join needs Postgres).
//
// No PHI (synthetic fixtures only).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toPacificParts, toPacific } from "../_lib/datetime";
import { isAllowedLocation, OFFICE_LOCATIONS } from "../_lib/location";

// ── Pacific time, DST-aware ────────────────────────────────────────────────
describe("toPacificParts — DST-aware Pacific conversion", () => {
  it("summer instant is PDT (UTC-7)", () => {
    assert.deepEqual(toPacificParts("2026-07-01T19:00:00Z"), {
      date: "2026-07-01",
      time: "12:00 PM",
    });
  });
  it("winter instant is PST (UTC-8) — same UTC wall time, different PT hour", () => {
    assert.deepEqual(toPacificParts("2026-12-01T19:00:00Z"), {
      date: "2026-12-01",
      time: "11:00 AM",
    });
  });
  it("date column reflects the Pacific day, not the UTC day", () => {
    // 05:00Z on the 7th is 10:00 PM PDT on the 6th.
    assert.deepEqual(toPacificParts("2026-08-07T05:00:00Z"), {
      date: "2026-08-06",
      time: "10:00 PM",
    });
  });
  it("spring-forward boundary (2026-03-08): offset jumps PST→PDT", () => {
    assert.equal(toPacificParts("2026-03-08T09:59:00Z").time, "1:59 AM"); // PST
    assert.equal(toPacificParts("2026-03-08T10:00:00Z").time, "3:00 AM"); // PDT (2am skipped)
  });
  it("fall-back boundary (2026-11-01): the 1 AM hour repeats", () => {
    assert.equal(toPacificParts("2026-11-01T08:30:00Z").time, "1:30 AM"); // PDT
    assert.equal(toPacificParts("2026-11-01T09:30:00Z").time, "1:30 AM"); // PST
  });
  it("null / invalid → blanks", () => {
    assert.deepEqual(toPacificParts(null), { date: "", time: "" });
    assert.deepEqual(toPacificParts("not-a-date"), { date: "", time: "" });
    assert.equal(toPacific(null), "");
  });
});

// ── location filter whitelist ──────────────────────────────────────────────
describe("isAllowedLocation — whitelist", () => {
  it("accepts the real clinic literals", () => {
    for (const c of ["Seattle, WA", "Portland, OR", "Plano, TX"]) {
      assert.equal(isAllowedLocation(c), true);
    }
  });
  it("rejects arbitrary / injection strings", () => {
    for (const bad of [
      "Plano",
      "plano, tx",
      "Dallas, TX",
      "",
      "all",
      "' OR 1=1--",
      "Seattle",
    ]) {
      assert.equal(isAllowedLocation(bad), false, `${bad} must be rejected`);
    }
  });
});

// ── clinic literal drift guard ─────────────────────────────────────────────
describe("clinic literals — no drift from the registration form", () => {
  function officeLocations(rel: string): string[] {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    const m = src.match(/const OFFICE_LOCATIONS\s*=\s*\[([^\]]*)\]/);
    assert.ok(m, `OFFICE_LOCATIONS not found in ${rel}`);
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }
  it("api/_lib/location OFFICE_LOCATIONS === Home.tsx OFFICE_LOCATIONS", () => {
    const home = officeLocations(
      "../../artifacts/intake-form/src/pages/Home.tsx",
    );
    assert.deepEqual([...OFFICE_LOCATIONS].sort(), [...home].sort());
  });
});

// ── consultation location-join ALGORITHM (reference for resolvedLocationSql) ─
type Reg = { office: string; patientId: number | null; email: string; createdAt: string };
type Consult = { patientId: number | null; email: string };

// Mirrors resolvedLocationSql: patient_id primary (when present), else
// normalized-email fallback; most-recent registration wins; blank otherwise.
function resolveLocation(c: Consult, regs: Reg[]): string {
  const norm = (e: string) => e.toLowerCase().trim();
  const candidates = regs.filter((r) =>
    c.patientId != null
      ? r.patientId === c.patientId
      : norm(r.email) === norm(c.email),
  );
  if (candidates.length === 0) return "";
  candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return candidates[0].office;
}

describe("consultation location join — algorithm", () => {
  const seattle: Reg = { office: "Seattle, WA", patientId: 100, email: "a@x.com", createdAt: "2026-06-01" };
  const plano: Reg = { office: "Plano, TX", patientId: 100, email: "a@x.com", createdAt: "2026-08-01" };
  const other: Reg = { office: "Portland, OR", patientId: 200, email: "b@x.com", createdAt: "2026-07-01" };

  it("joins by patient id", () => {
    assert.equal(
      resolveLocation({ patientId: 200, email: "nope@x.com" }, [seattle, other]),
      "Portland, OR",
    );
  });
  it("most recent registration wins for the same patient id", () => {
    assert.equal(
      resolveLocation({ patientId: 100, email: "a@x.com" }, [seattle, plano]),
      "Plano, TX", // 2026-08-01 > 2026-06-01
    );
  });
  it("resolves regardless of submission order (consult before registration)", () => {
    // Order in the array / real-world submit order is irrelevant; id match wins.
    assert.equal(resolveLocation({ patientId: 100, email: "a@x.com" }, [plano]), "Plano, TX");
  });
  it("email fallback ONLY when patient id is null", () => {
    assert.equal(
      resolveLocation({ patientId: null, email: "A@X.com " }, [seattle]),
      "Seattle, WA", // normalized email match
    );
  });
  it("patient id present but unmatched → blank (no email fallback)", () => {
    assert.equal(
      resolveLocation({ patientId: 999, email: "a@x.com" }, [seattle, other]),
      "", // id 999 matches nothing; we do NOT fall back to email
    );
  });
  it("unresolvable → blank", () => {
    assert.equal(resolveLocation({ patientId: null, email: "ghost@x.com" }, [seattle]), "");
    assert.equal(resolveLocation({ patientId: 100, email: "a@x.com" }, []), "");
  });
});
