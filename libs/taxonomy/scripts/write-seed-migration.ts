import { writeFileSync } from 'node:fs';
import { taxonomySeedSql } from '../src/lib/seed-sql';

/**
 * Writes the taxonomy seed SQL into a custom drizzle migration:
 *   npx drizzle-kit generate --custom --name=taxonomy_seed --config=libs/db/drizzle.config.ts
 *   npx tsx libs/taxonomy/scripts/write-seed-migration.ts libs/db/migrations/0002_taxonomy_seed.sql
 *
 * That was a one-off. 0002 is frozen once applied (a database never re-runs a migration), so never run this script
 * against 0002 again: after merge, every seed or rule change ships as a NEW custom migration that turns the 0002 data
 * into the new data, followed by `taxonomy:remap`. seeds.spec.ts pins 0002 to taxonomySeedSql() so drift is caught.
 */
const target = process.argv[2];
if (target === undefined) {
  console.error('usage: write-seed-migration.ts <migration.sql>');
  process.exit(1);
}
writeFileSync(target, taxonomySeedSql(), 'utf8');
console.log(`wrote ${target}`);
