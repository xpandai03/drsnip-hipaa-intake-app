// Phase 2 scoring engine — public entry point.
// Sprint 0 ships types + a stub evaluate(). Real evaluator lands in Sprint 2.

import type { EvaluateResult, LeadInput, RuleSet } from "./types.js";

export * from "./types.js";

export function evaluate(ruleSet: RuleSet, lead: LeadInput): EvaluateResult {
  // Stub. Sprint 2 implements the rule walker + trace builder.
  void ruleSet;
  void lead;
  throw new Error(
    "@workspace/scoring: evaluate() is a Sprint 0 stub — Sprint 2 implementation pending",
  );
}
