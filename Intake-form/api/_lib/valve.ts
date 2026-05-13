// Hold-valve gate. Decides whether to skip the Salesforce POST for a
// freshly-scored lead and mark it as 'held' instead.
//
// The check is BYTE-EXACT equality on Lead_Score__c — '7  ($0-$350k)'
// with TWO spaces after the 7. Not a startsWith, not a rank check, not a
// numeric extraction. If the score string drifts (e.g. picklist value
// renamed, a refactor changes the spacing), this gate stops matching and
// 7-scored leads route through to Salesforce as usual — fail-open by
// design, since the valve is a manual-review queue and erring toward
// "still send" is safer than erring toward "silently hold."

export const HOLD_VALVE_KEY = "hold_a7_for_review" as const;
export const HOLD_LEAD_SCORE = "7  ($0-$350k)" as const;

/**
 * Returns true iff the valve is on AND the leadScore is byte-identical to
 * HOLD_LEAD_SCORE. Returns false for any other combination, including:
 *   - valve off (regardless of score)
 *   - leadScore undefined / null
 *   - leadScore that doesn't byte-match (different spacing, different
 *     bucket, short variant like '7' without parens, etc.)
 */
export function shouldHoldLead(
  valveOn: boolean,
  leadScore: string | undefined,
): boolean {
  return valveOn === true && leadScore === HOLD_LEAD_SCORE;
}
