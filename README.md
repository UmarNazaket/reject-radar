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
- **Taxonomy:** keyword, exact and code-prefix rules map every source's fields to one commodity and any number of hazards. Unmatched values fall to "other food" or "unclassified" for review. `taxonomy:remap` re-applies changed rules to stored records.
- **Entity resolution:** records are linked to firms by FDA FEI number where one exists. Otherwise they're scored on name and address similarity within the same country. A score of at least 0.90 links automatically; 0.75–0.90 goes to a person for review. Firms can be merged and split, with an audit trail. The precision target for automatic links is at least 0.98, measured on 300 hand-labelled pairs.
- **$0 setup:**
  - Neon free tier (1 GB, Postgres 18) with a small pool, so the database can sleep
  - Render free web service for the API
  - Cloudflare Pages for the web app
  - free GitHub Actions minutes for the jobs

  A size guard stops every sync at 900 MB; the target for the full load is 450 MB or less.

## The product API

The app API under `/v1` has these product areas. Apart from `GET /taxonomy`, they need a signed-in user, and the account's plan decides the limits.

| Area          | What it does                                                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taxonomy      | `GET /taxonomy?locale=`: commodities, hazards, destinations and countries, with labels in the language asked for. Public.                                         |
| Notices       | `GET /notices` with every filter and a cursor (50 a page, no total count), `GET /notices/:id`. A commodity filter includes its sub-commodities.                   |
| Dashboards    | `GET /dashboards/topic`: monthly counts by destination, top hazards and commodities, the most frequent findings, the latest notices and how fresh each source is. |
| Firm search   | `GET /firms/search`: name and optional country and city, or an FEI number. Confidence labels as in the matching rules. 30 requests a minute per user.             |
| Firm profile  | `GET /firms/:id`: facts, every record newest first and source freshness. Uses one lookup a month per firm. `POST /firms/:id/disputes` reports a problem.          |
| MRL checker   | `GET /mrl/residues` finds a pesticide by name; `GET /mrl` gives the EU limits for a commodity and recent RASFF notices that name the residue.                     |
| Import Alerts | `GET /import-alerts/:number`: the alert text and a summary only if a person has approved it.                                                                      |
| Watchlist     | Firm and topic items, a CSV export and a notice estimate for a topic being added. Adding needs a verified email.                                                  |
| Alerts        | The alerts list, mark as read, unread counts, and each user's instant-email and digest settings.                                                                  |
| Billing       | Plans, the account's subscription and usage, Paddle checkout and customer portal for owners, and the Paddle webhook. See "Billing with Paddle".                   |
| Plan limits   | A used-up limit answers `403 PLAN_LIMIT_REACHED`; a feature the plan lacks answers `403 PLAN_UPGRADE_REQUIRED`. P9 will show both as an upgrade prompt.           |

Alerts are made by `alerts:run` and the digests by `digest:send` (see the ingestion commands below), not by the API.

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
- `tools/paddle/checkout.html` is a static page that stands in for the billing page until P9. Paste the response of `POST /v1/billing/checkout` into it and it opens the Paddle sandbox overlay.
- `PADDLE_SANDBOX_E2E=1 npx nx test api --testFile=sandbox.manual` runs the one spec that calls the Paddle sandbox (a throwaway customer and its portal session). It is skipped otherwise, and CI never reaches Paddle.

See `tools/paddle/README.md`.

### Owner steps before merging `p7/billing-paddle`

The API refuses to start without the Paddle variables, so these come before the merge and before any staging redeploy:

1. **Send Paddle the V9 questions:** payouts, the 7 countries, a data-subscription product and domain approval. The answers gate live selling, not the sandbox.
2. **Client-side token:** in the Paddle sandbox dashboard, go to Developer tools, Authentication, and create a client-side token (`test_…`). Put it in the local `.env` and the Render staging environment as `PADDLE_CLIENT_TOKEN`.
3. **Webhook destination for staging:** run `node tools/paddle/create-webhook.mjs --url https://<staging api>/v1/webhooks/paddle`. Copy the endpoint secret it points to into Render staging as `PADDLE_WEBHOOK_SECRET`.
4. **Render staging variables:** `PADDLE_ENV=sandbox`, `PADDLE_API_KEY` (the sandbox key), `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, and the four `PADDLE_PRICE_*` IDs.
5. **Migrate staging:** apply `0015` with the direct, not pooled, connection string.
6. **After the deploy, run a manual sandbox purchase:**
   - get the checkout details with `POST /v1/billing/checkout`;
   - open them in `tools/paddle/checkout.html` and pay with Paddle's sandbox test card;
   - check that `GET /v1/billing/subscription` turns Pro within a minute;
   - open the portal;
   - cancel, and check that the plan reads Free at the period end.

Not in this phase: the billing page in the web app (P9), live Paddle (P11, after the V9 answers), and clearing `paddle_event.payload` after 90 days (P6's `maintenance:purge`).

## Technology

| Area         | Choice                                                                             |
| ------------ | ---------------------------------------------------------------------------------- |
| Runtime      | Node 24                                                                            |
| Monorepo     | Nx                                                                                 |
| Web          | Angular, PrimeNG, Tailwind CSS, Transloco (four languages, right to left for Urdu) |
| API          | NestJS 11, zod contracts shared with the web app                                   |
| Database     | PostgreSQL 18 (`pg_trgm`), Drizzle ORM and drizzle-kit migrations                  |
| Ingestion    | Node `fetch`, `csv-parse`, `cheerio`, `unzipper`, `commander`                      |
| Email        | Resend (Mailpit locally)                                                           |
| Billing      | Paddle Billing                                                                     |
| AI summaries | Google Gemini, with structured output and human approval                           |
| PDF          | `pdfmake`                                                                          |
| Tests        | Jest, Playwright, real Postgres in CI                                              |

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
  perf/       load.mjs, the p95 check for notice search, dashboards and firm search
  paddle/     create-webhook.mjs and checkout.html, the owner's Paddle sandbox tools
.github/workflows/
  ci.yml       lint, test and build on every push and pull request
  sync-*.yml   scheduled syncs
  digest.yml   daily and weekly alert digests
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

### Common commands

```sh
npx nx run-many -t lint test build      # lint, test and build every project
npx nx serve api                        # then open http://localhost:3000/v1/health
npx nx build ingest && node dist/apps/ingest/main.js --help
node tools/perf/load.mjs --base http://localhost:3000 --email <email> --password <password>   # p95 of search and dashboards
```

`tools/perf/load.mjs` signs in, warms each route and checks that the 95th-percentile response time of notice search, dashboards and firm search is 800 ms or less. See `tools/perf/README.md`.

### Ingestion CLI

| Command                                     | What it does                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `sync:fda-charge-codes`                     | FDA charge codes and their hazards                                              |
| `sync:fda-refusals [--from YYYY-MM-DD]`     | FDA refusals (default: the last 120 days)                                       |
| `sync:import-alerts [--only 99-19,…]`       | FDA Import Alert red and green lists; a full crawl only in FDA's visiting hours |
| `sync:rasff [--from …] [--details-limit n]` | EU RASFF notifications and their hazards                                        |
| `sync:uk-bn` / `sync:au-ifis`               | UK and Australian monthly files, loading new or changed files only              |
| `sync:eu-mrl`                               | EU pesticide MRLs, replaced in full                                             |
| `taxonomy:remap`                            | Re-applies the taxonomy rules to every stored record                            |
| `entities:link`                             | Links records to firms and refreshes firm facts                                 |
| `alerts:run [--no-email]`                   | Turns new change events into alerts and sends the instant emails                |
| `digest:send`                               | Sends the daily digests, and the weekly ones on Mondays                         |
| `db:size-check`                             | Exits 1 at or above 900 MB                                                      |
| `verify-source`, `probe-page`               | Checks a source: fields, rows, fill rates, duplicate keys, page patterns        |

`alerts:run` and `digest:send` send email through the same daily cap as the API, so they read the mail variables above. `alerts:run --no-email` creates the alerts and needs none of them. `alerts:run` exits 3 when a firm-level record has stayed unlinked for 48 hours, because alerts stop at the first such record; GitHub Actions then emails the owner. `digest:send` exits 1 when a digest could not be sent.

Every `sync:*` command takes `--no-events` for backfills. Long syncs on Windows are best run in a Linux container, because Node 24 on Windows has aborted mid-way through long runs of HTTPS requests. From PowerShell, after `npx nx build ingest`:

```powershell
docker run --rm -e DATABASE_URL -v "${PWD}:/app:ro" -w /app node:24.15.0-bookworm-slim node dist/apps/ingest/main.js sync:rasff --details-limit 2000 --no-events
```

### Schedules (UTC)

| Workflow           | When                                                      | Runs                                                |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------- |
| `sync-daily.yml`   | 03:07 every day                                           | Import Alerts, then RASFF, then `entities:link`     |
| `sync-weekly.yml`  | 08:00 every day for now, then weekly on FDA's refresh day | FDA charge codes and refusals, then `entities:link` |
| `sync-weekly.yml`  | 06:30 on Mondays                                          | UK, then Australia, then `entities:link`            |
| `sync-monthly.yml` | 03:30 on the 1st                                          | EU MRLs                                             |
| `digest.yml`       | 03:00 every day                                           | `digest:send` (weekly digests on Mondays)           |
| `backfill.yml`     | On demand                                                 | One source with `--no-events`                       |

Each job first checks the database size, and only one job writes to the database at a time. Every scheduled sync workflow ends with `alerts:run`.

Alerts depend on that. `alerts:run` reads change events in order and moves its cursor past them, so an event committed late by a second writer would never be alerted. The sync workflows therefore share one concurrency group, and `digest.yml` has its own because it inserts no change events or alerts, so it cannot create the late-commit gap that the shared group prevents. Don't run syncs by hand at the same time as scheduled ones.

## Status and roadmap

About 70 development days in 11 phases.

| Phase | What                                                                                 | Status                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | Foundation: workspace, database, CI, accounts, checks of every source                | ✅ Done (October 2026)                                                                                                                                                                                                                                        |
| P2    | Ingestion and taxonomy: six sources, full history, scheduled syncs                   | Built and merged. Staging holds FDA refusals since 2016, RASFF since 2020, UK, Australia and EU MRLs (195 MB). Still to do: the first full Import Alert crawl, a week of green scheduled runs and the final size check.                                       |
| P3    | Entity resolution: linking, firm facts, merge and split                              | Built and merged; 20,833 firms from 90,614 records on a full local load. Waiting for the labelled-pair precision gate and the first link on staging.                                                                                                          |
| P4    | Auth, accounts, email and the i18n core                                              | Built and merged (PRs #35 and #36). Sign-up, login, sessions, password reset, members and invites, the email cap and localised emails. Still to do: the staging migrations and settings.                                                                      |
| P5    | Core product API: search, dashboards, firm profiles, MRL checker, watchlists, alerts | Built on branch `p5/core-product-api`, not merged. See "The product API". Still to do: review; before merging, the staging migration, mail settings and link check; then the p95 and hand checks.                                                             |
| P6    | Bulk supplier screening and PDF reports                                              | Not started                                                                                                                                                                                                                                                   |
| P7    | Billing with Paddle                                                                  | Built on branch `p7/billing-paddle`, not merged. See "Billing with Paddle". Still to do: review; before merging, the owner steps there (Paddle token, webhook destination, Render variables, the `0015` staging migration); then the manual sandbox purchase. |
| P8    | Public API and Import Alert summaries                                                | Not started                                                                                                                                                                                                                                                   |
| P9    | Web app in four languages                                                            | Not started                                                                                                                                                                                                                                                   |
| P10   | Admin panel: health, taxonomy, match review, summaries                               | Not started                                                                                                                                                                                                                                                   |
| P11   | Deployment and launch                                                                | Not started                                                                                                                                                                                                                                                   |

## Data and privacy principles

- Every notice links to the agency's own record. Facts are shown as published, never scored or interpreted.
- There are no public firm pages; firm profiles need an account.
- Personal details that a source publishes, such as the RASFF officials named in notification details, are never stored.
- Sources are credited as their licences require. The EU MRL database itself has no legal value; the EU Official Journal does.

## Docs

Design specs, phase plans and research findings are kept outside this repository, in a local `docs/` folder that git ignores. This README is the public summary of them.
