import { Injectable, effect, inject, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { Branding } from './branding';

/**
 * Titres des onglets : « Wolflog » y devient le nom de l'entreprise (« Logs · Wolflog » → « Logs · Acme »).
 * Le nombre d'alertes en cours, en tête du titre (« (2) … », posé par app.ts), est conservé.
 */
@Injectable({ providedIn: 'root' })
export class BrandTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly branding = inject(Branding);
  /** Page affichée : son titre est réécrit quand le nom change (chargement tardif, page Personnalisation). */
  private current: RouterStateSnapshot | null = null;

  constructor() {
    super();
    effect(() => {
      this.branding.title();
      untracked(() => {
        if (this.current) this.updateTitle(this.current);
      });
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot) {
    this.current = snapshot;
    const title = this.buildTitle(snapshot);
    if (title === undefined) return;
    const name = this.branding.title();
    const alerts = /^\(\d+\) /.exec(this.title.getTitle())?.[0] ?? '';
    this.title.setTitle(alerts + title.replace(/\bWolflog\b/g, () => name));
  }
}
