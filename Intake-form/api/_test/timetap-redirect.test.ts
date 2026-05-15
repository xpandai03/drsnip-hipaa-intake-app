// Unit tests for getTimeTapRedirectUrl. The function is pure — no DB,
// no env, no I/O — so these are straight input → output assertions.
//
// The byte-exact score keys are the contract. If a score string drifts
// (e.g. someone "fixes" the two-space spacing), this test catches it
// before users get misrouted.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TIMETAP_CALENDARS,
  getTimeTapRedirectUrl,
  type RedirectLeadFields,
} from "../_lib/timetap-redirect";

const baseLead: RedirectLeadFields = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.gov",
  phone: "555-0100",
};

describe("getTimeTapRedirectUrl — calendar mapping", () => {
  it("A-10 (over $1mm) → myadvisor with all four pre-fill params", () => {
    const url = getTimeTapRedirectUrl("A", "10  (over $1mm)", baseLead);
    assert.equal(
      url,
      "https://myadvisor.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("A-9 ($601k - $1mm) → advisorscheduling", () => {
    const url = getTimeTapRedirectUrl("A", "9 ($601k - $1mm)", baseLead);
    assert.equal(
      url,
      "https://advisorscheduling.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("A-8 ($351k-$600k) → advisorschedule", () => {
    const url = getTimeTapRedirectUrl("A", "8  ($351k-$600k)", baseLead);
    assert.equal(
      url,
      "https://advisorschedule.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("A-7 ($0-$350k) → advisorscheduler", () => {
    const url = getTimeTapRedirectUrl("A", "7  ($0-$350k)", baseLead);
    assert.equal(
      url,
      "https://advisorscheduler.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("B+ with a score → advisorconsult (B+ ignores score)", () => {
    const url = getTimeTapRedirectUrl("B+", "7  ($0-$350k)", baseLead);
    assert.equal(
      url,
      "https://advisorconsult.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("B+ without a score → advisorconsult (B+ always qualifies)", () => {
    const url = getTimeTapRedirectUrl("B+", undefined, baseLead);
    assert.equal(
      url,
      "https://advisorconsult.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=555-0100#/",
    );
  });

  it("B+ with null score → advisorconsult", () => {
    const url = getTimeTapRedirectUrl("B+", null, baseLead);
    assert.equal(typeof url, "string");
    assert.match(url ?? "", /^https:\/\/advisorconsult\.timetap\.com\//);
  });

  it("rank B → null (B alone never qualifies)", () => {
    const url = getTimeTapRedirectUrl("B", "8  ($351k-$600k)", baseLead);
    assert.equal(url, null);
  });

  it("rank C → null", () => {
    const url = getTimeTapRedirectUrl("C", "7  ($0-$350k)", baseLead);
    assert.equal(url, null);
  });

  it("rank N/A → null", () => {
    const url = getTimeTapRedirectUrl("N/A", undefined, baseLead);
    assert.equal(url, null);
  });

  it("rank null/undefined → null", () => {
    assert.equal(getTimeTapRedirectUrl(null, "10  (over $1mm)", baseLead), null);
    assert.equal(getTimeTapRedirectUrl(undefined, "10  (over $1mm)", baseLead), null);
  });

  it("rank A with null score → null (no fallback calendar)", () => {
    assert.equal(getTimeTapRedirectUrl("A", null, baseLead), null);
    assert.equal(getTimeTapRedirectUrl("A", undefined, baseLead), null);
  });

  it("rank A with an unmapped score → null (no fallback calendar — silent misroute is worse than no redirect)", () => {
    // Variants that look superficially right but byte-mismatch:
    assert.equal(getTimeTapRedirectUrl("A", "7", baseLead), null);
    assert.equal(getTimeTapRedirectUrl("A", "7 ($0-$350k)", baseLead), null); // ONE space, wrong
    assert.equal(getTimeTapRedirectUrl("A", "10 (over $1mm)", baseLead), null); // ONE space, wrong
    assert.equal(getTimeTapRedirectUrl("A", "Some other tier", baseLead), null);
  });

  it("special characters in name (O'Brien, José) are percent-encoded correctly", () => {
    const lead: RedirectLeadFields = {
      firstName: "José",
      lastName: "O'Brien",
      email: "jose.obrien+work@example.gov",
      phone: "+1 (555) 0100",
    };
    const url = getTimeTapRedirectUrl("A", "10  (over $1mm)", lead);
    assert.equal(
      url,
      "https://myadvisor.timetap.com/?CF_CLIENT_FIRSTNAME=Jos%C3%A9&CF_CLIENT_LASTNAME=O%27Brien&CF_CLIENT_EMAILADDRESS=jose.obrien%2Bwork%40example.gov&CF_CLIENT_MOBILE_PHONE=%2B1+%28555%29+0100#/",
    );
  });

  it("missing phone → empty string in URL, NOT 'undefined' or 'null'", () => {
    const lead: RedirectLeadFields = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.gov",
      // phone intentionally omitted
    };
    const url = getTimeTapRedirectUrl("B+", undefined, lead);
    assert.equal(
      url,
      "https://advisorconsult.timetap.com/?CF_CLIENT_FIRSTNAME=Jane&CF_CLIENT_LASTNAME=Doe&CF_CLIENT_EMAILADDRESS=jane%40example.gov&CF_CLIENT_MOBILE_PHONE=#/",
    );
  });

  it("calendar mapping table contains exactly the documented subdomains", () => {
    assert.deepStrictEqual(TIMETAP_CALENDARS.A_RANK, {
      "10  (over $1mm)": "myadvisor.timetap.com",
      "9 ($601k - $1mm)": "advisorscheduling.timetap.com",
      "8  ($351k-$600k)": "advisorschedule.timetap.com",
      "7  ($0-$350k)": "advisorscheduler.timetap.com",
    });
    assert.equal(TIMETAP_CALENDARS.B_PLUS, "advisorconsult.timetap.com");
  });

  it("URL always ends with the literal '#/' route suffix", () => {
    const urls = [
      getTimeTapRedirectUrl("A", "10  (over $1mm)", baseLead),
      getTimeTapRedirectUrl("A", "9 ($601k - $1mm)", baseLead),
      getTimeTapRedirectUrl("A", "8  ($351k-$600k)", baseLead),
      getTimeTapRedirectUrl("A", "7  ($0-$350k)", baseLead),
      getTimeTapRedirectUrl("B+", undefined, baseLead),
    ];
    for (const url of urls) {
      assert.equal(typeof url, "string");
      assert.match(url ?? "", /#\/$/);
    }
  });
});
