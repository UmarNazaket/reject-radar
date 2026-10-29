import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  BULK_ROW_STATUSES,
  type BulkJobListResponse,
  type BulkJobResponse,
  type BulkRowResponse,
  type BulkRowReviewRequest,
  bulkRowReviewRequest,
  type BulkRowsResponse,
  type WatchConfirmedResponse,
} from '@rejectradar/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RequestContext } from '../auth/context';
import { CurrentContext, RequireVerifiedEmail } from '../auth/decorators';
import { AppError } from '../common/errors';
import { PositiveIntParamPipe } from '../common/int-param.pipe';
import { RateLimit } from '../common/rate-limit';
import { UuidParamPipe } from '../common/uuid-param.pipe';
import { ZodValidationPipe } from '../common/zod-pipe';
import { BulkJobsService, TEMPLATE_CSV } from './bulk-jobs.service';

const HOUR_MS = 3_600_000;
const MAX_FILE_NAME_LENGTH = 200;

/** `GET /v1/bulk-jobs/:id/rows?status=&cursor=` */
const rowsQuery = z.object({ status: z.enum(BULK_ROW_STATUSES).optional(), cursor: z.string().min(1).max(200).optional() });
type RowsQuery = z.output<typeof rowsQuery>;

const unsupported = () =>
  new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_FILE_TYPE', 'Send a CSV file as the request body (Content-Type: text/csv), with a fileName ending in .csv.');

/** The media type without its parameters (`text/csv; charset=utf-8` is `text/csv`), lower-cased. */
const mediaType = (header: string | undefined): string => (header ?? '').split(';', 1)[0].trim().toLowerCase();

/** After the parser stops early, up to this much of the rest of the body is read and thrown away; past it the connection is dropped. */
const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The request body for the parser. Stopping early (a limit hit) must not destroy the request, which is what a Readable's own
 * iterator does when it is returned: the socket would reset before the client has read the error. Instead the rest of the
 * body is discarded in the background, up to `DRAIN_LIMIT_BYTES`, so the answer reaches a client that is still sending.
 */
function bodyOf(req: Request): AsyncIterable<Buffer> {
  return {
    [Symbol.asyncIterator]: () => {
      const source = (req as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
      const drain = async () => {
        try {
          for (let seen = 0; ; ) {
            const next = await source.next();
            if (next.done) return;
            seen += next.value.length;
            if (seen > DRAIN_LIMIT_BYTES) {
              req.destroy();
              return;
            }
          }
        } catch {
          // The client went away or the request was destroyed; there is nothing left to discard.
        }
      };
      return {
        next: () => source.next(),
        return: () => {
          void drain();
          return Promise.resolve({ done: true as const, value: undefined });
        },
      };
    },
  };
}

/**
 * Bulk supplier screening (spec §8.4). The upload takes the file as the raw request body (P6-D1), so it is streamed
 * and counted as it arrives; no multipart parser is involved. Declare the static route (`template.csv`) before `:id`.
 */
@Controller('bulk-jobs')
export class BulkJobsController {
  constructor(private readonly jobs: BulkJobsService) {}

  @Get()
  list(@CurrentContext() ctx: RequestContext): Promise<BulkJobListResponse> {
    return this.jobs.list(ctx);
  }

  @Get('template.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="rejectradar-bulk-template.csv"')
  template(): string {
    return TEMPLATE_CSV;
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireVerifiedEmail()
  @RateLimit({ name: 'bulk-upload', limit: 10, windowMs: HOUR_MS, key: 'user' })
  upload(@CurrentContext() ctx: RequestContext, @Query('fileName') fileName: unknown, @Req() req: Request): Promise<BulkJobResponse> {
    // The request shape is checked before anything is read: only a CSV body, under a name that ends in .csv.
    if (mediaType(req.headers['content-type']) !== 'text/csv') throw unsupported();
    if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > MAX_FILE_NAME_LENGTH || !/\.csv$/i.test(fileName)) throw unsupported();
    return this.jobs.upload(ctx, fileName, bodyOf(req));
  }

  @Get(':id')
  get(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<BulkJobResponse> {
    return this.jobs.get(ctx, id);
  }

  /** Reading results needs a verified email like the review does: the rows carry profile facts (P6-D10). */
  @Get(':id/rows')
  @RequireVerifiedEmail()
  rows(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Query(new ZodValidationPipe(rowsQuery)) query: RowsQuery,
  ): Promise<BulkRowsResponse> {
    return this.jobs.rows(ctx, id, query);
  }

  @Patch(':id/rows/:rowId')
  @RequireVerifiedEmail()
  review(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Param('rowId', new PositiveIntParamPipe()) rowId: number,
    @Body(new ZodValidationPipe(bulkRowReviewRequest)) body: BulkRowReviewRequest,
  ): Promise<BulkRowResponse> {
    return this.jobs.review(ctx, id, rowId, body);
  }

  @Post(':id/watch-confirmed')
  @HttpCode(HttpStatus.OK)
  @RequireVerifiedEmail()
  watchConfirmed(@CurrentContext() ctx: RequestContext, @Param('id', new UuidParamPipe()) id: string): Promise<WatchConfirmedResponse> {
    return this.jobs.watchConfirmed(ctx, id);
  }

  @Get(':id/export.csv')
  @RequireVerifiedEmail()
  async exportCsv(
    @CurrentContext() ctx: RequestContext,
    @Param('id', new UuidParamPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    // The headers are set only once the file exists, so a 404 or 409 is still a JSON error.
    const csv = await this.jobs.exportCsv(ctx, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="bulk-${id}.csv"`);
    // The file holds the account's supplier list and profile facts: no shared cache may keep it.
    res.setHeader('Cache-Control', 'no-store');
    return csv;
  }
}
