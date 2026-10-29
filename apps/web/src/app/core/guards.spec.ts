import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, provideRouter, Router, type RouterStateSnapshot, UrlTree } from '@angular/router';
import { staffOnly } from './guards';
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
