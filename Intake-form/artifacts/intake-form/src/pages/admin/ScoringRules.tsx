import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Info, Mail } from "lucide-react";
import { AdminLayout } from "./AdminLayout";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

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

type GroupedV1 = {
  a59: Rule[];
  a5559: Rule[];
  bplus: Rule;
  c: Rule;
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

/** Matches Tab 1 (Links) primary cards */
const ADMIN_CARD =
  "rounded-3xl shadow-2xl shadow-black/20 border-0 bg-white";

function ScoringRulesPage() {
  const query = useQuery({
    queryKey: ["rules-published"],
    queryFn: fetchPublished,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="min-h-screen pt-16 md:pt-24 pb-28 md:pb-12 px-4 sm:px-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-white">Scoring Rules</h1>
          <p className="text-sm text-white/75 mt-1">
            How each intake submission is ranked — written for the team, not for
            engineers.
          </p>
        </header>

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
  const grouped = tryGroupV1Rules(rules);

  return (
    <>
      <Card className={`${ADMIN_CARD} mb-6 overflow-hidden`}>
        <div className="bg-amber-50/95 border-b border-amber-100 px-5 py-4 flex gap-3 items-start">
          <Info className="w-5 h-5 text-amber-800 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-950 leading-relaxed">
            These are the rules currently scoring all new intake-form submissions.
            Editing is coming in a future update — for changes, contact Raunek.
          </p>
        </div>
      </Card>

      <Card className={`${ADMIN_CARD} p-6 mb-6`}>
        <h2 className="text-lg font-semibold text-slate-900">{data.name}</h2>
        <p className="text-xs text-slate-500 mt-1.5">
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
      </Card>

      {grouped ? (
        <GroupedRulesView grouped={grouped} defaultOutcome={defaultOutcome} />
      ) : (
        <FallbackRulesList rules={rules} defaultOutcome={defaultOutcome} />
      )}

      <footer className="mt-8 text-center">
        <Button asChild variant="outline" data-testid="request-rule-change" className="bg-white/95 border-white/30 text-slate-800 hover:bg-white">
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
// V1 grouping — structure-based (no backend import). Falls back if shape
// drifts from the seeded 12-rule set.
// ---------------------------------------------------------------------------

function isGroup(node: Condition | ConditionGroup): node is ConditionGroup {
  return "all" in node || "any" in node || "not" in node;
}

function flattenAllLeaves(when: ConditionGroup): Condition[] | null {
  if (!when.all?.length) return null;
  for (const node of when.all) {
    if (isGroup(node)) return null;
  }
  return when.all as Condition[];
}

function classifyA(rule: Rule): "a59" | "a5559" | null {
  if (rule.then.rank !== "A") return null;
  const leaves = flattenAllLeaves(rule.when);
  if (!leaves) return null;
  const age59 = leaves.some((l) => l.field === "age" && l.value === "59 1/2 or over");
  const age5559 = leaves.some((l) => l.field === "age" && l.value === "55 - 59");
  const separating = leaves.some(
    (l) => l.field === "separating" && l.value === "YES",
  );
  if (age59) return "a59";
  if (age5559 && separating) return "a5559";
  return null;
}

function tspBalanceValue(rule: Rule): string | null {
  const leaves = flattenAllLeaves(rule.when);
  const t = leaves?.find((l) => l.field === "tspBalance");
  return typeof t?.value === "string" ? t.value : null;
}

function sortATierRules(rules: Rule[]): Rule[] {
  const order = [
    "Over $1 million",
    "$600k - $1 million",
    "$350k - $600k",
    "Under $350k",
  ];
  return [...rules].sort((a, b) => {
    const ta = tspBalanceValue(a);
    const tb = tspBalanceValue(b);
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return order.indexOf(ta) - order.indexOf(tb);
  });
}

function tryGroupV1Rules(rules: Rule[]): GroupedV1 | null {
  const a59: Rule[] = [];
  const a5559: Rule[] = [];
  let bplus: Rule | null = null;
  let c: Rule | null = null;
  const unknown: Rule[] = [];

  for (const rule of rules) {
    if (rule.then.rank === "B+") {
      if (bplus) unknown.push(rule);
      else bplus = rule;
      continue;
    }
    if (rule.then.rank === "C") {
      if (c) unknown.push(rule);
      else c = rule;
      continue;
    }
    const kind = classifyA(rule);
    if (kind === "a59") a59.push(rule);
    else if (kind === "a5559") a5559.push(rule);
    else unknown.push(rule);
  }

  if (unknown.length > 0 || !bplus || !c) return null;
  if (a59.length !== 5 || a5559.length !== 5) return null;

  return {
    a59: sortATierRules(a59),
    a5559: sortATierRules(a5559),
    bplus,
    c,
  };
}

// ---------------------------------------------------------------------------
// Grouped “office manager” view
// ---------------------------------------------------------------------------

const TSP_LABEL: Record<string, string> = {
  "Over $1 million": "Over $1 million",
  "$600k - $1 million": "$600K – $1 million",
  "$350k - $600k": "$350K – $600K",
  "Under $350k": "Under $350K",
};

function formatTspRowLabel(raw: string | null): string {
  if (!raw) return "TSP balance not answered on the form";
  return TSP_LABEL[raw] ?? raw;
}

function leadScorePhrase(rule: Rule): string {
  if (rule.then.leadScore) return rule.then.leadScore;
  if (rule.then.rank === "A") return "Rank A — no numeric lead score (balance missing)";
  return "—";
}

function GroupedRulesView({
  grouped,
  defaultOutcome,
}: {
  grouped: GroupedV1;
  defaultOutcome: Outcome;
}) {
  return (
    <div className="space-y-6">
      <ATierSection
        title="A-tier — top priority (age 59½ or older)"
        subtitle="When someone is at or past 59½, wants a review, and we can size their TSP bucket."
        intro="These leads get a numeric lead score in Salesforce so the team can prioritize callbacks."
        qualifying={
          <>
            <li>Wants a complimentary pre-retirement review: Yes</li>
            <li>Age: 59½ or older</li>
          </>
        }
        rules={grouped.a59}
        rankBadgeClass="bg-emerald-100 text-emerald-900 border-emerald-200/80"
      />

      <ATierSection
        title="A-tier — top priority (ages 55–59, separating soon)"
        subtitle="When someone is 55–59, indicated they are separating from federal service within two months (or already separated), wants a review, and we have a TSP bracket."
        intro="Same A-rank treatment and lead scores as the 59½ path — the form captures this alternate high-intent scenario."
        qualifying={
          <>
            <li>Wants a complimentary pre-retirement review: Yes</li>
            <li>Age: 55–59</li>
            <li>Separating from service within two months (or already separated): Yes</li>
          </>
        }
        rules={grouped.a5559}
        rankBadgeClass="bg-emerald-100 text-emerald-900 border-emerald-200/80"
      />

      <SimpleTierCard
        rank="B+"
        badgeClass="bg-sky-100 text-sky-900 border-sky-200/80"
        title="B+ tier — disciplined savers"
        description="Strong savings habits even when they are not in the A-tier age/TSP paths above."
        body={
          <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
            <p className="font-medium text-slate-900">Qualifying criteria</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Wants a complimentary pre-retirement review: Yes</li>
              <li>Maxing TSP / 401(k) / 403(b) / 457 contributions: Yes</li>
              <li>Also contributing elsewhere (brokerage, IRA, savings, etc.): Yes</li>
            </ul>
            <Separator className="my-4" />
            <p>
              <span className="font-medium text-slate-900">Result:</span> Rank{" "}
              <Badge variant="outline" className="mx-1 font-semibold border-sky-200 bg-sky-50">
                B+
              </Badge>
              — no numeric lead score (only A-tier receives a score today).
            </p>
          </div>
        }
      />

      <SimpleTierCard
        rank="C"
        badgeClass="bg-slate-200 text-slate-900 border-slate-300/80"
        title="C tier — general catch-all"
        description="They completed enough of the survey to score, but they do not land in A or B+."
        body={
          <div className="space-y-3 text-sm text-slate-700 leading-relaxed">
            <p className="font-medium text-slate-900">Qualifying criteria</p>
            <p className="text-slate-600">
              Wants a review, and the key survey fields needed for routing are all
              filled in — but the answers do not match the A or B+ patterns.
            </p>
            <Separator className="my-4" />
            <p>
              <span className="font-medium text-slate-900">Result:</span> Rank{" "}
              <Badge variant="outline" className="mx-1 font-semibold border-slate-300 bg-slate-50">
                C
              </Badge>
              — no numeric lead score.
            </p>
          </div>
        }
      />

      <Card className={`${ADMIN_CARD} p-6`}>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <Badge variant="outline" className="border-slate-300 bg-slate-100 text-slate-800 font-semibold">
            N/A
          </Badge>
          <h3 className="text-lg font-semibold text-slate-900">If nothing above matches</h3>
        </div>
        <CardDescription className="text-slate-600 text-sm leading-relaxed">
          If none of the situations above apply — for example, they said they do not
          want a pre-retirement review yet — the lead is marked{" "}
          <span className="font-medium text-slate-800">N/A</span> (not yet qualified
          for a scored priority track).{" "}
          <span className="text-slate-700">{outcomeFriendlySentence(defaultOutcome)}</span>
        </CardDescription>
      </Card>
    </div>
  );
}

function ATierSection({
  title,
  subtitle,
  intro,
  qualifying,
  rules,
  rankBadgeClass,
}: {
  title: string;
  subtitle: string;
  intro: string;
  qualifying: ReactNode;
  rules: Rule[];
  rankBadgeClass: string;
}) {
  return (
    <Card className={`${ADMIN_CARD} overflow-hidden`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2 gap-y-2">
          <Badge variant="outline" className={`font-semibold ${rankBadgeClass}`}>
            A
          </Badge>
          <CardTitle className="text-xl font-semibold text-slate-900 leading-snug">
            {title}
          </CardTitle>
        </div>
        <CardDescription className="text-slate-600 text-base leading-relaxed">
          {subtitle}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-2">
        <p className="text-sm text-slate-700 leading-relaxed">{intro}</p>
        <div>
          <p className="text-sm font-semibold text-slate-900 mb-2">Shared qualifying criteria</p>
          <ul className="list-disc pl-5 text-sm text-slate-700 space-y-1">{qualifying}</ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-900 mb-3">
            Lead score depends on TSP balance
          </p>
          <div className="hidden md:block rounded-2xl border border-slate-200 overflow-hidden">
            <div className="grid grid-cols-2 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500 px-4 py-2.5 gap-4">
              <span>TSP balance (from the form)</span>
              <span>Lead score in Salesforce</span>
            </div>
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="grid grid-cols-2 px-4 py-3 text-sm border-t border-slate-100 text-slate-800 gap-4 items-start"
              >
                <span>{formatTspRowLabel(tspBalanceValue(rule))}</span>
                <span className="font-medium text-slate-900 tabular-nums">
                  {leadScorePhrase(rule)}
                </span>
              </div>
            ))}
          </div>
          <div className="md:hidden space-y-3">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="rounded-2xl border border-slate-200 bg-slate-50/50 px-4 py-3 space-y-1"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  TSP balance
                </div>
                <div className="text-sm text-slate-900">{formatTspRowLabel(tspBalanceValue(rule))}</div>
                <Separator className="my-2" />
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Lead score
                </div>
                <div className="text-sm font-medium text-slate-900">{leadScorePhrase(rule)}</div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SimpleTierCard({
  rank,
  badgeClass,
  title,
  description,
  body,
}: {
  rank: string;
  badgeClass: string;
  title: string;
  description: string;
  body: ReactNode;
}) {
  return (
    <Card className={`${ADMIN_CARD} overflow-hidden`}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={`font-semibold ${badgeClass}`}>
            {rank}
          </Badge>
          <CardTitle className="text-xl font-semibold text-slate-900">{title}</CardTitle>
        </div>
        <CardDescription className="text-slate-600 text-base leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function outcomeFriendlySentence(o: Outcome): string {
  if (o.rank === "N/A" && !o.leadScore) {
    return "That is the default outcome today.";
  }
  return outcomeToText(o);
}

// ---------------------------------------------------------------------------
// Fallback list — same data, friendlier than the old code-style view
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  preRetirementReview: "Wants a pre-retirement review",
  age: "Age",
  separating: "Separating from federal service (next two months or already)",
  maxingTsp: "Maxing TSP / plan contributions",
  externalInvestments: "Contributing elsewhere (IRA, brokerage, etc.)",
  tspBalance: "TSP balance bracket",
  maritalStatus: "Marital status",
  yearsToRetire: "Years to retirement",
  tspContributionPct: "TSP contribution %",
  areasOfConcern: "Areas of concern",
  federalAgency: "Federal agency",
  source: "Intake channel",
};

const OP_LABELS: Record<string, string> = {
  equals: "is",
  notEquals: "is not",
  in: "is one of",
  notIn: "is none of",
  isNull: "was not answered",
  notNull: "was answered",
  contains: "contains",
  notContains: "does not contain",
  matchesRegex: "matches pattern",
};

function FallbackRulesList({
  rules,
  defaultOutcome,
}: {
  rules: Rule[];
  defaultOutcome: Outcome;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-white/80 px-1">
        This rule set uses a layout we don&apos;t have a custom summary for yet —
        each rule is listed below in plain language.
      </p>
      {rules.map((rule, idx) => (
        <Card key={rule.id} className={`${ADMIN_CARD} p-6`}>
          <div className="flex flex-wrap items-baseline gap-2 mb-2">
            <span className="text-xs font-medium text-slate-400">Rule {idx + 1}</span>
            <h3 className="text-base font-semibold text-slate-900">{rule.name}</h3>
          </div>
          {rule.description && (
            <p className="text-sm text-slate-600 mb-3">{rule.description}</p>
          )}
          <Separator className="my-4" />
          <p className="text-sm font-medium text-slate-900 mb-2">When all of the following apply</p>
          <div className="text-sm text-slate-700 leading-relaxed">
            <ConditionRenderer node={rule.when} top />
          </div>
          <Separator className="my-4" />
          <p className="text-sm text-slate-800">
            <span className="font-medium text-slate-900">Then: </span>
            {outcomeToText(rule.then)}
          </p>
        </Card>
      ))}
      <Card className={`${ADMIN_CARD} p-6`}>
        <h3 className="text-sm font-semibold text-slate-900 mb-2">If no rules match</h3>
        <p className="text-sm text-slate-700 leading-relaxed">{outcomeFriendlySentence(defaultOutcome)}</p>
      </Card>
    </div>
  );
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
          conjunction="and"
          renderItem={(c) => <ConditionRenderer node={c} />}
          parens={!top}
        />
      );
    }
    if (node.any && node.any.length > 0) {
      return (
        <ListJoin
          items={node.any}
          conjunction="or"
          renderItem={(c) => <ConditionRenderer node={c} />}
          parens={!top}
        />
      );
    }
    if (node.not) {
      return (
        <span>
          Not: (<ConditionRenderer node={node.not} />)
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
  const needsValue = condition.op !== "isNull" && condition.op !== "notNull";
  return (
    <span className="inline leading-7">
      <span className="text-slate-900 font-medium">{fieldLabel}</span>{" "}
      <span className="text-slate-600">{opLabel}</span>
      {needsValue && condition.value !== undefined && (
        <>
          {" "}
          <span className="text-slate-800 bg-slate-100/90 rounded-md px-2 py-0.5 font-medium">
            {Array.isArray(condition.value)
              ? condition.value.join(", ")
              : formatValueDisplay(condition.value)}
          </span>
        </>
      )}
    </span>
  );
}

function formatValueDisplay(v: string): string {
  if (v === "59 1/2 or over") return "59½ or over";
  return v;
}

function ListJoin<T>({
  items,
  conjunction,
  renderItem,
  parens,
}: {
  items: T[];
  conjunction: "and" | "or";
  renderItem: (item: T, i: number) => React.ReactNode;
  parens: boolean;
}) {
  const glue = conjunction === "and" ? " · " : " or ";
  return (
    <span>
      {parens && <span className="text-slate-400">(</span>}
      {items.map((item, i) => (
        <span key={i}>
          {renderItem(item, i)}
          {i < items.length - 1 && <span className="text-slate-500 font-medium">{glue}</span>}
        </span>
      ))}
      {parens && <span className="text-slate-400">)</span>}
    </span>
  );
}

function outcomeToText(outcome: Outcome): string {
  const parts: string[] = [];
  if (outcome.rank) parts.push(`Rank ${outcome.rank}`);
  if (outcome.leadScore) parts.push(`Lead score: ${outcome.leadScore}`);
  if (parts.length === 0) return "No rank or score is assigned.";
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Loading / error states
// ---------------------------------------------------------------------------

function RulesSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-20 rounded-3xl" />
      <Skeleton className="h-24 rounded-3xl" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-40 rounded-3xl" />
      ))}
    </div>
  );
}

function RulesError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={`${ADMIN_CARD} py-16 text-center px-4`}>
      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-3" />
      <p className="text-slate-700 font-medium">Couldn&apos;t load scoring rules.</p>
      <p className="text-sm text-slate-500 mt-1">
        Network or server error. Try again in a moment.
      </p>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        Retry
      </Button>
    </div>
  );
}
