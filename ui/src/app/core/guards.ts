import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Session } from './session';

/** Page réservée aux utilisateurs connectés ; mot de passe provisoire : à changer avant toute chose. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  try {
    const me = session.me() ?? (await session.load());
    if (!me.authenticated) return router.createUrlTree(['/login']);
    if (me.mustChangePassword && !state.url.startsWith('/account')) return router.createUrlTree(['/account'], { queryParams: { first: 1 } });
    return true;
  } catch {
    return router.createUrlTree(['/login']);
  }
};

/** Page réservée aux administrateurs. */
export const adminGuard: CanActivateFn = () => {
  const session = inject(Session);
  return session.isAdmin() ? true : inject(Router).createUrlTree(['/']);
};
