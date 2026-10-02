import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Api } from './api';
import { SECTION_IDS, sectionInfo } from './access';
import { Me } from './models';

/** Session utilisateur. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly me = signal<Me | null>(null);
  /** Éditeur : peut modifier tableaux de bord, statuts d'erreurs, alertes. */
  readonly canEdit = computed(() => { const r = this.me()?.role; return r === 'editor' || r === 'admin'; });
  readonly isAdmin = computed(() => this.me()?.role === 'admin');
  /** Parties de Wolflog visibles (profil d'accès) : toutes pour un administrateur, sans profil ou sans authentification. */
  readonly sections = computed(() => new Set<string>(this.me()?.sections ?? SECTION_IDS));
  /** Services visibles (noms ou motifs « boutique-* », profil d'accès ou compte) ; null : tous. */
  readonly services = computed(() => {
    const services = this.me()?.services;
    return services?.length ? services : null;
  });
  /** Page d'accueil du profil (sinon sa première partie ; aucune partie : « Mon compte »). */
  readonly home = computed(() => {
    const allowed = this.sections();
    const home = this.me()?.home;
    const id = home && allowed.has(home) ? home : SECTION_IDS.find((s) => allowed.has(s));
    return sectionInfo(id)?.path ?? '/account';
  });
  private pending: Promise<Me> | null = null;
  private refreshedAt = 0;

  /** Partie visible ? Plusieurs : l'une suffit. Sans partie (mon compte, administration) : toujours. */
  can(section: string | readonly string[] | null | undefined): boolean {
    if (!section?.length) return true;
    const allowed = this.sections();
    return typeof section === 'string' ? allowed.has(section) : section.some((s) => allowed.has(s));
  }

  /** Lit la session ; les appels simultanés (gardes de navigation) partagent la même requête. */
  load(): Promise<Me> {
    this.pending ??= firstValueFrom(this.api.me())
      .then((me) => {
        this.me.set(me);
        return me;
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  /** Profil d'accès changé pendant la session (refus du serveur) : session relue, au plus une fois toutes les 10 s. */
  refreshAccess() {
    if (Date.now() - this.refreshedAt < 10_000) return;
    this.refreshedAt = Date.now();
    this.load().catch(() => {});
  }
}
