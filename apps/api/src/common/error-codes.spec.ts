import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGS } from '@rejectradar/i18n';
import { CODE_BY_STATUS } from './errors';

const SRC = join(__dirname, '..');

/** Every non-spec TypeScript file under `apps/api/src`. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

const CONSTRUCTION = /new AppError\(/g;
// Whitespace is allowed anywhere between the arguments, so a construction wrapped over several lines still counts.
const WITH_LITERAL_CODE = /new AppError\(\s*HttpStatus\.\w+\s*,\s*'([A-Z_]+)'/g;

/** Codes the error filter itself emits for errors that are not `AppError`s. */
const FILTER_CODES = [...Object.values(CODE_BY_STATUS), 'HTTP_ERROR', 'INTERNAL'];

describe('error codes', () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('writes the code of every AppError as a string literal the scan can read', () => {
    for (const { path, text } of files) {
      const constructions = text.match(CONSTRUCTION)?.length ?? 0;
      const readable = [...text.matchAll(WITH_LITERAL_CODE)].length;
      expect({ path, constructions }).toEqual({ path, constructions: readable });
    }
  });

  it('every AppError code has a catalog key', () => {
    const thrown = files.flatMap(({ text }) => [...text.matchAll(WITH_LITERAL_CODE)].map((m) => m[1]));
    expect(thrown.length).toBeGreaterThan(10);

    const codes = [...new Set([...thrown, ...FILTER_CODES])].sort();
    const missing = codes.flatMap((code) =>
      (Object.keys(CATALOGS) as (keyof typeof CATALOGS)[])
        .filter((locale) => typeof CATALOGS[locale][`errors.${code}`] !== 'string')
        .map((locale) => `${locale}: errors.${code}`),
    );
    expect(missing).toEqual([]);
  });
});
