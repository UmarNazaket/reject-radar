import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AlertItem } from '@rejectradar/contracts';
import { AlertCount } from '../core/alert-count';
import { I18n } from '../core/i18n';
import { Taxonomy } from '../core/taxonomy';
import { AlertDetail } from './alert-detail';

const EN = { 'alerts.kind.fda_refusal': 'New FDA refusal', 'errors.NOT_FOUND': 'We could not find what you asked for.' };

const ALERT: AlertItem = {
  id: '0192e2e0-0000-7000-8000-0000000000a1',
  severity: 'high',
  kind: 'fda_refusal',
  createdAt: '2026-10-30T08:00:00.000Z',
  occurredOn: '2026-10-29',
  readAt: null,
  firm: { id: 7, displayName: 'Zarfeen Rice Mills' },
  notice: { id: 12, noticeType: 'refusal', destination: 'US', originCountry: 'PK', productText: 'Basmati rice', title: null, url: 'https://example.com/12' },
};

// Lets the loader send its next request once the previous one is flushed.
const tick = () => new Promise((resolve) => setTimeout(resolve));

describe('AlertDetail', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => EN }) as Response) as unknown as typeof fetch;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Taxonomy, useValue: { label: (_kind: string, value: unknown) => String(value) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    await TestBed.inject(I18n).use('en');
  });

  afterEach(() => http.verify());

  const render = () => {
    const fixture = TestBed.createComponent(AlertDetail);
    fixture.componentRef.setInput('id', ALERT.id);
    TestBed.tick();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  it('shows the alert and marks it read, updating the count in the top bar', async () => {
    TestBed.inject(AlertCount).unread.set(3);
    const { fixture, el } = render();
    http.expectOne((req) => req.url.endsWith(`/v1/alerts/${ALERT.id}`)).flush(ALERT);
    await tick();
    const read = http.expectOne((req) => req.url.endsWith('/v1/alerts/read'));
    expect(read.request.body).toEqual({ ids: [ALERT.id] });
    read.flush({ updated: 1 });
    await fixture.whenStable();

    expect(el.querySelector('h1')?.textContent).toContain('New FDA refusal');
    expect(el.querySelector('a[href="/firms/7"]')?.textContent).toContain('Zarfeen Rice Mills');
    expect(el.querySelector('a[href="/notices/12"]')?.textContent).toContain('Basmati rice');
    expect(TestBed.inject(AlertCount).unread()).toBe(2);
  });

  it('does not mark an alert that is read already', async () => {
    const { fixture, el } = render();
    http.expectOne((req) => req.url.endsWith(`/v1/alerts/${ALERT.id}`)).flush({ ...ALERT, readAt: '2026-10-30T09:00:00.000Z' });
    await fixture.whenStable();
    http.expectNone((req) => req.url.endsWith('/v1/alerts/read'));
    expect(el.querySelector('h1')?.textContent).toContain('New FDA refusal');
  });

  it('says so when the alert is not one of the account', async () => {
    const { fixture, el } = render();
    http
      .expectOne((req) => req.url.endsWith(`/v1/alerts/${ALERT.id}`))
      .flush({ code: 'NOT_FOUND', message: 'Not found.' }, { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('We could not find what you asked for.');
  });
});
