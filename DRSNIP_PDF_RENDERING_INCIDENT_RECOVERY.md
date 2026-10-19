# PDF rendering incident: recovery record

**Incident date:** 24 September 2026. Clinic time is America/Los_Angeles (PDT, UTC−7).

**Status:**
- **Contained and verified for new and re-downloaded documents.**
- **No persistent DrChrono document was produced by the defective renderer.**
- One open item: staff must re-download any PDF they saved locally during the incident.

This report contains no patient information. The patient-linked ledger is kept outside git in a restricted local directory (mode 700/600): `~/.drsnip-incident-2026-09-24/`.

---

## 1. Root cause

The **staff-console PDF generator** (`lib/pdf/generator.ts`) was changed in app **v91** to embed Noto Sans through `@pdf-lib/fontkit` with **`subset: true`**. pdf-lib then re-subset fonts that were already subsets. The resulting embedded font programs were corrupt: viewers drew only a handful of glyphs, so labels, names and values disappeared.

| Viewer engine | Result on a v91 console PDF (synthetic) |
|---|---|
| PDFium (Chrome, Edge, Chrome's built-in viewer) | Nearly blank; label-column ink **0.35%** |
| PDFKit (Safari, macOS Preview) | Nearly blank (**0.5%**) |
| poppler | Nearly blank (**0.25%**) |
| Text extraction (`pdftotext`, pdf.js-style) | **Correct.** This is why the extraction-based tests passed. |

This was not viewer-specific. The same file after the fix: **2.27%**, fully readable.

**The same generator also serves the Insurance v1 workflow** through `/api/internal/insurance-pdf/:id`, so insurance chart PDFs were exposed to the same renderer.

**Not affected:** the n8n PDF nodes (Registration v2, legacy Jotform) build their own font objects and embed the complete subset without re-subsetting. They render correctly in PDFium, PDFKit and poppler. The Consultation v2 n8n renderer was never changed.

**Why testing missed it:** the name-fidelity tests checked extracted text and a PDFKit render of the **n8n** PDFs only. The console PDF was never rendered visually. It is now covered by a byte-level guard (§3) and by PDFium rendering in this incident.

---

## 2. Timeline (UTC; PDT is −7 h)

| Time | Event |
|---|---|
| 23 Sep 23:27 | Registration v2 `1ec3ccf9` (subscriber fix). Not a font change. |
| 24 Sep 00:25 | Registration v2 PDF node → `cf4eb6bf` (Unicode block). **Unaffected.** |
| 24 Sep 00:26 | Legacy PDF node → `0adb94c2`, then `76bff844`. **Unaffected**, and no runs since. |
| **24 Sep 00:28** | **App v91 deployed: defective console/insurance renderer live.** Last known-good renderer: v90 (Helvetica only). |
| 24 Sep 16:41 | Incident response started. Reproduced within minutes using synthetic data and PDFium. |
| 24 Sep 16:44 | Hotfix committed (`1efca08`), pushed, PR #56 updated. |
| **24 Sep 16:47** | **App v92 deployed** (clean `git archive 1efca08`; drain logged 0 in-flight calls). Defective window closed. |
| 24 Sep 16:47–16:54 | Verification: synthetic, real data (read-only) and destination copies. |

**Defective window:** 24 Sep 00:28–16:47 UTC, which is 23 Sep 17:28 to 24 Sep 09:47 PDT.

---

## 3. Fix

**`lib/pdf/generator.ts`: `subset: true` → `subset: false`** for all three Noto weights. This is a one-line behavioural change.

- The complete subset font (about 190 KB per weight) is embedded, which adds roughly 0.55 MB per console PDF.
- The subscriber payload fix, required-field fix and policy-association fix are **untouched**.
- Name fidelity is preserved: no transliteration and no `?`.
- No whole-app rollback was done, because v90 would have brought back the console crash on names like "Łukasz".

**Regression guard** (`api/_test/pdf-unicode.test.ts`): every embedded font program in console PDFs, for registration, consultation and insurance, must hash-match the complete asset font. The guard **fails on the v91 code and passes on v92.**

| Item | Value |
|---|---|
| Commit | `1efca08` on `fix/registration-subscriber-details` |
| PR | #56 (updated before deploy with the incident note); still stacked on #55, unmerged |
| Fly release | **v92**, from a clean export of `1efca08`. Previous: v91 (defective), v90 (last known-good for the console, but crashes on non-WinAnsi names) |
| n8n | **No workflow change needed.** Registration v2 `cf4eb6bf`, legacy `76bff844`, Consultation v2 `39ffc49b` and Insurance v1 `2d8e9d7c` are unchanged |
| **Rollback** | `fly releases rollback` to v91 would reintroduce the defect. The emergency fallback is v90 (readable ASCII, but a 500 error on non-WinAnsi names) |

---

## 4. Rendering checks

| Check | Result |
|---|---|
| Synthetic console PDFs from the hotfix code: 9 sequential and 6 concurrent in one process, mixing registration, consultation and insurance and alternating ASCII, accented, Łukasz, Nguyễn, Ольга, CJK and Øyvind names, with long multi-page fields | **40 of 40 pages rendered readably in PDFium.** Ink in the normal band (0.9–2.0%; the broken band is 0.2–0.35%). No drift across sequential or concurrent documents, so there is **no shared-state or caching fault**. Consultation and insurance pages were also inspected visually. |
| Font-object reuse and caching (hypothesis) | **Ruled out.** `loadFontAsset` caches only the immutable JSON; each document embeds its own fonts. The defect reproduced on the **first** document in a fresh process. |
| Deployed v92 renderer with **real data**: the three 23–24 Sep insurance submissions, fetched through the production `/api/internal/insurance-pdf` endpoint via a temporary, credential-referencing, read-only n8n workflow | **3 of 3 readable in PDFium** (ink 1.01–1.02 / 0.58; title and labels present). Bytes were processed in memory only. |
| v92 generator code (identical commit) on **every** real 23–24 Sep registration (24) and consultation (29), read-only rows, temporary files deleted | **53 of 53 generated with no errors and readable in PDFium.** Patient name present in the page text for 53 of 53; no "cannot be shown" notices needed. |
| Full test suite (fresh local disposable DBs) | **727 tests, 702 pass, 0 fail, 25 skipped** (the known attendance baseline) |
| `pnpm run build` (includes the full typecheck) | Pass |

**Visual inspection scope:**
- Synthetic pages were inspected by eye (registration, consultation and insurance; broken and fixed; three engines).
- **Real patient documents were checked by automated rendering metrics and text presence only.** They were not viewed, to keep PHI out of the transcript. Every page of every checked document was rendered in PDFium.

---

## 5. Impact: path matrix

| Form type | Console download (on demand) | n8n-generated PDF | Stored DrChrono document |
|---|---|---|---|
| Registration (custom v2) | **Broken 00:28–16:47Z; fixed in v92** | `cf4eb6bf` since 00:25Z: **unaffected** (8 of 8 checked) | **Unaffected**; 8 of 8 post-change copies verified byte-identical at the destination |
| Consultation (v2) | **Broken 00:28–16:47Z; fixed in v92** | Unchanged renderer: **unaffected** (5 PDFs since 00:25Z readable) | Unaffected |
| Insurance (v1) | **Broken 00:28–16:47Z; fixed in v92** | Fetched from the app, so it was **exposed** | **None produced in the window**: the only post-v91 insurance submission went to manual review, and that branch uploads no document. Earlier insurance documents were made by v90. |
| Legacy Jotform registration | n/a (no console record) | `76bff844`: unaffected | No runs since the change |

**Console PDFs have no persistent copy.** The endpoint sends `Cache-Control: no-store` and generates on demand, so there's no server cache to invalidate. A fresh download now produces a readable document **for any submission, of any date**. Files downloaded during the window stay broken on staff machines until re-downloaded.

---

## 6. 23–24 September ledger and totals

**Window:** 23 Sep 00:00 PDT to the 24 Sep cutoff at 09:54 PDT. In UTC: 23 Sep 07:00:00 to 24 Sep 16:54:37.

The patient-linked ledger (`~/.drsnip-incident-2026-09-24/ledger.json`, mode 600) holds one row per submission with form, path, source availability, document association, renderer and status.

| Category | Count |
|---|---|
| Submissions identified in the window | **56**: 24 registration, 29 consultation, 3 insurance |
| Source data available | 56 of 56 |
| **Confirmed unreadable persistent documents** | **0** |
| Persistent documents **produced by the defective renderer** | **0** |
| Persistent documents checked and **verified unaffected** | 8 (all post-change Registration v2 uploads: PDFium-readable, destination copy byte-identical, correct chart) |
| Persistent documents unaffected by construction (renderer unchanged at the time) | 16 registration (before 00:25Z), 18 consultation, 2 insurance |
| No persistent document (manual review) | 11 consultation, 1 insurance |
| On-demand console PDFs affected if downloaded during the window | Any of the 56 (and any older submission); **all regenerate readably now** (verified) |
| Repair needed | **0** |
| Repaired and verified | 0 (none needed) |
| Pending | 0 |
| Blocked | 0 |
| Evidence insufficient | 1: **the staff screenshot's PDF was not located** (see below) |

**Final catch-up:** 0 submissions between the hotfix (16:47Z) and 16:54Z.

**Outside the window:** the only outputs of the defective renderer were console downloads (on demand) and insurance bridge PDFs. No insurance bridge call landed in the window for any older submission (0), so there are no older persistent documents to repair.

**Screenshot sample:** the screenshot itself wasn't available to me, and the file is a download on a staff machine. Fly keeps only minutes of logs, so the specific download can't be traced. Everything about it is consistent with a console download during the defective window: every label missing, rendered in a Chromium-based viewer. Re-downloading it now produces a readable copy.

---

## 7. Destination verification

**Method:** a temporary, read-only n8n workflow using the existing DrChrono credential. It had no write nodes, retained no data, and was deleted afterwards (webhooks return 404; 0 stored executions). For each of the 8 post-change registration documents it made two GETs: the document metadata and the stored file.

| Check | Result |
|---|---|
| Document exists | 8 of 8 |
| On the intended patient chart (from trusted execution linkage) | 8 of 8 |
| Description | `Registration Intake (custom app v2)` on all 8 |
| Stored file byte-identical to the uploaded PDF | 8 of 8 |
| Uploaded PDF readable in PDFium | 8 of 8 |

This includes **the first real post-release Partner's Insurance registration** (24 Sep 15:45Z). Its uploaded document contains the stored subscriber first name, last name and DOB (in-process comparison, values not printed). So **real forward delivery of subscriber details to DrChrono is now verified**; it had been pending since the subscriber fix.

---

## 8. Jennifer's document

- **Not regenerated in this incident.** Her registration (23 Sep 22:12Z) was processed by the *pre-incident* renderer, so the document is readable. It is not in the defective-renderer set.
- **Her subscriber omission remains uncorrected** on the chart. The font fix does not change an existing document.
- The planned controlled repair (an addendum rendered from her stored submission) is still a separate step. Everything it depends on is now verified in production: the forward template, readable rendering, and destination verification.

---

## 9. Unsupported-script limitation (unchanged by this incident)

Chinese, Japanese, Korean, Arabic, Hebrew, Indic scripts, Thai, Armenian, Georgian, Ethiopic, emoji and leftover combining marks still render as an explicit "[Cannot be shown exactly …]" notice with a review banner, never as altered text. **None of the 56 window documents needed a notice.**

---

## 10. Cleanup

| Item | Result |
|---|---|
| Temporary n8n workflows (DrChrono verifier, insurance-PDF fetcher) | Deactivated and deleted. Webhooks return 404; 0 stored executions; token files removed. |
| Real-data temporary PDFs and rows | Deleted. Only the restricted ledger files remain. |
| Synthetic artefacts | Kept in the session scratchpad only: a v91 broken sample kept for comparison, plus fixed samples. None in git. |
| Changes elsewhere | No workflow, credential, OAuth, website, reporting, patient or chart change. No messages sent. |
| Operational health | Registration v2, Consultation v2, appointment sync (hourly and 10-minute) and the sweep are succeeding; Error Notify idle; health check passing. |

---

## Answers

1. **Are new PDFs readable?**
   - **Yes.** Console and insurance PDFs from v92 (since 16:47Z) are verified readable in PDFium with synthetic and real data.
   - n8n registration and consultation PDFs were never affected.
2. **Are console downloads for yesterday and today corrected?**
   - **Yes, on re-download.** Generation is on demand with no cache. All 56 window submissions regenerate readably: 53 with the deployed commit's code, 3 through the live endpoint.
   - Files already saved during 00:28–16:47Z (UTC) must be downloaded again.
   - I couldn't click a staff-session console download myself because I have no staff login; a staff member re-downloading one PDF would close that last gap.
3. **Are affected DrChrono documents repaired and verified?**
   - **None needed repair.** No DrChrono document was produced by the defective renderer.
   - The 8 documents produced by the changed n8n node were verified readable and byte-identical at the destination, on the correct charts.
4. **What remains blocked or unverified?**
   - Staff-side re-download of locally saved copies.
   - The screenshot's specific file (untraceable).
   - Jennifer's subscriber omission (separate repair).
   - Earlier blockers: website and Jotform access, and the "Other" definition.
5. **What can Raunek accurately tell Jeff now?**
   > "Yesterday evening's update broke the PDF download in the staff console, and the insurance PDFs made by the same tool: almost all text disappeared, whichever PDF viewer was used. It was fixed at 9:47 this morning Pacific. Any PDF downloaded between about 5:30 pm yesterday and 9:47 am today should be downloaded again; the new copy is complete. We checked the documents in DrChrono charts: none were affected. The registration documents uploaded since the change are readable, and today's partner-insurance registration now correctly includes the subscriber's name and date of birth. Jennifer's earlier document is still missing those details, and we'll add a corrected copy as a separate, careful step."
