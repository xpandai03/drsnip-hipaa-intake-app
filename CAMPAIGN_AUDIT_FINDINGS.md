# Campaign Audit Findings

Investigation date: 2026-05-06
Trigger: Mel from CJC pushed back on Phase 1 audit Finding #1 ("Channels not differentiated in data") — claimed channel tracking happens through Salesforce Campaigns, not Lead Source.
Verdict: **PARTIALLY YES — Mel is substantially right.** Finding #1 needs to be revised.

---

## Executive summary

Channel tracking does happen through Salesforce Campaigns, not Lead Source. The mechanism is the `LeadHandler.addLeadInCampaign` Apex method that fires after every Lead insert; it inspects `Lead.Survey_Detail__c` to route SOFA-direct (`DC SOFA 2` → "INTERNAL MARKETING" Campaign) and FNN (`DC SOFA 3` → FNN Campaign) leads, and otherwise resolves `Lead.Federal_Agency__c` through the `Agency_Mapping__mdt` custom metadata to attach the Lead to the most-recently-completed federal-agency Campaign matching `Campaign.FedralAgency__c` (sic — typo on the field).

Coverage is **98.6%** of recent Leads (351 of 356), distribution is clean (85.8% of covered Leads belong to exactly one Campaign), and the channel signal is meaningfully differentiated: **88.7%** of new memberships are agency-direct (47 distinct federal-agency Campaigns), **10.7%** are SOFA internal marketing (1 Campaign), and **0.6%** are FNN — completely contradicting the picture from Lead Source where 348/356 Leads were hardcoded to `"SOFA: Webinar"` regardless of true channel.

**Caveat 1**: because Apex picks "most recent COMPLETED matching Campaign" rather than the actual webinar the Lead came from, per-event attribution is lossy. Example: Joey Cizauskas was attached to a 2024-11-21 FWS Campaign on 2026-04-30 — channel correct, event wrong.

**Caveat 2**: Campaign assignment depends entirely on `Survey_Detail__c` and `Federal_Agency__c` being populated correctly upstream. If a Zap omits or mis-populates either field, the Lead either falls through to a wrong Campaign or joins none.

So Finding #1 in the audit ("Channels not differentiated in data") needs revision: **channels ARE differentiated — in Campaigns, via Apex, driven by `Survey_Detail__c` + `Federal_Agency__c`. The upstream Zap field mappings to those two fields are the real audit target, not Lead Source.**

---

## The actual mechanism

### Apex trigger chain on Lead insert

`LeadTrigger` (after-insert) → `LeadHandler.addLeadInCampaign(Trigger.new)`

The 3 Flows from the original audit (`Lead_Campaign_Member`, `Create_Campaign_Member_from_Lead_Detail`, `Add_Campain_Member_In_Campaign` [sic]) are **Screen Flows** (`ProcessType=Flow`, `TriggerType=null`) — manually invoked from a UI button. They are NOT what auto-creates CampaignMembers. They are red herrings.

### addLeadInCampaign decision logic (paraphrased)

```apex
public static void addLeadInCampaign(List<Lead> newLeadList) {
    Lead l = newLeadList[0];

    // Build agencySet from Federal_Agency__c via Agency_Mapping__mdt
    Set<String> agencySet = new Set<String>();
    Boolean flag = false;
    for (Agency_Mapping__mdt am : [SELECT Category__c, Sub_Category__c
                                   FROM Agency_Mapping__mdt
                                   WHERE Sub_Category__c = :l.Federal_Agency__c]) {
        if (am.Category__c != am.Sub_Category__c) {
            agencySet.add(am.Category__c);
            agencySet.add(am.Sub_Category__c);
        } else { flag = true; }
    }
    if (flag) {
        for (Agency_Mapping__mdt am : [SELECT Category__c, Sub_Category__c
                                       FROM Agency_Mapping__mdt
                                       WHERE Category__c = :l.Federal_Agency__c]) {
            agencySet.add(am.Sub_Category__c);
        }
    }
    if (agencySet.isEmpty()) agencySet.add(l.Federal_Agency__c);

    // Pick a Campaign based on Survey_Detail__c
    List<Campaign> cmp;
    if (l.Survey_Detail__c == 'DC SOFA 3') {
        cmp = [SELECT Id, Name FROM Campaign
               WHERE Name LIKE '%FNN%' AND Status = 'Completed'
                 AND StartDate <= :System.today()
               ORDER BY StartDate DESC LIMIT 1];
    } else if (l.Survey_Detail__c == 'DC SOFA 2') {
        cmp = [SELECT Id, Name FROM Campaign
               WHERE Name LIKE '%INTERNAL MARKETING%' AND Status = 'Completed'
                 AND StartDate <= :System.today()
               ORDER BY StartDate DESC LIMIT 1];
    } else {
        cmp = [SELECT Id, Name, FedralAgency__c FROM Campaign
               WHERE FedralAgency__c IN :agencySet
                 AND Status = 'Completed'
                 AND StartDate <= :System.today()
               ORDER BY StartDate DESC LIMIT 1];
    }

    // Insert CampaignMember
    if (!cmp.isEmpty()) {
        CampaignMember cmpMember = new CampaignMember();
        cmpMember.CampaignId = cmp[0].Id;
        cmpMember.LeadId = l.Id;
        // (Type and Status set elsewhere)
        insert cmpMember;
    }
}
```

⚠️ **In the actual source, the original guard `if (l.SurveyId__c != null && l.Duplicate_Lead__c == false)` is COMMENTED OUT** — the method runs unconditionally on every Lead insert. That's why coverage is 98.6% rather than restricted to survey-sourced leads.

⚠️ **Field name typo on Campaign**: `FedralAgency__c` (sic — missing "e"). Required when querying Campaigns directly.

Full source preserved at `/tmp/LeadHandler_addLeadInCampaign.apex`.

---

## Coverage numbers

### Q4 — 30-day coverage

| Metric | Value |
|---|---|
| Leads created in last 30d | 356 |
| Distinct Leads with ≥1 CampaignMember | 351 |
| **Coverage** | **98.6%** |
| Leads with NO Campaign membership | 5 |
| Total CampaignMember rows in the period | 420 |

### Q5 — Multi-Campaign distribution per Lead

| Campaigns per Lead | Leads | % of covered |
|---|---|---|
| 1 | 301 | 85.8% |
| 2 | 39 | 11.1% |
| 3 | 6 | 1.7% |
| 4 | 4 | 1.1% |
| 7 | 1 | 0.3% |

Most recently-created Leads belong to exactly one Campaign — clean 1:1 channel mapping.

---

## Channel distribution — truth vs. Lead Source lie

### Q6 — Channel breakdown of all 629 new memberships in last 30 days

| Channel | Campaigns | Members | % |
|---|---|---|---|
| Federal agency / direct | 47 | 558 | **88.7%** |
| SOFA (internal marketing) | 1 | 67 | **10.7%** |
| FNN Marketing | 2 | 4 | 0.6% |

### The discrepancy

| Metric | Lead Source field | Campaign membership |
|---|---|---|
| % of recent Leads tagged "SOFA" | 97.8% (348/356) | 10.7% (67/629 memberships) |
| Source of the value | Hardcoded by Zaps | Computed by Apex from Lead fields |
| Differentiates federal agency? | No | Yes (47 distinct agency Campaigns) |
| Useful for channel attribution? | No | Yes |

The Lead Source field is **lying** because the 5 production Zaps hardcode `Lead Source = "SOFA: Webinar"` for every lead regardless of true channel. The Campaign field tells the truth.

### Top 15 Campaigns by new-Member inflow (last 30d)

| Members | Campaign |
|---|---|
| 67 | Health and Human Svcs (HHS) HQ-Webinar-2026-04-15-Stewart |
| 67 | SOFA-Webinar-2026-04-21-INTERNAL MARKETING |
| 41 | Health and Human Svcs (HHS) HQ-Webinar-2026-04-16-Bossart |
| 39 | General Svcs Administration (GSA)-Webinar-2026-04-01-Jenkinson |
| 38 | Health and Human Svcs (HHS) HQ-Webinar-2026-04-29-Stewart |
| 32 | NASA-Webinar-2026-04-09-Madigan |
| 27 | NASA-Webinar-2026-04-14-Madigan |
| 24 | Smithsonian-Webinar-2026-04-09-Hicks |
| 24 | Centers for Medicare & Medicaid (CMS)-Webinar-2026-04-14-Souweine |
| 22 | NASA-Webinar-2026-04-28-Madigan |
| 18 | NASA-Webinar-2026-04-30-Madigan |
| 16 | Federal Deposit Insurance Corp (FDIC)-Webinar-2026-04-21-Rabba |
| 16 | Dept of Education-Webinar-2026-04-07-Dupree |
| 15 | Peace Corps-Webinar-2026-05-06-Shelton |
| 15 | FCC-Webinar-2026-04-08-Alston |

---

## Per-event attribution issue

The Apex query selects "most recent COMPLETED Campaign matching the channel/agency criterion." This means the Lead is attached to the most-recent past webinar for that channel — not necessarily the webinar the Lead actually came from.

### Example from Q3 sample

| Lead | Lead created | Campaign attached | Campaign date |
|---|---|---|---|
| Rosatina Chan (00QUU00000TTrmc2AD) | 2026-05-01 | NASA-Webinar-2026-04-30-Madigan | 2026-04-30 |
| Behnaz Beigi (00QUU00000TTNi62AH) | 2026-04-30 | NASA-Webinar-2026-04-30-Madigan | 2026-04-30 |
| Lui Wang (00QUU00000TTOuI2AX) | 2026-04-30 | NASA-Webinar-2026-04-30-Madigan | 2026-04-30 |
| Joey Cizauskas (00QUU00000TTOFz2AP) | 2026-04-30 | **FWS-Webinar-2024-11-21-Sasnett** | **2024-11-21** ⚠️ |

The 3 NASA leads landed on a same-day Campaign (good attribution). The FWS lead landed on a **17-month-old** Campaign because no newer FWS Campaign existed in `Status = 'Completed'`. Channel (FWS) is correct; specific event isn't.

### Implication

For per-channel rollups, the Campaign assignment is reliable. For per-event attribution (e.g., "how many leads did the 2026-04-29 FWS webinar produce?"), it is unreliable — Leads from that webinar may attach to an earlier Campaign if the 2026-04-29 one isn't yet marked `Status = 'Completed'` at the time the Lead is inserted.

### Bryan Tucker — invalid Lead ID

The audit-provided Lead ID `00QUPyQ2AX` for Bryan Tucker is malformed (10 chars; SF IDs are 15 or 18). SOQL rejected it. The audit doc almost certainly has a copy-paste truncation; the original ID likely starts `00QUU00000TTPyQ2AX` based on adjacent IDs in the same batch.

---

## Field dependencies

Channel routing relies on these Lead fields being populated correctly upstream by the Zaps:

### `Survey_Detail__c`
- `'DC SOFA 3'` → routes to most-recent completed Campaign with name LIKE '%FNN%'
- `'DC SOFA 2'` → routes to most-recent completed Campaign with name LIKE '%INTERNAL MARKETING%'
- Any other value (or null) → falls through to Federal_Agency__c logic

### `Federal_Agency__c`
- Looked up against `Agency_Mapping__mdt.Sub_Category__c` (and Category__c)
- The matched mapping's Category/Sub-Category set is then matched against `Campaign.FedralAgency__c`
- If `Federal_Agency__c` is null or has no mapping entry, the lead may attach to no Campaign

The full Agency_Mapping__mdt table (71 records) is preserved at `/tmp/agency_mapping.json`. Notable shape: Sub_Category values for sub-agencies are prefixed with `'    ► '` (4 spaces + ► + space) — e.g., `'    ► Dept of the Interior (DOI): Fish and Wildlife Service (FWS)'`. This whitespace prefix matters for matching.

### Other Lead fields the Apex inspects (less central)
- `RecordTypeId` — must match `Lead.RecordType.DeveloperName = 'Federal'` for duplicate-checking branches to fire
- `SurveyId__c`, `ResponseId__c`, `Sofa_Consultation_Survey_*__c` — used by `updateEvalType`/`createContentNote`, separate from Campaign assignment
- `Allow_Duplicate__c` — duplicate-handling toggle

---

## Revisions needed to the original Phase 1 audit doc

1. **Finding #1 ("Channels not differentiated in data") — MUST BE REVISED.** Channels ARE differentiated, in Campaigns. Replace the finding with: *"Lead Source is hardcoded to `'SOFA: Webinar'` by all 5 production Zaps and is unreliable for channel attribution. Channel signal is correctly captured in CampaignMember.CampaignId via `LeadHandler.addLeadInCampaign` Apex logic, driven by `Lead.Survey_Detail__c` and `Lead.Federal_Agency__c`."*

2. **Reframe the Phase 1 build target.** The action item is no longer "differentiate channels in Lead Source"; it's "verify the 5 Zaps populate `Survey_Detail__c` and `Federal_Agency__c` correctly so Apex can route." This is a different, narrower, and less invasive change.

3. **Remove the 3 named Flows from the audit's automation inventory** (or move them to a separate "manually-invoked Screen Flows" section). They have `TriggerType = null` and `ProcessType = Flow` — they are not record-triggered, do not auto-fire on Lead insert, and are not responsible for Campaign assignment. They are likely vestigial UI utilities.

4. **Add a new finding: per-event attribution is lossy.** Apex picks the most-recent COMPLETED Campaign matching the channel — not necessarily the event the Lead came from. If the client cares about per-event ROI (not just per-channel), this is a real issue worth flagging. If they only care about per-channel rollups, it's fine.

5. **Add a new finding: the `if (l.SurveyId__c != null && l.Duplicate_Lead__c == false)` guard is commented out** in `addLeadInCampaign`, meaning the method runs on every Lead insert (not just survey leads). This is why coverage is 98.6%. Whether this is intentional or a mistake is worth confirming with whoever owns the org.

6. **Add a new finding: the Campaign custom field is `FedralAgency__c` (sic — typo).** Any future SOQL or report that references this field needs the typo. Worth flagging because it's a footgun — anyone writing `FederalAgency__c` will silently get zero results.

7. **Fix the Bryan Tucker Lead ID in the audit doc.** `00QUPyQ2AX` is truncated. Re-look at the source data; the correct 18-char ID is most likely `00QUU00000TTPyQ2AX` based on adjacent IDs.

8. **Verify the 5 uncovered Leads** (the 1.4% with no CampaignMember). Determining why they fell through (null `Federal_Agency__c`? non-mapped value? `Survey_Detail__c` set to something the Apex doesn't recognize?) will pinpoint the failure mode the Phase 1 build needs to prevent.
