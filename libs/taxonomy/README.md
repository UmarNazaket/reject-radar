# taxonomy

This library was generated with [Nx](https://nx.dev).

## Seed migration is frozen

The commodity and hazard seeds and the classification rules in this library were written into
`libs/db/migrations/0002_taxonomy_seed.sql` by `scripts/write-seed-migration.ts`. A migration runs once per database,
so after merge 0002 is frozen: editing or regenerating it changes nothing on a database that already applied it.

Every seed or rule change after merge ships as a **new** custom drizzle migration
(`npx drizzle-kit generate --custom --name=<name> --config=libs/db/drizzle.config.ts`) holding the inserts, updates and
deletes that turn the 0002 data into the new data. Run `taxonomy:remap` after deploying it so stored records and notices
pick up the new rules. `seeds.spec.ts` pins 0002 to `taxonomySeedSql()`, so a change made here without that step fails
the tests.

## Running unit tests

Run `nx test taxonomy` to execute the unit tests via [Jest](https://jestjs.io).
