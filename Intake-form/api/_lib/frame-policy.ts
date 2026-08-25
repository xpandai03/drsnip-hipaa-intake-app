// Framing policy — which origins may put this app in an iframe.
//
// WHY THIS EXISTS: the intake forms collect PHI and, until now, shipped with no
// X-Frame-Options and no CSP frame-ancestors. Framing worked by omission, which
// means any site on the internet could iframe them — overlay them for
// clickjacking, or present them as its own. The insurance form is deliberately
// embedded on the client's marketing site, so a blanket DENY is wrong; the fix
// is an allowlist that permits exactly that embed and nothing else.
//
// SCOPE: frame-ancestors ONLY. A full Content-Security-Policy (script-src,
// style-src, …) is a separate and much riskier project — the SPA uses inline
// styles and a Google Fonts stylesheet, so a naive policy would break the forms.
// frame-ancestors is purely additive: it cannot break a page that is not framed,
// and it cannot break a frame that is on the allowlist.
//
// Pure + exported so the path→policy mapping is unit-tested without booting the
// server (api-server/index.ts is not importable — it calls serve() on load).

/** Public form routes: embeddable by the client's marketing site only. */
export const FRAME_ANCESTORS_EMBED =
  "frame-ancestors 'self' https://drsnip.com https://www.drsnip.com";

/** Everything else: not framable at all. */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * Paths that must never be framed by anyone:
 *   /api/*     — JSON, including the authed console API and the internal
 *                service-token endpoints. Nothing should frame these, and a
 *                framed JSON response is only ever an attack shape.
 *   /admin/*   — the staff console. Client-side route served by the SPA
 *                fallback, so it reaches this middleware as a document
 *                response. It contains no iframes of its own (verified), so
 *                'none' costs nothing and removes a clickjacking surface from
 *                the one surface that can delete submissions.
 *   /healthz   — infrastructure probe.
 */
export function isNoFramePath(path: string): boolean {
  return (
    path === "/healthz" ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/admin" ||
    path.startsWith("/admin/")
  );
}

/** The Content-Security-Policy value for a given request path. */
export function frameAncestorsFor(path: string): string {
  return isNoFramePath(path) ? FRAME_ANCESTORS_NONE : FRAME_ANCESTORS_EMBED;
}

/**
 * Legacy X-Frame-Options companion, or null when it must be omitted.
 *
 * XFO cannot express a third-party allowlist — it only understands DENY and
 * SAMEORIGIN. On the public form routes, SAMEORIGIN would forbid the very
 * drsnip.com embed we are trying to permit; browsers that honour XFO over CSP
 * would break the live insurance embed. So the form routes get CSP only, and
 * the no-frame paths get DENY, where the two headers agree exactly.
 */
export function xFrameOptionsFor(path: string): string | null {
  return isNoFramePath(path) ? "DENY" : null;
}
