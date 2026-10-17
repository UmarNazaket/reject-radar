import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import unzipper from 'unzipper';

/** Spec §6.3 rule 5: every request names RejectRadar and carries a contact address. */
export function userAgent(): string {
  const contact = process.env['INGEST_CONTACT_EMAIL']?.trim();
  if (!contact) throw new Error('Set INGEST_CONTACT_EMAIL in .env: every request must carry a contact address (spec §6.3)');
  return `RejectRadar data verification (${contact})`;
}

export async function downloadFile(url: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const response = await fetch(url, { headers: { 'user-agent': userAgent() } });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const target = path.join(dir, path.basename(new URL(url).pathname) || 'download.bin');
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(target));
  return target;
}

/** Returns a .csv path; extracts the first .csv entry when given a .zip. */
export async function ensureCsv(filePath: string, dir: string): Promise<string> {
  if (!filePath.toLowerCase().endsWith('.zip')) return filePath;
  await mkdir(dir, { recursive: true });
  const archive = await unzipper.Open.file(filePath);
  const entry = archive.files.find((file) => file.type === 'File' && file.path.toLowerCase().endsWith('.csv'));
  if (!entry) throw new Error(`No .csv file inside ${filePath}`);
  const target = path.join(dir, path.basename(entry.path));
  await pipeline(entry.stream(), createWriteStream(target));
  return target;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
