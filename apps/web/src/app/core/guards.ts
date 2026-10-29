import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';
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
