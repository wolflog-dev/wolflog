import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, firstValueFrom, throwError } from 'rxjs';
import { Api, Me, Range } from './api';

export interface RangePreset {
  label: string;
  long: string;
  from: string;
}

export const PRESETS: RangePreset[] = [
  { label: '5 min', long: '5 dernières minutes', from: '5m' },
  { label: '15 min', long: '15 dernières minutes', from: '15m' },
  { label: '1 h', long: 'Dernière heure', from: '1h' },
  { label: '6 h', long: '6 dernières heures', from: '6h' },
  { label: '24 h', long: '24 dernières heures', from: '24h' },
  { label: '3 j', long: '3 derniers jours', from: '3d' },
  { label: '7 j', long: '7 derniers jours', from: '7d' },
  { label: '30 j', long: '30 derniers jours', from: '30d' },
];

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}

/** Plage de temps et filtre de services partagés par toutes les pages. */
@Injectable({ providedIn: 'root' })
export class AppState {
  readonly from = signal(read('vigil.from', '1h'));
  readonly to = signal(read('vigil.to', ''));
  readonly service = signal(read('vigil.service', ''));
  /** Environnement (prod, staging…) : ajouté à toutes les requêtes de l'API par l'intercepteur. */
  readonly env = signal(read('vigil.env', ''));
  readonly autoRefresh = signal(read('vigil.refresh', '0') === '1');
  /** Incrémenté pour forcer le rechargement des pages. */
  readonly tick = signal(0);

  readonly range = computed<Range>(() => ({ from: this.from(), to: this.to() }));
  readonly isRelative = computed(() => !this.to());
  readonly label = computed(() => {
    const preset = PRESETS.find((p) => p.from === this.from());
    if (preset && !this.to()) return preset.long;
    return `${fmtShort(this.from())} → ${this.to() ? fmtShort(this.to()) : 'maintenant'}`;
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.applyRefresh();
  }

  setRelative(from: string) {
    this.from.set(from);
    this.to.set('');
    this.persist();
  }

  setAbsolute(from: Date, to: Date) {
    this.from.set(from.toISOString());
    this.to.set(to.toISOString());
    this.persist();
  }

  setService(service: string) {
    this.service.set(service);
    write('vigil.service', service);
    this.refresh();
  }

  setEnv(env: string) {
    this.env.set(env);
    write('vigil.env', env);
    this.refresh();
  }

  toggleAutoRefresh() {
    this.autoRefresh.update((v) => !v);
    write('vigil.refresh', this.autoRefresh() ? '1' : '0');
    this.applyRefresh();
  }

  refresh() {
    this.tick.update((t) => t + 1);
  }

  private applyRefresh() {
    if (this.timer) clearInterval(this.timer);
    this.timer = this.autoRefresh() ? setInterval(() => this.isRelative() && this.refresh(), 10_000) : null;
  }

  private persist() {
    write('vigil.from', this.from());
    write('vigil.to', this.to());
  }
}

function fmtShort(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Session utilisateur. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly me = signal<Me | null>(null);

  async load(): Promise<Me> {
    const me = await firstValueFrom(this.api.me());
    this.me.set(me);
    return me;
  }
}

export const authGuard: CanActivateFn = async () => {
  const session = inject(Session);
  const router = inject(Router);
  try {
    const me = session.me() ?? (await session.load());
    return me.authenticated ? true : router.createUrlTree(['/login']);
  } catch {
    return router.createUrlTree(['/login']);
  }
};

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


