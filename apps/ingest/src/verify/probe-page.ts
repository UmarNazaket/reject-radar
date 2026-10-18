import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Fetcher } from '../core/http';
import { downloadFile } from './fetch-file';

export interface ProbeResult {
  origin: string;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
  samples: string[];
}

export interface ProbeOptions {
  url?: string;
  file?: string;
  count?: string[];
  sample?: string;
  sampleCount?: number;
  workDir?: string;
}

/** Strips tags and collapses whitespace so samples read cleanly in the findings document. */
export function toPlainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function probeText(
  text: string,
  patterns: readonly string[],
  samplePattern?: string,
  sampleCount = 3,
): Pick<ProbeResult, 'counts' | 'samples'> {
  const counts: Record<string, number> = {};
  for (const pattern of patterns) counts[pattern] = [...text.matchAll(new RegExp(pattern, 'gi'))].length;
  const samples: string[] = [];
  if (samplePattern) {
    for (const match of text.matchAll(new RegExp(samplePattern, 'gi'))) {
      samples.push(toPlainText(match[0]));
      if (samples.length >= sampleCount) break;
    }
  }
  return { counts, samples };
}

export async function probePage(options: ProbeOptions, fetcher?: Fetcher): Promise<ProbeResult> {
  let filePath: string;
  if (options.file) filePath = options.file;
  else if (options.url) {
    if (!fetcher) throw new Error('probePage needs a fetcher to download --url');
    filePath = await downloadFile(fetcher, options.url, options.workDir ?? path.resolve('tmp/probe'), 'html');
  }
  else throw new Error('Pass --url <page url> or --file <saved page>');
  const buffer = await readFile(filePath);
  const { counts, samples } = probeText(buffer.toString('utf8'), options.count ?? [], options.sample, options.sampleCount);
  return {
    origin: options.url ?? filePath,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    counts,
    samples,
  };
}

export function formatProbeReport(result: ProbeResult, at: Date = new Date()): string {
  const counts = Object.entries(result.counts).map(([pattern, n]) => `\`${pattern}\` ${n}`).join(', ') || 'none';
  const samples = result.samples.length ? result.samples.map((sample) => `  - ${sample.slice(0, 300)}`) : ['  - none'];
  return [
    `## probe — ${result.origin} — ${at.toISOString()}`,
    '',
    `- Size: ${result.bytes.toLocaleString('en-US')} bytes`,
    `- SHA-256: \`${result.sha256}\``,
    `- Matches: ${counts}`,
    '- Samples:',
    ...samples,
    '',
    '',
  ].join('\n');
}
