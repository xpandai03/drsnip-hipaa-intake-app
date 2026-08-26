// Self-serve embed snippet builders for the admin Links page. Pure string
// assembly from known intake URLs — no network, no third-party scripts (iframe
// only; this is a PHI-adjacent property). Kept framework-free so it's unit-tested
// directly (api/_test/embed.test.ts).

export const INTAKE_BASE = "https://intake.drsnip.com";

/**
 * The ONLY query parameters forwarded from the parent page into the iframe.
 *
 * These are exactly the eight keys the form's reader consumes
 * (artifacts/intake-form/src/lib/attribution.ts) — campaign identifiers and
 * nothing else. This is an allowlist by deliberate design: a generic
 * "forward the whole query string" would eventually carry something it
 * shouldn't onto a PHI-adjacent property. The page URL and the referrer are
 * never forwarded.
 *
 * WHY THIS EXISTS: an iframe can only read its OWN URL. A visitor landing on
 * drsnip.com/...?gclid=x gives the form nothing, because that parameter lives
 * on the parent. Across 2,131 submissions this meant zero click IDs and zero
 * UTMs were ever captured, while the server-side columns sat ready and empty.
 */
export const ATTRIBUTION_PARAMS = [
  "source",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
] as const;

/** Defensive cap, mirroring MAX_LEN in the form's own reader. */
export const ATTRIBUTION_MAX_LEN = 200;

export type EmbedForm = {
  key: "registration" | "consultation" | "insurance";
  label: string;
  path: string;
  iframeId: string;
  title: string;
  /** Only the insurance form emits the drsnip:height auto-resize message. */
  autoHeight: boolean;
};

export const EMBED_FORMS: EmbedForm[] = [
  {
    key: "registration",
    label: "Registration",
    path: "/",
    iframeId: "drsnip-registration",
    title: "DrSnip Registration Form",
    autoHeight: false,
  },
  {
    key: "consultation",
    label: "Consultation",
    path: "/consultation",
    iframeId: "drsnip-consultation",
    title: "DrSnip Consultation Form",
    autoHeight: false,
  },
  {
    key: "insurance",
    label: "Insurance",
    path: "/insurance",
    iframeId: "drsnip-insurance",
    title: "DrSnip Insurance Form",
    autoHeight: true,
  },
];

/** Full form URL, optionally source-tagged. Empty/blank source → bare URL. */
export function formUrl(path: string, sourceKey?: string | null): string {
  const base = `${INTAKE_BASE}${path}`;
  const key = (sourceKey ?? "").trim();
  if (key === "") return base;
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${sep}source=${encodeURIComponent(key)}`;
}

/**
 * Copy-ready iframe embed snippet, mirroring the shipped insurance embed shape
 * (responsive min-width:100%, scrolling off). The insurance form additionally
 * gets the origin-locked postMessage auto-height listener it already emits;
 * registration/consultation render at their own height (they are full-page
 * forms — the direct link is usually the simpler share).
 */
export function iframeSnippet(form: EmbedForm, sourceKey?: string | null): string {
  const defaultSource = (sourceKey ?? "").trim();
  const keys = ATTRIBUTION_PARAMS.map((k) => `"${k}"`).join(", ");

  // The iframe ships with NO src. The script assigns it, so the URL is complete
  // on the FIRST and only load. Setting src after a load would fetch the form
  // twice and — if it ever ran late — reload a partially filled form out from
  // under the patient.
  const iframe =
    `<iframe\n` +
    `  id="${form.iframeId}"\n` +
    `  title="${form.title}"\n` +
    `  scrolling="no"\n` +
    `  allow="camera"\n` +
    `  allowtransparency="true"\n` +
    `  style="width: 1px; min-width: 100%; border: none; overflow: hidden; display: block;"\n` +
    `></iframe>`;

  const heightListener = form.autoHeight
    ? `\n` +
      `    // Auto-height: the form posts its content height as it grows.\n` +
      `    window.addEventListener("message", function (e) {\n` +
      `      if (e.origin !== BASE_ORIGIN) return;\n` +
      `      var d = e.data || {};\n` +
      `      if (d.type === "drsnip:height" && typeof d.height === "number") {\n` +
      `        if (el) el.style.height = d.height + "px";\n` +
      `      }\n` +
      `    });\n`
    : "";

  return (
    `${iframe}\n` +
    `<script>\n` +
    `  (function () {\n` +
    `    var IFRAME_ID = "${form.iframeId}";\n` +
    `    var BASE_ORIGIN = "${INTAKE_BASE}";\n` +
    `    var FORM_URL = BASE_ORIGIN + "${form.path}";\n` +
    `    var DEFAULT_SOURCE = ${JSON.stringify(defaultSource)};\n` +
    `    // Campaign parameters only — never the page URL or referrer.\n` +
    `    var KEYS = [${keys}];\n` +
    `\n` +
    `    var from = new URLSearchParams(window.location.search);\n` +
    `    var out = new URLSearchParams();\n` +
    `    for (var i = 0; i < KEYS.length; i++) {\n` +
    `      var v = from.get(KEYS[i]);\n` +
    `      if (v) {\n` +
    `        v = String(v).trim().slice(0, ${ATTRIBUTION_MAX_LEN});\n` +
    `        if (v) out.set(KEYS[i], v);\n` +
    `      }\n` +
    `    }\n` +
    `    // A campaign-supplied ?source= wins; the placement default only fills\n` +
    `    // in when the visitor arrived untagged.\n` +
    `    if (!out.get("source") && DEFAULT_SOURCE) out.set("source", DEFAULT_SOURCE);\n` +
    `\n` +
    `    var qs = out.toString();\n` +
    `    var el = document.getElementById(IFRAME_ID);\n` +
    `    if (el) el.src = FORM_URL + (qs ? "?" + qs : "");\n` +
    heightListener +
    `  })();\n` +
    `</script>`
  );
}
