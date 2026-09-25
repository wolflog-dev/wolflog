import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AppState } from './app-state';
import { Session } from './session';

/** Ajoute l'environnement sélectionné à chaque appel de l'API. */
export const envInterceptor: HttpInterceptorFn = (req, next) => {
  const env = inject(AppState).env();
  if (!env || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth') || req.url.startsWith('/api/dashboards') || req.params.has('env')) {
    return next(req);
  }
  return next(req.clone({ params: req.params.set('env', env) }));
};

/** Session expirée : retour à la page de connexion. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const session = inject(Session);
  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && !req.url.includes('/api/auth/')) {
        session.me.set(null);
        router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
      }
      return throwError(() => err);
    }),
  );
};
