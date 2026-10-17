import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { requestIdFor } from './request-id';

const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

/** Throw this for every expected failure; `code` is the stable, machine-readable part. */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}

/**
 * Client errors raised outside Nest (e.g. the body parser's `PayloadTooLargeError`) follow the http-errors
 * convention: a numeric 4xx `status`/`statusCode` and `expose: true` when the message is safe to show.
 */
function exposedClientStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const candidate = exception as { expose?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  if (candidate.expose !== true || typeof candidate.message !== 'string') return undefined;
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499 ? status : undefined;
}

export function toErrorBody(exception: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (exception instanceof AppError) {
    return {
      status: exception.getStatus(),
      body: {
        code: exception.code,
        message: exception.message,
        ...(exception.details === undefined ? {} : { details: exception.details }),
        requestId,
      },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const raw = typeof response === 'string' ? response : (response as { message?: unknown }).message;
    const message = Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : exception.message;
    return { status, body: { code: CODE_BY_STATUS[status] ?? 'HTTP_ERROR', message, requestId } };
  }
  const clientStatus = exposedClientStatus(exception);
  if (clientStatus !== undefined) {
    return {
      status: clientStatus,
      body: { code: CODE_BY_STATUS[clientStatus] ?? 'HTTP_ERROR', message: (exception as { message: string }).message, requestId },
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { code: 'INTERNAL', message: 'Something went wrong. Quote the request ID if you contact support.', requestId },
  };
}

@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: string | number }>();
    const response = http.getResponse<Response>();
    // Errors thrown by the body parser happen before the logger middleware assigns an id, so mint one here.
    const requestId = request.id === undefined ? requestIdFor(request, response) : String(request.id);
    const { status, body } = toErrorBody(exception, requestId);
    if (status >= 500) this.logger.error({ err: exception, requestId: body.requestId }, 'Request failed');
    response.status(status).json(body);
  }
}
