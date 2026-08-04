import { useEffect } from "react";

// Client-facing roadmap page — hidden, URL-only, fully STATIC. No auth, no DB,
// no network calls, no tracking. The token in the path IS the access control;
// any other /plan/* path falls through to NotFound (see App.tsx). Standalone
// layout: no admin chrome, no app nav, no links back into the console.
//
// The URL is a shared secret — keep it out of logs/tests/READMEs.
export const PLAN_PATH = "/plan/vw7UVjDkPbqhSrrxHxDZkASm";

const NAVY = "#0F4C81";

// Small status pill: modest color to mark live vs planned.
function Pill({ kind }: { kind: "live" | "next" }) {
  const live = kind === "live";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold align-middle"
      style={
        live
          ? { background: "#DCFCE7", color: "#166534" }
          : { background: "#E7EEF6", color: NAVY }
      }
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: live ? "#16A34A" : NAVY }}
      />
      {live ? "live" : "next"}
    </span>
  );
}

function H2({
  children,
  pill,
}: {
  children: React.ReactNode;
  pill?: "live" | "next";
}) {
  return (
    <h2 className="mt-12 mb-3 text-xl sm:text-2xl font-semibold text-slate-900 flex flex-wrap items-center gap-3">
      <span>{children}</span>
      {pill && <Pill kind={pill} />}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[15px] sm:text-base leading-relaxed text-slate-700">{children}</p>;
}

export default function Roadmap() {
  // Belt-and-suspenders noindex (the route also sends X-Robots-Tag). Injected
  // here and removed on unmount so it never leaks onto other client routes.
  useEffect(() => {
    document.title = "The DrSnip growth plan";
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    meta.setAttribute("data-roadmap", "1");
    document.head.appendChild(meta);
    return () => {
      document.querySelector('meta[data-roadmap="1"]')?.remove();
    };
  }, []);

  return (
    <div
      className="min-h-screen w-full bg-slate-50 text-slate-800"
      style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      <div className="mx-auto w-full max-w-2xl px-5 sm:px-8 py-12 sm:py-16">
        {/* Accent bar */}
        <div className="h-1 w-14 rounded-full" style={{ background: NAVY }} />

        <h1 className="mt-6 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
          The DrSnip growth plan
        </h1>
        <p className="mt-3 text-[15px] sm:text-base text-slate-500">
          What we've built, what ships next, and where it goes. Updated August 2026.
        </p>

        <div className="mt-4 h-px w-full bg-slate-200" />

        <H2>Where things stand</H2>
        <P>
          Your intake runs itself. Registration, consultation, and insurance forms
          flow straight into DrChrono, and the system emails a human the moment
          anything needs review. That part is done and boring, which is what
          infrastructure should be.
        </P>

        <H2 pill="live">New this week</H2>
        <P>Two things shipped.</P>
        <P>
          A marketing dashboard inside your intake console. It shows where patients
          say they heard about you, which office they chose, the insurance mix, and
          whether each submission made it into DrChrono. Live now, on your real data.
        </P>
        <P>
          And attribution. Every new submission records the link that produced it:
          the source, the campaign, and the click IDs ad platforms use. Until this
          week, a patient from a Google ad and a patient from a friend's
          recommendation looked identical in the data. Now they don't.
        </P>

        <H2 pill="next">Next up</H2>
        <P>
          Your marketing team's conversion tracking. The system is built to send one
          clean signal the moment a form completes. No scripts on patient pages, and
          no patient data in the signal. Turning it on takes three IDs from the
          marketing side, and once they arrive it's a same-day switch.
        </P>
        <P>
          After that: a referring-physician view and a zip-code view on the
          dashboard, and full campaign capture on the insurance form.
        </P>

        <H2>Phase 2: the full funnel</H2>
        <P>
          Today the system sees a submission and the DrChrono profile it creates. It
          can't yet see what happens after: consults booked, procedures done. Phase 2
          syncs that back. Then the dashboard answers the real question: which dollar
          produced which patient.
        </P>

        <H2>Phase 3: software that does the work</H2>
        <P>
          Once the data loop is closed, software can start doing recurring marketing
          work instead of just reporting on it. A Monday report that writes itself
          from your live numbers. Content drafted from the questions men actually ask
          before booking, waiting for your approval. Review requests after
          procedures, at the right moment. One rule throughout: the system does the
          work, your team approves it.
        </P>

        <H2>How patient data is handled</H2>
        <P>
          Patient information never touches the marketing site. Forms run on
          dedicated, encrypted infrastructure and land directly in your EHR.
          Analytics see counts, never people: any number small enough to point at
          one person is hidden, and the single conversion signal carries no patient
          data. This is deliberate, and it stays this way.
        </P>

        <div className="mt-12 h-px w-full bg-slate-200" />

        <P>
          Questions, or want to walk through any of it? Reply to my email and we'll
          grab twenty minutes.
        </P>
        <p className="mt-6 text-[15px] font-medium text-slate-900">
          Raunek Pratap,{" "}
          <span className="text-slate-500 font-normal">Xpand Technology</span>
        </p>
      </div>

      {/* Trivial print polish: white background, tighter margins. */}
      <style>{`
        @media print {
          body { background: #fff; }
          .min-h-screen { min-height: auto; background: #fff !important; }
        }
      `}</style>
    </div>
  );
}
