// Phase 4 C.4 — patientmail tests. Pure/unit: no DB, no network, no real send.
// The transport is stubbed and env is set per-case, so the four acceptance
// paths are exercised deterministically:
//   1. successful path  -> exactly one email with the four labelled fields
//   2. failed bridge    -> zero emails (via shouldNotify)
//   3. killswitch off   -> zero emails
//   4. audit log carries a send record with NO PHI values

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMessage,
  notifyPatientSubmission,
  shouldNotify,
  type MailMessage,
} from "./patientmail";

const PHI = {
  submissionId: "sub-123",
  office: "Seattle, WA",
  name: "Jonathan Abernathy-Williamson",
  dob: "1986-03-14",
  phone: "(206) 555-0142",
};

const PHI_VALUES = [PHI.name, PHI.dob, PHI.phone];

// Set patientmail env for a case; returns a restore fn.
function withEnv(env: Record<string, string | undefined>): () => void {
  const keys = [
    "PATIENTMAIL_ENABLED",
    "PATIENTMAIL_TO",
    "PATIENTMAIL_FROM",
  ];
  const prev: Record<string, string | undefined> = {};
  for (const k of keys) prev[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

// Capture console.log lines for the duration of `fn`.
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function recordingTransport(): {
  send: (msg: MailMessage) => Promise<void>;
  sent: MailMessage[];
} {
  const sent: MailMessage[] = [];
  return {
    sent,
    send: async (msg) => {
      sent.push(msg);
    },
  };
}

// ---- shouldNotify: only a clean success notifies (path 2) -----------------

test("shouldNotify is true ONLY for a successful bridge outcome", () => {
  assert.equal(shouldNotify("success"), true);
  assert.equal(shouldNotify("failed"), false);
  assert.equal(shouldNotify("manual_review"), false);
  assert.equal(shouldNotify(""), false);
});

// ---- buildMessage: EXACTLY the four labelled fields -----------------------

test("buildMessage contains exactly Office/Name/DOB/Phone, nothing else", () => {
  const msg = buildMessage({ to: "staff@drsnip.test", from: "no-reply@drsnip.test" }, PHI);
  assert.equal(
    msg.text,
    "Office: Seattle, WA\nName: Jonathan Abernathy-Williamson\nDOB: 1986-03-14\nPhone: (206) 555-0142\n",
  );
  assert.equal(msg.text.trim().split("\n").length, 4);
  // No medical / insurance / id leakage.
  for (const banned of ["medical", "insurance", "card", "patient_id", "submission"]) {
    assert.ok(!msg.text.toLowerCase().includes(banned), `must not include "${banned}"`);
  }
});

// ---- Path 1: enabled + success -> exactly one send ------------------------

test("enabled path sends exactly one email with the four fields", async () => {
  const restore = withEnv({
    PATIENTMAIL_ENABLED: "true",
    PATIENTMAIL_TO: "staff@drsnip.test",
    PATIENTMAIL_FROM: "no-reply@drsnip.test",
  });
  const tx = recordingTransport();
  try {
    const sent = await notifyPatientSubmission(PHI, tx.send);
    assert.equal(sent, true);
    assert.equal(tx.sent.length, 1);
    assert.equal(tx.sent[0].to, "staff@drsnip.test");
    assert.equal(tx.sent[0].from, "no-reply@drsnip.test");
    assert.match(tx.sent[0].text, /^Office: Seattle, WA\nName: /);
  } finally {
    restore();
  }
});

// ---- Path 3: killswitch off -> zero sends ---------------------------------

test("PATIENTMAIL_ENABLED!=true sends zero emails, no error", async () => {
  const restore = withEnv({
    PATIENTMAIL_ENABLED: "false",
    PATIENTMAIL_TO: "staff@drsnip.test",
  });
  const tx = recordingTransport();
  try {
    const sent = await notifyPatientSubmission(PHI, tx.send);
    assert.equal(sent, false);
    assert.equal(tx.sent.length, 0);
  } finally {
    restore();
  }
});

test("enabled but no recipient sends zero emails, no error", async () => {
  const restore = withEnv({ PATIENTMAIL_ENABLED: "true", PATIENTMAIL_TO: undefined });
  const tx = recordingTransport();
  try {
    const sent = await notifyPatientSubmission(PHI, tx.send);
    assert.equal(sent, false);
    assert.equal(tx.sent.length, 0);
  } finally {
    restore();
  }
});

// ---- Best-effort: a throwing transport never throws (edge case) -----------

test("a throwing transport is swallowed (best-effort), returns false", async () => {
  const restore = withEnv({
    PATIENTMAIL_ENABLED: "true",
    PATIENTMAIL_TO: "staff@drsnip.test",
    PATIENTMAIL_FROM: "no-reply@drsnip.test",
  });
  try {
    const sent = await notifyPatientSubmission(PHI, async () => {
      throw new Error("smtp connection refused");
    });
    assert.equal(sent, false); // did not throw, reported failure
  } finally {
    restore();
  }
});

// ---- Path 4: audit log carries a send record with NO PHI values -----------

test("audit log records the send (id + recipient) and leaks NO PHI", async () => {
  const restore = withEnv({
    PATIENTMAIL_ENABLED: "true",
    PATIENTMAIL_TO: "staff@drsnip.test",
    PATIENTMAIL_FROM: "no-reply@drsnip.test",
  });
  const tx = recordingTransport();
  try {
    const lines = await captureLogs(async () => {
      await notifyPatientSubmission(PHI, tx.send);
    });
    const sentLine = lines.find((l) => l.includes("[patientmail] sent"));
    assert.ok(sentLine, "expected a [patientmail] sent audit line");
    assert.ok(sentLine!.includes("sub-123"), "audit must include submission id");
    assert.ok(sentLine!.includes("staff@drsnip.test"), "audit must include recipient");
    // The PHI VALUES must never appear in ANY log line.
    for (const line of lines) {
      for (const phi of PHI_VALUES) {
        assert.ok(!line.includes(phi), `log line leaked PHI value: ${phi}`);
      }
    }
  } finally {
    restore();
  }
});
