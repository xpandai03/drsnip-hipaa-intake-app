// Clinic-day calendar tests. The point of this file is the LAST describe block:
// the reporting calendar and the export calendar must agree. Before
// api/_lib/clinic-time.ts they did not, and a 10 PM Pacific submission showed
// up on two different dates depending on which screen you looked at.
//
// No PHI, no DB, no network — pure date arithmetic.
//
// US DST in 2026: forward Sun 8 Mar, back Sun 1 Nov.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLINIC_TZ,
  addClinicDays,
  clinicDayEndExclusive,
  clinicDayOf,
  clinicDayRange,
  clinicDayStart,
  isClinicDay,
  lastClinicDays,
  resolveClinicWindow,
} from "../_lib/clinic-time";
import { toPacificParts } from "../_lib/datetime";

const HOUR = 3_600_000;

describe("clinicDayStart — DST-aware day boundaries", () => {
  it("a winter day starts at 08:00Z (PST, UTC-8)", () => {
    assert.equal(clinicDayStart("2026-01-15").toISOString(), "2026-01-15T08:00:00.000Z");
  });

  it("a summer day starts at 07:00Z (PDT, UTC-7)", () => {
    assert.equal(clinicDayStart("2026-07-01").toISOString(), "2026-07-01T07:00:00.000Z");
  });

  it("spring-forward day itself still starts in PST", () => {
    // Clocks jump 2am PST -> 3am PDT on 8 Mar, so midnight is still UTC-8.
    assert.equal(clinicDayStart("2026-03-08").toISOString(), "2026-03-08T08:00:00.000Z");
    // The following day is fully PDT.
    assert.equal(clinicDayStart("2026-03-09").toISOString(), "2026-03-09T07:00:00.000Z");
  });

  it("fall-back day itself still starts in PDT", () => {
    assert.equal(clinicDayStart("2026-11-01").toISOString(), "2026-11-01T07:00:00.000Z");
    assert.equal(clinicDayStart("2026-11-02").toISOString(), "2026-11-02T08:00:00.000Z");
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    assert.throws(() => clinicDayStart("2026-3-8"), RangeError);
    assert.throws(() => clinicDayStart("not a day"), RangeError);
  });
});

describe("clinicDayEndExclusive — a DST day is not 24 hours", () => {
  it("an ordinary day is 24h long", () => {
    const len = clinicDayEndExclusive("2026-01-15").getTime() - clinicDayStart("2026-01-15").getTime();
    assert.equal(len / HOUR, 24);
  });

  it("the spring-forward day is 23h long", () => {
    const len = clinicDayEndExclusive("2026-03-08").getTime() - clinicDayStart("2026-03-08").getTime();
    assert.equal(len / HOUR, 23);
  });

  it("the fall-back day is 25h long", () => {
    const len = clinicDayEndExclusive("2026-11-01").getTime() - clinicDayStart("2026-11-01").getTime();
    assert.equal(len / HOUR, 25);
  });

  it("is exclusive: the next day's first instant is NOT in this day", () => {
    const end = clinicDayEndExclusive("2026-09-17");
    assert.equal(clinicDayOf(end), "2026-09-18");
    assert.equal(clinicDayOf(new Date(end.getTime() - 1)), "2026-09-17");
  });
});

describe("clinicDayOf", () => {
  it("10 PM Pacific belongs to the Pacific day, not the next UTC day", () => {
    // 2026-08-07T05:00:00Z is 10:00 PM PDT on 2026-08-06.
    assert.equal(clinicDayOf("2026-08-07T05:00:00Z"), "2026-08-06");
  });

  it("midnight Pacific is the new day", () => {
    assert.equal(clinicDayOf("2026-08-07T07:00:00Z"), "2026-08-07");
    assert.equal(clinicDayOf("2026-08-07T06:59:59Z"), "2026-08-06");
  });

  it("throws on an invalid date rather than returning a wrong day", () => {
    assert.throws(() => clinicDayOf("nonsense"), RangeError);
  });
});

describe("addClinicDays / clinicDayRange", () => {
  it("steps across the spring-forward boundary without slipping", () => {
    assert.equal(addClinicDays("2026-03-07", 1), "2026-03-08");
    assert.equal(addClinicDays("2026-03-08", 1), "2026-03-09");
    assert.equal(addClinicDays("2026-03-09", -1), "2026-03-08");
  });

  it("steps across the fall-back boundary without slipping", () => {
    assert.equal(addClinicDays("2026-10-31", 1), "2026-11-01");
    assert.equal(addClinicDays("2026-11-01", 1), "2026-11-02");
  });

  it("steps across month and year ends", () => {
    assert.equal(addClinicDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addClinicDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addClinicDays("2026-03-01", -1), "2026-02-28");
  });

  it("an inclusive range spanning a DST change has the right day count", () => {
    const r = clinicDayRange("2026-03-06", "2026-03-10");
    assert.deepEqual(r, ["2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  });

  it("a single-day range is one day, and an inverted range is empty", () => {
    assert.deepEqual(clinicDayRange("2026-05-05", "2026-05-05"), ["2026-05-05"]);
    assert.deepEqual(clinicDayRange("2026-05-06", "2026-05-05"), []);
  });
});

describe("resolveClinicWindow", () => {
  it("resolves an inclusive day pair to instants, with an exclusive upper bound", () => {
    const w = resolveClinicWindow("2026-09-01", "2026-09-17");
    assert.equal(w.invalid, false);
    assert.equal(w.fromDay, "2026-09-01");
    assert.equal(w.toDay, "2026-09-17");
    assert.equal(w.from?.toISOString(), "2026-09-01T07:00:00.000Z");
    assert.equal(w.toExclusive?.toISOString(), "2026-09-18T07:00:00.000Z");
  });

  it("flags an inverted window instead of silently swapping it", () => {
    assert.equal(resolveClinicWindow("2026-09-17", "2026-09-01").invalid, true);
  });

  it("absent or malformed params mean an unbounded window, not an error", () => {
    const w = resolveClinicWindow(undefined, undefined);
    assert.equal(w.invalid, false);
    assert.equal(w.from, undefined);
    assert.equal(w.toExclusive, undefined);
    assert.equal(resolveClinicWindow("15/09/2026", "x").from, undefined);
  });

  it("a same-day window still covers that whole day", () => {
    const w = resolveClinicWindow("2026-03-08", "2026-03-08");
    assert.equal(w.from?.toISOString(), "2026-03-08T08:00:00.000Z");
    assert.equal(w.toExclusive?.toISOString(), "2026-03-09T07:00:00.000Z");
  });
});

describe("lastClinicDays", () => {
  it("a 7-day window is 7 days inclusive of today", () => {
    const { fromDay, toDay } = lastClinicDays(7, new Date("2026-09-17T20:00:00Z"));
    assert.equal(toDay, "2026-09-17");
    assert.equal(fromDay, "2026-09-11");
    assert.equal(clinicDayRange(fromDay, toDay).length, 7);
  });

  it("a 1-day window is today only", () => {
    const { fromDay, toDay } = lastClinicDays(1, new Date("2026-09-17T20:00:00Z"));
    assert.equal(fromDay, "2026-09-17");
    assert.equal(toDay, "2026-09-17");
  });

  it("late-evening Pacific has not yet rolled into tomorrow", () => {
    // 2026-09-18T05:00Z is 10 PM PDT on the 17th. The UTC calendar would have
    // called this the 18th; the clinic calendar must not.
    assert.equal(lastClinicDays(30, new Date("2026-09-18T05:00:00Z")).toDay, "2026-09-17");
  });
});

describe("isClinicDay", () => {
  it("accepts YYYY-MM-DD only", () => {
    assert.equal(isClinicDay("2026-09-17"), true);
    assert.equal(isClinicDay("2026-9-17"), false);
    assert.equal(isClinicDay(20260917), false);
    assert.equal(isClinicDay(null), false);
    assert.equal(isClinicDay(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// The regression that motivated the module.
// ---------------------------------------------------------------------------
describe("the reporting calendar agrees with the export calendar", () => {
  it("uses the same IANA zone as the exports", () => {
    assert.equal(CLINIC_TZ, "America/Los_Angeles");
  });

  it("10 PM Pacific: chart bucket === CSV date (this used to differ by a day)", () => {
    const instant = "2026-08-07T05:00:00Z"; // 10:00 PM PDT, 6 Aug
    assert.equal(clinicDayOf(instant), toPacificParts(instant).date);
    assert.equal(clinicDayOf(instant), "2026-08-06");
    // What the old UTC bucketing produced, kept here as the contrast:
    assert.equal(new Date(instant).toISOString().slice(0, 10), "2026-08-07");
  });

  it("agrees across a full sweep of instants, including both DST transitions", () => {
    // Every 37 minutes across 2026 — dense enough to straddle both transitions
    // and every midnight, cheap enough to run in a unit test.
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2027, 0, 1);
    let checked = 0;
    for (let t = start; t < end; t += 37 * 60_000) {
      const d = new Date(t);
      assert.equal(
        clinicDayOf(d),
        toPacificParts(d).date,
        `disagreement at ${d.toISOString()}`,
      );
      checked += 1;
    }
    assert.ok(checked > 14_000, `expected a dense sweep, checked ${checked}`);
  });

  it("every day of 2026 round-trips through its own start instant", () => {
    let day = "2026-01-01";
    let n = 0;
    while (day < "2027-01-01") {
      assert.equal(clinicDayOf(clinicDayStart(day)), day, `round-trip failed for ${day}`);
      day = addClinicDays(day, 1);
      n += 1;
    }
    assert.equal(n, 365);
  });
});
