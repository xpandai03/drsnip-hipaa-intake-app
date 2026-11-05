# AdsWizz pixel on registration success: report

**Date:** 5 Nov 2026 · **Release:** Fly `drsnip-intake-demo` **v108** (image `deployment-01M6PZKNZPSJWYRMKQ1PKH3MJV`), from tag **`pixel-adswizz-deploy-1`** (`7dd1ef2` = production's `train-b-j5` + this change) · **PR:** #83 · **Rollback point:** v107 / `train-b-j5`

## Result

| Check | Result |
|---|---|
| Pixel fires once on a live registration | ✅ One image request from the intake frame to exactly the supplied URL. **AdsWizz 302** → `pixel.tapad.com` 302 → **200**. |
| Not on consultation or insurance | ✅ Neither page references the module (unit test); same bundle, no call site. |
| Not on a failed submit | ✅ Gated on the server-confirmed `ok` (unit test). |
| Intrepy conversion message unaffected | ✅ Live: exactly one `{event: 'intake_conversion', form_type: 'registration'}` from `https://intake.drsnip.com`. |
| Live test submission | **`ee9fdd7e`**: `manual_review`, no chart (`n8n_patient_id` null), bridge 1.6 s. **Not removed yet:** no admin credentials here, so Raunek deletes it. |
| ManualReview Sheets row | **None was added.** n8n's `Sheets: ManualReview` returned *"Sheet with name ManualReview not found"* (see below). |
| CSP hosts added | **None.** The app's only CSP is `frame-ancestors`; there is no `img-src` to widen. |

## What changed

- **`artifacts/intake-form/src/lib/adswizz.ts`:**
  - one constant holding the pixel URL exactly as supplied (byte-identical to `scratchpad/pixel-adswizz.txt`, 785 chars, `redirectURL` untouched);
  - `appendRegistrationPixel()` adds one `<img>` (width and height 0, `display:none`, `referrerpolicy="no-referrer"`, `alt=""`, src set last) to the form's own document, and never throws.
- **`Home.tsx`:** `registrationPixelOnResult(ok)` runs right after the existing `if (ok) postConversion("registration")`, on the same `ok = res.ok && json.success === true`. Nothing runs in the error path, and there is no runtime flag.
- **`api/_lib/analytics.ts`:** a header line records the 2026-11-05 client request as the one exception to the 2026-08-27 vendor-script rule.
- **Tests:** 8 new (`api/_test/adswizz-pixel.test.ts`):
  - exactly one img with that src on a confirmed registration;
  - none on a failed submit;
  - none from consultation or insurance;
  - `postConversion` still exactly once per form;
  - the constant is not the placeholder.

  `test:api`: 715 pass, 0 fail.

## What leaves the patient's browser
One GET to `us-49476-adswizz.attribution.adswizz.com`. AdsWizz redirects it to **`pixel.tapad.com`**, a cross-device identity-sync partner named in the pixel's own `redirectURL`, so a second ad-tech vendor receives the request. No form data, submission id or referrer is sent. Both vendors see the browser's IP address, user agent and their own cookies, at the moment the patient completes a registration.

## Verification

- **Local run:**
  - Setup: the production build (`VITE_CONVERSION_TRACKING_ENABLED=true`) on a local server with a disposable DB and the n8n bridge off. Playwright served a stand-in `https://drsnip.com` parent and proxied `https://intake.drsnip.com` to the local server, so the origins matched production.
  - The pixel request was answered locally, so no fake conversion reached AdsWizz.
  - Result: one image request to the exact URL; one `intake_conversion {registration}` received by the parent; `/api/submit` 200; success step shown.
  - `assert-conversion-bundle.mjs`: self-test ok, "compiled ON". The image build re-ran it: "compiled ON".
- **Parity, with one substitution.** The brief said "byte-identical to a local build of main". It is compared against a local build of **`train-b-j5` + this change** instead, because CLAUDE.md requires deploying from production's tag while #72 is unapproved, and `main` contains #72. Agreed with Raunek.
  - `/`, `/consultation` and `/insurance` on `intake.drsnip.com` all serve `index-DbasREsr.js`.
  - sha256 `a62270ca…0fa460` is **identical** to the local build.
  - The bundle carries the `drsnip-conversion-build:enabled` marker, its `setAttribute("data-drsnip-conversion"…)`, `intake_conversion`, and the pixel URL exactly once.
- **Live test**, one submission on `https://drsnip.com/registration`. It used the manual-review recipe: the test chart's name and DOB, with a novel email and phone.
  - Two earlier attempts stopped inside the test driver before Submit (an off-screen button and an animated card in the headless browser). They created **no submission**: one row carries the test email, and that row is `ee9fdd7e`.

## Clean-up for Raunek

1. **Delete submission `ee9fdd7e`** in the console (admin).
2. **J5 comeback table, row `id = 47`.** The second aborted attempt passed the contact step, so the form saved a drop-off partial. The live submit cleared it by email match and recorded a "comeback" (`match_type = 'email'`, 63 s), which would skew December's percentiles.
   - Fix: `DELETE FROM registration_partial_conversions WHERE id = 47;`
   - Row 48 (`session`) is from the same test. It never enters the percentiles, but it can go too.
   - This is a production write beyond this brief, so it was not done.
3. **n8n Registration v2 `Sheets: ManualReview`.** The workbook has no `ManualReview` tab, so every manual-review registration's audit row fails, hidden by `continueOnFail`. That's why no row needed removing. It's pre-existing and n8n is out of scope here; worth a separate look.

## Rollback
`fly deploy -a drsnip-intake-demo --image registry.fly.io/drsnip-intake-demo:deployment-01M6M87MGY6GZDJZHEGNKVNJ66` (v107 / `train-b-j5`). No DB change in this item.
