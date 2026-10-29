import { HttpClient, HttpErrorResponse, HttpParams, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { apiInterceptor } from './api.interceptor';
import { downloadFile } from './download';
import { Session } from './session';

describe('downloadFile', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  const jsonBlob = (body: unknown) => new Blob([JSON.stringify(body)], { type: 'application/json' });
  const flushed = () => new Promise((resolve) => setTimeout(resolve));

  // Jest's jsdom has no Blob.text(), which every browser the app supports has.
  Blob.prototype.text ??= function (this: Blob) {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(this);
    });
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiInterceptor])),
        provideHttpClientTesting(),
        { provide: Session, useValue: { signedIn: () => true, clear: jest.fn() } },
        { provide: Router, useValue: { navigate: jest.fn(), url: '/topics' } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
    URL.createObjectURL = jest.fn(() => 'blob:report');
    URL.revokeObjectURL = jest.fn();
  });

  afterEach(() => backend.verify());

  it('refreshes an expired session and saves the file under the given name', async () => {
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('report.pdf');
    });
    const done = downloadFile(http, '/v1/report.pdf', new HttpParams({ fromObject: { origin: 'IN' } }), 'report.pdf');
    backend.expectOne('/v1/report.pdf?origin=IN').flush(jsonBlob({ code: 'UNAUTHORIZED' }), { status: 401, statusText: 'Unauthorized' });
    await flushed();
    backend.expectOne('/v1/auth/refresh').flush(null, { status: 204, statusText: 'No Content' });
    await flushed();
    backend.expectOne('/v1/report.pdf?origin=IN').flush(new Blob(['%PDF']));
    await done;
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('turns an error file back into the JSON error it holds', async () => {
    const done = downloadFile(http, '/v1/report.pdf', new HttpParams(), 'report.pdf');
    backend.expectOne('/v1/report.pdf').flush(jsonBlob({ code: 'PLAN_UPGRADE_REQUIRED' }), { status: 403, statusText: 'Forbidden' });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpErrorResponse);
    expect((error as HttpErrorResponse).status).toBe(403);
    expect((error as HttpErrorResponse).error).toEqual({ code: 'PLAN_UPGRADE_REQUIRED' });
  });
});
