import { useEffect, useState } from "react";

// Public integration guide for the client's marketing agency. Shareable by
// link, absent from search. FULLY STATIC: no auth, no DB, no network calls, and
// deliberately no tag containers or analytics of any kind — it would be absurd
// to track a page whose subject is tracking, and the form pages themselves
// carry none for the same PHI-boundary reason the page explains.
//
// Standalone layout: no admin chrome, no links back into the console.

export const INTEGRATION_PATH = "/integration";

const NAVY = "#0F4C81";

/** Paste the video URL here when it exists; the slot renders itself. */
const VIDEO_URL = "";

// ---------------------------------------------------------------------------
// Copy-to-clipboard code block — the most important interaction on this page.
// Their developer should never have to select text by hand.
// ---------------------------------------------------------------------------

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Older/permission-restricted browsers: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing more we can do; the code is still selectable */
      }
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="relative mt-5 group">
      {label && (
        <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
          {label}
        </div>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied to clipboard" : "Copy to clipboard"}
        className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors print:hidden"
        style={
          copied
            ? { background: "#DCFCE7", color: "#166534" }
            : { background: "rgba(255,255,255,0.10)", color: "#CBD5E1" }
        }
      >
        {copied ? (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            Copied
          </>
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            Copy
          </>
        )}
      </button>
      <pre className="overflow-x-auto rounded-2xl bg-slate-900 p-4 pr-24 text-[12.5px] leading-relaxed text-slate-100 print:bg-white print:text-black print:border print:border-slate-300">
        <code
          className="whitespace-pre"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
        >
          {code}
        </code>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typography primitives
// ---------------------------------------------------------------------------

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      className="mt-16 mb-2 scroll-mt-8 text-2xl sm:text-[28px] font-semibold tracking-tight text-slate-900"
    >
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-10 mb-1 text-lg font-semibold tracking-tight text-slate-900">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-[15.5px] leading-[1.75] text-slate-700">{children}</p>
  );
}

function B({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-slate-900">{children}</strong>;
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium underline decoration-slate-300 underline-offset-2 hover:decoration-current"
      style={{ color: NAVY }}
    >
      {children}
    </a>
  );
}

function Rule() {
  return <hr className="mt-14 border-slate-200" />;
}

function DataTable({ rows, head }: { rows: [string, string][]; head: [string, string] }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full border-collapse text-[14.5px]">
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="border-b-2 border-slate-200 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-slate-100">
              <td className="px-3 py-2.5 align-top text-slate-600">{k}</td>
              <td
                className="px-3 py-2.5 align-top font-medium text-slate-900"
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}
              >
                {v}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Trouble({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
      <div className="font-semibold text-slate-900">{title}</div>
      <div className="mt-1.5 text-[15px] leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code payloads
// ---------------------------------------------------------------------------

const LISTENER_TAG = `<script>
(function () {
  window.dataLayer = window.dataLayer || [];   // GTM
  window._mtm      = window._mtm      || [];   // Matomo Tag Manager

  window.addEventListener('message', function (e) {
    // Only trust the DrSnip intake origin. Not optional: without this,
    // any embedded third party could forge a conversion.
    if (e.origin !== 'https://intake.drsnip.com') return;

    var d = e.data || {};
    if (!d || d.event !== 'intake_conversion') return;

    window.dataLayer.push({
      event: 'drsnip_intake_conversion',
      drsnip_form_type: d.form_type          // insurance | registration | consultation
    });

    window._mtm.push({
      event: 'drsnip_intake_conversion',
      drsnip_form_type: d.form_type
    });
  });
})();
</script>`;

const EMBED_SNIPPET = `<iframe
  id="drsnip-insurance"
  title="DrSnip Insurance Form"
  scrolling="no"
  allow="camera"
  allowtransparency="true"
  style="width: 1px; min-width: 100%; border: none; overflow: hidden; display: block;"
></iframe>
<script>
  (function () {
    var IFRAME_ID = "drsnip-insurance";
    var BASE_ORIGIN = "https://intake.drsnip.com";
    var FORM_URL = BASE_ORIGIN + "/insurance";
    var DEFAULT_SOURCE = "cost-insurance-page";
    // Campaign parameters only — never the page URL or referrer.
    var KEYS = ["source", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];

    var from = new URLSearchParams(window.location.search);
    var out = new URLSearchParams();
    for (var i = 0; i < KEYS.length; i++) {
      var v = from.get(KEYS[i]);
      if (v) {
        v = String(v).trim().slice(0, 200);
        if (v) out.set(KEYS[i], v);
      }
    }
    // A campaign-supplied ?source= wins; the placement default only fills
    // in when the visitor arrived untagged.
    if (!out.get("source") && DEFAULT_SOURCE) out.set("source", DEFAULT_SOURCE);

    var qs = out.toString();
    var el = document.getElementById(IFRAME_ID);
    if (el) el.src = FORM_URL + (qs ? "?" + qs : "");

    // Auto-height: the form posts its content height as it grows.
    window.addEventListener("message", function (e) {
      if (e.origin !== BASE_ORIGIN) return;
      var d = e.data || {};
      if (d.type === "drsnip:height" && typeof d.height === "number") {
        if (el) el.style.height = d.height + "px";
      }
    });
  })();
</script>`;

const CONSOLE_SNIPPET = `addEventListener('message', e => console.log(e.origin, e.data))`;

const TEST_URL =
  "https://drsnip.com/cost-insurance/?utm_source=test&utm_medium=cpc&utm_campaign=your-test&gclid=TESTCLICK123";

const TOC: [string, string][] = [
  ["what-you-asked-for", "What you asked for"],
  ["what-was-wrong", "What was actually wrong"],
  ["what-is-live", "What is live now"],
  ["video", "Walkthrough video"],
  ["for-your-developer", "For your developer"],
  ["troubleshooting", "Troubleshooting"],
  ["next", "What is worth doing together next"],
  ["patient-data", "Where patient data lives"],
  ["questions", "Questions"],
];

// ---------------------------------------------------------------------------

export default function Integration() {
  // Belt-and-suspenders noindex (the route also sends X-Robots-Tag). Added here
  // and removed on unmount so it never leaks onto another client route.
  useEffect(() => {
    document.title = "DrSnip intake forms: tracking and integration";
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    meta.setAttribute("data-integration", "1");
    document.head.appendChild(meta);
    return () => {
      document.querySelector('meta[data-integration="1"]')?.remove();
    };
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800 print:bg-white">
      <div className="mx-auto w-full max-w-3xl px-5 py-14 sm:px-8 sm:py-20">
        {/* ---- Header ---- */}
        <header>
          <h1 className="text-[30px] sm:text-[40px] font-bold leading-[1.15] tracking-tight text-slate-900">
            DrSnip intake forms: tracking and integration
          </h1>
          <p className="mt-4 text-[14.5px] text-slate-500">
            Prepared by Xpand Technology for the DrSnip and Intrepy teams · August 2026
          </p>
        </header>

        {/* ---- Table of contents ---- */}
        <nav
          aria-label="Contents"
          className="mt-10 rounded-2xl border border-slate-200 bg-white p-5 print:hidden"
        >
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Contents
          </div>
          <ol className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {TOC.map(([id, label], i) => (
              <li key={id} className="text-[14.5px]">
                <a
                  href={`#${id}`}
                  className="hover:underline underline-offset-2"
                  style={{ color: NAVY }}
                >
                  <span className="text-slate-400 tabular-nums">{i + 1}.</span> {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <Rule />

        {/* ---- What you asked for ---- */}
        <H2 id="what-you-asked-for">What you asked for</H2>
        <P>
          Two things, from your{" "}
          <A href="https://docs.google.com/document/d/1gslwMhgMIjghF-kEQ7wwDFMy8YDr5L2i3wre7vKbza4/edit">
            tracking code document
          </A>{" "}
          and your{" "}
          <A href="https://docs.google.com/document/d/1wuZKjHFIMBIkVSfcJcxLNgylTyzr3IxrsgjHjdEWmG4/edit">
            migration specification
          </A>
          :
        </P>
        <ol className="mt-4 space-y-3 text-[15.5px] leading-[1.75] text-slate-700">
          <li className="flex gap-3">
            <span className="font-semibold text-slate-400 tabular-nums">1.</span>
            <span>
              <B>Get the intake forms onto pages of drsnip.com</B>, rather than living
              only on a separate subdomain.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-slate-400 tabular-nums">2.</span>
            <span>
              <B>Get conversion tracking working</B>, so campaigns can be measured
              properly.
            </span>
          </li>
        </ol>
        <P>
          Both are reasonable, and both are now solved. This page explains how, and gives
          your developer everything needed to finish the last step.
        </P>

        <Rule />

        {/* ---- What was actually wrong ---- */}
        <H2 id="what-was-wrong">What was actually wrong</H2>
        <P>
          The migration spec identified the subdomain as the cause, noting that a
          standalone app on a subdomain cannot access the site's UTM tracking. That was a
          fair read of the symptom. The actual cause turned out to be narrower and easier
          to fix.
        </P>
        <P>
          <B>Campaign parameters were never being passed to the form.</B>
        </P>
        <P>
          When someone clicks a Google ad, they arrive at a drsnip.com page carrying a{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">gclid</code>{" "}
          and UTM parameters in the URL. The form sits inside a frame on that page, and a
          frame can only read its own address, not the address of the page around it.
          Nobody had ever passed those values through. The form was ready to receive them;
          it was never handed them.
        </P>
        <P>
          The intake system has had database columns for{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">gclid</code>,{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">fbclid</code>,
          and all six UTM parameters for weeks. Across 2,131 submissions, every one of them
          was empty.
        </P>
        <P>
          <B>Additionally, the live embed carried no tag at all.</B> The insurance form on
          the cost and insurance page was loading a bare URL with no parameters, which is
          why every insurance submission recorded no source.
        </P>
        <P>
          Neither problem required moving the forms or changing where patient data lives.
        </P>

        <Rule />

        {/* ---- What is live now ---- */}
        <H2 id="what-is-live">What is live now</H2>
        <P>
          <B>Campaign parameters flow through.</B> The embed on
          drsnip.com/cost-insurance now forwards{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">gclid</code>,{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">fbclid</code>,{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">source</code>,
          and all six UTM parameters from the page's URL into the form. Verified in
          production on August 26:
        </P>
        <DataTable
          head={["Field", "Value recorded"]}
          rows={[
            ["gclid", "DEMOGCLID456"],
            ["source", "cost-insurance-page"],
            ["utm_source", "handover"],
            ["utm_medium", "cpc"],
            ["utm_campaign", "agency-demo"],
          ]}
        />
        <P>That is the first click ID ever recorded by this system.</P>
        <P>
          <B>The conversion signal is live.</B> On a confirmed submission, the form sends
          an event to the page it is embedded on. Your GTM container already sits on that
          page and can act on it. One listener tag connects the two, and that tag is below.
        </P>
        <P>
          <B>Attribution has been recording for weeks</B> and continues to, independent of
          any tag you install.
        </P>

        <Rule />

        {/* ---- Video ---- */}
        <H2 id="video">Walkthrough video</H2>
        {VIDEO_URL ? (
          <div className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-black">
            <div style={{ position: "relative", paddingBottom: "56.25%", height: 0 }}>
              <iframe
                src={VIDEO_URL}
                title="DrSnip integration walkthrough"
                allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-5 flex min-h-[180px] items-center justify-center rounded-2xl border-2 border-dashed border-slate-300 bg-white p-8 text-center">
            <div>
              <div className="text-[15px] font-medium text-slate-500">
                Walkthrough video — link coming
              </div>
              <div className="mt-1 text-[13px] text-slate-400">
                This section will hold a short screen recording.
              </div>
            </div>
          </div>
        )}

        <Rule />

        {/* ---- For your developer ---- */}
        <H2 id="for-your-developer">For your developer</H2>

        <H3>1. The listener tag</H3>
        <P>
          Add as a Custom HTML tag in GTM{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">GTM-K6883FZH</code>
          , firing on All Pages. It listens for the conversion event and makes it available
          to both Google Tag Manager and your Matomo container.
        </P>
        <CodeBlock code={LISTENER_TAG} label="GTM — Custom HTML tag" />
        <P>
          Then in GTM: a <B>Custom Event</B> trigger on{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            drsnip_intake_conversion
          </code>
          , and a Data Layer Variable on{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            drsnip_form_type
          </code>{" "}
          if you want conversions split by form.
        </P>
        <P>
          <B>One note on Matomo:</B> pushing to{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">_mtm</code>{" "}
          makes the trigger available in Matomo Tag Manager; it does not record anything by
          itself. A Matomo tag needs to be bound to that trigger. Without that step the
          data layer will look correct and Matomo will show nothing.
        </P>

        <H3>2. The event contract</H3>
        <DataTable
          head={["Field", "Value"]}
          rows={[
            ["event", "intake_conversion"],
            ["form_type", "insurance / registration / consultation"],
          ]}
        />
        <P>
          Fires exactly once, on confirmed submission success. Never on page view,
          validation failure, or step change. Sent only to{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            https://drsnip.com
          </code>{" "}
          and{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            https://www.drsnip.com
          </code>
          .
        </P>
        <P>
          <B>The payload never contains</B> name, email, phone, date of birth, address,
          insurance carrier, policy or group number, subscriber details, medical answers,
          card images, submission ID, patient chart ID, cookies, or the page URL. It is two
          strings, by construction.
        </P>

        <H3>3. The embed snippet</H3>
        <P>
          To place a form on any page, use this in an HTML block. Change{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">FORM_URL</code>{" "}
          and{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            DEFAULT_SOURCE
          </code>{" "}
          per placement.
        </P>
        <CodeBlock code={EMBED_SNIPPET} label="WordPress — HTML block" />
        <P>
          Form URLs: insurance is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">/insurance</code>,
          registration is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">/</code>,
          consultation is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            /consultation
          </code>
          .
        </P>

        <H3>4. Test it yourself</H3>
        <P>
          Open this in a browser, submit the form, and watch the event arrive:
        </P>
        <P>
          <A href={TEST_URL}>{TEST_URL}</A>
        </P>
        <P>
          Before submitting, paste this into the browser console to watch messages arrive:
        </P>
        <CodeBlock code={CONSOLE_SNIPPET} label="Browser console" />
        <P>
          You will see height messages as the form resizes, then the conversion event on
          submit.
        </P>

        <Rule />

        {/* ---- Troubleshooting ---- */}
        <H2 id="troubleshooting">Troubleshooting</H2>
        <Trouble title="Nothing fires at all.">
          Check the origin comparison in your listener. It must be{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            https://intake.drsnip.com
          </code>
          , the frame's origin, not your own site's.
        </Trouble>
        <Trouble title="Test on production over https.">
          Parameters and events do not travel from{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">http://</code>{" "}
          pages or from staging hosts, because those origins are not on the form's
          allowlist. If you need a staging host allowlisted for testing, tell us and we
          will add it.
        </Trouble>
        <Trouble title="Console messages about a www mismatch.">
          The form posts to both drsnip.com and www.drsnip.com; whichever one your page is
          not, the browser logs a complaint about. It is cosmetic. The message still
          reaches the correct origin.
        </Trouble>
        <Trouble title="Data layer looks right, Matomo shows nothing.">
          The Matomo tag is missing. The{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">_mtm</code>{" "}
          push creates a trigger, not a recording.
        </Trouble>
        <Trouble title="Conversions undercount relative to submissions.">
          Expected, and worth measuring. Ad blockers and consent gating block tag
          containers but not the underlying submission. We hold the true submission count
          and can reconcile whenever you want a denominator.
        </Trouble>

        <Rule />

        {/* ---- Next ---- */}
        <H2 id="next">What is worth doing together next</H2>
        <P>
          <B>Persisting campaign parameters across the visit.</B> Right now the parameters
          are read from the page the form sits on. Someone who lands on the homepage from
          an ad, browses, and later reaches the form has lost the{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">gclid</code>{" "}
          by the time they get there. Your site already runs the AFL UTM Tracker plugin,
          which your migration spec describes as capturing UTM parameters from the landing
          URL. If those stored values are written into the embed URL, attribution holds
          across the whole visit. That is a change on the WordPress side, and we are happy
          to help scope it.
        </P>
        <P>
          <B>Offline conversion import.</B> Click IDs are now recorded with each
          submission. A periodic export of click ID plus conversion time would let Google
          Ads match leads back to clicks. That export does not exist yet; it is
          straightforward to build and contains no patient information.
        </P>
        <P>
          <B>Deduplication for Meta CAPI.</B> If you run server-side Meta events alongside
          the browser pixel, an event ID in the payload would let you deduplicate. Not
          built, roughly an hour, and worth doing only if you are running CAPI.
        </P>
        <P>
          <B>Forcing HTTPS on the site.</B>{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px]">
            http://drsnip.com
          </code>{" "}
          currently serves without redirecting to https. Visitors arriving that way lose
          tracking silently. Worth fixing regardless.
        </P>

        <Rule />

        {/* ---- Patient data ---- */}
        <H2 id="patient-data">Where patient data lives, and why the forms stay put</H2>
        <P>
          The forms collect medical history, dates of birth, and photographs of insurance
          cards. That data goes from the patient directly into HIPAA-compliant hosting
          under a signed Business Associate Agreement, and from there into DrChrono. It
          never passes through or rests on the WordPress site.
        </P>
        <P>
          The migration spec's PHI section lists what rebuilding the forms in Gravity Forms
          would require: a signed BAA with the WordPress host, encryption of stored form
          entries, and a retention and deletion policy for uploaded insurance card images.
          Keeping the forms where they are avoids all three, while producing the same
          result for patients: the form appears on a drsnip.com page.
        </P>
        <P>
          This is also why no tag containers run on the form pages themselves. The single
          conversion event carries no patient data by design, which is what allows it to
          cross the boundary at all.
        </P>

        <Rule />

        {/* ---- Questions ---- */}
        <H2 id="questions">Questions</H2>
        <P>
          Raunek Pratap, Xpand Technology. Happy to get on a call with your developer any
          time.
        </P>

        <footer className="mt-20 border-t border-slate-200 pt-6 text-[13px] text-slate-400">
          Xpand Technology · August 2026
        </footer>
      </div>
    </div>
  );
}
