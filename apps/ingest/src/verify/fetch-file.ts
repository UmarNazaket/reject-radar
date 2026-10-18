import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import type { Expect, Fetcher } from '../core/http';

/** Downloads through the shared fetcher (allow-list, User-Agent, timeout, retries) and saves the body under the URL's file name. */
export async function downloadFile(fetcher: Fetcher, url: string, dir: string, expect: Expect = 'any'): Promise<string> {
  await mkdir(dir, { recursive: true });
  const response = await fetcher(url, { expect });
  const target = path.join(dir, path.basename(new URL(response.url).pathname) || 'download.bin');
  await writeFile(target, response.bytes);
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
