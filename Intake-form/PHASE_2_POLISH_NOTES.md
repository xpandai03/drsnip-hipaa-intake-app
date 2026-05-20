# PHASE 2 POLISH NOTES

Branch: `phase-2-polish`. Three discrete UX-polish changes. No form content
(wording / options / required-ness / conditional logic) changed — only screen
grouping, an Enter-key affordance, and the admin Links page.

## Step 1 — Max 3 single-select questions per screen

"Single-select" = RadioCard-based questions (`YesNoField`, `ChoiceField`).
Per the brief, native dropdowns (`SelectField`), text/email/phone/number,
textareas, date pickers, file uploads, and multi-selects (`MultiChoiceField`)
do **not** count toward the cap.

### Audit result — only two screens were over the cap
- **Registration / "Medical Background"** — 13 yes/no questions → split into 5.
- **Consultation / "Family Planning & Birth Control"** — 4 single-select → split into 2.

All other screens were already ≤3 (most are dropdowns + text fields, which
don't count).

### Registration — Medical Background split (13 → 5 screens)
Grouped logically by clinical theme; 3+3+3+2+2 (not 3+3+3+3+1) so no screen is
left with a single lonely question:

| New screen | Questions |
|---|---|
| Medical Background — Urological & Reproductive | testicle/scrotum/hernia · testicle injury/surgery · STIs |
| Medical Background — General Health | kidney · chronic problems · medications |
| Medical Background — Surgical & Procedure History | surgeries · surgery complications · fainting |
| Medical Background — Bleeding & Anesthesia | drug/anesthetic allergies · bleeding tendency |
| Medical Background — Aspirin & Pain | aspirin use · pain sensitivity |

The "Current Primary Care Physician" text field stays as a lead-in on the
first medical screen. The per-question "explain on Yes" textarea (shipped
earlier) is preserved on every question. Each screen's `isValid()` checks only
its own questions.

### Consultation — Family Planning split (4 → 2 screens)
| New screen | Single-select questions |
|---|---|
| Family Planning | wish for more children · adoption |
| Birth Control | tubal ligation considered · temporary BC considered |

(The vasectomy-duration text field and the current/prior birth-control
multi-selects ride along — they don't count toward the cap.)

### Screen counts (before → after)
- Registration: **5 → 9**
- Consultation: **6 → 7**

Both are ≤10, so no UX-warning threshold was hit. The progress bar is driven by
`screens.length` in `MultiStepForm`, so it auto-adjusted.

## Step 2 — Enter-key advances valid screens

Implemented as a single `useEffect` keydown listener in the shared
`MultiStepForm` component — **not** duplicated into `Home.tsx` /
`Consultation.tsx`. Both forms render through `MultiStepForm`, which already
owns step state, `current.isValid()`, and `handleNext()` (advance-or-submit),
so one implementation covers both forms with no duplication.

Behavior: Enter calls `handleNext()` — which already no-ops when the screen is
invalid or a submit is in flight. The handler ignores Enter when a `<textarea>`
is focused (newline) and when any modifier key is held (Shift/Cmd/Ctrl/Alt).
The effect re-registers each render so the listener always closes over live
form data. No conflict with existing shortcuts (there were none).

## Step 3 — `/admin/links` reworked for DrSnip

`LinkGenerator.tsx` was rewritten from the CJC campaign-URL tool (marketing
sources / UTM / medium / legacy webinar quick-links) to a DrSnip generator:

- **Inputs:** form type (Registration / Consultation — RadioCard, required),
  campaign/source (free text, optional), notes (free text, optional).
- **Output:** Registration → `/?source=<campaign|direct>`; Consultation →
  `/consultation?source=<campaign|direct>&patient_id=<crypto.randomUUID()>`.
  Origin is `window.location.origin` (correct on the deployed host).
- Generated-URL box (clinical-blue, monospace) + copy button; recent-links
  list (last 10) with date / form type / campaign / copy.
- **Persistence:** new `api/admin/links.ts` endpoint (GET recent 10 / POST
  save), mounted in `api-server/index.ts`. Migration
  `0004_link_form_type.sql` adds `form_type` + `notes` columns to
  `link_generations`; the schema (`links.ts`) and the release-command runner
  (`api-server/migrate.ts`) were updated to match.
- **Sources tab hidden:** the `/admin/sources` nav entry was removed from
  `AdminLayout.tsx` (CJC marketing-source catalog — not used by the free-text
  campaign model). The route and page code are **retained** (still in
  `App.tsx`), per the brief — only the nav link is hidden.

### Notes
- `LinkGenerator.tsx` is also rendered by the legacy public route
  `/internal-tools-x9k2`. There, unauthenticated, the persistence + recent-list
  API calls return 401 — the page degrades gracefully (URL still generates and
  copies; recent list shows "unavailable"). That route is unchanged otherwise.
- Branch only — not deployed. Migration `0004` will apply automatically on the
  next `fly deploy` via the existing `release_command`.

## Verification

- `pnpm build` passes (typecheck + SPA build + both esbuild bundles).
- Server boots; `/healthz` 200, SPA served, `/api/admin/links` wired (401
  unauthenticated, i.e. route exists + auth-guarded).
- The interactive behaviors (≤3 per screen, Enter-advance, in-browser link
  generation) are code- and type-verified; a final click-through in a browser
  is recommended as the visual confirmation.
