import { HttpErrorResponse, type HttpEvent, type HttpHandlerFn, HttpClient, type HttpInterceptorFn, type HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, type Observable, switchMap, throwError } from 'rxjs';
import { type ApiErrorBody, apiUrl, isApiUrl } from './api';
import { Session } from './session';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** An expired access cookie is dropped by the browser (`UNAUTHORIZED`) or rejected by the API (`INVALID_SESSION`). */
const EXPIRED = new Set(['UNAUTHORIZED', 'INVALID_SESSION']);

/** The refresh in flight, shared by every request that found the access cookie expired at the same time. */
let refreshing: Promise<void> | null = null;

const errorCode = (error: unknown): string | undefined =>
  error instanceof HttpErrorResponse ? (error.error as Partial<ApiErrorBody> | null)?.code : undefined;

/**
 * Every API request carries the session cookies and, when unsafe, the CSRF header the API requires. When the 15-minute
 * access cookie has expired, the session is refreshed once and the request retried. If that fails too, the session has
 * ended: a signed-in user is sent to the sign-in page, and a signed-out one just gets the error.
 */
export const apiInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> => {
  if (!isApiUrl(req.url)) return next(req);
  const http = inject(HttpClient);
  const session = inject(Session);
  const router = inject(Router);
  const prepared = req.clone({ withCredentials: true, setHeaders: UNSAFE.has(req.method) ? { 'X-RejectRadar-CSRF': '1' } : {} });

  return next(prepared).pipe(
    catchError((error: unknown) => {
      if (!EXPIRED.has(errorCode(error) ?? '') || req.url.startsWith(apiUrl('/v1/auth/'))) return throwError(() => error);
      refreshing ??= new Promise<void>((resolve, reject) =>
        http.post(apiUrl('/v1/auth/refresh'), {}).subscribe({ next: () => resolve(), complete: () => resolve(), error: reject }),
      ).finally(() => (refreshing = null));
      return from(refreshing).pipe(
        switchMap(() => next(prepared)),
        catchError((refreshError: unknown) => {
          const wasSignedIn = session.signedIn();
          session.clear();
          if (wasSignedIn) void router.navigate(['/login'], { queryParams: { next: router.url } });
          return throwError(() => refreshError);
        }),
      );
    }),
  );
};
