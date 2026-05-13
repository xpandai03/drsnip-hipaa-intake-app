import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  Loader2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Chip,
  copyToClipboard,
  exactTime,
  rankBadgeClass,
  sfStatusBadgeClass,
  sourceBadgeClass,
  SF_LEAD_URL,
} from "./Submissions";

// ---------------------------------------------------------------------------
// Types — mirror /api/submissions/[id]
// ---------------------------------------------------------------------------

type RuleTraceCondition = {
  field: string;
  op: string;
  target?: string | string[];
  actual: string | null | undefined;
  result: boolean;
};

type RuleTraceStep = {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  conditions: RuleTraceCondition[];
};

type ScoringTrace = {
  ruleSetId: string;
  ruleSetVersion: number;
  evaluatedAt: string;
  steps: RuleTraceStep[];
  finalOutcome: { rank?: string; leadScore?: string };
};

type DetailSubmission = {
  id: string;
  createdAt: string;
  source: string;
  surveyDetail: string;
  leadSource: string;
  campaign: string | null;
  event: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  stateResidence: string;
  federalAgency: string;
  qSpeakerRating: string | null;
  qWorkshopContent: string | null;
  qPreRetirement: string;
  qEvalComments: string | null;
  qYearsToRetire: string | null;
  qAge: string | null;
  qSeparating: string | null;
  qMaritalStatus: string | null;
  qMaxingTsp: string | null;
  qTspContributionPct: string | null;
  qExternalInvestments: string | null;
  qTspBalance: string | null;
  qAreasOfConcern: string | null;
  scoringRuleSetId: string | null;
  rank: string | null;
  leadScore: string | null;
  scoringTrace: ScoringTrace | null;
  autoScheduleHold: boolean;
  sfLeadId: string | null;
  sfStatus: string;
  sfError: string | null;
  sfAttempts: number;
  sfLastAttemptAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  discardedBy: string | null;
  discardedAt: string | null;
  rawPayload: unknown;
};

type DetailResponse = {
  submission: DetailSubmission;
  ruleSet: { id: string; version: number; name: string } | null;
};

async function fetchDetail(id: string): Promise<DetailResponse> {
  const res = await fetch(`/api/submissions/${id}`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`/api/submissions/${id} returned ${res.status}`);
  return (await res.json()) as DetailResponse;
}

// ---------------------------------------------------------------------------
// The survey fields the user sees in section 2 — in display order. Labels
// match what would make sense to a non-technical admin reading the page.
// ---------------------------------------------------------------------------

const SURVEY_FIELDS: Array<{ key: keyof DetailSubmission; label: string }> = [
  { key: "qSpeakerRating", label: "Speaker rating" },
  { key: "qWorkshopContent", label: "Workshop content rating" },
  { key: "qPreRetirement", label: "Pre-retirement review requested" },
  { key: "qEvalComments", label: "Evaluation comments" },
  { key: "qYearsToRetire", label: "Years to retirement" },
  { key: "qAge", label: "Age bracket" },
  { key: "qSeparating", label: "Separating from service" },
  { key: "qMaritalStatus", label: "Marital status" },
  { key: "qMaxingTsp", label: "Maxing out TSP" },
  { key: "qTspContributionPct", label: "TSP contribution %" },
  { key: "qExternalInvestments", label: "External investments" },
  { key: "qTspBalance", label: "TSP balance" },
  { key: "qAreasOfConcern", label: "Areas of concern" },
];

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function SubmissionDetailModal({
  id,
  open,
  onClose,
}: {
  id: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["submission-detail", id],
    queryFn: () => fetchDetail(id as string),
    enabled: open && !!id,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-w-3xl max-h-[90vh] overflow-y-auto border-slate-200 bg-white text-slate-900 shadow-2xl sm:rounded-3xl"
        data-testid="submission-detail-modal"
      >
        <DialogHeader>
          <DialogTitle className="sr-only">Submission detail</DialogTitle>
        </DialogHeader>
        {query.isLoading || !query.data ? (
          query.isError ? (
            <DetailError onRetry={() => query.refetch()} />
          ) : (
            <DetailLoading />
          )
        ) : (
          <DetailBody data={query.data} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailLoading() {
  return (
    <div className="py-16 flex flex-col items-center text-slate-500">
      <Loader2 className="w-6 h-6 animate-spin mb-2" />
      <p className="text-sm">Loading submission…</p>
    </div>
  );
}

function DetailError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="py-16 text-center">
      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
      <p className="text-slate-700 font-medium">Couldn't load this submission.</p>
      <Button variant="outline" className="mt-4" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function DetailBody({ data }: { data: DetailResponse }) {
  const s = data.submission;
  return (
    <div className="space-y-6 pt-2">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <Chip className={sourceBadgeClass(s.source)}>{s.source}</Chip>
          <span className="text-sm text-slate-500">{exactTime(s.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="font-mono">{s.id}</span>
          <button
            type="button"
            onClick={() => void copyToClipboard(s.id, "Submission ID copied")}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Copy submission ID"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Section 1: Lead Info */}
      <Section title="Lead">
        <Grid>
          <KV label="Name" value={`${s.firstName} ${s.lastName}`} />
          <KV label="Email" value={s.email} />
          <KV label="Phone" value={s.phone} />
          <KV label="State" value={s.stateResidence} />
          <KV label="Federal agency" value={s.federalAgency} />
          <KV label="Lead source" value={s.leadSource} />
        </Grid>
      </Section>

      {/* Section 2: Survey Answers */}
      <Section title="Survey answers">
        <Grid>
          {SURVEY_FIELDS.map((f) => {
            const v = s[f.key] as string | null | undefined;
            if (v === null || v === undefined || v === "") return null;
            return <KV key={String(f.key)} label={f.label} value={String(v)} />;
          })}
        </Grid>
      </Section>

      {/* Section 3: Scoring */}
      <Section title="Scoring">
        <div className="flex items-baseline gap-4 mb-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Rank</div>
            <Chip className={rankBadgeClass(s.rank) + " text-base px-3 py-1"}>
              {s.rank ?? "unscored"}
            </Chip>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Lead score</div>
            <div className="text-base text-slate-800 font-medium">
              {s.leadScore ?? <span className="text-slate-400">—</span>}
            </div>
          </div>
        </div>
        <ScoringWhySummary submission={s} />
        {data.ruleSet ? (
          <p className="text-xs text-slate-500">
            Scored by RuleSet v{data.ruleSet.version}: {data.ruleSet.name}
          </p>
        ) : (
          <p className="text-xs text-slate-500 italic">No RuleSet recorded — scoring did not complete.</p>
        )}
        {s.scoringTrace ? (
          <ScoringTraceView trace={s.scoringTrace} />
        ) : (
          <p className="text-xs text-slate-400 mt-3">
            Scoring did not complete — see the Salesforce section below for the error.
          </p>
        )}
      </Section>

      {/* Section 4: Salesforce */}
      <Section title="Salesforce">
        <Grid>
          <div>
            <KVLabel>SF Lead</KVLabel>
            {s.sfLeadId ? (
              <div className="flex items-center gap-2">
                <a
                  href={SF_LEAD_URL(s.sfLeadId)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-indigo-600 hover:underline"
                >
                  {s.sfLeadId}
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => void copyToClipboard(s.sfLeadId!, "SF Lead ID copied")}
                  className="text-slate-400 hover:text-slate-600"
                  aria-label="Copy SF Lead ID"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <span className="text-sm text-slate-500 italic">Not created in Salesforce</span>
            )}
          </div>
          <div>
            <KVLabel>Status</KVLabel>
            <Chip className={sfStatusBadgeClass(s.sfStatus)}>{s.sfStatus}</Chip>
          </div>
          <KV label="Attempts" value={String(s.sfAttempts)} />
          <KV
            label="Last attempt"
            value={s.sfLastAttemptAt ? exactTime(s.sfLastAttemptAt) : "—"}
          />
        </Grid>
        {s.sfError && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-900">
            <span className="font-medium">Error:</span> {s.sfError}
          </div>
        )}
      </Section>

      {/* Section 4b: Hold history — rendered only when this lead passed
          through the valve (released after being held, or discarded). */}
      {(s.releasedBy || s.releasedAt || s.discardedBy || s.discardedAt) && (
        <Section title="Hold history">
          <Grid>
            {s.releasedAt && (
              <KV
                label="Released"
                value={`${exactTime(s.releasedAt)}${s.releasedBy ? ` · ${s.releasedBy}` : ""}`}
              />
            )}
            {s.discardedAt && (
              <KV
                label="Discarded"
                value={`${exactTime(s.discardedAt)}${s.discardedBy ? ` · ${s.discardedBy}` : ""}`}
              />
            )}
          </Grid>
        </Section>
      )}

      {/* Section 5: Raw payload */}
      <Section title="Raw payload">
        <RawPayloadCollapsible payload={s.rawPayload} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components: scoring trace + raw payload + layout primitives
// ---------------------------------------------------------------------------

/** Plain-language line for admins — derived from trace + survey hints. */
function ScoringWhySummary({ submission: s }: { submission: DetailSubmission }) {
  const trace = s.scoringTrace;
  if (!trace) {
    if (s.rank != null || s.leadScore != null) {
      return (
        <div className="mb-3 flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50/95 px-3 py-2.5 text-sm text-amber-950 leading-snug">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" aria-hidden />
          <p>
            No scoring trace was stored for this submission. The rank and lead score
            below are what was saved to the database.
          </p>
        </div>
      );
    }
    return null;
  }

  const firstMatchedIdx = trace.steps.findIndex((st) => st.matched);
  const rank = s.rank ?? trace.finalOutcome.rank ?? "N/A";
  const score = s.leadScore ?? trace.finalOutcome.leadScore;

  let body: string;
  if (firstMatchedIdx === -1) {
    body = `No rule in the published set matched. Default outcome: Rank ${rank}`;
    if (score) body += `, lead score ${score}`;
    body += ".";
    if (s.qPreRetirement === "No") {
      body +=
        " They answered No to wanting a pre-retirement review, so the tiered rules (which all require Yes) did not apply.";
    }
  } else {
    const rule = trace.steps[firstMatchedIdx];
    body = `The first matching rule in the list wins: «${rule.ruleName}». Outcome — Rank ${rank}`;
    if (score) body += `, lead score ${score}`;
    body += ".";
  }

  return (
    <div className="mb-3 flex gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 leading-snug">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
      <p>{body}</p>
    </div>
  );
}

function ScoringTraceView({ trace }: { trace: ScoringTrace }) {
  const [open, setOpen] = useState(false);
  const matched = trace.steps.filter((s) => s.matched).length;
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900"
        aria-expanded={open}
        data-testid="trace-toggle"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {open ? "Hide" : "Show"} scoring trace
        <span className="text-xs text-slate-500 ml-1">
          ({matched}/{trace.steps.length} rules matched)
        </span>
      </button>
      {open && (
        <ol className="mt-3 space-y-3">
          {trace.steps.map((step, i) => (
            <li
              key={step.ruleId + i}
              className="rounded-md border border-slate-200 bg-slate-50/60 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-sm font-medium text-slate-900">{step.ruleName}</div>
                <Chip
                  className={
                    step.matched
                      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                      : "bg-slate-100 text-slate-600 border-slate-200"
                  }
                >
                  {step.matched ? "matched" : "no match"}
                </Chip>
              </div>
              <ul className="space-y-1 text-xs text-slate-700">
                {step.conditions.map((c, ci) => (
                  <li key={ci} className="flex flex-wrap items-center gap-1">
                    <code className="bg-white border border-slate-200 rounded px-1.5 py-0.5 font-mono text-[11px]">
                      {c.field} {c.op}
                      {c.target !== undefined && (
                        <>
                          {" "}'{Array.isArray(c.target) ? c.target.join("|") : c.target}'
                        </>
                      )}
                    </code>
                    <span className={c.result ? "text-emerald-700" : "text-slate-500"}>
                      →{" "}
                      {c.result ? (
                        "matched ✓"
                      ) : (
                        <>
                          no match{" "}
                          <span className="text-slate-400">
                            (actual: {c.actual === null || c.actual === undefined || c.actual === ""
                              ? "—"
                              : `'${c.actual}'`}
                            )
                          </span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RawPayloadCollapsible({ payload }: { payload: unknown }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-sm text-slate-700 hover:text-slate-900"
        aria-expanded={open}
        data-testid="raw-payload-toggle"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {open ? "Hide" : "Show"} raw payload
      </button>
      {open && (
        <pre className="mt-3 max-h-80 overflow-auto rounded-md bg-slate-900 text-slate-100 text-xs p-3 font-mono">
          <code>{JSON.stringify(payload, null, 2)}</code>
        </pre>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-3">{title}</h3>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">{children}</div>;
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <KVLabel>{label}</KVLabel>
      <div className="text-sm text-slate-800 break-words">{value}</div>
    </div>
  );
}

function KVLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">{children}</div>
  );
}
