// Reports — the front door to reporting.
//
// WHY THIS PAGE EXISTS. Patient-journey reporting was real, live and two clicks
// deep behind a nav group that only expanded once you were already inside it.
// The synthetic insurance follow-up demonstration sat at the same level, with
// the same weight, and was easier to stumble into. Somebody looking for "how
// many registrations turned into consultations" could not find it.
//
// THIS IS AN INDEX, NOT A DASHBOARD. It computes nothing. It shows no figure
// except the ones the freshness endpoint already returns about coverage, and it
// links to the pages that do the counting. Adding a second place where numbers
// are calculated would be the opposite of the fix.
//
// THE DEMO IS SEPARATED, NOT HIDDEN. It keeps its route, its link and its
// explanation, below a rule, under a heading that says what it is. Hiding it
// would be its own dishonesty; giving it equal billing with live clinical
// reporting was the problem.

import { Link } from "wouter";
import {
  ArrowRight, Activity, LineChart, Users, FlaskConical, ListChecks, Radio, CalendarCheck,
} from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { PageHeader } from "./PageHeader";
import {
  useFreshness,
  AppointmentFreshnessBadge,
  IntakeFreshnessBadge,
  clinicTime,
} from "@/components/reporting/freshness";

type Card = {
  to: string;
  title: string;
  blurb: string;
  answers: string[];
  icon: typeof LineChart;
  testId: string;
};

// Real reporting, in the order someone actually asks for it.
const LIVE: Card[] = [
  {
    to: "/admin/outcomes",
    title: "Monthly outcomes",
    blurb:
      "For patients who registered or sent an insurance inquiry in each month: how many have completed an appointment, and how many still have one scheduled — as of the latest appointment data.",
    answers: [
      "Of June's registrations, how many have completed an appointment?",
      "How many are still scheduled?",
      "How does each month compare so far?",
    ],
    icon: CalendarCheck,
    testId: "reports-card-outcomes",
  },
  {
    to: "/admin/journeys?journey=registration",
    title: "Registration form progression",
    blurb:
      "Whether people who registered went on to submit the consultation form, with a collapsed diagnostic of when appointment records were created.",
    answers: [
      "How many sent the consultation form afterwards?",
      "Within 14 days, compared across periods?",
    ],
    icon: LineChart,
    testId: "reports-card-registration",
  },
  {
    to: "/admin/journeys?journey=insurance",
    title: "Insurance inquiry progression",
    blurb:
      "Whether people who sent an insurance inquiry went on to register — a separate cohort that overlaps with registration and must never be added to it.",
    answers: [
      "Did inquiries become registrations?",
    ],
    icon: Users,
    testId: "reports-card-insurance",
  },
  {
    to: "/admin/dashboard",
    title: "Intake dashboard",
    blurb:
      "Day-to-day volume: submissions by form and by source, recent totals and the operational health of intake.",
    answers: ["How many forms came in?", "Which sources sent them?"],
    icon: ListChecks,
    testId: "reports-card-dashboard",
  },
  {
    to: "/admin/dropoffs",
    title: "Registration drop-offs",
    blurb: "People who began the registration form and did not finish it.",
    answers: ["Where do people stop?"],
    icon: Activity,
    testId: "reports-card-dropoffs",
  },
  {
    to: "/admin/activity",
    title: "Activity log",
    blurb: "What the automations did, run by run, including manual-review routing.",
    answers: ["Did that submission reach the chart?"],
    icon: Radio,
    testId: "reports-card-activity",
  },
];

function CardLink({ card }: { card: Card }) {
  const Icon = card.icon;
  return (
    <Link
      href={card.to}
      data-testid={card.testId}
      className="group flex flex-col rounded-lg border bg-card p-4 transition-colors hover:border-[var(--sh-accent)] hover:bg-[var(--sh-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-[var(--sh-surface)]">
          <Icon className="h-4 w-4 text-[var(--sh-muted)]" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--sh-fg)]">{card.title}</h3>
            <ArrowRight
              className="h-3.5 w-3.5 shrink-0 text-[var(--sh-muted)] transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </div>
          <p className="mt-1 text-xs leading-relaxed text-[var(--sh-muted)]">{card.blurb}</p>
        </div>
      </div>
      <ul className="mt-3 space-y-1 border-t pt-3 text-xs text-[var(--sh-muted)]">
        {card.answers.map((a) => (
          <li key={a} className="flex gap-1.5">
            <span aria-hidden="true">·</span>
            <span>{a}</span>
          </li>
        ))}
      </ul>
    </Link>
  );
}

export default function Reports() {
  const freshness = useFreshness();
  // EVERY HOP IS OPTIONAL, and that is not defensive clutter.
  //
  // This page self-wraps in <AdminLayout>, so its own function body runs BEFORE
  // the layout — and therefore before the layout's error boundary exists. A
  // throw here does not land in the boundary that keeps the navigation usable;
  // it blanks the whole console, sign-out included. `data?.sync.schedules` was
  // exactly that: the optional chain stopped after `data`, so a 200 whose body
  // was not the shape this page expected took the entire admin area down.
  const a = freshness.data?.appointments;
  const inc = freshness.data?.sync?.schedules?.find((s) => s.scope === "practice_incremental");

  return (
    <AdminLayout>
      <div data-testid="reports-page">
        <PageHeader
          eyebrow="Reporting"
          title="Reports"
          subtitle="Everything the console can tell you about real patients, and where each number comes from."
        >
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <IntakeFreshnessBadge query={freshness} />
            <AppointmentFreshnessBadge query={freshness} />
          </div>
        </PageHeader>

        <section aria-labelledby="live-reporting">
          <h2 id="live-reporting" className="text-sm font-semibold text-[var(--sh-fg)]">
            Real patient data
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--sh-muted)]">
            Every figure on these pages comes from submissions this clinic received and
            appointment records read from the chart system. Nothing on them is invented.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {LIVE.map((c) => (
              <CardLink key={c.to} card={c} />
            ))}
          </div>
        </section>

        {/* Coverage, stated once, here, rather than repeated on every page. */}
        <section className="mt-6 rounded-lg border bg-muted/20 p-4" data-testid="reports-coverage">
          <h2 className="text-sm font-semibold">What the appointment figures cover</h2>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>
              <strong className="tabular-nums">{a?.history_complete_patients ?? "—"}</strong>{" "}
              of <strong className="tabular-nums">{a?.linked_patients ?? "—"}</strong> linked
              patients have their appointment history loaded
            </span>
            {a?.awaiting_catchup != null && a.awaiting_catchup > 0 && (
              <span className="text-muted-foreground" data-testid="reports-awaiting-catchup">
                {a.awaiting_catchup} newly linked, awaiting their first history read
              </span>
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {inc
              ? `Appointment records are re-read on a schedule — ${inc.cadence.replace(/\.$/, "")}. A run that cannot finish its window leaves the cursor where it was, so the timestamp above always means "complete to", never "last attempted".`
              : "No appointment sync schedule is configured, so these records are a stored snapshot someone refreshes by hand."}
            {inc?.last_success_at
              ? ` Last successful run ${clinicTime(inc.last_success_at)}.`
              : ""}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            <strong>Attendance is not reported yet.</strong> The appointment history is loaded in
            full; what is missing is the clinic&rsquo;s decision about which appointment status
            values mean the patient physically arrived.
          </p>
        </section>

        {/* ------------------------------------------------------------------
            The demonstration. Separated by a rule and a heading that says what
            it is, below everything real, and never mixed into the cards above.
           ------------------------------------------------------------------ */}
        <hr className="my-8 border-[var(--sh-border)]" />

        <section aria-labelledby="demo-heading">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="demo-heading" className="text-sm font-semibold text-[var(--sh-fg)]">
              Demonstration — not patient data
            </h2>
            <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                  style={{ background: "var(--sh-demo-bg)", borderColor: "var(--sh-demo-border)", color: "var(--sh-demo-fg)" }}>
              <FlaskConical className="h-2.5 w-2.5" aria-hidden="true" />
              Demo
            </span>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--sh-muted)]">
            A worked example of what insurance follow-up could look like. Every name, number and
            queue entry below is invented, it reads a fixture file rather than the database, and
            it has no endpoint that can send anything to anybody.
          </p>
          <div className="mt-3 max-w-md">
            <Link
              href="/admin/insurance-demo"
              data-testid="reports-card-demo"
              className="group flex items-start gap-3 rounded-lg border border-dashed bg-muted/20 p-4 transition-colors hover:bg-[var(--sh-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-[var(--sh-surface)]">
                <FlaskConical className="h-4 w-4 text-[var(--sh-muted)]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold text-[var(--sh-fg)]">
                    Insurance follow-up demonstration
                  </h3>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--sh-muted)] transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--sh-muted)]">
                  Synthetic queue and outcomes. Nothing here is sent, and nothing here counts.
                </p>
              </div>
            </Link>
          </div>
        </section>
      </div>
    </AdminLayout>
  );
}
