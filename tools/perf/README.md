# Performance check

`load.mjs` measures the p95 budget of spec section 9.2: notice search, topic dashboards and firm search must answer in 800 ms or less at the 95th percentile while the database is awake. It uses Node's built-in `fetch` and has no dependencies.

```
node tools/perf/load.mjs --base http://localhost:3000 --email <email> --password <password> [--requests 200] [--concurrency 4] [--firm-requests 50]
```

- The account needs a verified email and a plan whose history window is the one you want to measure. Use `org.plan_override = 'pro'` (no history limit) for the worst case.
- It logs in, sends one warm-up request per scenario (not measured: the first request after Neon sleeps is outside the budget), then runs every scenario in turn:
  - notices with no filter, `origin=PK&commodity=100`, and `q=rice`;
  - dashboard `origin=PK`, and `origin=IN&commodity=200&destination=EU,UK`;
  - firm search `name=rice mills&country=PK`, and `name=al rahman`.
- Notice and dashboard scenarios send `--requests` requests, `--concurrency` at a time.
- Firm search is limited to 30 requests a minute per user, so it runs one request every 2 seconds, `--firm-requests` times each (default 50, about 100 seconds per scenario).
- It prints the count, p50, p95 and max per scenario, and exits 1 when any p95 is over 800 ms or any request did not answer 200.
- The access cookie lasts 15 minutes; the script logs in again before it ends.

Run it against a local API (`npx nx serve api`) and against staging, where the owner runs it with the staging account. Never run it against production data with a real customer's account.
