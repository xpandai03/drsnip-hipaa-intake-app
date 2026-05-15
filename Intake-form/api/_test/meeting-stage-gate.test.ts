// Tests for the Meeting_stage='Scheduled' optimistic-update gate in
// api/submit.ts.
//
// The gate (api/submit.ts, after createLead succeeds):
//   const redirectUrl = body.preRetirementReview === "Yes"
//     ? getTimeTapRedirectUrl(rank, leadScore, { …lead… })
//     : null;
//   if (redirectUrl) await updateLead(sfResult.id, { Meeting_stage__c: "Scheduled" });
//
// The update fires iff `redirectUrl !== null`. So we test that the
// redirectUrl resolution correctly returns null / non-null for the five
// scenarios from the spec, which transitively tests the gate.
//
// We don't mock SalesForce here: the held-lead branch is gated upstream
// in submit.ts (returns res.status(200) BEFORE the createLead path even
// runs), and the PATCH-fails branch is exercised by the existing
// try/catch wrapper which logs and suppresses. Those two scenarios are
// covered by reading the submit.ts code, not by a runtime test — adding
// a live-SF mock for them would be larger than the fix itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getTimeTapRedirectUrl,
  type RedirectLeadFields,
} from "../_lib/timetap-redirect";

const lead: RedirectLeadFields = {
  firstName: "Pat",
  lastName: "Tester",
  email: "pat@example.gov",
  phone: "555-0100",
};

/**
 * Mirrors the inline conditional in api/submit.ts. The optimistic
 * Meeting_stage update fires iff this predicate is true.
 */
function shouldMarkScheduled(
  preRetirementReview: string | undefined,
  rank: string | null | undefined,
  leadScore: string | null | undefined,
): boolean {
  if (preRetirementReview !== "Yes") return false;
  return getTimeTapRedirectUrl(rank, leadScore, lead) !== null;
}

describe("Meeting_stage='Scheduled' optimistic-update gate", () => {
  it("A-10 + consultation=Yes → fires", () => {
    assert.equal(shouldMarkScheduled("Yes", "A", "10  (over $1mm)"), true);
  });

  it("A-9 + consultation=Yes → fires", () => {
    assert.equal(shouldMarkScheduled("Yes", "A", "9 ($601k - $1mm)"), true);
  });

  it("A-8 + consultation=Yes → fires", () => {
    assert.equal(shouldMarkScheduled("Yes", "A", "8  ($351k-$600k)"), true);
  });

  it("A-7 + consultation=Yes → fires (held-lead handling is upstream in submit.ts)", () => {
    // Note: A-7 leads CAN be held by the valve. The valve branch in
    // submit.ts returns early — BEFORE the Meeting_stage update can be
    // reached — so this predicate test stays pure-logic. The held case
    // is documented in the gate's comment block.
    assert.equal(shouldMarkScheduled("Yes", "A", "7  ($0-$350k)"), true);
  });

  it("B+ + consultation=Yes → fires (any score)", () => {
    assert.equal(shouldMarkScheduled("Yes", "B+", "7  ($0-$350k)"), true);
    assert.equal(shouldMarkScheduled("Yes", "B+", undefined), true);
    assert.equal(shouldMarkScheduled("Yes", "B+", null), true);
  });

  it("C rank + consultation=Yes → does NOT fire", () => {
    assert.equal(shouldMarkScheduled("Yes", "C", "anything"), false);
  });

  it("N/A rank + consultation=Yes → does NOT fire", () => {
    assert.equal(shouldMarkScheduled("Yes", "N/A", undefined), false);
  });

  it("A-10 + consultation=No → does NOT fire", () => {
    assert.equal(shouldMarkScheduled("No", "A", "10  (over $1mm)"), false);
  });

  it("A-10 + consultation undefined/empty → does NOT fire", () => {
    assert.equal(shouldMarkScheduled(undefined, "A", "10  (over $1mm)"), false);
    assert.equal(shouldMarkScheduled("", "A", "10  (over $1mm)"), false);
  });

  it("A rank with unmapped score + consultation=Yes → does NOT fire (no fallback calendar)", () => {
    // Defensive: same byte-mismatch cases the redirect tests cover.
    assert.equal(shouldMarkScheduled("Yes", "A", null), false);
    assert.equal(shouldMarkScheduled("Yes", "A", undefined), false);
    assert.equal(shouldMarkScheduled("Yes", "A", "7"), false); // missing "  ($0-$350k)"
    assert.equal(shouldMarkScheduled("Yes", "A", "7 ($0-$350k)"), false); // one-space mismatch
  });

  it("B rank (NOT B+) + consultation=Yes → does NOT fire", () => {
    assert.equal(shouldMarkScheduled("Yes", "B", "8  ($351k-$600k)"), false);
  });
});
