import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Api } from './api';
import { AppState } from './app-state';
import { Deployment } from './models';

/**
 * Déploiements de la période affichée : partagés par tous les graphiques (marqueurs verticaux).
 * Rechargés avec la période, le service et l'environnement.
 */
@Injectable({ providedIn: 'root' })
export class Deployments {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  readonly list = signal<Deployment[]>([]);

  constructor() {
    effect(() => {
      const range = this.state.range();
      const service = this.state.service();
      this.state.env();
      this.state.tick();
      untracked(() => this.api.deployments(range, service).subscribe({ next: (d) => this.list.set(d), error: () => this.list.set([]) }));
    });
  }
}
