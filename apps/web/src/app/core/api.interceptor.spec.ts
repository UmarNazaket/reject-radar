import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { apiInterceptor } from './api.interceptor';
import { Session } from './session';

describe('apiInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let session: { signedIn: jest.Mock; clear: jest.Mock };
  let router: { navigate: jest.Mock; url: string };

  beforeEach(() => {
    session = { signedIn: jest.fn().mockReturnValue(true), clear: jest.fn() };
    router = { navigate: jest.fn().mockResolvedValue(true), url: '/firms/12' };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
        { provide: Session, useValue: session },
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  const expired = { status: 401, statusText: 'Unauthorized' };

  it('sends the cookies, and the CSRF header on unsafe methods only', () => {
    http.get('/v1/me').subscribe();
    http.post('/v1/watchlist', {}).subscribe();
    const get = backend.expectOne('/v1/me');
    const post = backend.expectOne('/v1/watchlist');
    expect(get.request.withCredentials).toBe(true);
    expect(get.request.headers.has('X-RejectRadar-CSRF')).toBe(false);
    expect(post.request.headers.get('X-RejectRadar-CSRF')).toBe('1');
    get.flush({});
    post.flush({});
  });

  it('leaves requests to other hosts alone', () => {
    http.get('/i18n/en.json').subscribe();
    const req = backend.expectOne('/i18n/en.json');
    expect(req.request.withCredentials).toBe(false);
    req.flush({});
  });

  it('refreshes an expired session once for concurrent requests, then retries them', async () => {
    const first = firstValueFrom(http.get('/v1/alerts'));
    const second = firstValueFrom(http.get('/v1/watchlist'));
    backend.expectOne('/v1/alerts').flush({ code: 'UNAUTHORIZED' }, expired);
    backend.expectOne('/v1/watchlist').flush({ code: 'INVALID_SESSION' }, expired);
    await Promise.resolve();
    const refresh = backend.expectOne('/v1/auth/refresh');
    expect(refresh.request.headers.get('X-RejectRadar-CSRF')).toBe('1');
    refresh.flush(null, { status: 204, statusText: 'No Content' });
    await new Promise((resolve) => setTimeout(resolve));
    backend.expectOne('/v1/alerts').flush({ alerts: [] });
    backend.expectOne('/v1/watchlist').flush({ items: [] });
    expect(await first).toEqual({ alerts: [] });
    expect(await second).toEqual({ items: [] });
  });

  it('sends a signed-in user to sign in when the session cannot be refreshed', async () => {
    const result = firstValueFrom(http.get('/v1/alerts')).catch((error: unknown) => error);
    backend.expectOne('/v1/alerts').flush({ code: 'UNAUTHORIZED' }, expired);
    await Promise.resolve();
    backend.expectOne('/v1/auth/refresh').flush({ code: 'INVALID_SESSION' }, expired);
    await result;
    expect(session.clear).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/login'], { queryParams: { next: '/firms/12' } });
  });

  it('does not redirect a visitor who was never signed in', async () => {
    session.signedIn.mockReturnValue(false);
    const result = firstValueFrom(http.get('/v1/me')).catch((error: unknown) => error);
    backend.expectOne('/v1/me').flush({ code: 'UNAUTHORIZED' }, expired);
    await Promise.resolve();
    backend.expectOne('/v1/auth/refresh').flush({ code: 'INVALID_SESSION' }, expired);
    await result;
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('does not refresh around auth routes or other errors', () => {
    http.post('/v1/auth/login', {}).subscribe({ error: () => undefined });
    backend.expectOne('/v1/auth/login').flush({ code: 'INVALID_CREDENTIALS' }, expired);
    http.get('/v1/firms/1').subscribe({ error: () => undefined });
    backend.expectOne('/v1/firms/1').flush({ code: 'PLAN_LIMIT_REACHED' }, { status: 403, statusText: 'Forbidden' });
    backend.expectNone('/v1/auth/refresh');
  });
});
