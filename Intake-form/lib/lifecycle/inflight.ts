// Train 2 — in-flight work registry + graceful drain.
//
// api/submit.ts responds to the caller and THEN fires the n8n bridge as
// fire-and-forget (submit.ts:192 responds, submit.ts:285 fires). The bridge
// awaits a fetch with a 30 s abort and only then writes the outcome back onto
// the submission row. Nothing held a reference to that promise, so a machine
// lifecycle event between the response and the write-back took the write with
// it: the row keeps n8n_status / n8n_response_at / n8n_response_body all NULL
// and the console renders it as "pending" forever (FINDINGS-submission-health
// §4.1 item 2). One confirmed victim in three months, so this is a correctness
// fix, not a firefight.
//
// `track()` registers the promise; `gracefulShutdown()` stops accepting new
// connections and waits for the registry to empty before exiting. Fly's
// kill_timeout (45 s in fly.toml) must stay above DRAIN_CAP_MS so the drain
// finishes before SIGKILL.
//
// Deliberately NOT changed: when the caller gets its response. `track()` is a
// pass-through — it never awaits, never delays, and never alters the value or
// the rejection of the promise it is handed.

/** Promises that must settle before the process may exit. */
const inflight = new Set<Promise<unknown>>();

/**
 * Register a fire-and-forget promise so shutdown waits for it.
 *
 * Returns the SAME promise, so call sites keep their existing shape:
 *   void track(runN8nBridge(...).catch(...))
 *
 * A rejection handler is attached here purely for bookkeeping; because
 * `.then(done, done)` handles the rejection on the derived promise, tracking
 * can never turn a handled rejection into an unhandled one.
 */
export function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = (): void => {
    inflight.delete(p);
  };
  p.then(done, done);
  return p;
}

/** How many tracked promises have not settled yet. */
export function inflightCount(): number {
  return inflight.size;
}

/** Test seam only — drop every registration without awaiting it. */
export function resetInflightForTests(): void {
  inflight.clear();
}

export interface DrainResult {
  /** Registrations outstanding when the drain began. */
  started: number;
  /** Still outstanding when the drain returned (0 unless it timed out). */
  remaining: number;
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * Wait for every tracked promise to settle, or for `capMs`, whichever comes
 * first. Never throws: a rejected tracked promise still counts as settled.
 */
export async function drain(capMs: number): Promise<DrainResult> {
  const startedAt = Date.now();
  const started = inflight.size;
  if (started === 0) {
    return { started: 0, remaining: 0, timedOut: false, elapsedMs: 0 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), capMs);
    // Never hold the event loop open on our own account.
    if (typeof timer.unref === "function") timer.unref();
  });

  // Snapshot: promises registered after the drain starts are not waited on —
  // the server has already stopped accepting connections by then.
  const settled = Promise.allSettled([...inflight]).then(() => "drained" as const);

  const outcome = await Promise.race([settled, cap]);
  if (timer) clearTimeout(timer);

  return {
    started,
    remaining: inflight.size,
    timedOut: outcome === "timeout",
    elapsedMs: Date.now() - startedAt,
  };
}

export interface ShutdownOptions {
  signal: string;
  /** Stop accepting new connections. May be sync or async; never throws. */
  closeServer: () => void | Promise<void>;
  /** Injected so the routine is testable without killing the test process. */
  exit: (code: number) => void;
  capMs?: number;
  log?: (line: string) => void;
}

/** Upper bound on the drain. Must stay below fly.toml's kill_timeout (45 s):
 *  the bridge's own abort is 30 s, plus the write-back. */
export const DRAIN_CAP_MS = 40_000;

let shuttingDown = false;

/** Test seam only. */
export function resetShutdownForTests(): void {
  shuttingDown = false;
}

/**
 * Drain, then exit. Idempotent — a second signal while a drain is running is
 * ignored rather than cutting the first one short.
 */
export async function gracefulShutdown(opts: ShutdownOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => console.log(line));
  if (shuttingDown) {
    log(`[shutdown] ${opts.signal} ignored — drain already in progress`);
    return;
  }
  shuttingDown = true;

  const outstanding = inflightCount();
  log(
    `[shutdown] ${opts.signal} received; draining ${outstanding} in-flight bridge call(s)`,
  );

  try {
    await opts.closeServer();
  } catch {
    // A close failure must not strand the drain.
    log("[shutdown] server close failed; draining anyway");
  }

  const result = await drain(opts.capMs ?? DRAIN_CAP_MS);
  log(
    "[shutdown] drain complete " +
      JSON.stringify({
        started: result.started,
        remaining: result.remaining,
        timed_out: result.timedOut,
        elapsed_ms: result.elapsedMs,
      }),
  );
  opts.exit(result.timedOut ? 1 : 0);
}
