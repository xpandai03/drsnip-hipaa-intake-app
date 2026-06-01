// HIPAA regression (Block B × Block D): partner insurance cards must behave
// EXACTLY like the original cards — base64 bytes stripped before raw_payload,
// and excluded from the CSV export's generic rp_ sweep. DB-free: exercises the
// real sanitizeForPersistence + buildSubmissionsCsv functions directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForPersistence } from "../submit";
import { buildSubmissionsCsv } from "../submissions/export";

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

// ---- Fix 2: export excludes partner cards from the rp_ sweep ---------------

test("buildSubmissionsCsv: no partner-card JSON dump, no base64; filename column present", () => {
  const rows = [
    {
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
        // Defense-in-depth: even if a legacy row still carried partner-card
        // bytes, the export must never emit them.
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
        // Block B: howHeard is now an array.
        howHeard: ["Family", "Friend", "Radio"],
        mhBleeding: "Yes",
        medicalDetails: { mhBleeding: "Resolved in 2021." },
      },
    },
  ] as unknown as Parameters<typeof buildSubmissionsCsv>[0];

  const csv = buildSubmissionsCsv(rows);
  const header = csv.split("\r\n")[0].split(",");

  // No generic rp_ dump of the partner card objects.
  assert.ok(
    !header.includes("rp_partnerInsuranceCardFront"),
    "partner card front must not be swept into an rp_ column",
  );
  assert.ok(
    !header.includes("rp_partnerInsuranceCardBack"),
    "partner card back must not be swept into an rp_ column",
  );

  // Dedicated partner filename columns are present (records the upload).
  assert.ok(header.includes("partner_insurance_card_front_filename"));
  assert.ok(header.includes("partner_insurance_card_back_filename"));

  // No base64 anywhere in the CSV.
  assert.ok(!csv.includes(SECRET), "no base64 may appear in the export");

  // The partner filename IS recorded, and howHeard is the joined string.
  assert.ok(csv.includes("partner-front.jpg"), "partner filename recorded");
  assert.ok(
    csv.includes("Family | Friend | Radio"),
    "howHeard array rendered as a pipe-joined string in rp_howHeard",
  );
  assert.ok(header.includes("rp_howHeard"));
});
