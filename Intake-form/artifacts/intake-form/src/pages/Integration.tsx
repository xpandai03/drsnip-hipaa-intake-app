import { useEffect, useState } from "react";

// Public integration guide for the client's marketing agency. Shareable by
// link, absent from search. FULLY STATIC: no auth, no DB, no network calls, and
// deliberately no tag containers or analytics of any kind — it would be absurd
// to track a page whose subject is tracking, and the form pages themselves
// carry none for the same PHI-boundary reason the page explains.
//
// Standalone layout: no admin chrome, no links back into the console.

export const INTEGRATION_PATH = "/integration";

// DrSnip brand values, taken from source rather than eyeballed:
//   NAVY  — index.css `--primary: 208 79% 28%`, commented "deep clinical blue".
//           The navy on the intake form header.
//   GOLD  — the marketing site's CTA orange, already used by the insurance form
//           shell (Insurance.tsx BRAND_ACCENT / BRAND_ACCENT_HOVER).
//   The logo is a WHITE KNOCKOUT (250x83 RGBA) — invisible on light ground, so
//   it only ever sits on the navy band, matching lib/pdf/layout/header.ts.
const NAVY = "#0F4C81";
const NAVY_DEEP = "#0B3A63";
const GOLD = "#F9B050";
const GOLD_DEEP = "#EFA143";
const LOGO = "/images/drsnip-logo.png";

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
      className="mt-16 mb-2 scroll-mt-8 text-2xl sm:text-[28px] font-semibold tracking-tight"
      style={{ color: NAVY }}
    >
      <span
        aria-hidden
        className="mb-3 block h-1 w-10 rounded-full"
        style={{ background: GOLD }}
      />
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-10 mb-1 text-lg font-semibold tracking-tight" style={{ color: NAVY_DEEP }}>
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-[15.5px] leading-[1.75] text-slate-700">{children}</p>
  );
}

/** Inline code token. */
function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
      {children}
    </code>
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
      className="font-medium underline underline-offset-2 hover:opacity-80"
      style={{ color: NAVY, textDecorationColor: GOLD }}
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

function Step({
  n,
  title,
  children,
  highlight,
}: {
  n: number;
  title: string;
  children?: React.ReactNode;
  /** For the one step people actually get stuck on. */
  highlight?: boolean;
}) {
  const body = (
    <div className="flex gap-4">
      <div
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold tabular-nums"
        style={
          highlight
            ? { background: GOLD, color: NAVY_DEEP }
            : { background: NAVY, color: "#fff" }
        }
        aria-hidden
      >
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-slate-900">{title}</div>
        {children && (
          <div className="mt-1.5 text-[15px] leading-relaxed text-slate-700">{children}</div>
        )}
      </div>
    </div>
  );
  if (!highlight) return <div className="mt-7">{body}</div>;
  return (
    <div
      className="mt-7 rounded-2xl border-2 p-5"
      style={{ borderColor: GOLD, background: "#FFFBF3" }}
    >
      {body}
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

// Shown verbatim so the developer knows exactly what to look for.
const SAMPLE_HEIGHT = `https://intake.drsnip.com  {type: 'drsnip:height', height: 1284}`;

const SAMPLE_CONVERSION = `https://intake.drsnip.com  {event: 'intake_conversion', form_type: 'insurance'}`;

const TEST_URL =
  "https://drsnip.com/cost-insurance/?utm_source=test&utm_medium=cpc&utm_campaign=your-test&gclid=TESTCLICK123";

const TOC: [string, string][] = [
  ["what-you-asked-for", "What you asked for"],
  ["why-tracking", "Why tracking wasn\'t working"],
  ["your-snippet", "About the tracking snippet you sent"],
  ["what-is-live", "What is live now"],
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
      {/* Brand band. The logo is a white knockout, so navy is the only ground
          it can sit on. Gold hairline separates band from page. */}
      <div style={{ background: NAVY, borderBottom: `3px solid ${GOLD}` }} className="print:hidden">
        <div className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
          <img
            src={LOGO}
            alt="DrSnip"
            className="mx-auto h-16 w-auto"
            width={250}
            height={83}
          />
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
        {/* ---- Header ---- */}
        <header>
          <h1
            className="text-[30px] sm:text-[40px] font-bold leading-[1.15] tracking-tight"
            style={{ color: NAVY }}
          >
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

        {/* ---- Why tracking wasn't working ---- */}
        <H2 id="why-tracking">Why tracking wasn&rsquo;t working</H2>
        <P>
          <B>Campaign parameters were never being passed to the form.</B>
        </P>
        <P>
          When someone clicks a Google ad, they arrive at a drsnip.com page carrying a{" "}
          <C>gclid</C> and UTM parameters in the URL. The form sits inside a frame on that
          page, and a frame can only read its own address, not the address of the page
          around it. The form was built to receive those values; nothing was passing them
          in. The live embed also carried no tag of its own, which is why insurance
          submissions recorded no source.
        </P>
        <P>
          The intake system has had columns for <C>gclid</C>, <C>fbclid</C>, and all six
          UTM parameters for weeks. Until this week, every one of them was empty.
        </P>
        <P>
          Fixing it did not require moving the forms or changing where patient data lives.
        </P>

        <Rule />

        {/* ---- About the tracking snippet you sent ---- */}
        <H2 id="your-snippet">About the tracking snippet you sent</H2>
        <P>
          Your tracking document asks for two containers, Google Tag Manager and the
          Intrepy analytics container, to be added to the head and body of the form pages.
        </P>
        <P>
          Those containers are already installed across drsnip.com, including the pages the
          forms sit on. What we have not done is run them <B>inside</B> the form itself,
          because that is where patients enter medical histories, dates of birth, and
          photographs of insurance cards. Tag containers can load additional scripts after
          the fact, and clinics have faced action over patient data reaching advertising
          platforms this way.
        </P>
        <P>
          The approach below gives you the same conversion data without that exposure. The
          form sends a single event to the page it sits on, carrying nothing but the event
          name and which form was submitted. Your GTM container is already on that page and
          can act on the event exactly as it would any other trigger. You keep your tags,
          your triggers, and your reporting; the only difference is that nothing
          third-party executes on a page where patient data is being typed.
        </P>
        <P>
          If there is something in your setup this does not cover, tell us and we will work
          it out.
        </P>

        <Rule />

        {/* ---- What is live now ---- */}
        <H2 id="what-is-live">What is live now</H2>
        <P>
          <B>Campaign parameters flow through.</B> The embed on
          drsnip.com/cost-insurance now forwards{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">gclid</code>,{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">fbclid</code>,{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">source</code>,
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

        {/* ---- For your developer ---- */}
        <H2 id="for-your-developer">For your developer</H2>

        <H3>1. The listener tag</H3>
        <P>
          Add as a Custom HTML tag in GTM{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">GTM-K6883FZH</code>
          , firing on All Pages. It listens for the conversion event and makes it available
          to both Google Tag Manager and your Matomo container.
        </P>
        <CodeBlock code={LISTENER_TAG} label="GTM — Custom HTML tag" />
        <P>
          Then in GTM: a <B>Custom Event</B> trigger on{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            drsnip_intake_conversion
          </code>
          , and a Data Layer Variable on{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            drsnip_form_type
          </code>{" "}
          if you want conversions split by form.
        </P>
        <P>
          <B>One note on Matomo:</B> pushing to{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">_mtm</code>{" "}
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
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            https://drsnip.com
          </code>{" "}
          and{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
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
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">FORM_URL</code>{" "}
          and{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            DEFAULT_SOURCE
          </code>{" "}
          per placement.
        </P>
        <CodeBlock code={EMBED_SNIPPET} label="WordPress — HTML block" />
        <P>
          Form URLs: insurance is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">/insurance</code>,
          registration is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">/</code>,
          consultation is{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            /consultation
          </code>
          .
        </P>

        <H3>4. Test it yourself</H3>
        <P>
          This takes about two minutes and needs nothing installed. Every step is below.
        </P>

        <Step n={1} title="Open the test link">
          <A href={TEST_URL}>{TEST_URL}</A>
          <div className="mt-2 text-[14px] text-slate-500">
            The parameters in this link are what a real ad click would carry.
          </div>
        </Step>

        <Step n={2} title="Open the browser console before you submit">
          On a Mac press <C>&#8984; + Option + J</C>. On Windows press{" "}
          <C>Ctrl + Shift + J</C>. That opens the Console tab in Chrome or Edge.
        </Step>

        <Step
          n={3}
          highlight
          title={'Set the console context to "top" \u2014 this is the step people miss'}
        >
          At the top of the Console panel there is a dropdown, usually reading{" "}
          <C>top</C>. When a page contains a frame, that dropdown can be switched to the
          frame instead &mdash; here, <C>intake.drsnip.com</C>.
          <div className="mt-3">
            <B>
              It must be set to <C>top</C>.
            </B>{" "}
            If it is pointing at the form&rsquo;s frame, the listener you paste next runs{" "}
            <em>inside</em> the form rather than on the page around it. The form sends its
            event outward to the parent page, so a listener sitting inside the frame never
            receives anything &mdash; the console stays silent and everything looks broken
            when it is working perfectly.
          </div>
          <div className="mt-3 text-[14.5px] text-slate-600">
            In Chrome the dropdown sits just left of the &ldquo;Filter&rdquo; box, above
            the console output. Set it to <C>top</C> before continuing.
          </div>
        </Step>

        <Step n={4} title="Paste this line into the console and press Enter">
          <CodeBlock code={CONSOLE_SNIPPET} />
          <div className="mt-1 text-[14px] text-slate-500">
            It prints every message the page receives from the form.
          </div>
          <div className="mt-3">
            <B>If Chrome refuses to paste</B>, it will print a warning about pasting
            code into the console instead of running the line. Type <C>allow pasting</C>{" "}
            into the console, press Enter, then paste the line again. Chrome blocks
            console pasting by default, so this happens on most machines the first time
            &mdash; it is not a sign anything is wrong.
          </div>
          <div className="mt-3 text-[14.5px] text-slate-600">
            Paste it <em>before</em> the form has finished loading. The listener only
            sees messages sent after it is running, and the first height messages arrive
            while the form is still coming up. Arm it late and the console stays quiet
            until you interact with the form, which looks like nothing is happening.
          </div>
        </Step>

        <Step n={5} title="Watch the height messages appear">
          Before you submit anything, as the form loads and you move through it, you will
          see lines like this. They are the form telling the page how tall it needs to be
          &mdash; normal, and a good sign the connection is working:
          <div className="mt-3">
            <CodeBlock code={SAMPLE_HEIGHT} />
          </div>
        </Step>

        <Step n={6} title="Fill in the form and submit it">
          Use an obviously fake name so the row is easy to spot &mdash; something like{" "}
          <C>Test Testerson</C>. Real submissions and test submissions land in the same
          place, so tell us which ones were tests and we will remove them.
        </Step>

        <Step n={7} title="Watch the conversion event arrive">
          The moment the submission succeeds, this appears in the console:
          <div className="mt-3">
            <CodeBlock code={SAMPLE_CONVERSION} />
          </div>
          <div className="mt-2">
            That is the event your listener tag reacts to. <C>form_type</C> tells you which
            form was submitted.
          </div>
        </Step>

        <Step n={8} title="Check it reached GTM">
          With GTM Preview running on the page, the same submission should show a{" "}
          <C>drsnip_intake_conversion</C> event in the events list, with{" "}
          <C>drsnip_form_type</C> available as a Data Layer Variable.
        </Step>

        <div
          className="mt-9 rounded-2xl border p-5"
          style={{ background: "#F0FDF4", borderColor: "#BBF7D0" }}
        >
          <div className="font-semibold" style={{ color: "#166534" }}>
            What a successful test looks like
          </div>
          <ul className="mt-2.5 space-y-1.5 text-[15px] leading-relaxed text-slate-700">
            <li>
              &bull; Height messages appear in the console as the form loads and resizes.
            </li>
            <li>
              &bull; Exactly one <C>intake_conversion</C> message appears, on submit, and
              never before.
            </li>
            <li>
              &bull; That message contains two fields and nothing else: <C>event</C> and{" "}
              <C>form_type</C>.
            </li>
            <li>&bull; GTM Preview shows the matching custom event.</li>
          </ul>
          <div className="mt-3 text-[14.5px] text-slate-600">
            If the height messages appear but the conversion does not, the connection is
            fine and the problem is in the submission itself &mdash; tell us and we will
            look. If nothing appears at all, start with the first item in Troubleshooting
            below.
          </div>
        </div>

        <Rule />

        {/* ---- Troubleshooting ---- */}
        <H2 id="troubleshooting">Troubleshooting</H2>
        <Trouble title="Nothing fires at all.">
          If you are testing by hand in the console, check the context dropdown
          first: it must be set to <C>top</C>, not the form&rsquo;s frame (step 3
          above). That is the most common cause by some margin. Otherwise, check the
          origin comparison in your listener &mdash; it must be{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
            https://intake.drsnip.com
          </code>
          , the frame's origin, not your own site's.
        </Trouble>
        <Trouble title="Test on production over https.">
          Parameters and events do not travel from{" "}
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">http://</code>{" "}
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
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">_mtm</code>{" "}
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
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">gclid</code>{" "}
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
          <code className="rounded bg-slate-200/70 px-1.5 py-0.5 text-[13.5px] text-slate-800">
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
          If anything about the listener event or setting it up is unclear, email Raunek
          directly &mdash; short questions are welcome and usually answered the same day.
          We are also happy to jump on a call with your developer and walk through it
          together, or sit in while you wire up the tag.
        </P>
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="text-[15px] font-semibold text-slate-900">Raunek Pratap</div>
          <div className="mt-0.5 text-[14.5px] text-slate-500">Xpand Technology</div>
          <a
            href="mailto:raunek@xpandai.com?subject=DrSnip%20intake%20tracking"
            className="mt-4 inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-[15px] font-semibold transition-opacity hover:opacity-90"
            style={{ background: GOLD, color: NAVY_DEEP, border: `1px solid ${GOLD_DEEP}` }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m2 7 10 6 10-6" />
            </svg>
            raunek@xpandai.com
          </a>
        </div>

        <footer className="mt-20 border-t border-slate-200 pt-6 text-[13px] text-slate-400">
          Xpand Technology · August 2026
        </footer>
      </div>
    </div>
  );
}
