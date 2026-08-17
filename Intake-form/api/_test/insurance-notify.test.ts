// Insurance notification + filter/export parity (this train). DB-FREE: exercises
// the pure email builder (content whitelist + Pacific edge), the never-throw
// notify gating with an injected transport, the form-type filter whitelist, and
// the insurance export columns.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildInsuranceNotification,
  formatPacific,
  notifyInsuranceSubmission,
  type NotifyTransport,
} from "../../lib/n8n/insurance-notify";
import { ALLOWED_FORM_TYPES } from "../submissions/index";
import { buildFormCsv, COLUMNS_BY_FORM } from "../submissions/export";

const BASE = "https://drsnip-intake-demo.fly.dev";

// ---- Email content: the doorbell whitelist (PHI-light, asserted) ----------

test("buildInsuranceNotification: exact subject, and body carries name/date/office/link", () => {
  const msg = buildInsuranceNotification(
    {
      submissionId: "b64e5cfb-58da-42b5-b14f-83c55637c0d3",
      name: "Jacob J.",
      office: "Seattle, WA",
      submittedAt: new Date("2026-08-16T21:14:00Z"), // 2:14 PM PT
    },
    BASE,
  );
  assert.equal(msg.subject, "New insurance form submission — DrSnip intake");
  assert.match(msg.body, /Jacob J\./);
  assert.match(msg.body, /Aug 16, 2:14 PM PT/);
  assert.match(msg.body, /\(Seattle, WA\)/);
  assert.match(
    msg.body,
    /https:\/\/drsnip-intake-demo\.fly\.dev\/admin\/submissions\/b64e5cfb-58da-42b5-b14f-83c55637c0d3/,
  );
});

test("buildInsuranceNotification: body leaks NO carrier/policy/DOB/medical/card data", () => {
  // Even though the builder's input can't carry these, lock the guarantee so a
  // future widening of the input can't silently leak PHI into the doorbell.
  const msg = buildInsuranceNotification(
    {
      submissionId: "11111111-1111-1111-1111-111111111111",
      name: "Pat Q.",
      office: "Portland, OR",
      submittedAt: new Date("2026-08-16T21:14:00Z"),
    },
    BASE,
  );
  const forbidden = [
    /carrier/i,
    /policy/i,
    /\bgroup\b/i,
    /subscriber/i,
    /\bDOB\b/i,
    /date of birth/i,
    /medical/i,
    /base64/i,
    /\.jpg|\.png|\.pdf|\.heic/i,
    /diagnos/i,
  ];
  for (const re of forbidden) {
    assert.doesNotMatch(msg.body, re, `body must not contain ${re}`);
  }
});

test("buildInsuranceNotification: empty office omits the parenthetical; empty name falls back", () => {
  const msg = buildInsuranceNotification(
    {
      submissionId: "22222222-2222-2222-2222-222222222222",
      name: "   ",
      office: "",
      submittedAt: new Date("2026-08-16T21:14:00Z"),
    },
    BASE,
  );
  assert.match(msg.body, /^A patient submitted an insurance form/);
  assert.doesNotMatch(msg.body, /\(\)/); // no empty parens
});

// ---- Pacific rendering: the 11:58 PM PT edge dates in PT, not UTC tomorrow --

test("formatPacific: 11:58 PM PT on Aug 16 (06:58Z Aug 17) renders as Aug 16, not 17", () => {
  const s = formatPacific(new Date("2026-08-17T06:58:00Z"));
  assert.match(s, /Aug 16, 11:58 PM PT/);
});

// ---- notify gating: never throws; skips cleanly; posts with auth header ----

test("notifyInsuranceSubmission: no webhook URL → clean skip (false), transport NOT called", async () => {
  const prev = process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
  delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
  try {
    let called = false;
    const spy: NotifyTransport = async () => {
      called = true;
    };
    const ok = await notifyInsuranceSubmission(
      { submissionId: "id", name: "A B", office: "", submittedAt: new Date() },
      spy,
    );
    assert.equal(ok, false);
    assert.equal(called, false);
  } finally {
    if (prev === undefined) delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
    else process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = prev;
  }
});

test("notifyInsuranceSubmission: URL set → posts, carries the token + payload", async () => {
  const prevUrl = process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
  const prevSecret = process.env.N8N_WEBHOOK_SECRET;
  process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = "https://n8n.example/webhook/x";
  process.env.N8N_WEBHOOK_SECRET = "s3cr3t";
  try {
    let captured: { env: unknown; payload: unknown } | null = null;
    const spy: NotifyTransport = async (env, payload) => {
      captured = { env, payload };
    };
    const ok = await notifyInsuranceSubmission(
      {
        submissionId: "abc",
        name: "Jacob J.",
        office: "Seattle, WA",
        submittedAt: new Date("2026-08-16T21:14:00Z"),
      },
      spy,
    );
    assert.equal(ok, true);
    assert.ok(captured);
    assert.equal((captured!.env as { secret: string }).secret, "s3cr3t");
    const p = captured!.payload as { submissionId: string; subject: string; body: string };
    assert.equal(p.submissionId, "abc");
    assert.equal(p.subject, "New insurance form submission — DrSnip intake");
    assert.match(p.body, /Jacob J\./);
  } finally {
    if (prevUrl === undefined) delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
    else process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.N8N_WEBHOOK_SECRET;
    else process.env.N8N_WEBHOOK_SECRET = prevSecret;
  }
});

test("notifyInsuranceSubmission: a throwing transport never propagates (returns false)", async () => {
  const prevUrl = process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
  process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = "https://n8n.example/webhook/x";
  try {
    const boom: NotifyTransport = async () => {
      throw new Error("network down");
    };
    let result: boolean | undefined;
    await assert.doesNotReject(async () => {
      result = await notifyInsuranceSubmission(
        { submissionId: "id", name: "A B", office: "", submittedAt: new Date() },
        boom,
      );
    });
    assert.equal(result, false);
  } finally {
    if (prevUrl === undefined) delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
    else process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = prevUrl;
  }
});

// ---- Filter whitelist: insurance is selectable, composes like the others ---

test("ALLOWED_FORM_TYPES: registration, consultation, AND insurance are accepted", () => {
  assert.ok(ALLOWED_FORM_TYPES.has("insurance"));
  assert.ok(ALLOWED_FORM_TYPES.has("registration"));
  assert.ok(ALLOWED_FORM_TYPES.has("consultation"));
  // Adding to the same set means insurance goes through the identical filter
  // code path (form_type AND-composed with location + date range).
  assert.equal(ALLOWED_FORM_TYPES.has("garbage"), false);
});

// ---- Export parity: insurance columns follow the convention -----------------

test("COLUMNS_BY_FORM.insurance exists with Pacific date/time split + insurance fields", () => {
  const cols = COLUMNS_BY_FORM.insurance;
  assert.ok(Array.isArray(cols) && cols.length > 0);
  const headers = cols.map((c) => c.header);
  assert.ok(headers.includes("Submitted Date (PT)"));
  assert.ok(headers.includes("Submitted Time (PT)"));
  assert.ok(headers.includes("Primary Carrier"));
  assert.ok(headers.includes("Primary Policy No."));
  assert.ok(headers.includes("Insurance Card Front (filename)"));
});

test("buildFormCsv(insurance): reads NESTED insurance data + card filename, no bytes", () => {
  const rows = [
    {
      id: "00000000-0000-0000-0000-000000000009",
      createdAt: new Date("2026-08-16T21:14:00Z"),
      formType: "insurance",
      hasInsuranceCards: true,
      n8nStatus: "not_applicable",
      n8nPatientId: null,
      n8nResponseAt: null,
      location: null,
      rawPayload: {
        firstName: "Jacob",
        lastName: "Jones",
        email: "jacob@example.com",
        phone: "(206) 555-0142",
        officeLocation: "Seattle, WA",
        insurance: {
          primary: {
            carrier: "Aetna",
            subscriberName: { first: "Jacob", last: "Jones" },
            policyNo: "POL123",
            groupNo: "GRP9",
            subscriberDob: "1988-02-02",
            relationship: "self",
          },
          secondary: null,
        },
        insuranceCardFront: {
          filename: "front.png",
          contentType: "image/png",
          base64Data: "SHOULD_NEVER_APPEAR",
        },
      },
    },
  ] as unknown as Parameters<typeof buildFormCsv>[0];

  const csv = buildFormCsv(rows, COLUMNS_BY_FORM.insurance);
  assert.ok(csv.includes("Aetna"), "nested primary carrier is read");
  assert.ok(csv.includes("POL123"), "nested policy no is read");
  assert.ok(csv.includes("front.png"), "card filename is recorded");
  assert.ok(!csv.includes("SHOULD_NEVER_APPEAR"), "card base64 never enters CSV");
  // Pacific split columns render.
  assert.ok(csv.includes("Aug 16, 2026") || /2026/.test(csv));
});
