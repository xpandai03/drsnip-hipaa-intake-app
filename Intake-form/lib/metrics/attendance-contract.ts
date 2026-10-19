// The attendance review contract — classifications, label identity, and the
// validation that keeps an unapproved opinion out of a published number.
//
// PURE. No DB, no IO, so it is unit-testable in isolation. The calculation
// itself lives in SQL (migration 0020) because suppression has to happen inside
// the database boundary, not in a browser.
//
// WHAT CHANGED FROM THE SPECIFICATION, AND WHY
//
// The spec proposed four classes plus a `remote_presence` ATTRIBUTE, and then
// said in one place that the attribute may never contribute to physical arrival
// and in another that a label could be `arrival_confirmed` + `remote_presence`.
// Those are different contracts and a reviewer cannot be asked to hold both.
//
// Resolved: remote presence is a CLASS, not an attribute. A label is physically
// present, or remote, or neither — never two of them. The contradiction is now
// unrepresentable rather than merely forbidden, which is the only kind of rule
// that survives contact with a later edit.
//
// `procedure_signal` stays an attribute, because it genuinely is orthogonal:
// a label can say something about the procedure whatever it says about arrival,
// and it never touches an attendance figure either way.

/** Exactly one per label. */
export const CLASSIFICATIONS = [
  "physically_present",
  "remote_presence",
  "no_arrival_information",
  "explicit_absence",
  "undecided",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

/** Which of the two inventories a label was seen in. They are not the same. */
export const SOURCE_COLUMNS = ["current_status", "transition"] as const;
export type SourceColumn = (typeof SOURCE_COLUMNS)[number];

export type LabelDecision = {
  source_column: SourceColumn;
  /** Exactly as the source sent it. `null` is a real, distinct value. */
  raw_label: string | null;
  classification: Classification;
  /** Says something about whether the procedure happened. Never about arrival. */
  procedure_signal: boolean;
};

/** What each choice means, in the words a reviewer reads. No jargon. */
export const CLASSIFICATION_COPY: Record<Classification, { label: string; help: string }> = {
  physically_present: {
    label: "Patient was physically here",
    help: "This status can only be set once the patient is in the building.",
  },
  remote_presence: {
    label: "Patient was present, but not in person",
    help:
      "Online or phone contact. Counted separately — it never counts towards being " +
      "physically in the clinic.",
  },
  no_arrival_information: {
    label: "Tells us nothing either way",
    help:
      "This status says nothing about whether the patient came in. It is NOT the same " +
      "as saying they did not come.",
  },
  explicit_absence: {
    label: "Patient did not come",
    help:
      "A deliberate record that the patient did not attend. We store your answer but we " +
      "are not publishing a “did not attend” figure yet.",
  },
  undecided: {
    label: "Not decided yet",
    help: "We will not count this status as anything until someone decides what it means.",
  },
};

/**
 * Only these two can establish anything. Everything else is inert by design —
 * including `explicit_absence`, which is recorded but deliberately does not
 * drive any published figure yet (see the implementation notes).
 */
export function establishesEvidence(c: Classification): boolean {
  return c === "physically_present" || c === "remote_presence";
}

// ---------------------------------------------------------------------------
// Label identity
// ---------------------------------------------------------------------------

/**
 * Durable, NULL-safe identity for a label.
 *
 * NULL and "" are DIFFERENT statuses. A plain UNIQUE index cannot express that
 * — SQL treats NULLs as distinct from each other — so identity is this key, and
 * it is generated the same way here and in the database (migration 0020).
 *
 * The `v:` prefix is what stops a clinic status literally spelled like the
 * sentinel from colliding with it.
 */
export function labelKey(raw: string | null): string {
  return raw === null ? "\u0001null" : `v:${raw}`;
}

/**
 * Lower-cased, trimmed, internal whitespace collapsed.
 *
 * FOR GROUPING ONLY. Two labels that differ by a space may be two different
 * front-desk habits; they are shown together so a human can notice, and
 * classified separately. Nothing merges them automatically.
 */
export function normalizedKey(raw: string | null): string {
  return raw === null ? "\u0001null" : raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** How a label reads on screen. Blank and absent are different sentences. */
export function displayLabel(raw: string | null): string {
  if (raw === null) return "(no status set)";
  if (raw === "") return "(empty status)";
  return raw;
}

export function isValidClassification(v: unknown): v is Classification {
  return typeof v === "string" && (CLASSIFICATIONS as readonly string[]).includes(v);
}
export function isValidSourceColumn(v: unknown): v is SourceColumn {
  return typeof v === "string" && (SOURCE_COLUMNS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; labels: LabelDecision[] }
  | { ok: false; error: string };

/**
 * Validate a submitted label set.
 *
 * Rejects rather than repairs. A draft that cannot be represented exactly is a
 * draft whose author believed something different from what would be stored.
 */
export function validateLabelSet(input: unknown): ValidationResult {
  if (!Array.isArray(input)) return { ok: false, error: "labels must be an array" };
  if (input.length > 500) return { ok: false, error: "too many labels" };

  const seen = new Set<string>();
  const labels: LabelDecision[] = [];

  for (const row of input) {
    if (row === null || typeof row !== "object") {
      return { ok: false, error: "each label must be an object" };
    }
    const r = row as Record<string, unknown>;
    if (!isValidSourceColumn(r.source_column)) {
      return { ok: false, error: `unknown source_column: ${String(r.source_column)}` };
    }
    if (!(r.raw_label === null || typeof r.raw_label === "string")) {
      return { ok: false, error: "raw_label must be a string or null" };
    }
    if (!isValidClassification(r.classification)) {
      return { ok: false, error: `unknown classification: ${String(r.classification)}` };
    }
    if (typeof r.procedure_signal !== "boolean") {
      return { ok: false, error: "procedure_signal must be a boolean" };
    }
    // Belt and braces against a future edit reintroducing the contradiction the
    // spec had. With remote as a class this is unreachable — which is the point.
    if ((r as { remote_presence?: unknown }).remote_presence !== undefined) {
      return {
        ok: false,
        error:
          "remote_presence is a classification, not a flag: a label is physically present " +
          "or remote, never both",
      };
    }
    const key = `${r.source_column}|${labelKey(r.raw_label as string | null)}`;
    if (seen.has(key)) return { ok: false, error: "duplicate label in submission" };
    seen.add(key);

    labels.push({
      source_column: r.source_column,
      raw_label: r.raw_label as string | null,
      classification: r.classification,
      procedure_signal: r.procedure_signal,
    });
  }
  return { ok: true, labels };
}

/** Only decided labels are stored on an approval; undecided is the absence of a decision. */
export function decidedLabels(labels: LabelDecision[]): LabelDecision[] {
  return labels.filter((l) => l.classification !== "undecided");
}

/** Counters for the audit trail and the UI. Never label text, never counts of people. */
export function summariseLabels(labels: LabelDecision[]): Record<Classification, number> {
  const out = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0])) as Record<Classification, number>;
  for (const l of labels) out[l.classification] += 1;
  return out;
}

// ---------------------------------------------------------------------------
// Approval provenance
// ---------------------------------------------------------------------------

export const CONFIRMED_VIA = ["call", "video_call", "email", "in_person", "written"] as const;
export type ConfirmedVia = (typeof CONFIRMED_VIA)[number];

export type Provenance = {
  confirmed_by_name: string;
  confirmed_by_role: string;
  confirmed_via: ConfirmedVia;
  confirmed_on: string;
  confirmed_scope: string;
};

/**
 * Provenance is required, in full, or the approval is refused.
 *
 * The person who presses the button and the person whose decision it is are
 * different people, and the record has to say which is which. The previous
 * contract allowed `provenance: null`; that is the hole this closes.
 */
export function validateProvenance(input: unknown): { ok: true; value: Provenance } | { ok: false; error: string } {
  if (input === null || typeof input !== "object") return { ok: false, error: "provenance is required" };
  const r = input as Record<string, unknown>;
  const str = (k: string): string | null => {
    const v = r[k];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const name = str("confirmed_by_name");
  const role = str("confirmed_by_role");
  const scope = str("confirmed_scope");
  const on = str("confirmed_on");
  const via = r.confirmed_via;

  if (!name) return { ok: false, error: "who confirmed this is required" };
  if (!role) return { ok: false, error: "their role is required" };
  if (!scope) return { ok: false, error: "the scope they confirmed is required" };
  if (typeof via !== "string" || !(CONFIRMED_VIA as readonly string[]).includes(via)) {
    return { ok: false, error: "how it was confirmed is required" };
  }
  if (!on || !/^\d{4}-\d{2}-\d{2}$/.test(on)) {
    return { ok: false, error: "the date it was confirmed is required (YYYY-MM-DD)" };
  }
  // A confirmation cannot be in the future; that would be a typo or a fiction.
  const today = new Date().toISOString().slice(0, 10);
  if (on > today) return { ok: false, error: "the confirmation date cannot be in the future" };

  return {
    ok: true,
    value: {
      confirmed_by_name: name,
      confirmed_by_role: role,
      confirmed_via: via as ConfirmedVia,
      confirmed_on: on,
      confirmed_scope: scope,
    },
  };
}

/** The exact sentence shown wherever attendance would appear while unapproved. */
export const ATTENDANCE_REVIEW_PROMPT =
  "Appointment history is available. Confirm which clinic statuses establish physical " +
  "arrival before publishing attendance.";
