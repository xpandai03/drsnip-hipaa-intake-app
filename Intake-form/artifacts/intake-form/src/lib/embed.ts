// Self-serve embed snippet builders for the admin Links page. Pure string
// assembly from known intake URLs — no network, no third-party scripts (iframe
// only; this is a PHI-adjacent property). Kept framework-free so it's unit-tested
// directly (api/_test/embed.test.ts).

export const INTAKE_BASE = "https://intake.drsnip.com";

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
  const src = formUrl(form.path, sourceKey);
  const iframe =
    `<iframe\n` +
    `  id="${form.iframeId}"\n` +
    `  src="${src}"\n` +
    `  title="${form.title}"\n` +
    `  scrolling="no"\n` +
    `  allow="camera"\n` +
    `  allowtransparency="true"\n` +
    `  style="width: 1px; min-width: 100%; border: none; overflow: hidden; display: block;"\n` +
    `></iframe>`;
  if (!form.autoHeight) return iframe;
  return (
    `${iframe}\n` +
    `<script>\n` +
    `  (function () {\n` +
    `    var IFRAME_ID = "${form.iframeId}";\n` +
    `    var ALLOWED_ORIGIN = "${INTAKE_BASE}";\n` +
    `    window.addEventListener("message", function (e) {\n` +
    `      if (e.origin !== ALLOWED_ORIGIN) return;\n` +
    `      var d = e.data || {};\n` +
    `      if (d.type === "drsnip:height" && typeof d.height === "number") {\n` +
    `        var el = document.getElementById(IFRAME_ID);\n` +
    `        if (el) el.style.height = d.height + "px";\n` +
    `      }\n` +
    `    });\n` +
    `  })();\n` +
    `</script>`
  );
}
