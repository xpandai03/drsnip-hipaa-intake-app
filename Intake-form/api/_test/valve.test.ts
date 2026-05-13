// Hold-valve gate — table test for byte-exact equality.
//
// The function under test, shouldHoldLead(valveOn, leadScore), decides
// whether a freshly-scored lead should be diverted to the 'held' queue
// instead of being POSTed to Salesforce. Pure function, no I/O — testable
// in isolation. The (sfStatus, didCallSf) outcome mapping is:
//
//   shouldHoldLead === true   → submit handler writes sfStatus='held' and
//                                does NOT call createLead. (didCallSf=false)
//   shouldHoldLead === false  → submit handler proceeds to the SF POST
//                                path, eventually writing sfStatus='sent'
//                                or 'error'. (didCallSf=true)
//
// The integration ("submit.ts uses this gate correctly") is verified by
// the manual test scenarios in the feature's test plan. This file locks
// the gate's pure-function contract.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_LEAD_SCORE,
  HOLD_VALVE_KEY,
  shouldHoldLead,
} from "../_lib/valve";

describe("shouldHoldLead — byte-exact A-7 hold gate", () => {
  const cases: Array<{
    name: string;
    valveOn: boolean;
    leadScore: string | undefined;
    expected: boolean;
    derivedSfStatus: "held" | "sent_or_error";
    derivedDidCallSf: boolean;
  }> = [
    {
      name: "valve=off + score=7 → SF call (today's default behavior)",
      valveOn: false,
      leadScore: "7  ($0-$350k)",
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
    {
      name: "valve=on + score=7 (byte-exact match) → HELD, no SF call",
      valveOn: true,
      leadScore: "7  ($0-$350k)",
      expected: true,
      derivedSfStatus: "held",
      derivedDidCallSf: false,
    },
    {
      name: "valve=on + score=8 → SF call (valve only matches the 7 literal)",
      valveOn: true,
      leadScore: "8  ($351k-$600k)",
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
    {
      name: "valve=on + score=undefined → SF call (no score = no hold)",
      valveOn: true,
      leadScore: undefined,
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
    {
      name: "valve=on + score='7' (short variant, no parens) → SF call (byte mismatch)",
      valveOn: true,
      leadScore: "7",
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
    {
      name: "valve=on + score='7 ($0-$350k)' (ONE space, wrong) → SF call (byte mismatch)",
      valveOn: true,
      leadScore: "7 ($0-$350k)",
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
    {
      name: "valve=on + score=10 → SF call",
      valveOn: true,
      leadScore: "10  (over $1mm)",
      expected: false,
      derivedSfStatus: "sent_or_error",
      derivedDidCallSf: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = shouldHoldLead(c.valveOn, c.leadScore);
      assert.equal(result, c.expected);
      // Outcome mapping (documented + asserted for clarity in failure output).
      if (result === true) {
        assert.equal(c.derivedSfStatus, "held");
        assert.equal(c.derivedDidCallSf, false);
      } else {
        assert.equal(c.derivedSfStatus, "sent_or_error");
        assert.equal(c.derivedDidCallSf, true);
      }
    });
  }

  it("HOLD_LEAD_SCORE constant matches SF's A-7 literal byte-for-byte (two spaces after 7)", () => {
    assert.equal(HOLD_LEAD_SCORE, "7  ($0-$350k)");
    // Spot-check the byte sequence — 7, space, space, ( ...
    assert.equal(HOLD_LEAD_SCORE.charCodeAt(0), 0x37); // '7'
    assert.equal(HOLD_LEAD_SCORE.charCodeAt(1), 0x20); // ' '
    assert.equal(HOLD_LEAD_SCORE.charCodeAt(2), 0x20); // ' '
    assert.equal(HOLD_LEAD_SCORE.charCodeAt(3), 0x28); // '('
  });

  it("HOLD_VALVE_KEY matches the seeded settings key name", () => {
    assert.equal(HOLD_VALVE_KEY, "hold_a7_for_review");
  });
});
