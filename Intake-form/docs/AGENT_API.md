# Read-only agent API (`/api/agent/*`)

What Xpand's clinic agents (the `xpand-drsnip-agents` app, Fly org it-snip) read from the console. The code is `api/agent/index.ts`, mounted in `api-server/index.ts` before the `/api/*` 404. The tests are `api/_test/agent-api.test.ts`, run as part of `pnpm run test:api`.

## Guarantees

- **Its own token:** `Authorization: Bearer <AGENT_API_TOKEN>`.
  - It isn't the console session or `N8N_SERVICE_TOKEN`, and neither of those opens it.
  - **Fail closed:** with `AGENT_API_TOKEN` unset, every route answers 503.
  - A missing or wrong token gets 401.
- **GET only:** every other method, OPTIONS included, gets 405 before anything else runs.
- **Read-only:** every query runs in a `READ ONLY` transaction with `statement_timeout = 2s` and `jit = off`, set per transaction before the query (the 2026-10-19 outage: `api/_lib/report-query.ts`).
  - A write is impossible, and a slow query fails fast (504) instead of holding the database.
  - At most 2 agent queries run at once; more get 429.
- **The fewest fields:** names and dates only, like the console's own patient lists.
  - Never a submission's `raw_payload` (one key, the office location, is read server side by the console's own location expression) or `n8n_response_body`.
  - Never an email, phone, date of birth, address, insurance or clinical field, and never `submission_files` (the card images).
- **A hard LIMIT on every query:** each list returns at most its cap, and `truncated: true` says there were more.
- **Nothing identifying in logs:** ids are query parameters, never in the path. On an error, the module logs the endpoint and the Postgres error code only.
- **Answers:** `{ rows, count, truncated, ms }`.

## Endpoints

| Endpoint | Returns | Cap |
|---|---|---|
| `GET /api/agent/health` | `{ ok: 1 }` | 1 |
| `GET /api/agent/submissions?days=14` (1 to 60) | Recent submissions, newest first: `submission_id, created_at, form_type, n8n_status, name, location` | 50 |
| `GET /api/agent/submission?id=<uuid>` | One submission: the fields above, plus `chart_id` and `days_since` | 1 |
| `GET /api/agent/manual-review` | Submissions in manual review, newest first: `submission_id, created_at, form_type, name, location, days_waiting`. No candidates and no response body. | 50 |
| `GET /api/agent/unscheduled` | The console's "Unscheduled at day 14: right now, past day 14" list (the same `DAY14_BUCKET_CTE`): registered in the last 30 days, past day 14, nothing booked. Fields: `chart_id, name, registered_on, days_since, has_appointment, latest_status, latest_date`. | 100 |
| `GET /api/agent/appointments?chart_id=<id>` | A chart's appointments, newest first: `date, time, status, type_id` | 20 |
| `GET /api/agent/cohorts?grain=month\|week` | `drsnip_conversion_cohorts('registration', grain)`, counts only, with small cells withheld by the function: `period_start, period_end, row_status, period_complete, forms, not_covered, converted_now, fill_p0..p3, fill_later, withheld` | 120 |

## Cost (timed at production shape)

Each query was timed once against production, read-only, under its 2 s timeout with JIT off, on 2026-11-03 at about 00:40 PT:

| Query | Time |
|---|---|
| unscheduled | 383 ms |
| cohorts (month) | 419 ms |
| cohorts (week) | 392 ms |
| appointments | 5.6 ms |
| submissions, submission, manual review | under 2 ms |

No index or migration was added.

## Reaching it

The agent app reaches the console over Fly's private network: `http://drsnip-intake-demo.internal:8080` (the same org). The server listens on every address, so this skips the public proxy.

## Setting it up

```bash
fly secrets set AGENT_API_TOKEN=<32 random bytes, hex> -a drsnip-intake-demo --stage   # with the next deploy
```

The same token goes to `xpand-drsnip-agents` as `CLIENT_API_TOKEN`. It's never printed or committed.

To turn the API off, `fly secrets unset AGENT_API_TOKEN -a drsnip-intake-demo`: every route then answers 503.
