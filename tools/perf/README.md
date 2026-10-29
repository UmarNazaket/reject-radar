# Performance check

`load.mjs` measures the p95 budget of spec section 9.2: notice search, topic dashboards, the watchlist and firm search must answer in 800 ms or less at the 95th percentile while the database is awake. It uses Node's built-in `fetch` and has no dependencies.

```
node tools/perf/load.mjs --base http://localhost:3000 --email <email> --password <password> [--requests 200] [--concurrency 4] [--firm-requests 50] [--watchlist-items 250]
```

- The account needs a verified email and a plan whose history window is the one you want to measure. Use `org.plan_override = 'pro'` (no history limit) for the worst case.
- It logs in, then runs every scenario in turn, with one warm-up request just before each (not measured: the first request after Neon sleeps is outside the budget):
  - notices with no filter, `origin=PK&commodity=100`, and `q=rice`;
  - dashboard `origin=PK`, and `origin=IN&commodity=200&destination=EU,UK`;
  - the watchlist, `GET /v1/watchlist`;
  - firm search `name=rice mills&country=PK`, and `name=al rahman`.
- Notice, dashboard and watchlist scenarios send `--requests` requests, `--concurrency` at a time.
- Before the watchlist scenario, the script brings the account's watchlist up to `--watchlist-items` topic items (default 250, the Business plan's size). It adds distinct topics (60 origin countries, each with or without one of 4 destinations, so up to 300) through `POST /v1/watchlist`, counts the items already there, and never removes any. If the plan's limit is lower, it stops there and says so. The account needs a verified email.
- Firm search is limited to 30 requests a minute per user, so it runs one request every 2.2 seconds, `--firm-requests` times each (default 50, about 110 seconds per scenario). Its warm-up runs just before the scenario, because it shares that window. If a firm request was made in the previous minute, the script waits 61 seconds first, and a warm-up that is still answered 429 waits 61 seconds and tries once more.
- Each request times out after 30 seconds, and a failed connection prints the underlying cause.
- It prints the count, p50, p95 and max per scenario, and exits 1 when any p95 is over 800 ms or any request did not answer 200.
- The access cookie lasts 15 minutes; the script logs in again before it ends.

Run it against a local API (`npx nx serve api`) and against staging, where the owner runs it with the staging account. Never run it against production data with a real customer's account.

## Phase 6: bulk job and PDF reports

`p6.mjs` measures what spec sections 9.8 and 9.9 promise: a 1,000-row bulk file finishes in 3 minutes or less, and each PDF report is made in 3 seconds or less. Like `load.mjs` it uses only Node's built-in `fetch`.

```
node tools/perf/p6.mjs --base http://localhost:3000 --email <email> --password <password> --csv bulk-1000.csv [--firm <id>]... [--topic "<dashboard query string>"]...
```

Without `--password` the script reads the password from the `P6_PASSWORD` environment variable, which keeps it out of the shell history (PowerShell: `$env:P6_PASSWORD = '…'`; bash: `read -rs P6_PASSWORD && export P6_PASSWORD`).

- The account needs a verified email and the Business plan (bulk screening is Business and above). Use `org.plan_override = 'business'`. Each run uploads the file, so it uses the file's rows from the account's 5,000 a month; the upload is also limited to 10 an hour per user.
- `--firm` and `--topic` can be given more than once. A topic is the dashboard's query string, for example `--topic "origin=PK&commodity=12"`. Every firm PDF uses one profile lookup (the same firm twice in a month costs one).
- It logs in, wakes the API with `GET /v1/health`, then:
  - uploads the CSV, polls `GET /v1/bulk-jobs/:id` every 2 seconds until the job is `finished`, and prints the seconds taken. It exits 1 when that is over 180 for a file of up to 1,000 rows, or when `processed` does not equal `total`;
  - times 5 requests for each firm PDF and each topic PDF, checks that the answer is a PDF, prints the times and the maximum, and exits 1 when the maximum is over 3 seconds or any request failed.
- It ends with one verdict line naming what was judged. When nothing was judged (a file of over 1,000 rows, which has no budget, and no `--firm` or `--topic`), it prints `NOTHING JUDGED` and exits 1 rather than pass.
- It never prints the password or a cookie.

To write a 1,000-row file from real firms in the local database:

```
psql "$DATABASE_URL" -c "\copy (select display_name as name, country_code as country, city, '' as fei from firm where country_code is not null order by random() limit 1000) to 'bulk-1000.csv' csv header"
```

The file holds real firm names. `.gitignore` covers `bulk-*.csv`, so a file named like that in the repository root is never committed; keep other names outside the repository. Without `psql` on the path, run the same `\copy` inside the Postgres container (`docker compose exec postgres psql -U rejectradar -d rejectradar …`, writing to `/tmp`) and copy it out with `docker compose cp`.

V11 (API memory under 400 MB while a PDF is made) is not measured by the script. The API logs `pdf_rendered` with `kind`, `ms` and `rssMb` for every PDF; on staging read those lines in Render's logs and check that `rssMb` stays under 400.

Run it against a local API and against staging, where the owner runs it with a Business test account.
