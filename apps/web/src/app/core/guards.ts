import { inject } from '@angular/core';
import { type CanActivateFn, type CanMatchFn, Router } from '@angular/router';
import { Session } from './session';

/** The session, or null when the API cannot say: the sign-in page then shows why. */
const current = (session: Session) => session.load().catch(() => null);

/** Signed-in screens: a signed-out visitor goes to the sign-in page and comes back after. */
export const signedIn: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  return (await current(inject(Session))) ? true : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

/** Sign-in screens: someone already signed in goes home. */
export const signedOut: CanActivateFn = async () => {
  const router = inject(Router);
  return (await current(inject(Session))) ? router.createUrlTree(['/']) : true;
};

/** The landing page at `/`: it matches only for a signed-out visitor, so `/` stays the app for everyone signed in. */
export const signedOutMatch: CanMatchFn = async () => !(await current(inject(Session)));

/** Staff screens: anyone else sees the page-not-found screen, as if the area did not exist. The API checks again. */
export const staffOnly: CanActivateFn = async () => {
  const router = inject(Router);
  return (await current(inject(Session)))?.user.isPlatformAdmin ? true : router.createUrlTree(['/not-found']);
};
