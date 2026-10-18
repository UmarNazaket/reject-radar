import { writeFileSync } from 'node:fs';
import { taxonomySeedSql } from '../src/lib/seed-sql';

/**
 * Writes the taxonomy seed SQL into a custom drizzle migration:
 *   npx drizzle-kit generate --custom --name=taxonomy_seed --config=libs/db/drizzle.config.ts
 *   npx tsx libs/taxonomy/scripts/write-seed-migration.ts libs/db/migrations/0002_taxonomy_seed.sql
 */
const target = process.argv[2];
if (target === undefined) {
  console.error('usage: write-seed-migration.ts <migration.sql>');
  process.exit(1);
}
writeFileSync(target, taxonomySeedSql(), 'utf8');
console.log(`wrote ${target}`);
