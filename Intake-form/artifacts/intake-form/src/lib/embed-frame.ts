// Embed-frame protocol shared by every form that renders inside an <iframe>
// on the marketing site. Extracted verbatim from the insurance form (the
// reference implementation) so registration reuses the SAME detection and the
// SAME height contract instead of a parallel copy.
//
//   Detection: the form is embedded when window.parent !== window. There is no
//              ?embed param and no referrer check.
//   Contract:  { type: "drsnip:height", height: <integer px> }, posted to each
//              allowlisted parent origin (never '*'). The browser silently
//              drops messages whose targetOrigin doesn't match the real parent,
//              so looping the allowlist is safe and origin-locked. The parent
//              snippet checks e.origin === "https://intake.drsnip.com" before
//              applying (lib/embed.ts iframeSnippet).
//
// Framework-free so it is unit-tested directly (api/_test/embed-frame.test.ts).

export const HEIGHT_MESSAGE_TYPE = "drsnip:height";
/**
 * Registration only: after a step change the frame asks the parent to bring
 * `top` (px from the top of the frame) into view. The frame also calls
 * scrollIntoView itself, which crosses the frame boundary in Chromium and
 * Firefox; WebKit (Safari) does not let a cross-origin frame scroll its parent,
 * so the parent snippet handles this message — and does nothing when the
 * target is already visible, so the two never fight.
 */
export const SCROLL_MESSAGE_TYPE = "drsnip:scroll";

/**
 * Registration only — the handshake. Registration stays in its standalone
 * layout (pinned bar, no height/scroll messages: exactly v93) until the parent
 * page proves it applies the form's height by sending { type: "drsnip:ready" }
 * into the frame (the §3a snippet does, on every frame load). A parent with a
 * fixed-height frame and no listener never sends it, so it keeps the pinned
 * bar instead of an inline bar hidden below the frame.
 */
export const READY_MESSAGE_TYPE = "drsnip:ready";

/** Production parent origins — the only pages allowed to receive messages. */
export const PARENT_ORIGINS = ["https://drsnip.com", "https://www.drsnip.com"];

/**
 * Parent origins for the running build. Local preview origins are added only
 * in a Vite dev build; read lazily (inside a function) so this module imports
 * cleanly under node:test, where import.meta.env is undefined.
 */
export function embedParentOrigins(): string[] {
  return [
    ...PARENT_ORIGINS,
    ...(import.meta.env.DEV
      ? ["http://localhost:5173", "http://localhost:4173"]
      : []),
  ];
}

type FrameWindow = {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
};

/** True when running inside an iframe. */
export function isEmbedded(win: FrameWindow | undefined = globalThis.window): boolean {
  return typeof win !== "undefined" && win.parent !== (win as unknown);
}

type ReadyEvent = { origin: string; source: unknown; data: unknown };

/** A ready message counts only from an allowed origin AND our real parent. */
export function isReadyMessage(
  e: ReadyEvent,
  origins: string[],
  win: { parent: unknown },
): boolean {
  const d = e.data as { type?: unknown } | null;
  return (
    origins.includes(e.origin) &&
    e.source === win.parent &&
    !!d &&
    typeof d === "object" &&
    d.type === READY_MESSAGE_TYPE
  );
}

let parentReady = false;
const readySubscribers = new Set<() => void>();

/** True once the parent has sent a valid ready message (sticky). */
export function isParentReady(): boolean {
  return parentReady;
}

/** Calls `cb` once the parent is ready (immediately if it already is). */
export function onParentReady(cb: () => void): () => void {
  if (parentReady) {
    cb();
    return () => {};
  }
  readySubscribers.add(cb);
  return () => {
    readySubscribers.delete(cb);
  };
}

// Listen from the moment this module loads (before React mounts), so a ready
// message sent on the frame's load event is never missed. Browser + iframe only;
// under node:test there is no window and nothing is registered.
if (typeof window !== "undefined" && window.parent !== window) {
  window.addEventListener("message", (e) => {
    if (parentReady || !isReadyMessage(e, embedParentOrigins(), window)) return;
    parentReady = true;
    for (const cb of [...readySubscribers]) cb();
    readySubscribers.clear();
  });
}

export function buildHeightMessage(height: number): {
  type: typeof HEIGHT_MESSAGE_TYPE;
  height: number;
} {
  return { type: HEIGHT_MESSAGE_TYPE, height: Math.ceil(height) };
}

export function buildScrollMessage(top: number): {
  type: typeof SCROLL_MESSAGE_TYPE;
  top: number;
} {
  return { type: SCROLL_MESSAGE_TYPE, top: Math.max(0, Math.round(top)) };
}

function post(
  message: unknown,
  origins: string[],
  win: FrameWindow | undefined,
): void {
  if (!isEmbedded(win)) return;
  for (const origin of origins) {
    try {
      win!.parent.postMessage(message, origin);
    } catch {
      /* targetOrigin mismatch — browser drops it; expected for non-parents */
    }
  }
}

/** Ask the parent to scroll `top` px (from the frame's top) into view. */
export function postEmbedScroll(
  top: number,
  origins: string[] = embedParentOrigins(),
  win: FrameWindow | undefined = globalThis.window,
): void {
  post(buildScrollMessage(top), origins, win);
}

/**
 * Post the content height to the parent. No-op when not embedded. `height` is
 * the root element's rendered height (falls back to the body's scrollHeight).
 */
export function postEmbedHeight(
  height: number,
  origins: string[] = embedParentOrigins(),
  win: FrameWindow | undefined = globalThis.window,
): void {
  post(buildHeightMessage(height), origins, win);
}
