# CJC Wealth — Unified Intake Form

## Goal
Replace SurveyMonkey eval forms (DC SOFA, DC SOFA 2, DC SOFA 3) with single
Next.js form hosted on Vercel. Form submits to Zapier webhook, which routes
to consolidated staging Zaps that write to Salesforce.

## Stack
- Vite + React 18 + TypeScript (existing scaffold)
- Tailwind CSS v4 + shadcn/ui (existing)
- Deployed to Vercel free tier as static SPA + serverless function
- Existing form is in artifacts/intake-form/ (Replit pnpm monorepo)
- No database, no auth — form is public

## Architecture
[Form] → POST /api/submit → Zapier Catch Hook → Salesforce Create Lead

Source attribution via URL parameter:
- ?source=fnn → Lead Source: "FNN: Webinar"
- ?source=internal → Lead Source: "Internal: Webinar"
- ?source=federal → Lead Source: "SOFA: Webinar"
- (no param) → Lead Source: "SOFA: Webinar" (default)

## Form structure
Multi-step, 3 questions per screen, progress bar, framer-motion transitions.
Existing form is 11 screens × 1 question — restructure to 5 screens × 3 questions.
Step 1 (Contact): First Name, Last Name, Email
Step 2 (Contact cont.): Phone, State, Federal Agency (dropdown)
Step 3 (Demographics): Age, Marital Status, Years to Retire
Step 4 (Financials): TSP Balance, Contributing elsewhere?, Maxing out TSP?
Step 5 (Status): Separating within 2 months?, Areas of concern, Comments

[Need to confirm exact question wording matches SurveyMonkey before launch]

## API route
POST /api/submit
- Vercel serverless function at /api/submit.ts
- Validates required fields server-side
- Reads source attribution from request body (set client-side from URL param)
- POSTs to Zapier webhook URL (env var: ZAPIER_WEBHOOK_URL)
- Returns { success: boolean, error?: string } to client

## Scope discipline
- Match SurveyMonkey questions exactly (don't add new ones)
- Don't try to fix Salesforce field mappings in the form — that's the Zap's job
- No analytics, no tracking pixels, no email confirmations in v1
- Mobile responsive, but desktop is primary

## Out of scope
- Custom domain (using Vercel default for now)
- Form analytics (later)
- Multi-language (later)
- A/B testing (later)
- Captcha (later — federal employees, low spam risk)

## Testing approach
1. Local dev: form submits to webhook.site to inspect payload structure
2. Staging: form submits to staging Zapier webhook
3. Production: form submits to production Zapier webhook (after cutover)

## Done criteria
- Form looks polished on desktop and mobile
- All 15+ questions captured
- Source attribution working
- Submits to webhook successfully with clean payload
- Deployed to Vercel
- Loom walkthrough recorded
