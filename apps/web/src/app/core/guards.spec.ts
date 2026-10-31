import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, provideRouter, type Route, Router, type RouterStateSnapshot, UrlTree } from '@angular/router';
import { signedOutMatch, staffOnly } from './guards';
import { Session } from './session';

describe('staffOnly', () => {
  const run = (me: unknown) => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: { load: () => Promise.resolve(me) } }] });
    return TestBed.runInInjectionContext(() => staffOnly({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot)) as Promise<boolean | UrlTree>;
  };

  it('lets a platform admin in', async () => {
    expect(await run({ user: { isPlatformAdmin: true } })).toBe(true);
  });

  it('shows anyone else the page-not-found screen', async () => {
    const result = await run({ user: { isPlatformAdmin: false } });
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/not-found');
  });
});

describe('signedOutMatch', () => {
  const run = (me: Promise<unknown>) => {
    TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: Session, useValue: { load: () => me } }] });
    return TestBed.runInInjectionContext(() => signedOutMatch({} as Route, [])) as Promise<boolean>;
  };

  it('shows the landing page to a signed-out visitor, and when the API cannot say', async () => {
    expect(await run(Promise.resolve(null))).toBe(true);
    TestBed.resetTestingModule();
    expect(await run(Promise.reject(new Error('down')))).toBe(true);
  });

  it('leaves `/` to the app for anyone signed in', async () => {
    expect(await run(Promise.resolve({ user: { isPlatformAdmin: false } }))).toBe(false);
  });
});
