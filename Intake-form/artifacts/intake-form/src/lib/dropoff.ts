// Registration drop-off capture (Train 2). A per-session partial id + a
// fire-and-forget beacon. NEVER blocks or delays the wizard, silent on failure —
// losing a drop-off record is acceptable; degrading the form is not.
//
// PRIVACY: this only ever sends the contact/progress/attribution whitelist. It
// must never be given a step answer; the server also strips anything extra.

import type { Attribution } from "./attribution";

const KEY = "drsnip_reg_partial_id";

/** A drop-off is captured ONLY once the visitor advances PAST the contact step —
 *  the earliest point at which name + email + phone all exist. Before that,
 *  nothing usable exists and nothing is sent. */
export function shouldCaptureAtStep(
  nextIndex: number,
  contactStepIndex: number,
): boolean {
  return nextIndex > contactStepIndex;
}

/** Read or create the per-session partial id (sessionStorage). "" if unavailable. */
export function getPartialId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.sessionStorage.getItem(KEY);
    if (!id) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      window.sessionStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

export type PartialBeacon = {
  partialId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  officeLocation?: string;
  furthestStep?: number;
  furthestStepLabel?: string;
  attribution?: Attribution;
};

/** Fire-and-forget the partial upsert. keepalive so it survives a tab close. */
export function sendPartialBeacon(payload: PartialBeacon): void {
  if (typeof window === "undefined" || !payload.partialId) return;
  try {
    void fetch("/api/registration-partial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {
      /* silent — never affects the wizard */
    });
  } catch {
    /* silent */
  }
}
