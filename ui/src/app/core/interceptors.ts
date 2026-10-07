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

/**
 * Modification ou suppression refusée par le serveur web lui-même (405, 501), avant Wolflog : le plus souvent le module
 * WebDAV d'IIS, qui intercepte PUT et DELETE. Le message le dit, au lieu d'un « Enregistrement impossible » sans cause.
 */
export const refusedMethodInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse) || (err.status !== 405 && err.status !== 501) || req.method === 'GET' || req.method === 'POST'
        || typeof err.error?.error === 'string') return throwError(() => err);
      return throwError(() => new HttpErrorResponse({
        error: { error: `Le serveur web a refusé la requête ${req.method} (erreur ${err.status}) : sous IIS, c'est en général le module WebDAV. `
          + 'Le web.config fourni avec Wolflog le retire ; sinon, retirez-le du site.' },
        headers: err.headers, status: err.status, statusText: err.statusText, url: err.url ?? undefined,
      }));
    }),
  );

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
      // Partie hors du profil d'accès (profil changé pendant la session) : la navigation est remise à jour.
      if (err instanceof HttpErrorResponse && err.status === 403 && typeof err.error?.section === 'string') session.refreshAccess();
      return throwError(() => err);
    }),
  );
};
