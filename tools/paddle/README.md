# Paddle sandbox tools

Two helpers for the owner's manual work against the Paddle sandbox (phase 7). Neither is used by the API or CI.

## `create-webhook.mjs`

Creates the notification destination that sends Paddle events to the API.

```
node tools/paddle/create-webhook.mjs --url https://<api host>/v1/webhooks/paddle [--description <text>] [--show-secret] [--production]
```

- It reads `PADDLE_API_KEY` from `.env` (or the environment) and never prints it. Only a sandbox key (`pdl_sdbx_apikey_…`) is accepted unless you pass `--production`.
- It sends `POST /notification-settings` with `type: 'url'` and the five events the API handles: `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.past_due` and `transaction.completed`.
- It prints the destination id. The endpoint secret is on the destination in the Paddle dashboard (Developer tools, Notifications); the tool prints it only with `--show-secret`. Either way it goes into `PADDLE_WEBHOOK_SECRET`.
- Run it once per environment. Running it twice makes two destinations; delete the extra one in the dashboard.

## `checkout.html`

A static page that stands in for the billing page until P9. It loads Paddle.js from `https://cdn.paddle.com/paddle/v2/paddle.js` and holds no secrets.

1. Call `POST /v1/billing/checkout` as an account owner with a verified email (with the CSRF header and the session cookies).
2. Open `tools/paddle/checkout.html` in a browser and paste the JSON response.
3. Click Open checkout and pay with Paddle's sandbox test card. The overlay uses `priceId`, `customData`, `customerEmail` and `successUrl` from the response.
4. Within a minute `GET /v1/billing/subscription` shows the paid plan.

It only opens the sandbox overlay and refuses a response whose `environment` is not `sandbox`.

## The sandbox check

`apps/api/src/billing/paddle/sandbox.manual.spec.ts` is skipped unless `PADDLE_SANDBOX_E2E=1`. It creates a throwaway sandbox customer, checks that `SdkPaddleGateway.createPortalSession` returns an `https://` URL, and archives the customer. It reads the sandbox key from `.env`.

```
PADDLE_SANDBOX_E2E=1 npx nx test api --testFile=sandbox.manual
```
