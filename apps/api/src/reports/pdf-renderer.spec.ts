import { Logger } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { PdfRenderer } from './pdf-renderer';
import { pageCount, textOf } from './pdf-test-utils';

const env = (NODE_ENV: ApiEnv['NODE_ENV']) => ({ NODE_ENV }) as ApiEnv;
const NAME = 'Công ty Thực phẩm Đông Á';
const small = (text: string): TDocumentDefinitions => ({
  pageSize: 'A4',
  content: [{ text }],
});

describe('PdfRenderer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders a small document to a PDF in under 3 seconds', async () => {
    const started = Date.now();
    const pdf = await new PdfRenderer(env('test')).render('firm', small('Hello'));
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(pageCount(pdf)).toBe(1);
  });

  it('logs pdf_rendered with kind, ms and rssMb and nothing else', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new PdfRenderer(env('test')).render('topic', small('Hello'));
    expect(log).toHaveBeenCalledTimes(1);
    const [fields, message] = log.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toBe('pdf_rendered');
    expect(Object.keys(fields).sort()).toEqual(['kind', 'ms', 'rssMb']);
    expect(fields.kind).toBe('topic');
    expect(typeof fields.ms).toBe('number');
    expect(typeof fields.rssMb).toBe('number');
    expect(fields.rssMb as number).toBeGreaterThan(0);
  });

  it('renders a Vietnamese name with its diacritics without throwing', async () => {
    const doc = small(NAME);
    expect(textOf(doc)).toContain(NAME);
    const pdf = await new PdfRenderer(env('test')).render('firm', doc);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('compresses its streams except under NODE_ENV=test', async () => {
    const body = Array.from({ length: 40 }, (_, i) => ({
      text: `Line ${i} of a document that repeats itself`,
    }));
    const doc: TDocumentDefinitions = { content: body };
    const plain = await new PdfRenderer(env('test')).render('firm', doc);
    const packed = await new PdfRenderer(env('production')).render('firm', doc);
    expect(plain.toString('latin1')).not.toContain('/FlateDecode');
    expect(packed.toString('latin1')).toContain('/FlateDecode');
    expect(packed.length).toBeLessThan(plain.length);
  });

  it('rejects, and logs nothing, when the document cannot be rendered', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const broken = {
      content: [{ text: 'x', font: 'NoSuchFont' }],
    } as TDocumentDefinitions;
    await expect(new PdfRenderer(env('test')).render('firm', broken)).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
