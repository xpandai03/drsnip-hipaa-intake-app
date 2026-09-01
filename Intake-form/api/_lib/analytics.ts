// Third-party analytics injection — the marketing agency's (Intrepy) container.
//
// WHY THIS EXISTS: on the 2026-08-27 developer call the agency's ads lead agreed
// that Google Tag Manager must NOT go on the intake pages, and asked instead for
// their own in-house container (Matomo Tag Manager, self-hosted at
// tracking.intrepy.com) which they describe as HIPAA-compliant under a signed
// BAA, returning only gclid/fbclid to the ad platforms. That is the ONLY vendor
// script this module will ever emit.
//
// THE HARD REQUIREMENT: this must never load on /admin/*. The staff console
// holds patient names, DOBs, insurance details and card images; a tag manager
// there could exfiltrate all of it through a container change we do not control
// and cannot see. The intake forms are a different risk class — a patient
// filling in their own form — and are what the agency actually asked for.
//
// HOW THE EXCLUSION IS GUARANTEED (this is the whole point of the file):
// the SPA serves ONE index.html shell for every route, so "inject into the HTML"
// cannot be left to the client-side router. Instead the server decides, per
// request path, against an EXACT-MATCH allowlist of three literal strings.
// "/admin", "/admin/links", … are not equal to "/", "/consultation" or
// "/insurance", so the admin document is returned byte-identical to the build
// output — the tag is not present to be blocked, deferred, or raced. There is no
// prefix match, no wildcard and no regex anywhere in this path check, because
// each of those is a way to accidentally match a route added later.
//
// injectAnalytics() re-checks the path itself rather than trusting its caller,
// so the guarantee survives someone later wiring it to a broader Hono route.
//
// Pure + exported so the whole policy is unit-tested without booting the server
// (api-server/index.ts is not importable — it calls serve() on load).

/**
 * The ONLY paths that get the tag: the three public intake forms, matching
 * EMBED_FORMS in artifacts/intake-form/src/lib/embed.ts (drift-tested).
 *
 * Deliberately NOT included:
 *   /admin/*            — PHI. The reason this module is written the way it is.
 *   /plan/*             — the hidden client roadmap; internal, noindex.
 *   /integration        — the agency's own guide page; internal, noindex.
 *   /internal-tools-x9k2
 *   /api/*, /healthz    — not documents at all.
 */
export const ANALYTICS_ROUTES: readonly string[] = [
  "/",
  "/consultation",
  "/insurance",
];

/** Exact match only — never startsWith, never a pattern. */
export function isAnalyticsRoute(path: string): boolean {
  return ANALYTICS_ROUTES.includes(path);
}

/**
 * A usable container URL, or null.
 *
 * The value comes from an env var, so it is validated as untrusted input before
 * it is interpolated into markup: https only, a real absolute URL, no embedded
 * credentials, and none of the characters that could break out of the src
 * attribute or close the script element. Anything else yields null and the page
 * ships with no tag at all — a broken analytics config must never be able to
 * inject markup into a page that also renders a patient's form.
 */
export function analyticsSrc(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/["'<>\\\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return value;
}

/** Off unless INTREPY_ANALYTICS_ENABLED is exactly "true". Fails closed. */
export function analyticsEnabled(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() === "true";
}

/**
 * The markup, as two tags.
 *
 * The vendor's published install is one inline IIFE that pushes the mtm.Start
 * event onto window._mtm and then DOM-inserts the container script. We keep the
 * queue line — the container does not initialise without it — but load the
 * container as a plain external <script async src>, because a static tag is
 * reviewable in "view source" whereas a DOM-inserting IIFE is not. Functionally
 * identical: same queue, same async external fetch, same ordering.
 *
 * Nothing of ours is passed to it. No patient data, no form values, no URL
 * parameters, no dataLayer push, no callback. The tag is loaded and that is all;
 * whatever it collects, it collects from the page on its own.
 */
export function analyticsSnippet(src: string): string {
  return (
    `<script>window._mtm=window._mtm||[];` +
    `window._mtm.push({"mtm.startTime":(new Date().getTime()),"event":"mtm.Start"});</script>` +
    `<script async src="${src}"></script>`
  );
}

/**
 * The shell HTML with the tag added, or null to mean "serve the file unchanged".
 *
 * Null on: a non-form path (the admin guarantee), an unusable src, or a shell
 * with no </head>. Every failure mode is "no tag", never "no page".
 */
export function injectAnalytics(
  path: string,
  html: string,
  rawSrc: string | undefined,
): string | null {
  if (!isAnalyticsRoute(path)) return null;
  const src = analyticsSrc(rawSrc);
  if (!src) return null;
  const head = html.lastIndexOf("</head>");
  if (head === -1) return null;
  return html.slice(0, head) + analyticsSnippet(src) + html.slice(head);
}
