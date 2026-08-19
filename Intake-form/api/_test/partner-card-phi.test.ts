// HIPAA regression (Block B × Block D): partner insurance cards must behave
// EXACTLY like the original cards — base64 bytes stripped before raw_payload,
// and excluded from the CSV export's generic rp_ sweep. DB-free: exercises the
// real sanitizeForPersistence + buildFormCsv functions directly.
//
// 2026-08-19 (Train C): repaired. The export was rewritten in fc3e788 from a
// generic `rp_*` raw_payload sweep to an explicit per-form column allow-list
// (buildFormCsv + COLUMNS_BY_FORM), and `buildSubmissionsCsv` ceased to exist —
// but this file still imported it, so the whole suite died on the import and
// this HIPAA guard had not run since. The invariant is unchanged and still
// worth asserting; only the mechanism it asserts against moved. (api/tsconfig
// excludes _test/**, which is why typecheck never surfaced the dead import.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForPersistence } from "../submit";
import { buildFormCsv, COLUMNS_BY_FORM } from "../submissions/export";

const SECRET = "BASE64_SECRET_SHOULD_NEVER_PERSIST";

// ---- Fix 1: sanitizeForPersistence strips partner-card base64 -------------

test("sanitizeForPersistence strips base64 from partner cards (keeps metadata)", () => {
  const body = {
    formType: "registration",
    firstName: "Jordan",
    lastName: "Rivera",
    email: "jordan@example.com",
    phone: "(206) 555-0142",
    insuranceCoverage: "Both",
    insuranceCardFront: {
      filename: "own-front.jpg",
      size: 1000,
      contentType: "image/jpeg",
      base64Data: SECRET + "_OWN_FRONT",
    },
    insuranceCardBack: {
      filename: "own-back.jpg",
      size: 1100,
      contentType: "image/jpeg",
      base64Data: SECRET + "_OWN_BACK",
    },
    // Partner cards arrive via .passthrough() (untyped).
    partnerInsuranceCardFront: {
      filename: "partner-front.jpg",
      size: 2000,
      contentType: "image/jpeg",
      base64Data: SECRET + "_PARTNER_FRONT",
    },
    partnerInsuranceCardBack: {
      filename: "partner-back.jpg",
      size: 2100,
      contentType: "image/jpeg",
      base64Data: SECRET + "_PARTNER_BACK",
    },
  } as unknown as Parameters<typeof sanitizeForPersistence>[0];

  const out = sanitizeForPersistence(body) as Record<string, Record<string, unknown>>;

  // Whole-object scan: no base64 sentinel survives anywhere.
  assert.ok(
    !JSON.stringify(out).includes(SECRET),
    "no base64Data should survive sanitization (any card)",
  );

  // Partner cards keep metadata, drop bytes — mirroring the originals.
  for (const key of ["partnerInsuranceCardFront", "partnerInsuranceCardBack"]) {
    const card = out[key];
    assert.equal(card.base64Data, undefined, `${key}.base64Data must be dropped`);
    assert.ok(card.filename, `${key}.filename must be preserved`);
    assert.ok(typeof card.size === "number", `${key}.size must be preserved`);
    assert.ok(card.contentType, `${key}.contentType must be preserved`);
  }
  // Originals unchanged in behavior.
  assert.equal(out.insuranceCardFront.base64Data, undefined);
  assert.equal(out.insuranceCardFront.filename, "own-front.jpg");
});

// ---- Fix 2: no card bytes reach the CSV, for any form --------------------

test("export CSV: no card base64 for any form; partner filenames still recorded", () => {
  const row = {
    id: "00000000-0000-0000-0000-000000000001",
    createdAt: new Date("2026-05-20T15:42:00Z"),
    formType: "registration",
    firstName: "Jordan",
    lastName: "Rivera",
    email: "jordan@example.com",
    phone: "(206) 555-0142",
    dateOfBirth: "1986-03-14",
    stateResidence: "WA",
    insuranceCardFrontFilename: "own-front.jpg",
    insuranceCardBackFilename: "own-back.jpg",
    hasInsuranceCards: true,
    mhMentalIllness: "No",
    n8nStatus: "success",
    n8nPatientId: null,
    n8nResponseAt: null,
    rawPayload: {
      officeLocation: "Seattle, WA",
      // Defense-in-depth: even if a legacy row still carried card bytes, the
      // export must never emit them. Every slot, primary and partner.
      insuranceCardFront: {
        filename: "own-front.jpg",
        size: 1900,
        contentType: "image/jpeg",
        base64Data: SECRET,
      },
      partnerInsuranceCardFront: {
        filename: "partner-front.jpg",
        size: 2000,
        contentType: "image/jpeg",
        base64Data: SECRET,
      },
      partnerInsuranceCardBack: {
        filename: "partner-back.jpg",
        size: 2100,
        base64Data: SECRET,
      },
      howHeard: ["Family", "Friend", "Radio"],
      mhBleeding: "Yes",
      medicalDetails: { mhBleeding: "Resolved in 2021." },
      // The insurance form nests its cards the same way.
      insurance: {
        primary: { carrier: "Test Carrier", policyNo: "POL1" },
        secondary: null,
      },
    },
  } as unknown as Parameters<typeof buildFormCsv>[0][number];

  // The allow-list design means a raw_payload key can only reach the CSV if a
  // column names it — so assert the invariant across EVERY form's schema, which
  // also covers any column added to one form and forgotten in another.
  for (const [form, columns] of Object.entries(COLUMNS_BY_FORM)) {
    const csv = buildFormCsv([row], columns);
    assert.ok(
      !csv.includes(SECRET),
      `card base64 leaked into the ${form} export`,
    );
    assert.ok(
      !/base64Data/i.test(csv),
      `a card object was stringified into the ${form} export`,
    );
  }

  // Registration records the partner card FILENAMES (the upload happened) while
  // carrying none of the bytes.
  const regCsv = buildFormCsv([row], COLUMNS_BY_FORM.registration);
  const header = regCsv.split("\r\n")[0];
  assert.ok(header.includes("Partner Insurance Card Front (filename)"));
  assert.ok(header.includes("Partner Insurance Card Back (filename)"));
  assert.ok(regCsv.includes("partner-front.jpg"), "partner filename recorded");
});
