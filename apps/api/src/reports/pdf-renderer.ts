import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@rejectradar/contracts';
import type { TDocumentDefinitions, TFontDictionary } from 'pdfmake/interfaces';
import { API_ENV } from '../config/env';

/** Which report a render is for; it names the `pdf_rendered` log line. */
export type PdfKind = 'firm' | 'topic';

/*
 * pdfmake 0.3 (pinned to 0.3.11) is a CommonJS singleton whose methods sit on its prototype, so it is required rather than
 * imported (`import * as` would copy only own properties). webpack leaves it external, as it does every package in
 * node_modules, so `require` runs at start-up against the installed package and the font files next to it are found.
 */
const pdfmake = require('pdfmake') as typeof import('pdfmake');

/**
 * The Roboto files pdfmake ships (`pdfmake/fonts/Roboto/*.ttf`, Latin including the Vietnamese letters). `pdfmake/fonts/Roboto.js`
 * lists their four paths inside the installed package. pdfmake reads a font file by path, so the local access policy lets
 * through exactly those paths and nothing else.
 */
function loadFonts(): { fonts: TFontDictionary; paths: ReadonlySet<string> } {
  const { Roboto } = require('pdfmake/fonts/Roboto.js') as { Roboto: Record<'normal' | 'bold' | 'italics' | 'bolditalics', string> };
  return { fonts: { Roboto }, paths: new Set(Object.values(Roboto)) };
}

/**
 * The one place a PDF is made (spec §9.9, P6-D12): A4, pdfmake, Roboto. A document definition goes in and a Buffer comes out.
 * The fonts are fixed here; a definition that names another font fails to render. Images and links to local files or URLs
 * are refused, because nothing in a report needs them.
 */
@Injectable()
export class PdfRenderer {
  private readonly logger = new Logger(PdfRenderer.name);
  private static fonts: ReturnType<typeof loadFonts> | null = null;

  constructor(@Inject(API_ENV) private readonly env: Pick<ApiEnv, 'NODE_ENV'>) {}

  /**
   * Renders `doc`. Streams are compressed except under `NODE_ENV=test`, where specs count pages in the raw file.
   * Logs `pdf_rendered` with the kind, the milliseconds it took and the process's resident memory in MB (the V11
   * measurement, read from the host's logs); nothing else, so no name or id reaches the log.
   */
  async render(kind: PdfKind, doc: TDocumentDefinitions): Promise<Buffer> {
    const started = performance.now();
    const { fonts, paths } = (PdfRenderer.fonts ??= loadFonts());
    pdfmake.setFonts(fonts);
    pdfmake.setUrlAccessPolicy(() => false);
    pdfmake.setLocalAccessPolicy((path) => paths.has(path));
    const pdf = await pdfmake.createPdf({ ...doc, compress: this.env.NODE_ENV !== 'test' }).getBuffer();
    const ms = Math.round(performance.now() - started);
    this.logger.log(
      {
        kind,
        ms,
        rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      },
      'pdf_rendered',
    );
    return pdf;
  }
}
