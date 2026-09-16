// Train 3 — ledger, digest and stuck-threshold tests.
//
// The load-bearing one is "the digest cannot leak PHI": it runs the renderer
// over a fixture whose submission IDs sit alongside a patient identity, and
// asserts none of those identity strings can appear in the output. The
// renderer's input type has nowhere to put them, and this test is what keeps
// that true as the digest grows.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  isQuiet,
  renderDigest,
  type DigestData,
} from "./digest";
import { sanitizeDetail } from "./ledger";
import {
  notifyPatientSubmission,
  type SendResult,
} from "../email/patientmail";
import {
  notifyInsuranceSubmission,
  type NotifySendResult,
} from "../n8n/insurance-notify";
import { syncStatusCell } from "../../api/submissions/export";

// A fabricated patient. None of these strings may ever reach the digest.
const PHI = {
  firstName: "Marguerite",
  lastName: "Ashdown-Petrie",
  dob: "1984-03-11",
  phone: "(206) 555-0147",
  email: "marguerite.ashdown@example.com",
  office: "Seattle WA",
};

const BASE: DigestData = {
  generatedAt: new Date("2026-09-16T16:00:00Z"),
  consoleBaseUrl: "https://intake.drsnip.com",
  stuck: [
    { id: "8faf35fc-c526-43db-912f-ba3e0d8e546e", formType: "consultation", ageMinutes: 2861 },
  ],
  failed24h: [
    { errorMessage: "timeout after 30000ms", count: 2, ids: ["aaaaaaaa-0000-0000-0000-000000000001"] },
  ],
  manualReview: { open: 177, oldestDays: 93, added24h: 2 },
  notificationProblems24h: [
    { channel: "patientmail", outcome: "skipped", detail: "no_recipient", count: 5 },
  ],
};

describe("digest — no PHI", () => {
  it("cannot emit any identity field from a fixture that has them", () => {
    const { subject, body } = renderDigest(BASE);
    const haystack = `${subject}\n${body}`;
    for (const [field, value] of Object.entries(PHI)) {
      assert.ok(
        !haystack.includes(value),
        `digest leaked ${field}: ${value}`,
      );
    }
  });

  it("carries submission ids and console links, which is what a human needs", () => {
    const { body } = renderDigest(BASE);
    assert.match(body, /8faf35fc-c526-43db-912f-ba3e0d8e546e/);
    assert.match(
      body,
      /https:\/\/intake\.drsnip\.com\/admin\/submissions\/8faf35fc/,
    );
  });

  it("tells the reader not to resubmit — the bridge is not idempotent", () => {
    assert.match(renderDigest(BASE).body, /not idempotent|duplicate a chart/i);
  });

  it("states it never acts", () => {
    assert.match(renderDigest(BASE).body, /reports only|never retries/i);
  });
});

describe("digest — content", () => {
  it("reports every section", () => {
    const b = renderDigest(BASE).body;
    assert.match(b, /Stuck \(no bridge result recorded\): 1/);
    assert.match(b, /Failed in the last 24h: 2/);
    assert.match(b, /Manual review: 177 open, oldest 93 days, \+2 in 24h/);
    assert.match(b, /5 x patientmail skipped \(no_recipient\)/);
  });

  it("an all-clear tick is still a full report, and is marked quiet", () => {
    const quiet: DigestData = {
      ...BASE,
      stuck: [],
      failed24h: [],
      notificationProblems24h: [],
    };
    const r = renderDigest(quiet);
    assert.equal(r.quiet, true);
    assert.equal(isQuiet(quiet), true);
    assert.match(r.subject, /all clear/);
    // The backlog is still stated: it is the standing finding.
    assert.match(r.body, /Manual review: 177 open/);
  });

  it("a manual-review backlog alone does not make the digest noisy", () => {
    assert.equal(
      isQuiet({ ...BASE, stuck: [], failed24h: [], notificationProblems24h: [] }),
      true,
    );
  });

  it("singular day reads correctly", () => {
    const r = renderDigest({
      ...BASE,
      manualReview: { open: 1, oldestDays: 1, added24h: 0 },
    });
    assert.match(r.body, /oldest 1 day,/);
  });
});

describe("ledger — sanitizeDetail", () => {
  it("passes short machine reasons through untouched", () => {
    for (const d of ["no_recipient", "no_url", "HTTP 500", "AbortError"]) {
      assert.equal(sanitizeDetail(d), d);
    }
  });

  it("redacts anything email-shaped", () => {
    assert.equal(
      sanitizeDetail(`failed for ${PHI.email}`),
      "failed for [redacted]",
    );
  });

  it("truncates a long blob so a message body cannot fit", () => {
    const out = sanitizeDetail("x".repeat(500));
    assert.ok(out !== null && out.length <= 121, `got ${out?.length}`);
  });

  it("normalises empty and missing to null", () => {
    assert.equal(sanitizeDetail(""), null);
    assert.equal(sanitizeDetail("   "), null);
    assert.equal(sanitizeDetail(null), null);
    assert.equal(sanitizeDetail(undefined), null);
  });
});

describe("send sites report their outcome", () => {
  const n = {
    submissionId: "11111111-1111-1111-1111-111111111111",
    office: PHI.office,
    name: `${PHI.firstName} ${PHI.lastName}`,
    dob: PHI.dob,
    phone: PHI.phone,
  };

  it("patientmail reports the no_recipient SKIP — the case that went unseen for months", async () => {
    const seen: SendResult[] = [];
    const prevEnabled = process.env.PATIENTMAIL_ENABLED;
    const prevTo = process.env.PATIENTMAIL_TO;
    process.env.PATIENTMAIL_ENABLED = "true";
    delete process.env.PATIENTMAIL_TO;
    try {
      const sent = await notifyPatientSubmission(n, async () => {}, (r) => seen.push(r));
      assert.equal(sent, false);
      assert.deepEqual(seen, [{ outcome: "skipped", detail: "no_recipient" }]);
    } finally {
      if (prevEnabled === undefined) delete process.env.PATIENTMAIL_ENABLED;
      else process.env.PATIENTMAIL_ENABLED = prevEnabled;
      if (prevTo !== undefined) process.env.PATIENTMAIL_TO = prevTo;
    }
  });

  it("patientmail reports the disabled skip", async () => {
    const seen: SendResult[] = [];
    const prev = process.env.PATIENTMAIL_ENABLED;
    process.env.PATIENTMAIL_ENABLED = "false";
    try {
      await notifyPatientSubmission(n, async () => {}, (r) => seen.push(r));
      assert.deepEqual(seen, [{ outcome: "skipped", detail: "disabled" }]);
    } finally {
      if (prev === undefined) delete process.env.PATIENTMAIL_ENABLED;
      else process.env.PATIENTMAIL_ENABLED = prev;
    }
  });

  it("patientmail reports sent, and an error by name only", async () => {
    const prevEnabled = process.env.PATIENTMAIL_ENABLED;
    const prevTo = process.env.PATIENTMAIL_TO;
    process.env.PATIENTMAIL_ENABLED = "true";
    process.env.PATIENTMAIL_TO = "staff@example.invalid";
    try {
      const ok: SendResult[] = [];
      await notifyPatientSubmission(n, async () => {}, (r) => ok.push(r));
      assert.deepEqual(ok, [{ outcome: "sent", detail: null }]);

      const bad: SendResult[] = [];
      await notifyPatientSubmission(
        n,
        async () => {
          throw new TypeError(`smtp blew up for ${PHI.email}`);
        },
        (r) => bad.push(r),
      );
      assert.deepEqual(bad, [{ outcome: "error", detail: "TypeError" }]);
      // The error NAME is reported, never the message — which held an address.
      assert.ok(!JSON.stringify(bad).includes(PHI.email));
    } finally {
      if (prevEnabled === undefined) delete process.env.PATIENTMAIL_ENABLED;
      else process.env.PATIENTMAIL_ENABLED = prevEnabled;
      if (prevTo === undefined) delete process.env.PATIENTMAIL_TO;
      else process.env.PATIENTMAIL_TO = prevTo;
    }
  });

  it("a throwing reporter never breaks the send", async () => {
    const prevEnabled = process.env.PATIENTMAIL_ENABLED;
    const prevTo = process.env.PATIENTMAIL_TO;
    process.env.PATIENTMAIL_ENABLED = "true";
    process.env.PATIENTMAIL_TO = "staff@example.invalid";
    try {
      let delivered = false;
      const sent = await notifyPatientSubmission(
        n,
        async () => {
          delivered = true;
        },
        () => {
          throw new Error("ledger down");
        },
      );
      assert.equal(delivered, true, "send must still happen");
      assert.equal(sent, true, "send must still report success");
    } finally {
      if (prevEnabled === undefined) delete process.env.PATIENTMAIL_ENABLED;
      else process.env.PATIENTMAIL_ENABLED = prevEnabled;
      if (prevTo === undefined) delete process.env.PATIENTMAIL_TO;
      else process.env.PATIENTMAIL_TO = prevTo;
    }
  });

  it("insurance doorbell reports no_url, sent and error", async () => {
    const input = {
      submissionId: "22222222-2222-2222-2222-222222222222",
      name: `${PHI.firstName} ${PHI.lastName}`,
      office: PHI.office,
      submittedAt: new Date("2026-09-16T16:00:00Z"),
    };
    const prev = process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
    try {
      delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
      const skip: NotifySendResult[] = [];
      await notifyInsuranceSubmission(input, async () => {}, (r) => skip.push(r));
      assert.deepEqual(skip, [{ outcome: "skipped", detail: "no_url" }]);

      process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = "https://n8n.invalid/hook";
      const ok: NotifySendResult[] = [];
      await notifyInsuranceSubmission(input, async () => {}, (r) => ok.push(r));
      assert.deepEqual(ok, [{ outcome: "sent", detail: null }]);

      const bad: NotifySendResult[] = [];
      await notifyInsuranceSubmission(
        input,
        async () => {
          throw new Error("HTTP 500");
        },
        (r) => bad.push(r),
      );
      assert.deepEqual(bad, [{ outcome: "error", detail: "Error" }]);
    } finally {
      if (prev === undefined) delete process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL;
      else process.env.N8N_WEBHOOK_INSURANCE_NOTIFY_URL = prev;
    }
  });
});

describe("stuck threshold", () => {
  const NOW = Date.parse("2026-09-16T16:00:00Z");
  const ago = (min: number): string => new Date(NOW - min * 60_000).toISOString();

  it("a row still in flight reads pending, not stuck", () => {
    // n8n stalls have reached 269 s, so 9 minutes is legitimately in flight.
    assert.equal(syncStatusCell({ n8nStatus: null, createdAt: ago(9) }, NOW), "pending");
  });

  it("past the threshold it reads stuck", () => {
    assert.equal(syncStatusCell({ n8nStatus: null, createdAt: ago(11) }, NOW), "stuck");
  });

  it("a real status always wins, including not_applicable", () => {
    for (const st of ["success", "failed", "manual_review", "not_applicable"]) {
      assert.equal(syncStatusCell({ n8nStatus: st, createdAt: ago(9999) }, NOW), st);
    }
  });

  it("an unparseable timestamp falls back to pending rather than crying wolf", () => {
    assert.equal(syncStatusCell({ n8nStatus: null, createdAt: "nonsense" }, NOW), "pending");
  });
});
