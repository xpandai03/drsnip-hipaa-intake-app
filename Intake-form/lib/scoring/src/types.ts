// Phase 2 — scoring engine types.
// Mirrors PLAN_PHASE_2.md §5. Engine implementation lands in Sprint 2.

// All form field names the rule engine knows about. Mirrors the FormData
// type in Home.tsx; engine input is camelCase (DB column names are snake_case).
export type LeadField =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "stateResidence"
  | "federalAgency"
  | "speakerRating"
  | "workshopContent"
  | "preRetirementReview"
  | "evalComments"
  | "yearsToRetire"
  | "age"
  | "separating"
  | "maritalStatus"
  | "maxingTsp"
  | "tspContributionPct"
  | "externalInvestments"
  | "tspBalance"
  | "areasOfConcern"
  | "source"
  | "leadSource"
  | "surveyDetail"
  | "campaign"
  | "event";

export type LeadInput = Partial<Record<LeadField, string | null | undefined>>;

export type ConditionOp =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "isNull"
  | "notNull"
  | "contains"
  | "notContains"
  | "matchesRegex";

export type Condition = {
  field: LeadField;
  op: ConditionOp;
  // Required for all ops except isNull / notNull.
  value?: string | string[];
};

// Boolean tree. Mirrors the SF Flow's "1 OR (2 AND 3)" style with
// explicit nesting. Exactly one of { all, any, not } per node.
export type ConditionGroup = {
  all?: Array<Condition | ConditionGroup>;
  any?: Array<Condition | ConditionGroup>;
  not?: Condition | ConditionGroup;
};

// Fields the rule writes when matched. Both optional — a rule can set
// just rank. Kept narrow for v1; future extensibility (setStatus, etc.)
// goes here.
export type Outcome = {
  rank?: "A" | "B+" | "B" | "C" | "N/A";
  // Exact SF picklist string, e.g. "10  (over $1mm)". Note the double-space
  // in "7  ($0-$350k)" and "8  ($351k-$600k)" — picklist values are
  // whitespace-sensitive and must be preserved verbatim.
  leadScore?: string;
};

export type Rule = {
  id: string; // stable uuid; preserved on edit/clone
  name: string;
  description?: string;
  when: ConditionGroup;
  then: Outcome;
};

export type RuleSet = {
  schemaVersion: 1; // bump if RuleSet shape changes
  rules: Rule[]; // evaluated in order; first match wins per output field
  default: Outcome; // applied for any output field still unset
};

// Trace produced by evaluator — stored in submissions.scoring_trace.
export type RuleTraceStep = {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  conditions: Array<{
    field: LeadField;
    op: ConditionOp;
    target?: string | string[];
    actual: string | null | undefined;
    result: boolean;
  }>;
};

export type ScoringTrace = {
  ruleSetId: string;
  ruleSetVersion: number;
  evaluatedAt: string; // ISO timestamp
  steps: RuleTraceStep[];
  finalOutcome: Outcome;
};

export type EvaluateResult = {
  rank: Outcome["rank"];
  leadScore: Outcome["leadScore"];
  trace: ScoringTrace;
};
