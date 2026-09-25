import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Api } from './api';
import { Me } from './models';

/** Session utilisateur. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly me = signal<Me | null>(null);
  /** Éditeur : peut modifier tableaux de bord, statuts d'erreurs, alertes. */
  readonly canEdit = computed(() => { const r = this.me()?.role; return r === 'editor' || r === 'admin'; });
  readonly isAdmin = computed(() => this.me()?.role === 'admin');

  async load(): Promise<Me> {
    const me = await firstValueFrom(this.api.me());
    this.me.set(me);
    return me;
  }
}
