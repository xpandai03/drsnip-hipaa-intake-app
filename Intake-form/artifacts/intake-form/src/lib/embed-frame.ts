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

export function buildHeightMessage(height: number): {
  type: typeof HEIGHT_MESSAGE_TYPE;
  height: number;
} {
  return { type: HEIGHT_MESSAGE_TYPE, height: Math.ceil(height) };
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
  if (!isEmbedded(win)) return;
  const message = buildHeightMessage(height);
  for (const origin of origins) {
    try {
      win!.parent.postMessage(message, origin);
    } catch {
      /* targetOrigin mismatch — browser drops it; expected for non-parents */
    }
  }
}
