// Tests for the marketing-dashboard reporting layer (api/_lib/reporting.ts +
// api/reports/*). Split into:
//   • Pure-function tests (no DB): suppression thresholds, the dimension
//     allow-list, and a safety assertion that no dimension expression reads a
//     PHI/identifier column.
//   • Handler guard tests (no DB query reached): 405 wrong-method, and 401 when
//     unauthenticated — requireAuth returns before any DB call on a missing
//     cookie (getSessionFromCookie: no cookie → null).
//
// The actual how_heard jsonb unnest + GROUP BY run in Postgres and are verified
// against the deployed DB (a multi-select consultation row yields one count per
// selected channel; channel total ≥ submission count). No PHI in this file.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  suppress,
  suppressRows,
  isAllowedDimension,
  DIMENSION_EXPR,
  ALLOWED_DIMENSIONS,
  SUPPRESS_BELOW,
} from "../_lib/reporting";
import countsHandler from "../reports/counts";
import summaryHandler from "../reports/summary";
import { makeReq, makeRes } from "./harness";

describe("suppress — minimum-cell threshold", () => {
  it("hides 1..4 as '<5'", () => {
    for (const n of [1, 2, 3, 4]) assert.equal(suppress(n), `<${SUPPRESS_BELOW}`);
  });
  it("passes 5 and above through as the number", () => {
    assert.equal(suppress(5), 5);
    assert.equal(suppress(6), 6);
    assert.equal(suppress(250), 250);
  });
  it("keeps 0 as an explicit 0 (not hidden)", () => {
    assert.equal(suppress(0), 0);
  });
});

describe("suppressRows — counts hidden cells, preserves labels", () => {
  it("suppresses only sub-threshold cells and tallies them", () => {
    const { rows, suppressed_cells } = suppressRows([
      { value: "Google", count: 214 },
      { value: "Facebook", count: 5 },
      { value: "Radio", count: 4 },
      { value: "TV", count: 1 },
    ]);
    assert.equal(suppressed_cells, 2);
    assert.deepEqual(rows, [
      { value: "Google", count: 214 },
      { value: "Facebook", count: 5 },
      { value: "Radio", count: "<5" },
      { value: "TV", count: "<5" },
    ]);
  });
});

describe("dimension allow-list", () => {
  it("accepts exactly the whitelisted dimensions + how_heard", () => {
    for (const d of [
      "form_type",
      "n8n_status",
      "office_location",
      "insurance_coverage",
      "action_label",
      "day",
      "week",
      "month",
      "how_heard",
    ]) {
      assert.equal(isAllowedDimension(d), true, `${d} should be allowed`);
    }
    assert.equal(ALLOWED_DIMENSIONS.length, 9);
  });

  it("rejects anything not on the list — including PHI columns and SQL", () => {
    for (const bad of [
      "email",
      "first_name",
      "last_name",
      "phone",
      "date_of_birth",
      "raw_payload",
      "n8n_patient_id",
      "n8n_response_body",
      "",
      "1;DROP TABLE submissions",
      "created_at); SELECT",
    ]) {
      assert.equal(isAllowedDimension(bad), false, `${bad} must be rejected`);
    }
  });
});

describe("dimension expressions — PHI safety", () => {
  it("no dimension expression references an identifier/medical column", () => {
    const forbidden = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "date_of_birth",
      "n8n_patient_id",
      "insuranceIdNo",
      "insuranceCompany",
      "insuredFirstName",
      "streetAddress",
      "postalCode",
      "referringProfessional",
      "primaryCarePhysician",
      "mh_mental_illness",
      "howHeardOther",
    ];
    for (const [dim, expr] of Object.entries(DIMENSION_EXPR)) {
      for (const f of forbidden) {
        assert.ok(
          !expr.includes(f),
          `dimension '${dim}' expression must not reference '${f}'`,
        );
      }
    }
  });
});

describe("counts handler — guards (no DB reached)", () => {
  it("405s a non-GET method", async () => {
    const res = makeRes();
    await countsHandler(makeReq({ method: "POST" }), res);
    assert.equal(res.statusCode, 405);
  });

  it("401s an unauthenticated GET before any query", async () => {
    const res = makeRes();
    await countsHandler(
      makeReq({ method: "GET", query: { dimension: "form_type" } }),
      res,
    );
    assert.equal(res.statusCode, 401);
  });
});

describe("summary handler — guards (no DB reached)", () => {
  it("405s a non-GET method", async () => {
    const res = makeRes();
    await summaryHandler(makeReq({ method: "POST" }), res);
    assert.equal(res.statusCode, 405);
  });

  it("401s an unauthenticated GET before any query", async () => {
    const res = makeRes();
    await summaryHandler(makeReq({ method: "GET" }), res);
    assert.equal(res.statusCode, 401);
  });
});
