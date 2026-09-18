// ===========================================================================
// DEMO DATA — INVENTED. Static, illustrative, self-contained.
//
// Nothing in this file comes from the DrSnip database, DrChrono, n8n, Google
// Sheets or any other live source, and nothing on the demo pages reads
// anything but this module. There is no fetch, no query client, no
// @workspace/db import here or in the pages that consume it — asserted by
// api/_test/demo-isolation.test.ts, which reads the source of both.
//
// No patient was contacted and no worker is running. Identifiers are
// "Demo inquiry NN" and there are no real names, emails or phone numbers. The
// clinic locations are real because they are the clinic's own; every person,
// date, event and number below is fabricated.
//
// WHAT IT ILLUSTRATES: the proposed insurance-inquiry follow-up workflow —
// inquiry -> insurance verified -> estimate sent -> patient responded ->
// booked -> attended. That is a PROPOSED workflow, not a claim that every
// patient moves through every stage in that order. Stages branch (a patient
// can ring the clinic instead of replying) and can be skipped; the pages say so.
//
// SCALE IS AN ASSUMPTION. 75 inquiries over an 8-week window is chosen because
// it is the order of magnitude of insurance submissions actually seen in the
// console. It is NOT a verified count of unique patients, and the pages label
// it as illustrative.
//
// EVERY DISPLAYED FIGURE IS DERIVED FROM `RECORDS` BY THE FUNCTIONS BELOW.
// No stage count, conversion or scoreboard number is written down by hand, so
// the views cannot drift from the records they claim to summarise.
// ===========================================================================

export const DEMO_BANNER =
  "Demo data — illustrative workflow. No patient messages are sent.";

/** The proposed journey, in order. */
export const STAGE_ORDER = [
  "inquiry",
  "verified",
  "estimate",
  "responded",
  "booked",
  "attended",
] as const;
export type DemoStageId = (typeof STAGE_ORDER)[number];

export const STAGE_LABEL: Record<DemoStageId, string> = {
  inquiry: "Inquiry submitted",
  verified: "Insurance verified",
  estimate: "Estimate sent",
  responded: "Patient responded",
  booked: "Booked",
  attended: "Attended",
};

/** What each stage would be read from, in a real pilot. */
export const STAGE_SOURCE: Record<DemoStageId, string> = {
  inquiry: "Live today: submissions where form_type = 'insurance'.",
  verified:
    "Needs connecting: the clinic records verification outside the console.",
  estimate:
    "Needs connecting: estimates are sent from n8n's mail node, which writes no event back.",
  responded: "Needs connecting: there is no inbound channel today.",
  booked: "Needs connecting: no booking system is integrated.",
  attended: "Needs connecting: attendance is not recorded in the console.",
};

/** Cohort window and observation cutoff — stated on screen, never implied. */
export const COHORT = {
  /** Day 0 of the cohort. Inquiries arrive continuously up to the cutoff. */
  firstEntryDay: "2026-07-25",
  lastEntryDay: "2026-09-18",
  entryWindowDays: 56,
  /**
   * Everything is observed as at this date, and NOTHING in the fixture happens
   * after it — a demo that showed an event past its own observation cutoff
   * would be claiming to know the future.
   */
  observedThrough: "2026-09-18",
  /** The follow-up window the conversion is defined over. */
  followUpWindowDays: 90,
  /**
   * Days of observation a record needs before its outcome is treated as
   * settled. Entrants younger than this are still in play, so the whole-cohort
   * conversion is an observed-to-date figure, not a final one.
   */
  maturityDays: 30,
};

export const DEMO_LOCATIONS = ["Seattle, WA", "Portland, OR", "Plano, TX"];

export type DemoEvent = { stage: DemoStageId; day: number };

export type DemoRecord = {
  /** Fictional, obviously so. */
  id: string;
  location: string;
  /** Day index from COHORT.firstEntryDay. */
  entryDay: number;
  /** Furthest stage this record reached. */
  reached: DemoStageId;
  /** Chronological event log. Day indices from COHORT.firstEntryDay. */
  events: DemoEvent[];
};

const MS = 86_400_000;

// Declared here, above buildRecords, because the record builder needs the
// cutoff to keep every event inside the observation window.
const OBSERVED_DAY_RAW = Math.round(
  (new Date(`${COHORT.observedThrough}T12:00:00Z`).getTime() -
    new Date(`${COHORT.firstEntryDay}T12:00:00Z`).getTime()) /
    MS,
);

// --- deterministic jitter --------------------------------------------------
// A tiny LCG so the fixture is byte-stable: the same numbers every render, so
// a screenshot, a test and the meeting all agree. Never Math.random().
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/**
 * How far each record got. The shape of the funnel lives here, and the counts
 * are then COUNTED off it rather than declared.
 *
 *   attended                       17
 *   booked, not yet attended        5   -> booked      22
 *   responded, not booked          12   -> responded   34
 *   estimate sent, no response     27   -> estimate    61
 *   verified, no estimate yet       7   -> verified    68
 *   inquiry only                    7   -> inquiry     75
 */
const REACHED_PLAN: Array<{ stage: DemoStageId; n: number }> = [
  { stage: "attended", n: 17 },
  { stage: "booked", n: 5 },
  { stage: "responded", n: 12 },
  { stage: "estimate", n: 27 },
  { stage: "verified", n: 7 },
  { stage: "inquiry", n: 7 },
];

/**
 * How long a journey to `stage` takes, given four jitter draws. Returned as the
 * per-hop offsets so the caller can lay the events out from a chosen entry day.
 */
function hops(stage: DemoStageId, rand: () => number): number[] {
  const idx = STAGE_ORDER.indexOf(stage);
  const out: number[] = [];
  if (idx >= 1) out.push(1 + Math.floor(rand() * 2)); // verified:  1-2 d
  if (idx >= 2) out.push(1 + Math.floor(rand() * 3)); // estimate:  1-3 d
  if (idx >= 3) out.push(2 + Math.floor(rand() * 6)); // responded: 2-7 d
  if (idx >= 4) out.push(1 + Math.floor(rand() * 3)); // booked:    1-3 d
  if (idx >= 5) out.push(7 + Math.floor(rand() * 8)); // attended:  7-14 d
  return out;
}

function buildRecords(): DemoRecord[] {
  const rand = lcg(20260918);
  const out: DemoRecord[] = [];
  let i = 0;

  for (const { stage, n } of REACHED_PLAN) {
    const idx = STAGE_ORDER.indexOf(stage);
    for (let k = 0; k < n; k += 1) {
      const steps = hops(stage, rand);
      const journey = steps.reduce((a, b) => a + b, 0);

      // An entry day that leaves room for the whole journey inside the
      // observation window. This is what keeps every event at or before
      // OBSERVED_DAY without truncating anything.
      const latestEntry = Math.max(0, OBSERVED_DAY_RAW - journey);
      const draw = rand();
      // Records that have not progressed far are mostly RECENT arrivals — a
      // pipeline fills from the near end. Records that reached the later stages
      // must have entered earlier. Biasing this way is what puts believable
      // activity in the most recent week instead of leaving it empty.
      const biased = idx <= 1 ? 1 - draw * draw : draw * (0.85 + 0.15 * draw);
      const entryDay = Math.min(latestEntry, Math.round(biased * latestEntry));

      const events: DemoEvent[] = [{ stage: "inquiry", day: entryDay }];
      let day = entryDay;
      for (let sIdx = 0; sIdx < steps.length; sIdx += 1) {
        day += steps[sIdx];
        events.push({ stage: STAGE_ORDER[sIdx + 1], day });
      }

      i += 1;
      out.push({
        id: `Demo inquiry ${String(i).padStart(2, "0")}`,
        location: DEMO_LOCATIONS[i % DEMO_LOCATIONS.length],
        entryDay,
        reached: stage,
        events,
      });
    }
  }
  return out.sort((a, b) => a.entryDay - b.entryDay || a.id.localeCompare(b.id));
}

export const RECORDS: DemoRecord[] = buildRecords();

// --- derived figures -------------------------------------------------------

/** Index of a stage in the proposed order. */
function stageIndex(s: DemoStageId): number {
  return STAGE_ORDER.indexOf(s);
}

/** How many records reached at least `stage`. Counted off RECORDS. */
export function stageCount(stage: DemoStageId, records: DemoRecord[] = RECORDS): number {
  const want = stageIndex(stage);
  return records.filter((r) => stageIndex(r.reached) >= want).length;
}

/** Every stage's count, in order. */
export function stageCounts(records: DemoRecord[] = RECORDS): Array<{
  stage: DemoStageId;
  count: number;
}> {
  return STAGE_ORDER.map((stage) => ({ stage, count: stageCount(stage, records) }));
}

/**
 * Stage-to-stage conversion as a one-decimal percentage string, or null.
 *
 * NULL whenever the denominator is zero — "0% of nothing" is not a rate. A real
 * zero numerator over a real denominator is "0.0%". The views never divide;
 * they read this.
 */
export function conversionFromPrev(
  stage: DemoStageId,
  records: DemoRecord[] = RECORDS,
): string | null {
  const i = stageIndex(stage);
  if (i <= 0) return null;
  const prev = stageCount(STAGE_ORDER[i - 1], records);
  if (prev === 0) return null;
  const cur = stageCount(stage, records);
  return `${(Math.round((cur / prev) * 1000) / 10).toFixed(1)}%`;
}

/**
 * The sub-cohort old enough for its outcome to be treated as settled: entrants
 * with at least COHORT.maturityDays of observation behind them.
 *
 * Reported BESIDE the whole-cohort figure, never instead of it. The
 * whole-cohort number includes people who inquired last week and have barely
 * had a chance to book, which drags it down; showing only the matured figure
 * would flatter it. Both, labelled, is the honest pair.
 */
export function maturedRecords(records: DemoRecord[] = RECORDS): DemoRecord[] {
  return records.filter((r) => OBSERVED_DAY - r.entryDay >= COHORT.maturityDays);
}

/** Entrants too recent to have a settled outcome yet. */
export function maturingRecords(records: DemoRecord[] = RECORDS): DemoRecord[] {
  return records.filter((r) => OBSERVED_DAY - r.entryDay < COHORT.maturityDays);
}

/** Inquiry -> booked for the whole cohort. Null on a zero denominator. */
export function inquiryToBooked(records: DemoRecord[] = RECORDS): number | null {
  const base = stageCount("inquiry", records);
  if (base === 0) return null;
  return Math.round((stageCount("booked", records) / base) * 1000) / 10;
}

/** The day a record reached a stage, or null if it never did. */
export function dayOf(r: DemoRecord, stage: DemoStageId): number | null {
  const e = r.events.find((x) => x.stage === stage);
  return e ? e.day : null;
}

/**
 * Mean days from inquiry to estimate, over ONLY the records that actually got
 * an estimate. Averaging across records with no estimate would be averaging
 * over a denominator that does not apply.
 */
export function meanDaysToEstimate(records: DemoRecord[] = RECORDS): {
  mean: number | null;
  n: number;
} {
  const spans: number[] = [];
  for (const r of records) {
    const a = dayOf(r, "inquiry");
    const b = dayOf(r, "estimate");
    if (a !== null && b !== null) spans.push(b - a);
  }
  if (spans.length === 0) return { mean: null, n: 0 };
  const mean = spans.reduce((x, y) => x + y, 0) / spans.length;
  return { mean: Math.round(mean * 10) / 10, n: spans.length };
}

/** Records still sitting at `stage`, oldest first. */
export function stalledAt(
  stage: DemoStageId,
  records: DemoRecord[] = RECORDS,
): DemoRecord[] {
  return records
    .filter((r) => r.reached === stage)
    .sort((a, b) => a.entryDay - b.entryDay);
}

// --- calendar helpers (fixture-local, no live clock) -----------------------

/** Absolute date for a day index, as YYYY-MM-DD. */
export function dayToDate(day: number): string {
  const base = new Date(`${COHORT.firstEntryDay}T12:00:00Z`);
  return new Date(base.getTime() + day * MS).toISOString().slice(0, 10);
}

/** Day index of the observation cutoff. */
export const OBSERVED_DAY = OBSERVED_DAY_RAW;

/** Days a record has been sitting at its furthest stage, as at the cutoff. */
export function daysStalled(r: DemoRecord): number {
  const last = r.events[r.events.length - 1];
  return Math.max(0, OBSERVED_DAY - last.day);
}

// --- the weekly scoreboard -------------------------------------------------

/** The scoreboard week: the last 7 observed days, inclusive. */
export const WEEK = { fromDay: OBSERVED_DAY - 6, toDay: OBSERVED_DAY };

/**
 * ACTIVITY counts: events that happened inside the week.
 *
 * These are NOT a funnel and must never be divided into each other — the
 * bookings in a week mostly belong to inquiries from earlier weeks. The
 * scoreboard says so beside them.
 */
export function weeklyActivity(records: DemoRecord[] = RECORDS): Record<DemoStageId, number> {
  const out = Object.fromEntries(STAGE_ORDER.map((s) => [s, 0])) as Record<
    DemoStageId,
    number
  >;
  for (const r of records) {
    for (const e of r.events) {
      if (e.day >= WEEK.fromDay && e.day <= WEEK.toDay) out[e.stage] += 1;
    }
  }
  return out;
}

/** Follow-up actions the demo shows as having happened this week. */
export const WEEKLY_FOLLOW_UPS = {
  suggested: 9,
  approvedByStaff: 6,
  skippedByStaff: 2,
  awaitingReview: 1,
  escalatedToStaff: 1,
};

/**
 * Jeff's recalled 30-40% insurance conversion. ILLUSTRATIVE ONLY: it is a
 * remembered figure about a different question (how many insurance enquirers
 * become patients, by some undefined definition), not a measured booking rate
 * from this console. It is shown as a band, labelled, and never used as a
 * denominator or a target the demo claims to have beaten.
 */
export const ILLUSTRATIVE_BASELINE = { lowPct: 30, highPct: 40 };

// --- the follow-up queue ---------------------------------------------------

export type QueueStatus =
  | "awaiting_response"
  | "call_requested"
  | "draft_awaiting_review"
  | "human_review_required"
  | "verification_pending"
  | "booked";

export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  awaiting_response: "Estimate sent; awaiting response",
  call_requested: "Patient requested a call",
  draft_awaiting_review: "Draft awaiting staff review",
  human_review_required: "Human review required",
  // This one is waiting on the CLINIC, not the patient. It must not be
  // labelled "estimate sent" when no estimate exists — the status has to
  // match the record's own evidence.
  verification_pending: "Waiting on insurance verification",
  booked: "Booked",
};

export type QueueItem = {
  recordId: string;
  location: string;
  status: QueueStatus;
  daysStalled: number;
  /** Why a follow-up is suggested, in plain words. */
  reason: string;
  /**
   * A neutral administrative draft. Deliberately contains no clinical advice,
   * no coverage promise, no price, and no discount — the demo shows the shape
   * of an admin nudge, nothing a clinic would not send itself.
   */
  draft: string | null;
  /** Shown for the items that must not be automated at all. */
  handoff?: string;
  events: Array<{ label: string; day: number; live: boolean }>;
  /** Action log entries the demo starts with. */
  history: Array<{ day: number; text: string }>;
};

function evt(stage: DemoStageId, day: number) {
  const live = stage === "inquiry";
  return { label: STAGE_LABEL[stage], day, live };
}

/**
 * Six queue items, hand-written so each one shows a distinct situation. Their
 * ids point at real fixture records so the queue and the waterfall are talking
 * about the same cohort.
 */
export function buildQueue(records: DemoRecord[] = RECORDS): QueueItem[] {
  const awaiting = stalledAt("estimate", records);
  const responded = stalledAt("responded", records);
  const verified = stalledAt("verified", records);
  const booked = stalledAt("booked", records);
  const inquiryOnly = stalledAt("inquiry", records);

  // Pick the record whose stall age is CLOSEST to a target, so the queue shows
  // believable recent neglect rather than whichever record happens to be
  // oldest. `used` stops two rows being the same record.
  const used = new Set<string>();
  const pickByStall = (list: DemoRecord[], targetDays: number): DemoRecord => {
    const pool = list.filter((r) => !used.has(r.id));
    const from = pool.length > 0 ? pool : list;
    let best = from[0];
    let bestGap = Number.POSITIVE_INFINITY;
    for (const r of from) {
      const gap = Math.abs(daysStalled(r) - targetDays);
      if (gap < bestGap) {
        best = r;
        bestGap = gap;
      }
    }
    used.add(best.id);
    return best;
  };

  const a = pickByStall(awaiting, 11);
  const b = pickByStall(responded, 4);
  const c = pickByStall(awaiting, 18);
  const d = pickByStall(verified, 6);
  const e = pickByStall(booked, 3);
  const f = pickByStall(inquiryOnly, 9);

  return [
    {
      recordId: a.id,
      location: a.location,
      status: "awaiting_response",
      daysStalled: daysStalled(a),
      reason:
        "An estimate went out and nothing has come back. No follow-up has been sent.",
      draft:
        "Hello — we sent you a cost estimate for your procedure a little while " +
        "ago and wanted to check it reached you. If you have any questions about " +
        "it, or you would like to go ahead and find an appointment time, just " +
        "reply to this message and we will help.",
      events: [
        evt("inquiry", a.entryDay),
        evt("verified", dayOf(a, "verified") ?? a.entryDay + 1),
        evt("estimate", dayOf(a, "estimate") ?? a.entryDay + 3),
      ],
      history: [
        { day: OBSERVED_DAY, text: "Follow-up suggested · awaiting approval" },
        { day: OBSERVED_DAY, text: "Draft prepared · not sent" },
      ],
    },
    {
      recordId: b.id,
      location: b.location,
      status: "call_requested",
      daysStalled: daysStalled(b),
      reason:
        "The patient replied asking to be phoned. A call is a staff action, so no " +
        "message is drafted.",
      draft: null,
      handoff: "Assign to the front desk to call back.",
      events: [
        evt("inquiry", b.entryDay),
        evt("verified", dayOf(b, "verified") ?? b.entryDay + 1),
        evt("estimate", dayOf(b, "estimate") ?? b.entryDay + 3),
        evt("responded", dayOf(b, "responded") ?? b.entryDay + 7),
      ],
      history: [{ day: OBSERVED_DAY - 1, text: "Routed to staff · call requested" }],
    },
    {
      recordId: c.id,
      location: c.location,
      status: "draft_awaiting_review",
      daysStalled: daysStalled(c),
      reason: "A second reminder is due. The draft is waiting for a staff decision.",
      draft:
        "Hello — following up once more on the estimate we sent. If the timing " +
        "is not right we will leave you be; if you would like to book, reply and " +
        "we will send some available times.",
      events: [
        evt("inquiry", c.entryDay),
        evt("verified", dayOf(c, "verified") ?? c.entryDay + 1),
        evt("estimate", dayOf(c, "estimate") ?? c.entryDay + 3),
      ],
      history: [
        { day: OBSERVED_DAY - 7, text: "First follow-up approved by staff · sent" },
        { day: OBSERVED_DAY, text: "Second follow-up suggested · awaiting approval" },
      ],
    },
    {
      recordId: d.id,
      location: d.location,
      status: "human_review_required",
      daysStalled: daysStalled(d),
      reason:
        "The patient asked a question about the procedure itself. Clinical " +
        "questions stop here — nothing is drafted and nothing is sent.",
      draft: null,
      handoff: "Escalated to clinical staff. No automated reply.",
      events: [
        evt("inquiry", d.entryDay),
        evt("verified", dayOf(d, "verified") ?? d.entryDay + 1),
      ],
      history: [
        { day: OBSERVED_DAY - 2, text: "Stopped · clinical question detected" },
        { day: OBSERVED_DAY - 2, text: "Escalated to clinical staff" },
      ],
    },
    {
      recordId: f.id,
      location: f.location,
      status: "verification_pending",
      daysStalled: daysStalled(f),
      reason:
        "The inquiry arrived but insurance has not been verified, so no estimate " +
        "can be prepared yet. This one is waiting on the clinic, not the patient.",
      draft: null,
      handoff: "Waiting on insurance verification by staff.",
      events: [evt("inquiry", f.entryDay)],
      history: [{ day: OBSERVED_DAY, text: "Flagged · verification overdue" }],
    },
    {
      recordId: e.id,
      location: e.location,
      status: "booked",
      daysStalled: 0,
      reason:
        "Resolved. Shown so the queue is not only exceptions — this one booked " +
        "after one follow-up.",
      draft: null,
      events: [
        evt("inquiry", e.entryDay),
        evt("verified", dayOf(e, "verified") ?? e.entryDay + 1),
        evt("estimate", dayOf(e, "estimate") ?? e.entryDay + 3),
        evt("responded", dayOf(e, "responded") ?? e.entryDay + 8),
        evt("booked", dayOf(e, "booked") ?? e.entryDay + 10),
      ],
      history: [
        { day: OBSERVED_DAY - 12, text: "Follow-up approved by staff · sent" },
        { day: OBSERVED_DAY - 9, text: "Patient replied · asked for times" },
        { day: OBSERVED_DAY - 8, text: "Booked by front desk" },
      ],
    },
  ];
}

export const QUEUE: QueueItem[] = buildQueue();
