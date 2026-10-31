# RejectRadar

RejectRadar shows food exporters and importers which shipments are refused at US, EU, UK and Australian borders, and why. It collects the border records that government agencies publish, puts them in one taxonomy of commodities and hazards, links each exporter's records into one firm profile, and emails users when something new appears for a firm or topic they watch.

The product reports what agencies published. It gives no risk score and no legal, regulatory or laboratory advice.

## Why

A refused container costs an exporter the shipment, the freight and often a buyer. The information that would have warned them is public, but it is spread across agencies, formats and languages. FDA, the EU, the UK and Australia each publish their own records. Some name firms and some don't, none link to the others, and some exist only as web pages or monthly spreadsheets. RejectRadar gathers it, cleans it and makes it searchable in one place.

## Who it is for

- **Primary:** export and quality managers at mid-size food exporters (20–500 staff) in Pakistan, India, Bangladesh, Sri Lanka, Vietnam, Kenya and Egypt. Their products include spices, rice, seafood, honey, nuts, dried fruit and processed food.
- **Secondary:**
  - supplier-QA teams at importers in the US, EU, UK and Australia
  - testing labs
  - export promotion bodies
  - trade consultants

## What the MVP does

1. **Topic check:** pick an origin country, commodity and destination. See monthly counts, top hazards and the latest notices, each linked to its source record, in under 10 seconds.
2. **Firm check:** find an exporter or producer by name or FDA FEI number. See its FDA refusals, FDA Import Alert listings and Australian failed tests on one profile.
3. **Watchlists and alerts:** watch firms and topics. An email arrives at once for high-severity events and in a digest for the rest.
4. **EU MRL checker:** look up the EU maximum residue level for a commodity and pesticide, with recent notices that name that residue.
5. **Bulk supplier screening:** an importer uploads up to 5,000 suppliers, reviews the matches, watches them and exports the results.
6. **PDF reports:** a one-page firm report and a report for an origin × commodity × destination topic.
7. **Import Alert summaries:** plain-language summaries of FDA Import Alerts, drafted by AI. Only summaries a person has approved are shown.
8. **Four languages:** the app and its emails in English, Urdu (right to left), Hindi and Bengali.
9. **Public API:** for Business customers, with their own keys and a monthly quota.
10. **Billing:** subscriptions through Paddle, with plan limits enforced.
11. **$0 hosting:** hosting costs nothing until the first paying customer, apart from the domain and a few dollars of AI usage.

### Not in the MVP

- Public pages for individual firms, or any numeric or predictive risk score. Only the facts as published.
- Screening people. Sole traders that an agency publishes under their own name are shown exactly as published and never enriched.
- WhatsApp and SMS alerts. These are planned for v2, on the same alert engine.
- Data from Japan, China, the Gulf states or Canada.
- Lab-report upload, green-list petition workflows, SSO and a mobile app.

### Plans

|                              | Free           | Pro         | Business           | Enterprise  |
| ---------------------------- | -------------- | ----------- | ------------------ | ----------- |
| Price                        | $0             | $39/month   | $149/month         | Custom      |
| Notice search and dashboards | Last 12 months | All history | All history        | All history |
| Firm profiles per month      | 10             | 200         | 2,000              | Custom      |
| Watchlist (firms + topics)   | 3              | 25          | 250                | Custom      |
| Members                      | 1              | 3           | 10                 | Custom      |
| PDF reports                  | —              | ✓           | ✓                  | ✓           |
| Bulk screening               | —              | —           | 5,000 rows/month   | Custom      |
| Public API                   | —              | —           | 10,000 calls/month | Custom      |

The prices are hypotheses still to be tested with customers. The limits live in one `PLANS` object in `libs/contracts`.

## Data sources

| Source                                                           | How it is read                                                                                              | History kept                                                               | Refresh      | Names firms?       | Licence                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ | ------------------ | -------------------------------- |
| FDA import refusals                                              | FDA Data Dashboard API (free credentials); food and feed only                                               | From October 2016                                                          | Weekly       | Yes, with FEI      | US federal work, public domain   |
| FDA Import Alerts                                                | Public alert pages, crawled inside FDA's robots.txt visiting hours (03:00–09:00 UTC), 30 s between requests | Current red and green lists, plus every listing seen since the first crawl | Daily        | Yes, without FEI   | US federal work, public domain   |
| EU RASFF                                                         | RASFF Window public notifications and their details                                                         | From 2020                                                                  | Daily        | No                 | European Commission reuse policy |
| UK FSA border notifications                                      | Monthly CSV files listed on data.gov.uk                                                                     | From January 2023                                                          | Weekly check | No                 | Open Government Licence          |
| Australia failing food reports (Imported Food Inspection Scheme) | Monthly CSV files listed on data.gov.au                                                                     | From June 2019                                                             | Weekly check | Producer name only | CC BY 4.0                        |
| EU pesticide MRLs                                                | The EU Pesticides Database's XML files                                                                      | Current                                                                    | Monthly      | —                  | European Commission reuse policy |

Firm-level facts come only from FDA and Australia. EU and UK data appears at country × commodity × hazard level.

## How it works

```
GitHub Actions (scheduled)                        Browser
  apps/ingest CLI                                    │
  sources → parse and check → one-transaction        ▼
  upsert → notice + change event → link firms   Cloudflare Pages (Angular web app)
  → match watchlists → email                         │
          │                                          ▼
          └──────────► Neon Postgres ◄──── Render (NestJS API) ──► Resend (email)
                       (Singapore)                   ▲        └──► Paddle (billing)
                                                     └── public API clients
```

- **Ingestion** runs as a CLI in scheduled GitHub Actions jobs, not as an always-on worker. Each sync parses everything in memory first, checks its structure and writes in one transaction. A malformed file or page therefore fails loudly and changes nothing. Files are skipped when their SHA-256 is unchanged.
- **Change events:** every new record becomes a `notice` and, after the first load, a `change_event` that alerts are built from. First loads and backfills (`--no-events`) emit no events.
- **Taxonomy:** keyword, exact and code-prefix rules map every source's fields to one commodity and any number of hazards. Unmatched values fall to "other food" or "unclassified" for review. `taxonomy:remap` re-applies changed rules to stored records; staff change the rules and ask for a remap at `/admin/taxonomy`, and the daily sync job runs `taxonomy:remap --if-requested` after its syncs.
- **Entity resolution:** records are linked to firms by FDA FEI number where one exists. Otherwise they're scored on name and address similarity within the same country. A score of at least 0.90 links automatically; 0.75–0.90 goes to a person for review. Firms can be merged and split, with an audit trail. The precision target for automatic links is at least 0.98, measured on 300 hand-labelled pairs.
- **$0 setup:**
  - Neon free tier (1 GB, Postgres 18) with a small pool, so the database can sleep
  - Render free web service for the API
  - Cloudflare Pages for the web app
  - free GitHub Actions minutes for the jobs

  A size guard stops every sync at 900 MB; the target for the full load is 450 MB or less.

## The product API

The app API under `/v1` has these product areas. Apart from `GET /taxonomy`, they need a signed-in user, and the account's plan decides the limits.

| Area           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taxonomy       | `GET /taxonomy?locale=`: commodities, hazards, destinations and countries, with labels in the language asked for. Public.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Notices        | `GET /notices` with every filter and a cursor (50 a page, no total count), `GET /notices/:id`. A commodity filter includes its sub-commodities.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Dashboards     | `GET /dashboards/topic`: monthly counts by destination, top hazards and commodities, the most frequent findings, the latest notices and how fresh each source is.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Firm search    | `GET /firms/search`: name and optional country and city, or an FEI number. Confidence labels as in the matching rules. 30 requests a minute per user.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Firm profile   | `GET /firms/:id`: facts, every record newest first and source freshness. Uses one lookup a month per firm. `POST /firms/:id/disputes` reports a problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| MRL checker    | `GET /mrl/residues` finds a pesticide by name; `GET /mrl` gives the EU limits for a commodity and recent RASFF notices that name the residue.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Import Alerts  | `GET /import-alerts/:number`: the alert text and a summary only if a person has approved it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Watchlist      | Firm and topic items, a CSV export and a notice estimate for a topic being added. Adding needs a verified email.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Alerts         | The alerts list, one alert (`GET /alerts/:id`, where alert emails link), mark as read, unread counts, and each user's instant-email and digest settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Bulk screening | Business and above. Upload a CSV of suppliers, review the matches, add confirmed firms to the watchlist and export the results. See "Bulk screening and PDF reports".                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| PDF reports    | A one-page firm report and a topic report, for Pro and above. See "Bulk screening and PDF reports".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Billing        | Plans, the account's subscription and usage, Paddle checkout and customer portal for owners, and the Paddle webhook. See "Billing with Paddle".                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| API keys       | `GET`, `POST` and `DELETE /org/api-keys`: owners and admins of Business and Enterprise accounts manage the keys of the public API. See "Public API and Import Alert summaries".                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Summary review | `GET` and `PATCH /admin/import-alert-summaries`: RejectRadar staff approve or reject the Import Alert summaries Claude drafts. See "Public API and Import Alert summaries".                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Source health  | `GET /admin/sources`: RejectRadar staff see each source's freshness and its last 10 sync runs, with their counts and errors, plus the database size against the 900 MB sync limit and today's emails against the daily cap. The web app shows it at `/admin`.                                                                                                                                                                                                                                                                                                                                             |
| Match review   | `GET /admin/match-reviews`, `POST /admin/match-reviews/:id/decision`, `GET /admin/firms/:id`, `POST /admin/firms/merge` and `POST /admin/firms/:id/split`: staff decide the records the matcher was unsure about, and merge or split firms. The web app shows them at `/admin/matches` and `/admin/firms`.                                                                                                                                                                                                                                                                                                |
| Dispute review | `GET /admin/disputes` and `PATCH /admin/disputes/:id`: staff resolve or reject what customers reported with "Report a problem", once, with a note the reporter is emailed in their language. The web app shows them at `/admin/disputes`.                                                                                                                                                                                                                                                                                                                                                                 |
| Taxonomy rules | `GET`, `POST`, `PATCH` and `DELETE /admin/taxonomy-rules` (`/:kind/:id` to change or delete), `POST /admin/taxonomy-rules/preview` to try a rule on a sample, and `GET`/`POST /admin/taxonomy/remap` to ask for a remap, which the daily sync job runs. The web app shows them at `/admin/taxonomy`.                                                                                                                                                                                                                                                                                                      |
| Accounts       | `GET /admin/orgs?q=`, `GET` and `PATCH /admin/orgs/:id`: staff find an account by name or a member's email, see its plan, usage and members, and grant or clear a plan override (Enterprise, mostly). `POST /admin/orgs/:id/deactivate` and `/reactivate` lock an account out (its sessions and API keys are refused and its alert emails stop) and let it back in; its data stays. `GET /admin/audit?action=&cursor=` reads the audit log, and `GET /admin/emails?to=&cursor=` every email sent or tried, newest first. The web app shows them at `/admin/accounts`, `/admin/audit` and `/admin/emails`. |
| Plan limits    | A used-up limit answers `403 PLAN_LIMIT_REACHED`; a feature the plan lacks answers `403 PLAN_UPGRADE_REQUIRED`. The web app shows the message for each, with a link to the plans.                                                                                                                                                                                                                                                                                                                                                                                                                         |

Alerts are made by `alerts:run` and the digests by `digest:send` (see the ingestion commands below), not by the API.

The admin area is in English only. Not built yet: the users page and the list of unmapped taxonomy values.

## Bulk screening and PDF reports

Bulk screening is for Business and above: 5,000 rows a month on Business and 50,000 by default on Enterprise. PDF reports are for Pro and above. A plan without the feature answers `403 PLAN_UPGRADE_REQUIRED` with `details.feature` of `bulk` or `pdf`; a used-up row counter answers `403 PLAN_LIMIT_REACHED` with `details.action` of `bulk_rows`. Every route needs a signed-in user.

| Route                                        | Who                         | What it does                                                                                                                                                                                                            |
| -------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/bulk-jobs/template.csv`             | Any signed-in user          | The header line and one example row.                                                                                                                                                                                    |
| `POST /v1/bulk-jobs?fileName=x.csv`          | Verified email, Business up | The CSV is the raw request body with `Content-Type: text/csv`. Answers `202` with the job. 10 uploads an hour per user.                                                                                                 |
| `GET /v1/bulk-jobs`                          | Any member                  | The account's newest 50 jobs. Every member sees every job. A stale `running` job among them is resumed, as on `GET /v1/bulk-jobs/:id`.                                                                                  |
| `GET /v1/bulk-jobs/:id`                      | Any member                  | The job's status and `processed` of `total`. A `running` job whose heartbeat is older than 60 seconds is resumed.                                                                                                       |
| `GET /v1/bulk-jobs/:id/rows?status=&cursor=` | Verified email              | 100 rows a page: the input, status, `failed`, score, the top 3 candidates and, for a row with a firm, the FDA refusals in 3 years, the red-list status and Australian failures in 3 years.                              |
| `PATCH /v1/bulk-jobs/:id/rows/:rowId`        | Verified email              | `{ action: 'confirm', firmId }` (one of the row's candidates) or `{ action: 'reject' }`. `409 ROW_PENDING` for a row not yet processed.                                                                                 |
| `POST /v1/bulk-jobs/:id/watch-confirmed`     | Verified email              | Adds the firms of `matched` and `confirmed` rows to the watchlist, as many as fit. Answers `{ added, alreadyWatched, overLimit }`.                                                                                      |
| `GET /v1/bulk-jobs/:id/export.csv`           | Verified email              | The input columns plus the matched firm, score, status and summary facts, after a UTF-8 BOM and with the upload's own delimiter (`,` or `;`). `Cache-Control: no-store`. `409 ROW_PENDING` while the job is unfinished. |
| `GET /v1/firms/:id/report.pdf`               | Verified email, Pro up      | The one-page firm report. It uses one profile lookup on the same terms as the profile, and none when the plan has no PDFs. 20 reports a minute per user, shared with the topic report.                                  |
| `GET /v1/dashboards/topic/report.pdf`        | Pro up                      | The topic dashboard as a PDF, from the dashboard's own query (`origin`, `commodity`, `destination`). It uses no lookup. 20 reports a minute per user, shared with the firm report.                                      |

**The upload.**

- The file is CSV only, at most 2 MB and 5,000 data rows, UTF-8 with or without a BOM. Excel's plain "CSV" in many locales is Windows-1252 and answers `400 INVALID_ENCODING`; save as "CSV UTF-8". The first line that is not blank is the header; if it has `;` and no `,`, the file is read with `;` as the delimiter.
- Columns are `name` and `country` (required; a country code or a name), `city` and `fei`. Headers are trimmed and case-insensitive, and unknown columns are ignored.
- Every row is checked before anything is written; one bad row rejects the whole file with `400 INVALID_ROWS` and up to 20 problems (`required`, `too_short`, `too_long`, `unknown_country`, `not_digits`). A problem's `row` counts every row under the header, blank ones too, so it matches the sheet; the 5,000-row limit counts only rows with something in them. A file that is not valid CSV (an unclosed quote, say) answers `400 INVALID_ROWS` with the `line` the parser stopped at; for an unclosed quote that is where the file ends. A `name` is 2 to 300 characters, a `city` at most 120, an `fei` 1 to 10 digits.
- The rows are charged at upload, one bulk row each, and the upload is refused if they exceed what is left of the month. The file itself is never stored.
- A `fileName` that is missing, over 200 characters or not ending in `.csv`, or any other content type, answers `415 UNSUPPORTED_FILE_TYPE`. Other errors are `413 FILE_TOO_LARGE`, `400 INVALID_HEADER` and `400 TOO_MANY_ROWS`.

**Matching.** Each row runs the firm search within its country (an FEI found exactly scores 1.0) and keeps the top 3 candidates of at least 0.50. A top score of 0.90 or more is `matched`, 0.75 to below 0.90 is `review`, and anything lower is `no_record`. A row whose search fails 3 times ends `no_record` with `failed: true`, and its export status reads `search_failed`: its search never ran to the end, which is not the same as no record found. An error about the database itself (a lost connection, Postgres out of resources, a cancelled statement) counts against no row. Reviewing sets a row `confirmed` or `rejected`.

**Processing.** The API answers the upload at once and works through the rows in batches of 50 in the same process, updating `processed` and a heartbeat. When a job's heartbeat is older than 60 seconds, the next API start, `GET /v1/bulk-jobs/:id`, `GET /v1/bulk-jobs` or the API's own sweep (every 60 seconds) resumes the pending rows, and each row is processed once. The job finishes when no row is pending. A batch in which every row fails pauses the job until a later resume, so the retries are spread out. A deploy or an idle spin-down on Render free pauses a running job until the next sweep after the API wakes: Render starts the new instance before it stops the old one, so the new instance's startup scan still sees a fresh heartbeat.

**The PDFs.** Both are A4, in English whatever the interface language, made with `pdfmake` and sent as an attachment with `Cache-Control: no-store`.

- The firm report is one page: the account's name, the firm, its facts, a 3-year summary, the latest 5 refusals, 5 Import Alert listings and 5 Australian failures, the data dates, the sources and the disclaimer. A list that is cut says "+N more".
- The topic report shows the monthly counts, the top hazards, the 8 latest notices, the data dates, the sources and the disclaimer.
- Each is made in 3 seconds or less with the API under 400 MB. Every render logs `pdf_rendered` with `kind`, `ms` and `rssMb`.

`tools/perf/p6.mjs` measures the bulk job and the PDFs (see `tools/perf/README.md`).

### Retention: `maintenance:purge`

`node dist/apps/ingest/main.js maintenance:purge` applies the retention rules, each in its own transaction, and prints how many rows each touched:

- `bulk_job_row` rows are deleted 30 days after their job finished (the `bulk_job` row stays as a record);
- `paddle_event.payload` is cleared after 90 days;
- `email_delivery` and `alert_email` rows are deleted after 90 days;
- `alert` rows, read or not, are deleted after 365 days, with their `alert_email` rows;
- `email_token`, `refresh_token` and `invite` rows are deleted 30 days after they were used, revoked or accepted, or after they expired, whichever is later.

`maintenance.yml` runs it daily at 02:30 UTC (see the schedules below).

### Backups

`backup:app --out <file>` writes the account tables to a gzipped file, one JSON line per row, from one read-only snapshot: accounts, people, memberships, invites, subscriptions and Paddle events, usage, watchlists, alerts, notification settings, bulk jobs, disputes, the audit log and API keys. Sessions, one-time tokens, email logs and the reference data (records, firms, taxonomy) are left out; the syncs or a copy rebuild the reference data, and Neon's point-in-time restore covers recent damage to anything.

`backup.yml` runs it daily at 02:17 UTC, encrypts the file with [age](https://age-encryption.org) to the public key in the `BACKUP_AGE_RECIPIENT` repository variable, and keeps it 30 days as a workflow artifact. It fails, writing nothing, while that variable is unset.

- **Set up the key once:** run `age-keygen -o rejectradar-backup.key` on your own computer, keep that file offline (it is the only way to open the backups), and put the `public key: age1…` line's key in `BACKUP_AGE_RECIPIENT`.
- **Restore:** download the artifact, run `age -d -i rejectradar-backup.key backup-<date>.ndjson.gz.age > backup.ndjson.gz`, then `node dist/apps/ingest/main.js backup:restore --file backup.ndjson.gz` with `DATABASE_URL` set to the target. The target must be migrated to the same version, hold the reference data, and have empty account tables; the restore refuses otherwise and writes nothing.
- **Drill:** before launch, restore the latest staging backup into a Neon branch of staging whose account tables are emptied (`truncate org, app_user, paddle_event, audit_log restart identity cascade` empties them all), and compare the row counts the two commands print.

### Owner steps for P6

1. **Migrate staging:** apply `0016` with the direct, not pooled, connection string, after P7's `0015`.
2. **GitHub:** nothing new. `maintenance.yml` uses the `INGEST_DATABASE_URL` secret the other workflows already use. After the merge, run it once by hand (`workflow_dispatch`) and check its counts.
3. **After the deploy, on Render staging**, with a Business test account (an admin override is fine), set the password in the environment first, so it stays out of the shell history (PowerShell: `$env:P6_PASSWORD = '…'`), then run `node tools/perf/p6.mjs --base https://rejectradar-staging-api.umarnazaket.com --email … --csv bulk-1000.csv --firm <id> --topic "origin=PK&commodity=<id>"`.
   - Check that the job takes 3 minutes or less and each PDF 3 seconds or less.
   - Read the `pdf_rendered` lines in Render's logs and check that `rssMb` stays under 400 (V11).
   - Note the results in `docs/findings/account-checks.md` against A6/V11.
4. **Restart check on staging:**
   1. Start a 1,000-row job.
   2. Restart the service from Render's dashboard while it runs.
   3. Don't open the job after the restart: wait 2 minutes, then read `processed` and `status` in the database (or in Render's logs, `bulk_jobs_resumed`), and check that the job resumed on its own, through the sweep.
   4. Check that it finishes with `processed = total` and that the usage counter went up by 1,000 once.

Not in this phase: the "Download PDF (English)" label for the other languages (built in P12; the bulk page and the PDF buttons came with P9); the multipart upload path (not needed; the `multer` advisory is cleared by an override in `package.json`); a retention rule for `alert` rows (P11); and `backup:app` with `backup.yml` (named in spec §6.3, flagged for the roadmap at P11).

## Billing with Paddle

Plans are sold through Paddle Billing: Pro at $39 a month or $390 a year, Business at $149 a month or $1,490 a year. Free has no Paddle price, and Enterprise is granted by an admin and never sold through checkout. The limits come from the plan table in `libs/contracts` and nowhere else. An admin override wins, then a paid subscription, otherwise Free. A subscription in `active`, `trialing` or `past_due` counts as paid; `past_due` keeps the plan while Paddle retries a failed payment.

| Route                          | Who                         | What it does                                                                                                                                                                                          |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/billing/plans`        | Anyone                      | The plans, their prices and limits, for the pricing page.                                                                                                                                             |
| `GET /v1/billing/subscription` | Any member                  | The plan in force and where it comes from (`override`, `subscription` or `free`), the Paddle status, interval, period end and cancel date, this month's usage and the limits.                         |
| `POST /v1/billing/checkout`    | Owner with a verified email | Returns what Paddle.js needs: `priceId`, `customData` (`{ orgId }`), `customerEmail`, the client-side token, the environment and `successUrl`. `409 ALREADY_SUBSCRIBED` while a subscription is live. |
| `POST /v1/billing/portal`      | Owner                       | Returns a Paddle customer-portal URL for plan changes, payment methods and cancellation. `409 NO_BILLING_ACCOUNT` before the first purchase.                                                          |
| `POST /v1/webhooks/paddle`     | Paddle                      | Checks the `Paddle-Signature` over the raw body, records the event once, and updates the account's subscription. No session and no CSRF header; the signature is the credential.                      |

The webhook answers 200 for a replayed event and for one that matches no account, and 5xx on a processing error so that Paddle retries. An event older than the last one applied is recorded and not applied. When a payment fails, the account's verified owners get an email in their own language.

On a downgrade nothing is deleted. New lookups, watchlist additions, bulk uploads, API calls and members are blocked until usage is back under the new limits.

### Paddle environment variables

The API refuses to start unless every one of these is set and well-formed, in every environment. Staging runs `NODE_ENV=production` with `PADDLE_ENV=sandbox`.

| Variable                | What it is                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `PADDLE_ENV`            | `sandbox` or `production`.                                                                                              |
| `PADDLE_API_KEY`        | Server-side key: `pdl_sdbx_apikey_…` for the sandbox, `pdl_live_apikey_…` for production. Never logged.                 |
| `PADDLE_CLIENT_TOKEN`   | Client-side token for Paddle.js: `test_…` for the sandbox, `live_…` for production. Safe in a browser.                  |
| `PADDLE_WEBHOOK_SECRET` | The notification destination's endpoint secret (`pdl_ntfset_…`). Never logged.                                          |
| `PADDLE_PRICE_*`        | Four recurring price IDs (`pri_…`): `PADDLE_PRICE_PRO_MONTHLY`, `_PRO_YEARLY`, `_BUSINESS_MONTHLY`, `_BUSINESS_YEARLY`. |

### Paddle sandbox tools

- `node tools/paddle/create-webhook.mjs --url https://<api host>/v1/webhooks/paddle` creates the notification destination for the five events the API handles. It reads `PADDLE_API_KEY` from `.env`, accepts only a sandbox key unless `--production` is given, and prints the secret only with `--show-secret`.
- `tools/paddle/checkout.html` is a static fallback for trying the sandbox overlay without the web app; the web app's billing page (`/settings/billing`) opens the same overlay. Paste the response of `POST /v1/billing/checkout` into it and it opens the Paddle sandbox overlay.
- `PADDLE_SANDBOX_E2E=1 npx nx test api --testFile=sandbox.manual` runs the one spec that calls the Paddle sandbox (a throwaway customer and its portal session). It is skipped otherwise, and CI never reaches Paddle.

See `tools/paddle/README.md`.

### Owner steps for Paddle (P7)

The API refuses to start without the Paddle variables, so set them before any staging redeploy:

1. **Send Paddle the V9 questions:** payouts, the 7 countries, a data-subscription product and domain approval. The answers gate live selling, not the sandbox.
2. **Client-side token:** in the Paddle sandbox dashboard, go to Developer tools, Authentication, and create a client-side token (`test_…`). Put it in the local `.env` and the Render staging environment as `PADDLE_CLIENT_TOKEN`.
3. **Webhook destination for staging:** run `node tools/paddle/create-webhook.mjs --url https://<staging api>/v1/webhooks/paddle`. Copy the endpoint secret it points to into Render staging as `PADDLE_WEBHOOK_SECRET`.
4. **Render staging variables:** `PADDLE_ENV=sandbox`, `PADDLE_API_KEY` (the sandbox key), `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, and the four `PADDLE_PRICE_*` IDs.
5. **Migrate staging:** apply `0015` with the direct, not pooled, connection string.
6. **Payment recovery:** in the Paddle dashboard's payment-recovery (dunning) settings, check that a subscription whose retries all fail is canceled, not paused. The API reads `past_due` as still paid and `canceled` as the end (P7-D6); a paused subscription does not block checkout, so its owner could buy a second one beside it.
7. **After the deploy, run a manual sandbox purchase:**
   - wake staging first with `GET /v1/health`: Render's free instances sleep, and the first webhook must not land on a cold start;
   - get the checkout details with `POST /v1/billing/checkout`;
   - open them in `tools/paddle/checkout.html` and pay with Paddle's sandbox test card;
   - check that `GET /v1/billing/subscription` turns Pro within a minute;
   - open the portal;
   - cancel, and check that the plan reads Free at the period end.

Not in this phase: live Paddle (P11, after the V9 answers), and clearing `paddle_event.payload` after 90 days (P6's `maintenance:purge`). The web app's billing page came with P9; a sandbox purchase from it is still to be run.

## Public API and Import Alert summaries

### Public API

Business and Enterprise accounts can read RejectRadar from their own systems. A public call is `GET /v1/public/...` with `Authorization: Bearer rr_live_...`. It answers with the same JSON as the app route of the same name, and it is read-only.

| Route under `/v1/public`             | What it does                                                    |
| ------------------------------------ | --------------------------------------------------------------- |
| `GET /notices`, `GET /notices/:id`   | As `/v1/notices`, with the account's history window             |
| `GET /dashboards/topic`              | As `/v1/dashboards/topic`                                       |
| `GET /firms/search`                  | As `/v1/firms/search`                                           |
| `GET /firms/:id`                     | As `/v1/firms/:id`; it also uses one firm lookup, as in the app |
| `GET /import-alerts/:number?locale=` | The alert text and its approved summary                         |
| `GET /taxonomy?locale=`              | Commodities, hazards, destinations and countries                |
| `GET /usage`                         | This month's API calls and the plan's limit; not charged        |

- **Keys.** Owners and admins with a verified email create keys with `POST /v1/org/api-keys` `{ name }` and revoke them with `DELETE /v1/org/api-keys/:id`. A key is shown once, when it is created; only its SHA-256 is stored, with its first 12 characters for display. An account holds at most 5 live keys (`409 API_KEY_LIMIT`). Creating and revoking are written to the audit log.
- **Quota.** Every call except `/usage` uses one of the plan's monthly API calls: 10,000 on Business and 100,000 by default on Enterprise. The answer carries `X-Quota-Used` and `X-Quota-Limit`. At the limit a call answers `403 PLAN_LIMIT_REACHED` with `details.action` of `api_calls`. A call with a bad query still counts; a call refused by the key check or the rate limit does not.
- **Rate limit.** 60 calls a minute per key, then `429 RATE_LIMITED` with `Retry-After`.
- **Errors.** No key or a malformed one answers `401 API_KEY_MISSING`, an unknown or revoked key `401 API_KEY_INVALID`. A plan without the API answers `403 PLAN_UPGRADE_REQUIRED` with `details.feature` of `api`. After a downgrade the keys stop working but are not deleted. A session cookie does not open `/v1/public`, and a key opens nothing else.
- **Logs** carry the key's id and account, never the key.

### Import Alert summaries

The ingestion CLI drafts a plain-language English summary of each food Import Alert with Claude (Anthropic's API). A person then approves or rejects it, and approved English is machine-translated into Urdu, Hindi and Bengali. `GET /v1/import-alerts/:number` shows an English summary only once it is approved, and a translation only beside approved English, labelled as a machine translation.

1. `summaries:draft` drafts every listed food alert that has no English summary of its current text. It sends only the alert's own text and asks for JSON in the summary's shape (structured outputs, at low effort); an answer that fails the contract schema (120 words at most), a refusal or a cut-off answer is asked for once more, then left for the next run. A refusal is first retried server-side on Anthropic's recommended fallback model (`fallbacks: "default"`). The SDK retries a busy (429 or 5xx) or timed-out call twice; a call that still fails ends the run, and the rest wait for the next one.
2. A platform admin reviews the drafts: `GET /v1/admin/import-alert-summaries?status=draft` lists them beside the alert text, and `PATCH /v1/admin/import-alert-summaries/:number` with `{ "action": "approve" }` (optionally with corrected `content`) or `{ "action": "reject" }` decides. The web app shows them at `/admin/summaries`.
3. `summaries:translate` translates approved English that has no translation of the current text yet.

When FDA changes an alert's text, its old summaries stop being shown at once, and the next `summaries:draft` writes a new draft. A summary of the old text cannot be approved (`409 SUMMARY_STALE`). A rejected summary is not drafted again until the text changes. Approving drops the alert's translations, which the next `summaries:translate` makes again from the approved English.

`summaries:draft` and `summaries:translate` read two more variables; no other command needs them.

| Variable            | What it is                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | An Anthropic API key from the Claude Console. In GitHub Actions it is a secret. |
| `ANTHROPIC_MODEL`   | The model, `claude-opus-5-5`. In GitHub Actions it is a secret too.             |

### Owner steps for P8

1. **Claude:** create an API key in the Claude Console and set a monthly spend limit on its workspace. Add it as the `ANTHROPIC_API_KEY` repository secret, and the model as the `ANTHROPIC_MODEL` secret. (Done.)
2. **Migrate staging:** apply `0017` with the direct, not pooled, connection string, after `0016`.
3. **First summaries:** run `backfill.yml` with the source `summaries`, then review the drafts and approve or reject them. Run it with `summary_translations` once a batch is approved, or let the daily run translate 30 a day.
4. **After the deploy, on staging:** make a Business test account a platform admin (`update app_user set is_platform_admin = true where email = '...'`) for the review, create an API key with `POST /v1/org/api-keys`, and call `GET /v1/public/notices` with it.

Not in this phase: an OpenAPI document of the public API and a public MRL route. The `/developers` reference page came with P12. The API-key and summary-review screens came with P9 and P10 (`/settings/api-keys`, `/admin/summaries`).

## Technology

| Area         | Choice                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| Runtime      | Node 24                                                                                                     |
| Monorepo     | Nx                                                                                                          |
| Web          | Angular, Angular Material, Tailwind CSS; the `libs/i18n` catalogs in four languages, right to left for Urdu |
| API          | NestJS 11, zod contracts shared with the web app                                                            |
| Database     | PostgreSQL 18 (`pg_trgm`), Drizzle ORM and drizzle-kit migrations                                           |
| Ingestion    | Node `fetch`, `csv-parse`, `cheerio`, `unzipper`, `commander`                                               |
| Email        | Resend (Mailpit locally)                                                                                    |
| Billing      | Paddle Billing                                                                                              |
| AI summaries | Claude Opus 5.5 through `@anthropic-ai/sdk` (structured outputs), with human approval                       |
| PDF          | `pdfmake`                                                                                                   |
| Tests        | Jest, Playwright, real Postgres in CI                                                                       |

## Repository layout

```
apps/
  api/        NestJS API: app API under /v1, public API under /v1/public
  web/        Angular web app
  web-e2e/    Playwright tests
  ingest/     Ingestion CLI run by the scheduled workflows
libs/
  contracts/  zod schemas and types for every request and response, plans and limits
  i18n/       message catalogs in English, Urdu, Hindi and Bengali, and server-side translation
  db/         Drizzle schema, SQL migrations, connection pool
  taxonomy/   commodity and hazard rules and rule matching
  matching/   name, address and country normalisation and scoring
  entities/   linking records to firms, firm facts, merge and split
  mail/       the mailer, its transports and the email templates, shared by the API and the ingest CLI
tools/
  perf/       load.mjs, the p95 check for notice search, dashboards and firm search; p6.mjs, the bulk job and PDF timings
  paddle/     create-webhook.mjs and checkout.html, the owner's Paddle sandbox tools
  smoke/      check.mjs, the read-only smoke check of a running API and web app
.github/workflows/
  ci.yml       lint, test and build on every push and pull request
  e2e.yml      the web app's end-to-end tests, nightly
  sync-*.yml   scheduled syncs
  digest.yml   daily and weekly alert digests
  maintenance.yml  the daily retention purge
  backup.yml   the daily encrypted backup of the account tables
  promote.yml  moves release, which production deploys, forward
  smoke.yml    the smoke check of production or staging, on demand
  backfill.yml manual full loads
docker-compose.yml  Postgres 18 and Mailpit for local development
```

## Getting started

Prerequisites: Node 24 and Docker.

```sh
npm ci
cp .env.example .env
npm run secret   # copy the output into JWT_SECRET in .env
npm run db:up    # PostgreSQL on 127.0.0.1:5432, Mailpit on 127.0.0.1:1025 / 8025
```

FDA refusals need free credentials from FDA's OII Unified Logon, set as `FDA_API_USER` and `FDA_API_KEY` in `.env`. `INGEST_CONTACT_EMAIL` goes into the User-Agent of every request to a source.

### API environment variables

The API validates its environment at start and refuses to start on a missing or placeholder value. `.env.example` lists them all; these are the ones for accounts and email.

| Variable           | What it is                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`       | Signs access tokens. Generate it with `npm run secret`.                                                                                                                                           |
| `APP_ORIGIN`       | The web app's origin, used in email links and CORS.                                                                                                                                               |
| `MAIL_TRANSPORT`   | `smtp` (Mailpit, for local development) or `resend`. In production the API refuses to start unless it is `resend`.                                                                                |
| `MAIL_SMTP_URL`    | Where the `smtp` transport sends mail. Default `smtp://127.0.0.1:1025`.                                                                                                                           |
| `RESEND_API_KEY`   | Required when `MAIL_TRANSPORT=resend`. A sending-only key from the Resend dashboard.                                                                                                              |
| `MAIL_FROM`        | The From header of every email, as `"Name <address>"` or a bare address. The domain must be verified in Resend.                                                                                   |
| `TRUST_PROXY_HOPS` | How many proxies in front of the API to trust for the client IP, from 0 to 5. Default 0. Staging and production sit behind Cloudflare and Render, so set it from what the logs show for `req.ip`. |

The ingestion CLI reads `MAIL_TRANSPORT`, `MAIL_SMTP_URL`, `MAIL_FROM`, `RESEND_API_KEY` and `APP_ORIGIN` as well, but only for `alerts:run` and `digest:send`. In GitHub Actions `MAIL_FROM` and `APP_ORIGIN` are repository variables and `RESEND_API_KEY` is a secret.

Locally, `npx nx serve api` sends account emails to Mailpit, whose inbox is at http://localhost:8025. In development and test, http://localhost:3000/v1/dev/emails previews every account email in every language, including the right-to-left Urdu layout. The route does not exist in production.

### The web app

`apps/web` is the Angular app (P9). It calls the API with the session cookies and the CSRF header, and renews the session when the 15-minute access cookie expires. Its text comes from the same `libs/i18n` catalogs as the emails (keys under `web.*`), served as `/i18n/<locale>.json` and formatted with Latin digits; Urdu switches the page to right to left. The UI uses Angular Material (MIT) and Tailwind CSS. Besides the sign-in screens, the public pages are the landing page at `/` (for signed-out visitors; signed in, `/` is the topic check), `/pricing`, `/sources`, `/developers` (the public API reference, in English), and `/disclaimer`, `/terms`, `/privacy` and `/refunds` (in English, as drafts until the owner's text replaces them). Pre-rendering is not built; `index.html` carries a description meta tag. Alert emails link to `/alerts/<id>`, which opens the alert and marks it read. A plan error ends with a link to the plans.

| Build                                      | API it calls                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `npx nx serve web`                         | `/v1` on the same origin, proxied to `localhost:3000` (`apps/web/proxy.conf.json`) |
| `npx nx build web --configuration=staging` | `https://rejectradar-staging-api.umarnazaket.com`                                  |
| `npx nx build web` (production)            | `https://rejectradar-api.umarnazaket.com`                                          |

Cloudflare Pages deploys `main` as the staging site and every other branch as a preview. A second Pages project, for production, deploys only the `release` branch with `npx -y npm@11.12.1 ci && npx nx build web`, at `rejectradar.umarnazaket.com` (see "Releases and rollback"). It builds with `npx -y npm@11.12.1 ci && npx nx build web --configuration=staging` on the Node version in `.nvmrc` and publishes `dist/apps/web/browser`. The project sets `SKIP_DEPENDENCY_INSTALL`, so the build command installs the dependencies itself, with npm 11, because the build image's npm 10 rejects this lockfile; keep that npm version in step with the one that writes `package-lock.json`. Unknown paths serve `index.html`, so deep links work. The API's `APP_ORIGIN` must be the web app's origin exactly, for CORS and the links in emails.

The public `/terms`, `/privacy` and `/refunds` pages, linked at the foot of the sign-in screens and the pricing page, show the English text in `apps/web/src/app/legal/legal-text.ts`. Until the owner's final text replaces the drafts there (the square brackets mark what is missing), each page says it is not yet in force; set `draft: false` when it is.

`apps/web-e2e` holds the Playwright tests. The E2E workflow runs them nightly at 01:41 UTC (and on demand) in Chromium against the real API and Postgres, migrated and loaded with `apps/web-e2e/seed.sql`; a failed run uploads the Playwright report. The tests cover a wrong password, the topic check, a notice leading to its Import Alert, the firm profile with its lookup prompt and Watch, the switch to Urdu and right to left, and the staff match review; sign-up, bulk, the PDFs and the core flow in Urdu are not covered yet. The workflow is not part of `ci.yml`, so it does not gate pull requests. To run them locally, load the seed into an empty, migrated database, start the API against it, and run `npx nx e2e web-e2e -- --project=chromium`.

### Releases and rollback

`main` deploys to staging on every merge; production (the Render service and the Pages project for `rejectradar.umarnazaket.com`) deploys the `release` branch. To release:

1. Check the commit on staging: CI green, the nightly E2E run green, and the screens you changed by hand.
2. Run the **Promote to production** workflow (Actions tab), optionally with the commit to release. It refuses a commit that is not on `main` or whose CI did not pass, and only moves `release` forward.
3. Wait for both production deploys, then run the **Smoke check** workflow for production (see "Smoke check and monitoring") and check the screens you changed.

To roll back, use "Rollback" on the previous deploy in Render and in Cloudflare Pages; each takes about a minute. `release` then sits ahead of what runs, so the next promotion carries the fix forward. Migrations only go forward and are written so the previous release still runs on the new schema (add a column first, remove the old one a release later); a bad migration is fixed by a new one.

### Smoke check and monitoring

`tools/smoke/check.mjs` checks a running API with read-only requests: `/v1/health/ready`, the plan list with its Paddle prices, a sign-in, a notice search and a firm search that must each find something, and a sign-out. With `--web` it also checks that the web app loads and was built for that API. It reads the account from `SMOKE_EMAIL` and `SMOKE_PASSWORD` and exits 1 if any check fails.

```sh
SMOKE_EMAIL=… SMOKE_PASSWORD=… node tools/smoke/check.mjs --base https://rejectradar-api.umarnazaket.com --web https://rejectradar.umarnazaket.com
```

- The E2E workflow runs it against the seeded local API before Playwright.
- The **Smoke check** workflow (on demand) runs it against production or staging. It needs the `SMOKE_EMAIL` and `SMOKE_PASSWORD` repository secrets: a verified, free-plan smoke account with the same email and password on both, used for nothing else.
- Uptime: two free checks (UptimeRobot or Better Stack, every 5 minutes, alerting the owner by email) watch `https://rejectradar-api.umarnazaket.com/v1/health/ready`, which fails when the database is unreachable, and `https://rejectradar.umarnazaket.com/`. The scheduled workflows email the owner when they fail (GitHub's own notification setting).

### Common commands

```sh
npx nx run-many -t lint test build      # lint, test and build every project
npx nx serve api                        # then open http://localhost:3000/v1/health
npx nx serve web                        # the web app on http://localhost:4200, calling the API through a proxy
npx nx build ingest && node dist/apps/ingest/main.js --help
node tools/perf/load.mjs --base http://localhost:3000 --email <email> --password <password>   # p95 of search and dashboards
node tools/perf/p6.mjs --base http://localhost:3000 --email <email> --password <password> --csv bulk-1000.csv --firm <id>   # bulk job and PDF times
SMOKE_EMAIL=<email> SMOKE_PASSWORD=<password> node tools/smoke/check.mjs --base http://localhost:3000   # read-only smoke check
```

`tools/perf/load.mjs` signs in, warms each route and checks that the 95th-percentile response time of notice search, dashboards and firm search is 800 ms or less. `tools/perf/p6.mjs` uploads a 1,000-row CSV as a bulk job and times the firm and topic PDFs. See `tools/perf/README.md`.

### Ingestion CLI

| Command                                                    | What it does                                                                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync:fda-charge-codes`                                    | FDA charge codes and their hazards                                                                                                                                                              |
| `sync:fda-refusals [--from YYYY-MM-DD]`                    | FDA refusals (default: the last 120 days)                                                                                                                                                       |
| `sync:import-alerts [--only 99-19,…]`                      | FDA Import Alert red and green lists; a full crawl only in FDA's visiting hours. `--if-due` (scheduled runs) skips instead of failing outside them or after a full crawl succeeded that UTC day |
| `sync:rasff [--from …] [--details-limit n]`                | EU RASFF notifications and their hazards                                                                                                                                                        |
| `sync:uk-bn` / `sync:au-ifis`                              | UK and Australian monthly files, loading new or changed files only                                                                                                                              |
| `sync:eu-mrl`                                              | EU pesticide MRLs, replaced in full                                                                                                                                                             |
| `taxonomy:remap`                                           | Re-applies the taxonomy rules to every stored record; with `--if-requested`, only when staff asked for it since the last remap                                                                  |
| `entities:link`                                            | Links records to firms and refreshes firm facts                                                                                                                                                 |
| `alerts:run [--no-email]`                                  | Turns new change events into alerts and sends the instant emails                                                                                                                                |
| `digest:send`                                              | Sends the daily digests, and the weekly ones on Mondays                                                                                                                                         |
| `summaries:draft [--limit n] [--only …]`                   | Drafts English Import Alert summaries with Claude, for a person to approve                                                                                                                      |
| `summaries:translate [--limit n]`                          | Translates approved English summaries into Urdu, Hindi and Bengali                                                                                                                              |
| `db:size-check`                                            | Exits 1 at or above 900 MB                                                                                                                                                                      |
| `maintenance:purge`                                        | Applies the retention rules and prints each count (see "Retention")                                                                                                                             |
| `backup:app --out <file>` / `backup:restore --file <file>` | Writes the account tables to a gzipped file, or puts one back into empty account tables (see "Backups")                                                                                         |
| `verify-source`, `probe-page`                              | Checks a source: fields, rows, fill rates, duplicate keys, page patterns                                                                                                                        |

`alerts:run` and `digest:send` send email through the same daily cap as the API, so they read the mail variables above. `alerts:run --no-email` creates the alerts and needs none of them. `alerts:run` exits 3 when a firm-level record has stayed unlinked for 48 hours, because alerts stop at the first such record; GitHub Actions then emails the owner. `digest:send` exits 1 when a digest could not be sent.

Every `sync:*` command takes `--no-events` for backfills. Long syncs on Windows are best run in a Linux container, because Node 24 on Windows has aborted mid-way through long runs of HTTPS requests. From PowerShell, after `npx nx build ingest`:

```powershell
docker run --rm -e DATABASE_URL -v "${PWD}:/app:ro" -w /app node:24.15.0-bookworm-slim node dist/apps/ingest/main.js sync:rasff --details-limit 2000 --no-events
```

### Schedules (UTC)

| Workflow           | When                                                      | Runs                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync-daily.yml`   | 03:07 every day; Import Alerts alone also at 23:37        | Import Alerts, then `entities:link`, `alerts:run`, `summaries:draft` and `summaries:translate`; then, in the 03:07 run only, RASFF with its `alerts:run` and, last, `taxonomy:remap --if-requested`. GitHub can start a schedule hours late, so the extra run makes sure one crawl starts inside FDA's visiting hours; a scheduled crawl outside them, or after one succeeded that day, skips (`--if-due`) |
| `sync-weekly.yml`  | 08:00 every day for now, then weekly on FDA's refresh day | FDA charge codes and refusals, then `entities:link`                                                                                                                                                                                                                                                                                                                                                        |
| `sync-weekly.yml`  | 06:30 on Mondays                                          | UK, then Australia, then `entities:link`                                                                                                                                                                                                                                                                                                                                                                   |
| `sync-monthly.yml` | 03:30 on the 1st                                          | EU MRLs                                                                                                                                                                                                                                                                                                                                                                                                    |
| `backup.yml`       | 02:17 every day                                           | `backup:app`, encrypted, kept 30 days                                                                                                                                                                                                                                                                                                                                                                      |
| `maintenance.yml`  | 02:30 every day                                           | `maintenance:purge`                                                                                                                                                                                                                                                                                                                                                                                        |
| `digest.yml`       | 03:00 every day                                           | `digest:send` (weekly digests on Mondays)                                                                                                                                                                                                                                                                                                                                                                  |
| `backfill.yml`     | On demand                                                 | One source with `--no-events`                                                                                                                                                                                                                                                                                                                                                                              |

Each job first checks the database size, and only one job writes to the database at a time. Every scheduled sync workflow ends with `alerts:run`.

Alerts depend on that. `alerts:run` reads change events in order and moves its cursor past them, so an event committed late by a second writer would never be alerted. The sync workflows therefore share one concurrency group, and `digest.yml` has its own because it inserts no change events or alerts, so it cannot create the late-commit gap that the shared group prevents. `maintenance.yml` has its own group too: it only deletes rows past their retention and clears old payloads. Those include `alert_email` rows, which `alerts:run` writes, but only ones over 90 days old; `alerts:run` only adds new `alert_email` rows, so the purge and the runs never touch the same rows. Don't run syncs by hand at the same time as scheduled ones.

## Launch runbook

Production copies staging's shape on the same providers: the web app at `https://rejectradar.umarnazaket.com` (Cloudflare Pages), the API at `https://rejectradar-api.umarnazaket.com` (Render, Singapore, an always-on Starter instance), its own Neon project (Singapore, Postgres 18), Resend on a verified domain and live Paddle. Both production hosts deploy the `release` branch (see "Releases and rollback"). Nothing is done on production before it has passed on staging. Do the steps in this order.

### 1. Finish staging

1. Apply the missing migrations with the direct, not pooled, connection string: `DATABASE_URL=<direct url> npx drizzle-kit migrate --config=libs/db/drizzle.config.ts` applies whatever is not applied yet, in order (`0015` to `0018` on staging today).
2. Close the earlier owner steps: Paddle sandbox ("Owner steps for Paddle"), the `APP_ORIGIN` and `MAIL_FROM` repository variables, the staff accounts (`update app_user set is_platform_admin = true where email = '…'`), the first full Import Alert crawl and a week of green scheduled runs, the P3 precision check, the P5 and P6 measurements, and the native-speaker review of the ur, hi and bn strings.
3. Set up the backup key and run the restore drill ("Backups").
4. Sign up a smoke account on staging and verify its email; put its email and password in the `SMOKE_EMAIL` and `SMOKE_PASSWORD` repository secrets, and run the **Smoke check** workflow for staging.

### 2. Set up production

1. **Paddle live**, which takes days, so start first: send the business details and the V9 answers for approval, replace the `[bracketed]` parts of `apps/web/src/app/legal/legal-text.ts` with the final text and set `draft: false`, in a pull request like any other change (Paddle reviews those pages), then create the live products and four prices, a live client-side token, and the live webhook with `node tools/paddle/create-webhook.mjs --production --url https://rejectradar-api.umarnazaket.com/v1/webhooks/paddle`. Set payment recovery to cancel, as in the sandbox.
2. **Neon:** create the production project and migrate it with its direct connection string, as in step 1.1.
3. **Reference data:** copy it from staging instead of crawling every source again. With `pg_dump` and `pg_restore` 18:

   ```sh
   pg_dump "$STAGING_DIRECT_URL" -Fc --data-only -f reference.dump $(printf -- '-t public.%s ' commodity commodity_rule hazard hazard_rule fda_charge_code fda_refusal rasff_notification uk_border_notification au_failing_food eu_pesticide_residue eu_mrl_product eu_mrl import_alert import_alert_listing import_alert_listing_product import_alert_summary firm firm_fei firm_alias match_review notice change_event job_cursor source_file source_sync_run)
   psql "$PRODUCTION_DIRECT_URL" -c "truncate commodity, commodity_rule, hazard, hazard_rule cascade"
   pg_restore --data-only --no-owner -d "$PRODUCTION_DIRECT_URL" reference.dump
   ```

   The truncate clears the taxonomy the migrations seeded, so staging's rules replace it. No account table is copied. `pg_dump` warns about `commodity`'s link to itself; the restore still works.

4. **Resend:** verify the production sender domain (SPF and DKIM records) and create a sending-only key.
5. **Render:** run **Promote to production** once first, so the `release` branch exists. Then create a new web service from this repository in Singapore, on the Starter instance, deploying `release` automatically, with the staging service's build and start commands. Set every variable afresh, never copied from staging: `NODE_ENV=production`, the pooled `DATABASE_URL`, a new `JWT_SECRET` (`npm run secret`), `APP_ORIGIN=https://rejectradar.umarnazaket.com`, `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `MAIL_FROM` on the verified domain, `TRUST_PROXY_HOPS` as on staging, and the live Paddle values with `PADDLE_ENV=production`. Add the custom domain `rejectradar-api.umarnazaket.com`.
6. **Cloudflare Pages:** a second project from this repository with production branch `release`, build command `npx -y npm@11.12.1 ci && npx nx build web`, output `dist/apps/web/browser` and `SKIP_DEPENDENCY_INSTALL` set, as on staging. Turn off its preview deployments (the staging project already builds every branch) and add the custom domain `rejectradar.umarnazaket.com`.
7. **GitHub:** point the `INGEST_DATABASE_URL` secret at production's direct string, and `APP_ORIGIN`, `MAIL_FROM` and `RESEND_API_KEY` at production's values. From then on every scheduled job writes to production only; staging keeps the data it has. To refresh it, copy production's reference data into a freshly migrated staging database the same way.
8. **People:** sign up the staff accounts on production and make them admins, and sign up the smoke account with the same email and password as on staging.

### 3. Launch day

1. Run **Promote to production** and wait for both deploys.
2. Run the **Smoke check** workflow for production.
3. By hand, in English and in Urdu: sign up, verify the email, open a firm, watch it and receive an alert email.
4. Buy Pro with a real card through the live checkout, check that the plan changes, then refund the payment and cancel the subscription in Paddle, and check that the plan reads Free.
5. Turn on the two uptime checks ("Smoke check and monitoring") and check that a test alert reaches you.
6. Watch the first scheduled runs and the first nightly backup; download that backup and open it with the private key.

To roll back code or migrations, see "Releases and rollback". For data, restore Neon to a point in time into a branch for recent damage, or use the latest `backup:app` file ("Backups") for account data older than Neon keeps.

## Status and roadmap

About 75 development days in 12 phases.

| Phase | What                                                                                 | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Foundation: workspace, database, CI, accounts, checks of every source                | ✅ Done (October 2026)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P2    | Ingestion and taxonomy: six sources, full history, scheduled syncs                   | Built and merged. Staging holds FDA refusals since 2016, RASFF since 2020, UK, Australia and EU MRLs (195 MB). Still to do: the first full Import Alert crawl, a week of green scheduled runs and the final size check.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P3    | Entity resolution: linking, firm facts, merge and split                              | Built and merged; 20,833 firms from 90,614 records on a full local load. Waiting for the labelled-pair precision gate and the first link on staging.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| P4    | Auth, accounts, email and the i18n core                                              | Built and merged (PRs #35 and #36). Sign-up, login, sessions, password reset, members and invites, the email cap and localised emails. Still to do: the staging migrations and settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P5    | Core product API: search, dashboards, firm profiles, MRL checker, watchlists, alerts | Built and merged (PR #37). See "The product API". Still to do: the staging migration, mail settings and link check; then the p95 and hand checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| P6    | Bulk supplier screening and PDF reports                                              | Built and merged (PR #39). See "Bulk screening and PDF reports". Still to do: the owner steps there (the `0016` staging migration); then the staging measurements and the restart check.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| P7    | Billing with Paddle                                                                  | Built and merged (PR #38). See "Billing with Paddle". Still to do: the owner steps there (Paddle token, webhook destination, Render variables, the `0015` staging migration); then the manual sandbox purchase.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| P8    | Public API and Import Alert summaries                                                | Built and merged (PRs #40, #41 and #43). See "Public API and Import Alert summaries". Still to do: the owner steps there (the `0017` staging migration, the first summaries) and the cost check of one summary in four languages. Not built: an OpenAPI document and a public MRL route (the `/developers` page came with P12).                                                                                                                                                                                                                                                                                                             |
| P9    | Web app in four languages                                                            | Built and merged (#42, #44, #46, #47, #48, #50): every signed-in screen in the four languages, right to left in Urdu, axe-checked (WCAG 2.1 AA) in English and Urdu, with a first download of about 367 kB (about 100 kB over the wire) and a nightly Playwright run. The public pages, the `/alerts/<id>` route, upgrade links and the "Download PDF (English)" label came with P12. Not built: pre-rendering and the "Waking up the server…" message (production runs always on). Still to do: a native-speaker review of the ur, hi and bn strings                                                                                       |
| P10   | Admin panel: health, taxonomy, match review, summaries                               | Built and merged (#51 to #54, #56): the admin area at `/admin` for staff (`app_user.is_platform_admin = true`, set by SQL): source health, the summary review, match review and the firm merge and split tools, dispute review, taxonomy rules with remap requests, accounts with the plan override and deactivation (P11), and the audit log. The email log and the database size and email count on source health came with P12. Not built: the users page and the unmapped-values list. Still to do: the `0018` staging migration, making the staff accounts admins on staging, and a native-speaker review of the dispute email strings |
| P11   | Deployment and launch                                                                | Built and merged (#62 onwards): the production build and the Promote to production workflow, draft terms, privacy and refund pages, the nightly encrypted backup with its restore, the 365-day alert retention, account deactivation and the smoke check. Still to do: the owner steps in "Launch runbook", then launch                                                                                                                                                                                                                                                                                                                     |
| P12   | Closing the MVP gaps                                                                 | Built and merged (#65 onwards): the alert page alert emails link to, upgrade links on plan errors, the "Download PDF (English)" label, the landing page, the data-sources and disclaimer pages, the `/developers` API reference, and the email log with the database size and email count for staff. Still to do: the owner's review of the landing, sources and disclaimer copy, and the native-speaker review of the new strings                                                                                                                                                                                                          |

## Data and privacy principles

- Every notice links to the agency's own record. Facts are shown as published, never scored or interpreted.
- There are no public firm pages; firm profiles need an account.
- Personal details that a source publishes, such as the RASFF officials named in notification details, are never stored.
- Sources are credited as their licences require. The EU MRL database itself has no legal value; the EU Official Journal does.

## Docs

Design specs, phase plans and research findings are kept outside this repository, in a local `docs/` folder that git ignores. This README is the public summary of them.
