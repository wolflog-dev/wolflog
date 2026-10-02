import { Component, ElementRef, afterNextRender, computed, inject, input, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { DashboardInfo } from '../core/models';
import { Toasts } from '../core/toasts';
import { NavIcon } from '../shared/nav-icon';
import { hue } from '../shared/rich-option';
import { VisibilityPicker } from '../shared/visibility-picker';

/** Nouveau tableau de bord : nom, description, visibilité (« Visible pour »), départ vide ou copie d'un tableau existant. */
@Component({
  selector: 'wl-dashboard-form',
  imports: [FormsModule, RouterLink, NavIcon, VisibilityPicker],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <nav class="crumbs" aria-label="Fil d'Ariane">
          <a routerLink="/dashboards" class="crumb"><wl-nav-icon name="dashboards" [size]="14" />Tableaux de bord</a>
          <wl-nav-icon name="chevron-right" [size]="13" class="sep" />
        </nav>
        <h1>Nouveau tableau de bord</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/dashboards">Annuler</a>
        <button class="btn primary" (click)="create()" [disabled]="busy() || !name().trim()">
          <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [size]="14" [class.spin]="busy()" />{{ busy() ? 'Création…' : 'Créer le tableau' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Point de départ</h2><span class="hint">vide, ou copie d'un tableau existant</span></div>
            <div class="step-body">
              <div class="choices">
                <button type="button" class="choice" [class.on]="!from()" (click)="pick(null)" style="--i: 0">
                  <span class="c-icon"><wl-nav-icon name="plus" [size]="18" /></span>
                  <span class="c-text"><strong>Tableau vide</strong><span>Vous ajoutez les panneaux un par un.</span></span>
                  <wl-nav-icon name="check" [size]="15" class="tick" />
                </button>
                @if (!loaded()) {
                  @for (g of [1, 2]; track g) {
                    <div class="choice ghost" aria-busy="true"><i class="skeleton c-ghost"></i><span class="c-text"><i class="skeleton" style="width: 70%; height: 12px"></i><i class="skeleton" style="width: 45%; height: 9px"></i></span></div>
                  }
                }
                @for (d of existing(); track d.id; let i = $index) {
                  <button type="button" class="choice" [class.on]="from()?.id === d.id" (click)="pick(d)" [style.--i]="i + 1" [style.--hue]="hueOf(d.name)">
                    <span class="c-icon copy"><wl-nav-icon name="copy" [size]="18" /></span>
                    <span class="c-text">
                      <strong class="ellipsis" [title]="d.name">Copie de « {{ d.name }} »</strong>
                      <span class="ellipsis" [title]="d.description ?? ''">{{ d.panels }} panneau{{ d.panels > 1 ? 'x' : '' }}{{ d.description ? ' · ' + d.description : '' }}</span>
                    </span>
                    <wl-nav-icon name="check" [size]="15" class="tick" />
                  </button>
                }
              </div>
            </div>
          </section>

          <section class="panel step" [class.done]="!!name().trim()">
            <div class="step-head"><span class="num">2</span><h2>Nom et description</h2></div>
            <div class="step-body">
              <label class="field">Nom
                <input #nameInput [ngModel]="name()" (ngModelChange)="name.set($event)" placeholder="ex. Paiements" autocomplete="off" (keydown.enter)="create()" />
              </label>
              <label class="field">Description <input [(ngModel)]="description" placeholder="facultatif : à quoi sert ce tableau" autocomplete="off" /></label>
            </div>
          </section>

          <section class="panel step done">
            <div class="step-head"><span class="num">3</span><h2>Visible pour</h2><span class="hint">tout le monde, ou certains profils d'accès</span></div>
            <div class="step-body">
              <wl-visibility-picker [value]="visibleTo()" (valueChange)="visibleTo.set($event); visibilityChosen = true" />
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Aperçu</h3>
            <div class="preview" [style.--hue]="hueOf(name().trim() || 'Sans nom')">
              <span class="tile"><wl-nav-icon name="dashboards" [size]="20" /></span>
              <span class="p-text">
                <strong class="ellipsis" [class.placeholder]="!name().trim()">{{ name().trim() || 'Sans nom' }}</strong>
                <span class="small muted ellipsis">{{ description.trim() || (from() ? from()!.description : '') || 'Sans description' }}</span>
              </span>
              <span class="p-count" [title]="(from()?.panels ?? 0) + ' panneau(x)'"><wl-nav-icon name="layers" [size]="13" />{{ from()?.panels ?? 0 }}</span>
            </div>
          </div>
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">{{ summary() }}</p>
            <p class="muted small tip"><wl-nav-icon name="sparkles" [size]="13" />Le tableau s'ouvre en mode édition : « Ajouter un panneau » propose des requêtes toutes prêtes.</p>
          </div>
          @if (error()) {
            <div class="block err-block"><span class="danger small err"><wl-nav-icon name="warning" [size]="14" />{{ error() }}</span></div>
          }
          <div class="actions">
            <button class="btn primary" (click)="create()" [disabled]="busy() || !name().trim()">
              <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [size]="14" [class.spin]="busy()" />{{ busy() ? 'Création…' : 'Créer le tableau' }}
            </button>
            <a class="btn" routerLink="/dashboards">Annuler</a>
            @if (!name().trim()) { <span class="muted small need">Le nom est obligatoire.</span> }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .crumbs { display: inline-flex; align-items: center; gap: 4px; }
    .crumb { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 7px; border-radius: 999px; font-size: 12px; color: var(--text-3);
      transition: background-color .2s, color .2s; }
    .crumb:hover { color: var(--text-1); background: var(--surface-3); text-decoration: none; }
    .sep { color: var(--text-3); opacity: .55; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { margin: 0; }
    /* Choix du point de départ : pastille d'icône, coche qui apparaît avec un rebond. */
    .choice { grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 12px;
      animation: choice-in .45s var(--ease) backwards; animation-delay: min(calc(var(--i, 0) * 40ms + 80ms), 500ms); }
    @keyframes choice-in { from { opacity: 0; transform: translateY(8px); } }
    .choice .c-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent); transition: transform .4s var(--spring), background-color .25s, color .25s; }
    .choice .c-icon.copy { color: hsl(var(--hue) 70% 62%); background: hsl(var(--hue) 70% 55% / .15); }
    .choice:hover .c-icon { transform: rotate(-8deg) scale(1.08); }
    .choice.on .c-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .choice .c-text { display: grid; gap: 2px; min-width: 0; color: var(--text-1); font-size: 13px; }
    .choice .c-text strong { font-weight: 600; }
    .choice .tick { color: var(--accent); opacity: 0; transform: scale(.3) rotate(-30deg); transition: opacity .2s, transform .45s var(--spring); }
    .choice.on .tick { opacity: 1; transform: none; }
    .choice.ghost { pointer-events: none; }
    .c-ghost { width: 36px; height: 36px; border-radius: 11px; }
    .choice.ghost .c-text { gap: 8px; }
    /* Aperçu de la carte du futur tableau : suit le nom et la description saisis. */
    .preview { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--surface-2); box-shadow: inset 0 1px 0 var(--highlight); }
    .tile { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; color: #fff;
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 44%));
      box-shadow: 0 10px 22px -10px hsl(var(--hue) 70% 45% / .9), inset 0 1px 0 rgb(255 255 255 / .35); }
    .p-text { display: grid; gap: 2px; min-width: 0; }
    .p-text strong { font-size: 13.5px; }
    .p-text strong.placeholder { color: var(--text-3); font-style: italic; font-weight: 500; }
    .p-count { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; font: 650 11px var(--mono);
      color: var(--accent); background: var(--accent-soft); }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    .tip, .err { display: flex; align-items: flex-start; gap: 6px; }
    .tip wl-nav-icon { color: var(--accent); margin-top: 2px; }
    .err-block { animation: err-in .4s var(--spring); }
    @keyframes err-in { from { opacity: 0; transform: translateX(-6px); } }
    .need { margin-left: auto; }
  `,
})
export class DashboardFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  /** ?from=<id> : préselectionne la copie d'un tableau (bouton « Dupliquer »). */
  readonly copy = input<string>('', { alias: 'from' });

  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  protected readonly existing = signal<DashboardInfo[]>([]);
  protected readonly loaded = signal(false);
  protected readonly from = signal<DashboardInfo | null>(null);
  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected description = '';
  /** « Visible pour » : profils d'accès qui voient le tableau ; vide : tout le monde. */
  protected readonly visibleTo = signal<string[]>([]);
  /** Visibilité choisie à la main : la copie d'un tableau ne la remplace plus par la sienne. */
  protected visibilityChosen = false;

  protected readonly summary = computed(() => {
    const n = this.name().trim() || 'Sans nom';
    const f = this.from();
    const v = this.visibleTo().length;
    const audience = v ? ` Visible seulement pour ${v} profil${v > 1 ? 's' : ''} d'accès (et les administrateurs).` : ' Visible pour tout le monde.';
    return (f
      ? `« ${n} », copie des ${f.panels} panneaux de « ${f.name} » ; l'original reste inchangé.`
      : `« ${n} », vide.`) + audience;
  });

  constructor() {
    this.api.dashboards().subscribe({
      next: (d) => {
        this.existing.set(d);
        this.loaded.set(true);
        const pre = d.find((x) => x.id === this.copy());
        if (pre) this.pick(pre);
      },
      error: () => this.loaded.set(true),
    });
    // Le nom est le seul champ obligatoire : le curseur y est placé d'emblée.
    afterNextRender(() => this.nameInput()?.nativeElement.focus({ preventScroll: true }));
  }

  protected hueOf(name: string) {
    return hue(name);
  }

  protected pick(d: DashboardInfo | null) {
    const previous = this.from();
    this.from.set(d);
    // Propose un nom tant que l'utilisateur n'a pas écrit le sien.
    if (!this.name().trim() || (previous && this.name() === `${previous.name} (copie)`)) this.name.set(d ? `${d.name} (copie)` : '');
    // Même visibilité que l'original, tant que l'utilisateur n'a pas choisi la sienne.
    if (!this.visibilityChosen) this.visibleTo.set(d?.visibleTo ?? []);
  }

  protected create() {
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const fail = (e: { error?: { error?: string } }) => {
      this.busy.set(false);
      this.error.set(e?.error?.error ?? 'Création impossible.');
      this.toasts.error(this.error());
    };
    const done = {
      next: (d: { id: string }) => {
        this.toasts.ok(this.from() ? `Copie créée : « ${name} »` : `Tableau « ${name} » créé`, 'dashboards');
        this.router.navigate(['/dashboards', d.id], { queryParams: { edit: 1 } });
      },
      error: fail,
    };
    const description = this.description.trim() || null;
    const visibleTo = this.visibleTo();
    const f = this.from();
    if (!f) {
      this.api.createDashboard({ name, description, panels: [], visibleTo }).subscribe(done);
      return;
    }
    // Copie : seulement les panneaux que la personne voit (les autres ne lui sont pas transmis).
    this.api.dashboard(f.id).subscribe({
      next: (src) => this.api.createDashboard({ name, description: description ?? src.description, panels: src.panels, variables: src.variables, visibleTo }).subscribe(done),
      error: fail,
    });
  }
}
