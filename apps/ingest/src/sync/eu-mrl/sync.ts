import { euMrl, euMrlProduct, euPesticideResidue } from '@rejectradar/db';
import { count } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { SyncDeps } from '../../core/deps';
import { runSync, type SyncRunResult } from '../../core/sync-run';
import { EU_MRL_FILES, parentCode, parseMrlXml, type MrlParse } from './parse';

export { EU_MRL_FILES };

const BATCH_SIZE = 1000;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Loads the EU Pesticides Database MRLs (decision P2-D3): the eight `Publication<n>.xml` files are downloaded and
 * parsed one at a time and merged (a later file wins for a repeated product/residue pair), then `eu_mrl`,
 * `eu_pesticide_residue` and `eu_mrl_product` are emptied and refilled in one transaction, so a bad or missing file
 * leaves the old data untouched. No notices and no change events.
 *
 * `rowsRead` counts the MRL rows parsed from all files; `rowsInserted` and `rowsDeleted` count `eu_mrl` rows.
 */
export async function syncEuMrl(deps: SyncDeps): Promise<SyncRunResult> {
  return runSync(deps.db, 'eu_mrl', async (ctx) => {
    const products = new Map<string, string>();
    const residues = new Map<string, MrlParse['residues'][number]>();
    const mrls = new Map<string, MrlParse['mrls'][number]>();
    const hashes: string[] = [];

    for (const url of EU_MRL_FILES) {
      const file = await deps.fetcher(url, { expect: 'xml' });
      hashes.push(file.sha256);
      let parsed: MrlParse;
      try {
        parsed = parseMrlXml(file.text());
      } catch (error) {
        throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
      ctx.counts.rowsRead += parsed.mrls.length;
      for (const [code, name] of parsed.products) if (!products.has(code)) products.set(code, name);
      for (const residue of parsed.residues) residues.set(residue.id, residue);
      for (const mrl of parsed.mrls) mrls.set(`${mrl.productCode}|${mrl.residueId}`, mrl);
    }
    ctx.setOrigin(EU_MRL_FILES[0], createHash('sha256').update(hashes.join('')).digest('hex'));

    const known: ReadonlySet<string> = new Set(products.keys());
    const productRows = [...products].map(([code, name]) => ({ code, name, parentCode: parentCode(code, known) }));

    await deps.db.transaction(async (tx) => {
      const [{ n }] = await tx.select({ n: count() }).from(euMrl);
      await tx.delete(euMrl);
      await tx.delete(euPesticideResidue);
      await tx.delete(euMrlProduct);
      for (const batch of chunks(productRows, BATCH_SIZE)) await tx.insert(euMrlProduct).values(batch);
      for (const batch of chunks([...residues.values()], BATCH_SIZE)) await tx.insert(euPesticideResidue).values(batch);
      for (const batch of chunks([...mrls.values()], BATCH_SIZE)) await tx.insert(euMrl).values(batch);
      ctx.counts.rowsDeleted = Number(n);
      ctx.counts.rowsInserted = mrls.size;
    });
  });
}
