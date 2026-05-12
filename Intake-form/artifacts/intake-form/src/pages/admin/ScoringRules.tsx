import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Info, Mail } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Types — mirror /api/rules/published. The `rules` field is the full
// RuleSet JSON; we only annotate the fields used here.
// ---------------------------------------------------------------------------

type Condition = {
  field: string;
  op: string;
  value?: string | string[];
};

type ConditionGroup = {
  all?: Array<Condition | ConditionGroup>;
  any?: Array<Condition | ConditionGroup>;
  not?: Condition | ConditionGroup;
};

type Outcome = { rank?: string; leadScore?: string };

type Rule = {
  id: string;
  name: string;
  description?: string;
  when: ConditionGroup;
  then: Outcome;
};

type RuleSet = {
  schemaVersion: number;
  rules: Rule[];
  default: Outcome;
};

type PublishedRuleSet = {
  id: string;
  version: number;
  name: string;
  rules: RuleSet;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
};

async function fetchPublished(): Promise<PublishedRuleSet> {
  const res = await fetch(`/api/rules/published`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`/api/rules/published returned ${res.status}`);
  return (await res.json()) as PublishedRuleSet;
}

// ---------------------------------------------------------------------------
// Page wrapper + body
// ---------------------------------------------------------------------------

export default function AdminScoringRules() {
  return (
    <AdminLayout>
      <ScoringRulesPage />
    </AdminLayout>
  );
}

const MAILTO_HREF =
  "mailto:raunek@xpandai.com?subject=" +
  encodeURIComponent("CJC Intake — scoring rule change request") +
  "&body=" +
  encodeURIComponent(
    [
      "Hi Raunek,",
      "",
      "I'd like to request a change to the scoring rules.",
      "",
      "Rule(s) to change:",
      "",
      "What should change:",
      "",
      "Why:",
      "",
      "Thanks!",
    ].join("\n"),
  );

function ScoringRulesPage() {
  const query = useQuery({
    queryKey: ["rules-published"],
    queryFn: fetchPublished,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="min-h-screen bg-slate-50 pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">Scoring Rules</h1>
          <p className="text-sm text-slate-500 mt-1">
            A plain-English view of how every intake-form submission is scored.
          </p>
        </header>

        <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 mb-6 flex gap-3 items-start">
          <Info className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-900">
            These are the rules currently scoring all new intake-form submissions.
            Editing is coming in a future update — for changes, contact Raunek.
          </p>
        </div>

        {query.isLoading ? (
          <RulesSkeleton />
        ) : query.isError ? (
          <RulesError onRetry={() => query.refetch()} />
        ) : query.data ? (
          <RulesBody data={query.data} />
        ) : null}
      </div>
    </div>
  );
}

function RulesBody({ data }: { data: PublishedRuleSet }) {
  const { rules, default: defaultOutcome } = data.rules;

  return (
    <>
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mb-6">
        <h2 className="text-lg font-semibold text-slate-900">
          {data.name}
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          Version <span className="font-medium text-slate-700">v{data.version}</span>
          {data.publishedBy && data.publishedAt && (
            <>
              {" · Published by "}
              <span className="font-medium text-slate-700">{data.publishedBy}</span>
              {" on "}
              <span className="font-medium text-slate-700">
                {new Date(data.publishedAt).toLocaleDateString()}
              </span>
            </>
          )}
        </p>
      </section>

      <section className="space-y-3">
        {rules.map((rule, idx) => (
          <RuleCard key={rule.id} rule={rule} number={idx + 1} />
        ))}
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 mt-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-2">If no rules match</h3>
        <p className="text-sm text-slate-700">{outcomeToText(defaultOutcome)}</p>
      </section>

      <footer className="mt-8 text-center">
        <Button asChild variant="outline" data-testid="request-rule-change">
          <a href={MAILTO_HREF}>
            <Mail className="w-4 h-4" />
            Request a rule change
          </a>
        </Button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Rule card — renders one rule in plain English.
// ---------------------------------------------------------------------------

function RuleCard({ rule, number }: { rule: Rule; number: number }) {
  return (
    <article className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-baseline gap-3">
        <span className="text-xs font-mono text-slate-400">#{number}</span>
        <h3 className="text-base font-semibold text-slate-900">{rule.name}</h3>
      </div>
      {rule.description && (
        <p className="text-sm text-slate-500 mt-1.5">{rule.description}</p>
      )}
      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-1.5">
          When
        </div>
        <div className="text-sm text-slate-800 leading-relaxed">
          <ConditionRenderer node={rule.when} top />
        </div>
      </div>
      <div className="mt-4">
        <div className="text-xs uppercase tracking-wide font-semibold text-slate-500 mb-1.5">
          Then
        </div>
        <div className="text-sm text-slate-800">{outcomeToText(rule.then)}</div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Plain-English rendering of conditions + outcomes
// ---------------------------------------------------------------------------

// Friendly labels for engine field names. Anything not listed falls back to
// the raw camelCase identifier so a new field still renders (just less prettily).
const FIELD_LABELS: Record<string, string> = {
  preRetirementReview: "pre-retirement review requested",
  age: "age bracket",
  separating: "separating from service",
  maxingTsp: "maxing out TSP",
  externalInvestments: "external investments",
  tspBalance: "TSP balance",
  maritalStatus: "marital status",
  yearsToRetire: "years to retirement",
  tspContributionPct: "TSP contribution %",
  areasOfConcern: "areas of concern",
  federalAgency: "federal agency",
  source: "intake channel",
};

const OP_LABELS: Record<string, string> = {
  equals: "is",
  notEquals: "is not",
  in: "is one of",
  notIn: "is none of",
  isNull: "is empty",
  notNull: "is set",
  contains: "contains",
  notContains: "does not contain",
  matchesRegex: "matches",
};

function isGroup(node: Condition | ConditionGroup): node is ConditionGroup {
  return "all" in node || "any" in node || "not" in node;
}

function ConditionRenderer({
  node,
  top = false,
}: {
  node: Condition | ConditionGroup;
  top?: boolean;
}) {
  if (isGroup(node)) {
    if (node.all && node.all.length > 0) {
      return (
        <ListJoin
          items={node.all}
          conjunction="AND"
          renderItem={(c) => <ConditionRenderer node={c} />}
          parens={!top}
        />
      );
    }
    if (node.any && node.any.length > 0) {
      return (
        <ListJoin
          items={node.any}
          conjunction="OR"
          renderItem={(c) => <ConditionRenderer node={c} />}
          parens={!top}
        />
      );
    }
    if (node.not) {
      return (
        <span>
          NOT (<ConditionRenderer node={node.not} />)
        </span>
      );
    }
    return <span className="italic text-slate-400">(empty group)</span>;
  }
  return <ConditionLeaf condition={node} />;
}

function ConditionLeaf({ condition }: { condition: Condition }) {
  const fieldLabel = FIELD_LABELS[condition.field] ?? condition.field;
  const opLabel = OP_LABELS[condition.op] ?? condition.op;
  const needsValue =
    condition.op !== "isNull" && condition.op !== "notNull";
  return (
    <span>
      <span className="font-mono text-[12px] bg-slate-100 rounded px-1.5 py-0.5">
        {fieldLabel}
      </span>{" "}
      <span className="text-slate-600">{opLabel}</span>
      {needsValue && condition.value !== undefined && (
        <>
          {" "}
          <span className="font-mono text-[12px] bg-emerald-50 text-emerald-800 rounded px-1.5 py-0.5">
            {Array.isArray(condition.value)
              ? condition.value.map((v) => `"${v}"`).join(" | ")
              : `"${condition.value}"`}
          </span>
        </>
      )}
    </span>
  );
}

function ListJoin<T>({
  items,
  conjunction,
  renderItem,
  parens,
}: {
  items: T[];
  conjunction: "AND" | "OR";
  renderItem: (item: T, i: number) => React.ReactNode;
  parens: boolean;
}) {
  return (
    <span>
      {parens && <span className="text-slate-400">(</span>}
      {items.map((item, i) => (
        <span key={i}>
          {renderItem(item, i)}
          {i < items.length - 1 && (
            <span className="text-slate-500 font-semibold mx-1">{conjunction}</span>
          )}
        </span>
      ))}
      {parens && <span className="text-slate-400">)</span>}
    </span>
  );
}

function outcomeToText(outcome: Outcome): string {
  const parts: string[] = [];
  if (outcome.rank) parts.push(`assign Rank "${outcome.rank}"`);
  if (outcome.leadScore) parts.push(`assign Lead Score "${outcome.leadScore}"`);
  if (parts.length === 0) return "no outcome (no fields set)";
  return parts.join(" and ");
}

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

function RulesSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 rounded-2xl" />
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-32 rounded-2xl" />
      ))}
    </div>
  );
}

function RulesError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm py-16 text-center">
      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
      <p className="text-slate-700 font-medium">Couldn't load scoring rules.</p>
      <p className="text-sm text-slate-500 mt-1">
        Network or server error. Try again in a moment.
      </p>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        Retry
      </Button>
    </div>
  );
}
