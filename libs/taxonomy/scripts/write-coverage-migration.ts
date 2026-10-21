import { writeFileSync } from 'node:fs';
import { taxonomyCoverageSql } from '../src/lib/seed-sql';

/**
 * Writes the rules added after the seed into a custom drizzle migration:
 *   npx drizzle-kit generate --custom --name=taxonomy_coverage --config=libs/db/drizzle.config.ts
 *   npx tsx libs/taxonomy/scripts/write-coverage-migration.ts libs/db/migrations/0009_taxonomy_coverage.sql
 *
 * A one-off like write-seed-migration.ts: 0009 is frozen once applied, so a later rule change ships as a migration of
 * its own, followed by `taxonomy:remap`. seeds.spec.ts pins 0009 to taxonomyCoverageSql() so drift is caught.
 */
const target = process.argv[2];
if (target === undefined) {
  console.error('usage: write-coverage-migration.ts <migration.sql>');
  process.exit(1);
}
writeFileSync(target, taxonomyCoverageSql(), 'utf8');
console.log(`wrote ${target}`);
