# mail

An [Nx](https://nx.dev) library, set up like `libs/i18n`.

The mailer core shared by the API and the ingest CLI (spec §11): `Mailer` records every send in `email_delivery` and
applies the daily cap, the transports (`createMailTransport`) send through SMTP or Resend, and the renderers build the
localised account, instant-alert and digest emails on one layout.

## Running unit tests

Run `nx test mail` to execute the unit tests via [Jest](https://jestjs.io). `mailer.spec.ts` needs the test database
server (see `libs/db/src/testing.ts`).
