import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { switchMap } from 'rxjs';
import { Api } from '../core/api';
import { DashboardInfo, Panel } from '../core/models';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';
import { panelIcon } from './dashboard-panel';

/** Bouton qui transforme la vue courante (recherche, métrique…) en panneau de tableau de bord. */
@Component({
  selector: 'wl-add-to-dashboard',
  imports: [FormsModule, RouterLink, NavIcon, RichOption],
  template: `
    <!-- Tableaux de bord hors du profil d'accès : pas de bouton (le serveur refuserait). -->
    @if (session.can('dashboards')) {
    <div class="wrap">
      <button class="btn trigger" type="button" (click)="toggle()" [class.on]="open()" [attr.aria-expanded]="open()">
        <wl-nav-icon name="dashboards" [size]="14" class="lead" />Ajouter au tableau de bord<wl-nav-icon name="chevron" [size]="13" class="chev" />
      </button>
      @if (open()) {
        <div class="menu" animate.leave="menu-out" role="dialog" aria-label="Ajouter au tableau de bord"
             (click)="$event.stopPropagation()" (keydown.enter)="$event.preventDefault(); canAdd() && add()">
          @if (addedTo(); as target) {
            <div class="done">
              <span class="done-icon"><wl-nav-icon name="check" [size]="20" /></span>
              <p><strong>Panneau ajouté</strong><span class="muted small ellipsis" [title]="target.name">à « {{ target.name }} »</span></p>
            </div>
            <div class="row">
              <a class="btn primary" [routerLink]="['/dashboards', target.id]"><wl-nav-icon name="arrow-right" [size]="14" />Ouvrir le tableau</a>
              <button class="btn" type="button" (click)="close()">Fermer</button>
            </div>
          } @else {
            <div class="menu-head">
              <span class="m-icon"><wl-nav-icon [name]="icon()" [size]="15" /></span>
              <div class="m-text"><strong>Nouveau panneau</strong><span class="muted small ellipsis" [title]="panel().title">{{ panel().title }}</span></div>
            </div>
            <label>Tableau
              @if (loading()) {
                <i class="skeleton select-ghost" aria-busy="true"></i>
              } @else {
                <select [(ngModel)]="target" [ngModelOptions]="{ standalone: true }">
                  @for (d of dashboards(); track d.id) {
                    <option [value]="d.id" [wlOpt]="d.name" icon="dashboards" [desc]="d.description" [meta]="d.panels + (d.panels > 1 ? ' panneaux' : ' panneau')" metaTone="muted"></option>
                  }
                  <option value="__new" wlOpt="Nouveau tableau…" icon="plus" tone="ok" desc="Créé avec ce panneau"></option>
                </select>
              }
            </label>
            @if (target === '__new') {
              <label>Nom du nouveau tableau <input [(ngModel)]="newName" [ngModelOptions]="{ standalone: true }" placeholder="ex. Paiements" /></label>
            }
            <label>Titre du panneau <input [(ngModel)]="title" [ngModelOptions]="{ standalone: true }" /></label>
            @if (error()) { <p class="danger small err"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</p> }
            <div class="row">
              <button class="btn primary" type="button" (click)="add()" [disabled]="!canAdd()">
                <wl-nav-icon [name]="busy() ? 'refresh' : 'plus'" [size]="14" [class.spin]="busy()" />{{ busy() ? 'Ajout…' : 'Ajouter' }}
              </button>
              <button class="btn" type="button" (click)="close()">Annuler</button>
            </div>
          }
        </div>
      }
    </div>
    }
  `,
  styles: `
    .wrap { position: relative; }
    .trigger { gap: 7px; }
    .trigger .lead { color: var(--accent); transition: transform .45s var(--spring); }
    .trigger:hover .lead { transform: rotate(-10deg) scale(1.1); }
    .trigger .chev { color: var(--text-3); transition: transform .45s var(--spring), color .25s; }
    .trigger.on .chev { transform: rotate(180deg); color: var(--accent); }
    .menu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 60; width: 320px; display: grid; gap: 10px; padding: 12px;
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); border: 1px solid var(--border); border-radius: var(--radius);
      box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight); transform-origin: top right; animation: pop-in .4s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(-8px) scale(.95); } }
    .menu > * { animation: item-in .35s var(--ease) backwards; }
    .menu > :nth-child(2) { animation-delay: 40ms; } .menu > :nth-child(3) { animation-delay: 70ms; } .menu > :nth-child(4) { animation-delay: 100ms; }
    .menu > :nth-child(5) { animation-delay: 130ms; }
    @keyframes item-in { from { opacity: 0; transform: translateY(-4px); } }
    .menu-out { animation: menu-out .18s ease-in forwards; }
    @keyframes menu-out { to { opacity: 0; transform: translateY(-6px) scale(.97); } }
    .menu-head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
    .m-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
    .m-text { display: grid; min-width: 0; }
    .m-text strong { font-size: 13px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label:focus-within { color: var(--accent); }
    .select-ghost { height: 32px; border-radius: var(--radius-sm); }
    @keyframes field-in { from { opacity: 0; transform: translateY(-6px); } }
    .err { display: flex; align-items: center; gap: 6px; animation: field-in .35s var(--spring); }
    .row { display: flex; gap: 8px; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Confirmation : coche qui apparaît avec un rebond. */
    .done { display: flex; align-items: center; gap: 12px; }
    .done-icon { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 50%; color: var(--on-accent);
      background: linear-gradient(135deg, var(--ok), color-mix(in srgb, var(--ok) 60%, var(--accent-3)));
      box-shadow: 0 10px 22px -10px var(--ok); animation: done-pop .55s var(--spring) backwards; }
    @keyframes done-pop { from { opacity: 0; transform: scale(.3) rotate(-30deg); } }
    .done p { display: grid; min-width: 0; }
    p { margin: 0; }
  `,
  host: { '(document:click)': 'close()', '(click)': '$event.stopPropagation()', '(document:keydown.escape)': 'close()' },
})
export class AddToDashboard {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);
  /** Panneau à ajouter, construit par la page à partir de ce qui est affiché. */
  readonly panel = input.required<Panel>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly dashboards = signal<DashboardInfo[]>([]);
  protected readonly addedTo = signal<{ id: string; name: string } | null>(null);
  protected target = '';
  protected newName = '';
  protected title = '';

  protected icon() {
    return panelIcon(this.panel());
  }

  protected canAdd() {
    return !this.busy() && !this.loading() && !!this.title.trim() && (this.target !== '__new' || !!this.newName.trim());
  }

  toggle() {
    if (this.open()) return this.close();
    this.addedTo.set(null);
    this.error.set('');
    this.title = this.panel().title;
    this.loading.set(true);
    this.api.dashboards().subscribe({
      next: (d) => {
        this.dashboards.set(d);
        this.target = d[0]?.id ?? '__new';
        this.loading.set(false);
      },
      error: () => {
        this.dashboards.set([]);
        this.target = '__new';
        this.loading.set(false);
      },
    });
    this.open.set(true);
  }

  close() {
    this.open.set(false);
  }

  add() {
    this.busy.set(true);
    this.error.set('');
    const panel: Panel = { ...structuredClone(this.panel()), title: this.title.trim(), id: Math.random().toString(36).slice(2, 10) };
    const save$ =
      this.target === '__new'
        ? this.api.createDashboard({ name: this.newName.trim(), panels: [panel] })
        : this.api.dashboard(this.target).pipe(switchMap((d) => this.api.saveDashboard({ ...d, panels: [...d.panels, panel] })));
    save$.subscribe({
      next: (d) => {
        this.busy.set(false);
        this.addedTo.set({ id: d.id, name: d.name });
        this.toasts.ok(`Panneau ajouté à « ${d.name} »`, 'dashboards');
      },
      error: () => {
        this.busy.set(false);
        this.error.set('Impossible d’enregistrer le tableau.');
        this.toasts.error('Impossible d’enregistrer le tableau.');
      },
    });
  }
}
