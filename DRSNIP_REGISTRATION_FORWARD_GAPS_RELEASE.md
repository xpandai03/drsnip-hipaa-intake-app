# Registration forward gaps: release record

**Date:** 24 September 2026, released 00:09–00:30 UTC, last check 00:40 UTC. All times are UTC.

**Scope:** forward fixes only.
- **Jennifer's document and every other historical document were left unchanged.** Nothing was regenerated, replaced or uploaded.
- No patient records were created or changed.
- No production submission or replay was made.
- No messages were sent.

This report contains no patient data. Evidence is limited to version IDs, counts, presence flags and synthetic fixtures.

---

## 1. Active paths and rollback points (verified live before changing anything)

| Path | Before | After | Rollback point |
|---|---|---|---|
| Custom registration app (`intake.drsnip.com`, Fly `drsnip-intake-demo`) | v90 (`48f8665`) | **v91** (`a0fbf09`), image `sha256:5b9460c75dd6…`, both machines | `fly releases rollback` to v90 |
| **[Custom App] DrSnip Registration v2** (`H2HihkGKntbfRNcK`): *Generate Registration PDF* only | `1ec3ccf9-4b99-42d3-8090-4953989f6eea` | **`cf4eb6bf-698b-4fc6-8b6f-a821d8c958fc`** | `n8n-rollback/H2HihkGKntbfRNcK_2026-09-24_names_pre.json` |
| **Patient Intake — Jotform → Sheets → DrChrono** (`6warkNFZSSzuasMB`): *Generate Registration PDF* only | `a6abc18d-b663-4db8-8b59-d0b40807c31f` | **`76bff844-541b-486f-a9e0-9263dc2a2454`** | `n8n-rollback/6warkNFZSSzuasMB_2026-09-24_names-subscriber_pre.json` |
| Console PDF (`/api/submissions/:id/pdf`) | Helvetica only | Noto Sans plus the shared rule | app v91 → v90 |
| Legacy Jotform form `260987576842071` (account ITSnip) | unchanged | unchanged (**blocked**, §5) | — |
| drsnip.com "Register Now" links | unchanged | unchanged (**blocked**, §4) | — |

**What the snapshots contain:** workflow configuration only. They hold no credential values and no patient data (checked: no secret-like fields, empty pinned data, only a staff email address).

**Commits and PR:** `44c00ad` (fixes) and `a0fbf09` (validator false-positive fix) on `fix/registration-subscriber-details`. **PR #56** is updated and still stacked on #55; both are unmerged, and nothing unrelated is included.

---

## 2. Name fidelity

**Problem (from verification):**
- **n8n v2 PDF:** transliterated names ("José" → "Jose") or printed `?`.
- **Legacy PDF:** wrote the low byte of any character above U+00FF, so "Ł" became "A", a silent wrong letter.
- **Console PDF:** threw an error on any name outside WinAnsi, so the download failed with HTTP 500.

**Fix: one rule for all three paths.**

| Component | What it does |
|---|---|
| `lib/pdf-unicode/fonts/` | **Noto Sans** Regular, Bold and Italic subsets (SIL Open Font License 1.1, which permits embedding; `OFL.txt` included). Covers Latin including Vietnamese, Greek, Cyrillic, punctuation and currency: 2,171 characters common to all three weights. |
| `lib/pdf-unicode/support.ts` | The rule. After NFC, a value is either:<br>• **WinAnsi**: standard font, exact bytes;<br>• **covered**: embedded Noto;<br>• **anything else**: replaced by `[Cannot be shown exactly in this document (<script> characters) - see the DrSnip intake console for the exact text]`.<br>Never transliterated, never `?`. |
| `lib/n8n/pdf-unicode.block.js` | The same rule for the n8n Code nodes. It is synced verbatim into both PDF nodes (`sync-pdf-unicode.mjs`), and a test checks it stays in sync and agrees with `support.ts`. It embeds a Type0/Identity-H font with a **ToUnicode** map, so text copies and extracts correctly. |
| `artifacts/intake-form/public/pdf-fonts/noto-sans-v1.json` | The font asset, served by the app at `https://intake.drsnip.com/pdf-fonts/noto-sans-v1.json` (200, `application/json`). n8n fetches it **only when a document contains non-WinAnsi text**. Metrics are validated against fontTools: 0 mismatches. |
| Registration v2 PDF | Header name, every Patient Information and insurance value, and every page footer go through the rule. A "Review needed" banner appears when anything can't be shown. `pdf_review` in the node output lists **field labels only**, never values. |
| Legacy PDF | Same rule for every row. Width-aware wrapping that also breaks over-long words. |
| Console PDF | Noto embedded through `@pdf-lib/fontkit` (MIT; a new dependency), with every stored string checked before layout. The stored submission is never modified. |

**Fallback behaviour:**
- If the font asset can't be fetched, WinAnsi names stay exact and other names show the explicit notice. The document and the intake still complete; the node never throws.
- Documents with only WinAnsi text embed no font, so their size is unchanged.

**19-name fixture** (tests, confirmed in the n8n runtime):

| Result | Names |
|---|---|
| **Exact, standard font** | José, Zoë, Müller, Núñez, François, Øyvind, Søren, Ægir, Straße, Siobhán, O’Brien, Œuvre, Šimon |
| **Exact, embedded Noto** | Łukasz, Nguyễn, Đặng, Ольга |
| **Explicit notice plus review banner** (not altered) | 王小明 (Chinese/Japanese), محمد (Arabic) |

**Remaining unsupported cases, stated precisely:**
- Chinese, Japanese and Korean (no glyphs in the subset).
- Arabic, Hebrew and Indic scripts, Thai and other scripts that need shaping or right-to-left layout.
- Armenian, Georgian and Ethiopic.
- Emoji.
- Any combining mark left over after NFC.

All of these get the notice. The exact value is unchanged in the intake console and in DrChrono's demographic fields, which receive UTF-8 through the API. Supporting any of them exactly needs an additional font, and for Arabic and Indic a shaping engine.

**Visual inspection:** PDFs produced *inside n8n* were rendered with macOS PDFKit.
- "Łukasz" and "Nguyễn" (stacked Vietnamese marks) draw correctly in Noto Bold.
- The notice is clearly styled.
- `pdffonts` shows `DRSNPR+NotoSans-Regular` and `DRSNPB+NotoSans-Bold` as embedded, subset, with Unicode maps.
- `pdftotext` extracts "Łukasz Nguyễn" exactly.

---

## 3. Coverage switching

**Problem:** the form cleared entered details silently when switching between Partner's and Both, and forced retyping.

**Fix:** `lib/registration/insurance.ts` plus `Home.tsx`.
- **Two canonical records in form state:** the flat fields are always the patient's **own** policy, and the `partner*` fields are always the **partner's**.
- Under "Partner's Insurance", the first on-screen block edits the partner record.
- `insuranceForSubmission` maps the records onto the **unchanged payload contract** once, at submit: the partner record goes in the flat fields for Partner's, both records go for Both, and irrelevant fields are blanked.
- Switching never moves, clears or relabels anything.
- **A note appears** when details are kept on the page but won't be sent, for example: "Your partner's policy details are kept on this page but won't be sent unless you choose "Partner's Insurance" or "Both"."
- The client and the server still require the partner-policy holder's name and DOB. Server validation is unchanged and runs on the same payload shape. No "Other" option was added.

**Browser verification.** The same 26-check script ran on a local dev build (desktop and mobile) and on **production v91** (desktop 1280 px and mobile 390 px), all passing. Every non-GET request was aborted: only the drop-off beacon and analytics were attempted. `/api/submit` was never called and Submit was never clicked.

| Check | Result |
|---|---|
| Partner's: name and DOB required; blocked until complete | Pass |
| **Partner's → Both:** partner details appear in the Partner's section with no retyping; patient's own section empty (not relabelled); DOB kept | Pass |
| Both: blocked until the patient's own company and ID are given; then enabled | Pass |
| Review → Back: both records intact and separate | Pass |
| **Both → Partner's:** partner details shown with no retyping; own policy not shown as the partner's; note shown | Pass |
| Partner's → Own: own policy restored; partner not relabelled; holder optional; note shown | Pass |
| No Insurance usable, with note; back to Partner's restores everything | Pass |
| Clearing a required partner field blocks again | Pass |
| No page errors | Pass |

---

## 4. Website "Register Now" links: not changed; blocked, and the premise has shifted

**Access:** there is no WordPress access in this environment (no connector, no `wp-cli`, no credentials). **Blocked action: editing the drsnip.com header and mobile-menu link targets.** Nothing was changed.

**What the public site actually does**, verified today by rendering and clicking, not just reading saved URLs:

| Where | Rendered? | Target |
|---|---|---|
| Desktop header "Register Now" (Elementor header template 14268) | **Visible** at 1280 and 1920 px | `https://drsnip.com/consultation/`, a page embedding the custom app's **consultation** form (`intake.drsnip.com/consultation?source=website`, first step "About You"). Clicking it lands there. |
| Mobile menu "Register Now" (Elementor popup 14346) | Inside the phone menu | `https://intake.drsnip.com/?source=website-registernow`, the **custom registration app** (fixed flow) |
| Astra header button ("Register Now", 2 copies) | **Not rendered** at any tested width: 390, 600, 768, 820, 1024, 1280 or 1920 px | `https://form.jotform.com/ITSnip/drsnip-registration-form` (legacy) |

**Correction to the earlier verification report:** it said the header button on every page links to Jotform. That was read from static HTML without checking rendered visibility. The Jotform links are **dormant markup**. Today, desktop visitors reach the consultation form and phone visitors reach the fixed registration app.

**Destination verified healthy:** `https://intake.drsnip.com/?source=website-registernow` returns 200 on desktop and mobile with no redirect, and the query string is preserved. The app captured `source`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` and `gclid` exactly; this was observed in the drop-off beacon body, which was aborted, using synthetic values only. The staff-assisted flow is the same wizard, and all fields and validation are present (§3).

**Smallest change for the website owner:**
1. Point the dormant Astra header button `href` at `https://intake.drsnip.com/?source=website-registernow`, or remove it, so it can't resurface.
2. **Clinic decision:** should the desktop header "Register Now" go to the **Consultation** page (as now) or to the **registration** app (as on mobile)?

---

## 5. Legacy Jotform path

**Workflow fix (deployed, `76bff844`):**
- The PDF node reads **q35–q38** directly from the webhook's `rawRequest`, using the meanings established from the published form:
  - q35 full name {first, last};
  - q36 separate last name;
  - q37 DOB {month, day, year};
  - q38 employer.

  Only for coverage **Partner's Insurance** or **Both**, where Jotform shows those fields.
- **Partner's:** "Policy ownership: Partner's policy - the partner is the policyholder", followed by the policyholder's name, DOB and employer.
- **Both:** "Policy ownership: **NOT SPECIFIED** - this form collects one policy for "Both" and does not say whether it is the patient's or the partner's. Confirm both policies with the patient."
  - The holder is shown as "name - **as entered**".
  - Ownership is not guessed and the document does not present it as complete.
- **Last names:** the separate last-name answer wins. If it differs from q35's last name, a "check" row is added.
- **Dates:** an impossible DOB shows "Not a valid date on the form - confirm with the patient".
- **Missing values:** shown as "Not provided on the form". Nothing is invented and the patient is never substituted.
- **Name fidelity:** the rule from §2, so the "Ł" → "A" corruption is gone.
- **Unchanged:** *Parse & Normalize* and the **auto-mapped** Sheets audit behind it. Adding keys there could have silently added PHI columns to the audit workbook. Compatibility: the Jotform payload shape is unchanged and older payloads render the same way.
- **In n8n's runtime:** the synthetic Partner's and Both cases rendered as above, and "Full Name: Łukasz Synthetic" is exact.

**Blocked: form changes (Jotform account ITSnip, not accessible through our connector).**
- Making q35–q37 **required** for Partner's and Both.
- Adding a clearly labelled route from "Both" to the corrected custom form.

**Status of legacy Both:** an **explicit unresolved forward gap**. The document flags it for manual confirmation; it can't collect the second policy.

**Smallest decision or change needed:** someone with ITSnip Jotform access should do one of these:
- **(a)** Mark q35–q37 required under the existing Partner's/Both condition, and add a text element shown for "Both" linking to `https://intake.drsnip.com/?source=jotform-both`.
- **(b)** Stop sharing the Jotform link. It isn't rendered on the website today, and it had 1 submission in 13 days.

---

## 6. Tests

| Suite | Result |
|---|---|
| `api/_test/pdf-unicode.test.ts` (new, 16 tests) | 16 of 16 passed. Covers:<br>• block and `support.ts` agree (font loaded and unavailable);<br>• block synced into both node files;<br>• every WinAnsi character covered;<br>• the 19-name fixture;<br>• header, footer and Patient Information exact;<br>• unsupported patient name → notice and generic footer;<br>• font unreachable → explicit notices, intake continues;<br>• no font embedded when not needed;<br>• long international names wrap;<br>• legacy Partner's, conflict, missing/invalid, Both, Own/None and international;<br>• console PDF generates for all 19 names (exact or notice, checked with `pdftotext`). |
| `api/_test/registration-subscriber.test.ts` (22 tests) | 22 of 22 passed. Includes the new two-record, switching and note tests, and the retry test: **exactly one POST** per submission. |
| Full `pnpm test` (fresh local disposable DBs) | **726 tests, 701 pass, 0 fail, 25 skipped.** The skips are the known attendance-fixture baseline. |
| `pnpm run build` (includes typecheck of libs, API, form and scripts) | Pass. The server bundle grew from 2.6 MB to 4.2 MB (fontkit). |
| n8n runtime | Isolated temporary workflows ran the **exact deployed node code** with synthetic payloads. They had no credentials or write nodes, retained no data, and were deleted afterwards; webhooks now return 404 and 0 executions are stored. |
| Local server | The built `dist/server.cjs` serves the asset as `application/json`, and `/register` returns 200. |

**Retry and idempotency:** unchanged. The app still sends one POST per submission and has no replay path. The n8n upload nodes' existing `retryOnFail` is untouched, and no new retries were added.

---

## 7. Release order and in-flight safety

1. **Commit and push** `44c00ad`, then **update PR #56**, before any deploy.
2. **Registration v2 PDF node.**
   - Precheck: version unchanged, 0 running executions.
   - PUT, then verify: active version = draft = `cf4eb6bf`, code SHA-256 matches the repo, the other 28 nodes, the connections and the settings are identical, and n8n validation shows 0 errors (7 pre-existing warnings).
3. **Legacy PDF node.**
   - The first PUT was **rejected (400)** by the API's settings schema, which refuses `binaryMode`, `timeSavedMode` and `availableInMCP`. Nothing changed.
   - A no-op PUT without those keys confirmed n8n preserves them. The deploy then went through as `0adb94c2`, with all settings identical.
   - n8n's static validator reported one false positive (`return ['']` inside a helper). It was fixed in `a0fbf09`, pushed, and redeployed as **`76bff844`**: validation 0 errors (7 pre-existing warnings), code matches the repo, everything else identical.
4. **App v91** from a clean `git archive a0fbf09` export.
   - Drain: `draining 0 in-flight bridge call(s)`, `timed_out:false`.
   - Both machines on the v91 image.
   - The served bundle `index-CcjwsJBI.js` equals the local build.
   - The font asset is live.

Both workflow changes were backward compatible **before** the app shipped: the same payload contract, and explicit notices while the asset wasn't yet served. n8n executions already running keep their own version. Intake was never disabled. Patient matching, chart creation, document destination, alerts, Sheets audits, sync schedules, credentials, OAuth and build flags are untouched.

---

## 8. Production checks (00:40 UTC)

| Check | Result |
|---|---|
| Live form (v91) | 26 of 26 browser checks on desktop and mobile; no submission |
| Public routing | Verified by click (§4) |
| Source forwarding | Verified on desktop and mobile (§4) |
| Active workflow mappings | Both PDF nodes' code SHA-256 equals the repo, in the active version |
| Workflow and app errors | Error Notify: no runs since 16 Sep. No app errors after the restart. Fly health check passing |
| Intake since release | 3 consultations (1 success, 2 `manual_review`, a normal outcome: 17 of 83 this week); 0 registrations |
| Appointment sync | Hourly (`jUNJrRWhZkogFhpX`) success 00:05; 10-minute catch-up (`9Wvd36XnnbDdypaf`) success every 10 minutes through 00:30; sweep success 00:00 |

**Real DrChrono delivery: PENDING.**
- No Partner's or Both registration has arrived since the fixed workflow (23:27) or since this release. The last check was 00:40 UTC.
- No execution was manufactured and nothing is polling.

**Remaining step:** on the first real Partner's or Both registration:
1. Confirm the stored submission has the holder's name and DOB (presence only).
2. In the retained Registration v2 execution, check `policyholderContract = 1`, `insurance_insured_*` or `partner_insured_*`, and the PDF binary's text under the correct policy heading.
3. Download the uploaded document **read-only** from the DrChrono chart that execution resolved, and compare name, DOB and policy association without exposing values.

---

## 9. Rollback

| Target | How |
|---|---|
| **App** | `fly releases rollback -a drsnip-intake-demo`, back to v90. |
| **Registration v2** | PUT the *Generate Registration PDF* `jsCode` from `n8n-rollback/H2HihkGKntbfRNcK_2026-09-24_names_pre.json` (version `1ec3ccf9`). |
| **Legacy** | Same for `n8n-rollback/6warkNFZSSzuasMB_2026-09-24_names-subscriber_pre.json` (version `a6abc18d`). Omit `binaryMode`, `timeSavedMode` and `availableInMCP` from the PUT settings; n8n keeps them. |
| **Git** | Revert `a0fbf09` and `44c00ad`. |

Each piece can be rolled back independently: old nodes ignore nothing new, and the payload contract is unchanged.

---

## 10. Remaining blockers and decisions

1. **Website access (blocked):** the dormant Astra header links to Jotform, plus the clinic decision on whether desktop "Register Now" should go to Consultation or Registration (§4).
2. **Jotform access (blocked):** required q35–q37, and a route from "Both" to the custom form, or stop using the form (§5).
3. **"Other" coverage (clinic):** still undefined. Is it a spouse/partner specifically, or any non-patient policyholder, such as a parent? What should staff select today? No option was added and Partner's Insurance is not a catch-all.
4. **Scripts outside the font (product):** CJK and shaped/RTL scripts show an explicit notice. Exact rendering needs additional fonts and a shaping step.

---

## Status

| Forward path or issue | Fixed and verified? | Remaining limitation |
|---|---|---|
| Custom Partner/Both registration | **Yes.** Required fields on client and server; payload and document carry each policy's holder. Verified by tests, n8n runtime and the production form (no submission) | Real DrChrono delivery not yet observed |
| Coverage switching | **Yes.** Two-record state, no retyping, no relabelling, kept-but-not-sent notes. 26/26 production checks, desktop and mobile | None known |
| Name fidelity | **Yes, for WinAnsi, Latin (including Vietnamese), Greek and Cyrillic, in all three document paths.** Exact text, visually and in extraction | CJK and shaped/RTL scripts show an explicit notice and review banner rather than exact rendering |
| Website Register Now links | **Not changed (no WordPress access).** Rendered routing verified: desktop → Consultation embed; mobile → fixed registration app; Jotform links dormant | Owner should remove or repoint the dormant Jotform header button, and the clinic should decide Consultation vs Registration for desktop |
| Legacy Jotform | **Partly.** Document now carries q35–q38 with honest labelling and exact names (deployed and verified in the n8n runtime) | Fields still optional; "Both" collects one policy with no stated owner (flagged, not guessed). Form changes blocked (ITSnip Jotform access) |
| Real DrChrono delivery | **Pending.** 0 qualifying registrations since release (last check 00:40 UTC) | Needs the first real Partner's or Both registration, then a read-only document check |

**Confirmed:**
- **Jennifer's document and all other historical documents were left unchanged.**
- No document was regenerated, replaced or uploaded, and no chart was modified.

**Ready for the controlled repair of Jennifer's document?** **Yes, with one caveat.**
- The forward template the repair should reuse is live and verified in n8n's runtime. The repair can render Jennifer's stored submission through it exactly.
- Her case is a v2 Partner's Insurance registration with the name and DOB stored. Whatever characters that name contains, it will be either rendered exactly or explicitly flagged, never altered.
- The caveat: real end-to-end delivery through the new template has not yet been observed. The repair task should include its own read-only check of the uploaded document, or wait for the first real Partner's or Both delivery.
