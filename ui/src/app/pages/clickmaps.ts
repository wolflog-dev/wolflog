import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { ClickmapFrustration, ClickmapPage, ClickmapReport, ClickmapSnapshot } from '../core/models';
import { formatNumber } from '../core/format';
import { readSetting, writeSetting } from '../core/settings';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NumPipe } from '../core/pipes/num-pipe';
import { ClickmapView } from '../shared/clickmap-view';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

/** Cartes de chaleur à la Microsoft Clarity : clics et défilement superposés à la page, rage clicks et dead clicks. */
@Component({
  selector: 'wl-clickmaps',
  imports: [FormsModule, RouterLink, NumPipe, ClickmapView, CountUp, NavIcon, RichOption, Skeleton],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Clics &amp; défilement</h1>
        <span class="spacer"></span>
        <div class="seg">
          <button [class.on]="mode() === 'clicks'" (click)="mode.set('clicks')"><wl-nav-icon name="cursor" [size]="13" />Clics</button>
          <button [class.on]="mode() === 'scroll'" (click)="mode.set('scroll')"><wl-nav-icon name="arrow-down" [size]="13" />Défilement</button>
        </div>
        <div class="seg">
          @for (d of devices; track d.value) {
            <button [class.on]="device() === d.value" (click)="device.set(d.value)">{{ d.label }}</button>
          }
        </div>
      </div>

      @if (!pages().length && !loading()) {
        <div class="panel empty">
          <strong>Aucun clic sur cette période</strong>
          <span>La collecte démarre avec le script navigateur (désactivable avec <code>data-heatmaps="false"</code>).</span>
          <div class="cta">
            <a class="btn" routerLink="/audience"><wl-nav-icon name="audience" [size]="14" />Voir l'audience</a>
            @if (session.isAdmin()) {
              <a class="btn primary" routerLink="/admin/keys/new"><wl-nav-icon name="plus" [size]="14" />Connecter un site</a>
            }
          </div>
        </div>
      } @else if (report(); as r) {
        <div class="layout">
          <div class="main">
            <div class="bar-top">
              <select [ngModel]="path()" (ngModelChange)="path.set($event)" class="page-select" aria-label="Page">
                @for (p of pages(); track p.path) {
                  <option [value]="p.path" [wlOpt]="p.path" icon="page" [tone]="p.rage ? 'danger' : null" [desc]="pageDesc(p)"
                          [meta]="pageMeta(p)" [metaTone]="p.rage ? 'danger' : null"></option>
                }
              </select>
              <div class="stats">
                <span class="stat" title="Clics enregistrés sur cette page"><wl-nav-icon name="cursor" [size]="13" /><b class="num" [wlCountUp]="r.clicks | num"></b> clic{{ r.clicks > 1 ? 's' : '' }}</span>
                <span class="stat" title="Pages vues mesurées"><wl-nav-icon name="eye" [size]="13" /><b class="num" [wlCountUp]="r.views | num"></b> vue{{ r.views > 1 ? 's' : '' }}</span>
                <span class="stat" title="Profondeur de défilement moyenne"><wl-nav-icon name="arrow-down" [size]="13" /><b class="num" [wlCountUp]="round(r.avgScroll) + ' %'"></b> défilé</span>
                @if (r.rage) { <span class="stat bad" title="3 clics ou plus en moins d'une seconde au même endroit"><wl-nav-icon name="warning" [size]="13" /><b class="num" [wlCountUp]="r.rage | num"></b> rage</span> }
                @if (r.dead) { <span class="stat" title="Clic sans aucune réaction de la page"><wl-nav-icon name="target" [size]="13" /><b class="num" [wlCountUp]="r.dead | num"></b> sans effet</span> }
              </div>
            </div>

            <wl-clickmap-view [report]="r" [url]="pageUrl()" [mode]="mode()" [showPage]="showPage()" [snapshot]="snapshot()"
                              (reachable)="reachable.set($event)" (openOnSite)="openOnSite()" />

            <div class="bar-bottom">
              <label class="site" [class.warn]="!reachable()"
                     title="Le site doit autoriser Wolflog en iframe : app.UseWolflogHeatmapPreview() (Wolflog.Client.Blazor) ou frame-ancestors. Application dans un sous-dossier (IIS) : son adresse complète, https://serveur/appli">
                <span>Site</span>
                <span class="control">
                  <wl-nav-icon [name]="reachable() ? 'globe' : 'warning'" [size]="13" />
                  <input [ngModel]="siteOrigin()" (ngModelChange)="setOrigin($event)" placeholder="https://www.exemple.fr" spellcheck="false" />
                </span>
              </label>
              <button type="button" class="btn small" (click)="openOnSite()" [disabled]="!siteOrigin() || !path() || opening()"
                      title="Affiche la carte sur le site lui-même, avec votre session : pour les pages protégées par une connexion. Le site sert /_wolflog/heatmap (Wolflog.Client.Blazor : app.UseWolflogHeatmapPreview()).">
                <wl-nav-icon name="external" [size]="13" />Ouvrir sur le site
              </button>
              <span class="spacer"></span>
              <span class="legend" [class.scroll]="mode() === 'scroll'">{{ mode() === 'clicks' ? 'Peu' : 'Vu par tous' }}<i></i>{{ mode() === 'clicks' ? 'Beaucoup' : 'Vu par peu' }}</span>
              <label class="check" title="Afficher la page sous la carte"><input type="checkbox" class="switch" [checked]="showPage()" (change)="showPage.set(!showPage())" /> Page</label>
            </div>
          </div>

          <aside class="side">
            <h2><wl-nav-icon name="cursor" [size]="13" />Éléments cliqués</h2>
            <div class="rows">
              @for (e of topElements(); track e.selector; let i = $index) {
                <div class="row" [style.--w]="share(e.clicks, r.elements[0].clicks)" [style.--i]="i" [title]="e.selector ?? ''">
                  <span class="fill"></span>
                  <span class="rank">{{ i + 1 }}</span>
                  <span class="text"><span class="ellipsis">{{ display(e) }}</span>@if (duplicated().has(display(e))) { <small class="ellipsis">{{ context(e.selector) }}</small> }</span>
                  @if (e.rage) { <span class="dot bad" title="Rage clicks">{{ e.rage }}</span> }
                  @if (e.dead) { <span class="dot" title="Clics sans effet">{{ e.dead }}</span> }
                  <span class="num val">{{ e.clicks | num }}</span>
                </div>
              } @empty {
                <div class="none"><wl-nav-icon name="inbox" [size]="14" />Aucun élément</div>
              }
            </div>

            <h2><wl-nav-icon name="warning" [size]="13" />Frustrations <span>tout le site</span></h2>
            <div class="rows">
              @for (f of frustrations(); track f.path + f.selector; let i = $index) {
                <button class="row click" [class.current]="f.path === path()" [style.--i]="i" (click)="path.set(f.path)" [title]="'Voir ' + f.path">
                  <span class="text"><span class="ellipsis">{{ f.label ?? short(f.selector) }}</span><small class="ellipsis">{{ f.path }}</small></span>
                  @if (f.rage) { <span class="dot bad" title="Rage clicks">{{ f.rage }}</span> }
                  @if (f.dead) { <span class="dot" title="Clics sans effet">{{ f.dead }}</span> }
                  <wl-nav-icon class="go" name="chevron-right" [size]="14" />
                </button>
              } @empty {
                <div class="none ok-none"><wl-nav-icon name="ok" [size]="14" />Rien à signaler</div>
              }
            </div>
          </aside>
        </div>
      } @else {
        <div class="layout">
          <div class="main">
            <div class="bar-top"><i class="skeleton" style="width: 260px; height: 32px"></i><i class="skeleton" style="width: 320px; height: 14px"></i></div>
            <i class="skeleton map-skeleton"></i>
          </div>
          <aside class="side"><wl-skeleton [rows]="9" /></aside>
        </div>
      }
    </div>
  `,
  styles: `
    .seg button { display: inline-flex; align-items: center; gap: 6px; }
    .empty { display: grid; justify-items: center; gap: 6px; padding: 64px 20px; }
    .empty strong { color: var(--text-1); font-weight: 600; font-size: 14px; }
    .cta { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 10px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
    .main { display: grid; gap: 10px; min-width: 0; }
    .bar-top, .bar-bottom { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; min-width: 0; }
    .page-select { min-width: 240px; max-width: 100%; font-weight: 500; }
    .stats { display: flex; gap: 8px; flex-wrap: wrap; color: var(--text-3); font-size: 12.5px; }
    .stat { display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px 0 9px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border-soft); transition: border-color .2s, transform .3s var(--spring); }
    .stat:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); transform: translateY(-1px); }
    .stat wl-nav-icon { color: var(--accent); }
    .stats b { color: var(--text-1); font-weight: 650; font-size: 13.5px; }
    .stat.bad { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 9%, transparent); }
    .stat.bad wl-nav-icon, .stats .bad b { color: var(--danger); }
    .site { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
    .control { position: relative; display: block; }
    .control wl-nav-icon { position: absolute; left: 9px; top: 0; bottom: 0; margin: auto 0; height: 13px; color: var(--text-3); pointer-events: none;
      transition: color .25s; }
    .control:focus-within wl-nav-icon { color: var(--accent); }
    .site input { width: 260px; height: 28px; padding-left: 28px; font-size: 12px; background: none; }
    .site.warn input { border-color: var(--danger); }
    .site.warn .control wl-nav-icon { color: var(--danger); }
    .legend { display: inline-flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 11.5px; }
    .legend i { width: 64px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, rgba(250, 178, 25, .5), #eb6834, #d03b3b, #7a1d1d); }
    .legend.scroll i { background: linear-gradient(90deg, rgba(16, 16, 12, .05), rgba(16, 16, 12, .75)); box-shadow: inset 0 0 0 1px var(--border); }
    .check { font-size: 12px; }
    .map-skeleton { height: min(62vh, 560px); border-radius: var(--radius-sm); }

    .side { display: grid; gap: 8px; min-width: 0; position: sticky; top: 12px; }
    .side h2 { display: flex; align-items: center; gap: 7px; margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--text-2); }
    .side h2 wl-nav-icon { color: var(--accent); }
    .side h2 span { font-weight: 400; color: var(--text-3); font-size: 11px; }
    .side h2:not(:first-child) { margin-top: 18px; }
    .rows { display: grid; gap: 2px; }
    .row { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 32px; padding: 4px 8px;
      border: 0; border-radius: 8px; background: none; color: var(--text-1); font: 12.5px var(--sans); text-align: left;
      transition: background-color .15s; animation: row-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 12) * 25ms); }
    .row:hover { background-color: var(--row-hover); }
    .row.click { cursor: pointer; }
    .row.current { box-shadow: inset 2px 0 0 var(--accent); }
    /* Part des clics : barre qui se remplit (transform). */
    .fill { position: absolute; inset: 0; border-radius: inherit; transform-origin: left; transform: scaleX(var(--w));
      background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 22%, transparent), var(--accent-soft));
      transition: transform .6s var(--ease); animation: grow .7s var(--ease) backwards; animation-delay: calc(min(var(--i), 12) * 30ms); }
    @keyframes grow { from { transform: scaleX(0); } }
    .rank, .text, .dot, .val, .go { position: relative; }
    .rank { flex: none; width: 16px; font: 600 10.5px var(--mono); color: var(--text-3); text-align: right; }
    .text { flex: 1; min-width: 0; display: grid; }
    .text small { color: var(--text-3); font-size: 11px; }
    .val { font-weight: 600; flex: none; }
    .dot { flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--surface-3); color: var(--text-2);
      font: 600 10.5px/18px var(--mono); text-align: center; }
    .dot.bad { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
    .go { flex: none; color: var(--text-3); transition: transform .35s var(--spring), color .2s; }
    .row.click:hover .go { transform: translateX(3px); color: var(--accent); }
    .none { display: flex; align-items: center; gap: 6px; padding: 6px 8px; color: var(--text-3); font-size: 12px; }
    .ok-none wl-nav-icon { color: var(--ok); }
    @keyframes row-in { from { opacity: 0; transform: translateX(-4px); } }
    @media (max-width: 1100px) { .layout { grid-template-columns: minmax(0, 1fr); } .side { position: static; } }
  `,
})
export class ClickmapsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);
  /** Jeton de la carte sur le site en cours de préparation. */
  protected readonly opening = signal(false);

  protected readonly devices = [
    { value: 'desktop', label: 'Ordinateur' },
    { value: 'tablet', label: 'Tablette' },
    { value: 'mobile', label: 'Mobile' },
    { value: '', label: 'Tous' },
  ];
  protected readonly device = signal('desktop');
  protected readonly mode = signal<'clicks' | 'scroll'>('clicks');
  protected readonly showPage = signal(true);
  protected readonly path = signal<string | null>(null);
  protected readonly pages = signal<ClickmapPage[]>([]);
  protected readonly report = signal<ClickmapReport | null>(null);
  /** Capture de la page (texte masqué), affichée quand la page en direct n'est pas affichable ici. */
  protected readonly snapshot = signal<ClickmapSnapshot | null>(null);
  protected readonly frustrations = signal<ClickmapFrustration[]>([]);
  protected readonly loading = signal(false);
  protected readonly reachable = signal(true);
  private readonly originOverride = signal<string | null>(null);
  private subs: Subscription[] = [];
  private reportSub?: Subscription;
  private snapshotSub?: Subscription;
  private snapshotKey = '';

  /** Origine du site affiché : réglage local par service, sinon déduite de l'hôte mesuré. */
  protected readonly siteOrigin = computed(() => {
    const custom = this.originOverride();
    if (custom) return custom;
    const host = this.report()?.host;
    if (!host) return '';
    // Le plus souvent sans certificat : machine locale, adresse IP, nom court ou en .local de l'intranet (modifiable à côté).
    const name = host.replace(/:\d+$/, '');
    const plain = /^(localhost|127\.|\[::1\])/.test(host) || name.endsWith('.localhost') || name.endsWith('.local')
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || !name.includes('.');
    return `${plain ? 'http' : 'https'}://${host}`;
  });

  protected readonly topElements = computed(() => this.report()?.elements.slice(0, 10) ?? []);

  /** Libellés répétés (ex. « Ajouter au panier » sur chaque carte) : on affiche alors leur emplacement. */
  protected readonly duplicated = computed(() => {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const e of this.topElements()) {
      const name = this.display(e);
      (seen.has(name) ? dup : seen).add(name);
    }
    return dup;
  });

  protected readonly pageUrl = computed(() => {
    // Chemins mesurés depuis la racine du site, sous-application comprise : seule l'origine de l'adresse compte ici (« Ouvrir
    // sur le site » garde l'adresse entière, https://serveur/appli, où l'application sert /_wolflog/heatmap).
    const origin = /^https?:\/\/[^/?#]+/i.exec(this.siteOrigin().trim())?.[0] ?? '';
    const path = this.path();
    // Marqueur lu par le script navigateur et Wolflog.Client.Blazor : l'aperçu n'est jamais compté comme une visite.
    return origin && path ? `${origin}${path}${path.includes('?') ? '&' : '?'}wolflog-preview=1` : null;
  });

  constructor() {
    effect(() => {
      this.device();
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      untracked(() => this.loadPages());
    });
    effect(() => {
      const path = this.path();
      this.device();
      this.state.tick();
      untracked(() => this.loadReport(path));
    });
    effect(() => {
      const saved = readSetting(`wolflog.clickmap.origin.${this.state.service()}`, '');
      untracked(() => this.originOverride.set(saved || null));
    });
  }

  private loadPages() {
    this.subs.forEach((s) => s.unsubscribe());
    const r = this.state.range(), service = this.state.service(), device = this.device();
    this.loading.set(true);
    this.subs = [
      this.api.clickmapPages(r, service, device).subscribe({
        next: (pages) => {
          this.pages.set(pages);
          this.loading.set(false);
          const current = this.path();
          if (!current || !pages.some((p) => p.path === current)) this.path.set(pages[0]?.path ?? null);
          else this.loadReport(current);
        },
        error: () => this.loading.set(false),
      }),
      this.api.clickmapFrustrations(r, service, device).subscribe((f) => this.frustrations.set(f)),
    ];
  }

  private loadReport(path: string | null) {
    this.reportSub?.unsubscribe();
    if (!path) { this.report.set(null); this.snapshot.set(null); return; }
    this.loadSnapshot(path);
    this.reportSub = this.api.clickmap(this.state.range(), this.state.service(), path, this.device()).subscribe((r) => this.report.set(r));
  }

  /**
   * Carte sur le site : la page /_wolflog/heatmap du site affiche ses pages avec la session de la personne (l'aperçu de
   * Wolflog ne la reçoit pas quand le site est sur un autre domaine) et lit les clics avec un jeton de quelques heures.
   */
  protected openOnSite() {
    const origin = this.siteOrigin().replace(/\/$/, ''), path = this.path();
    if (!origin || !path || this.opening()) return;
    // Onglet ouvert tout de suite (sinon bloqué comme fenêtre surgissante), adresse posée une fois le jeton reçu.
    const tab = window.open('', '_blank');
    this.opening.set(true);
    this.api.clickmapViewer(this.state.range(), this.state.service()).subscribe({
      next: ({ token }) => {
        this.opening.set(false);
        const query = new URLSearchParams({ t: token, path, device: this.device(), mode: this.mode() });
        const url = `${origin}/_wolflog/heatmap?${query}`;
        if (!tab) { window.open(url, '_blank', 'noopener'); return; }
        tab.opener = null;
        tab.location.href = url;
      },
      error: () => {
        this.opening.set(false);
        tab?.close();
        this.toasts.error('Impossible de préparer la carte sur le site.');
      },
    });
  }

  /**
   * Capture de la page, chargée quand la page, l'appareil ou le service change : l'actualisation de la carte ne retélécharge
   * pas le décor (une capture par jour au plus), elle le cherche seulement tant qu'il n'y en a pas.
   */
  private loadSnapshot(path: string) {
    const key = `${this.state.service()}|${path}|${this.device()}`;
    if (key === this.snapshotKey && this.snapshot()) return;
    if (key !== this.snapshotKey) this.snapshot.set(null);
    this.snapshotKey = key;
    this.snapshotSub?.unsubscribe();
    this.snapshotSub = this.api.clickmapSnapshot(this.state.service(), path, this.device()).subscribe({
      next: (s) => this.snapshot.set(s),
      error: () => this.snapshot.set(null),
    });
  }

  protected setOrigin(value: string) {
    const v = value.trim();
    this.originOverride.set(v || null);
    writeSetting(`wolflog.clickmap.origin.${this.state.service()}`, v);
  }

  protected share(n: number, max: number) {
    return max ? Math.min(1, n / max).toFixed(4) : '0';
  }

  /** Dernier maillon lisible du sélecteur : « div.img:nth-of-type(1) » → « div.img ». */
  protected short(selector: string | null) {
    const last = selector?.split(' > ').pop();
    return last ? last.replace(/:nth-of-type\(\d+\)/g, '') || last : '(élément)';
  }

  /** Dernier conteneur numéroté du sélecteur : « article.carte:nth-of-type(3) » → « carte 3 ». */
  protected context(selector: string | null) {
    const parts = (selector ?? '').split(' > ').slice(0, -1).reverse();
    const m = parts.map((p) => /^([a-z0-9]*)\.?([\w-]*)[^:]*:nth-of-type\((\d+)\)/i.exec(p)).find((x) => x);
    return m ? `${m[2] || m[1] || 'élément'} ${m[3]}` : this.short(selector);
  }

  /** Nom affiché d'un élément : son libellé, sinon la fin de son sélecteur. */
  protected display(e: { label: string | null; selector: string | null }) {
    return e.label ?? this.short(e.selector);
  }

  protected round(n: number) {
    return Math.round(n);
  }

  /** Deuxième ligne de l'option : vues et frustrations de la page. */
  protected pageDesc(p: ClickmapPage) {
    const parts = [`${formatNumber(p.views)} vue${p.views > 1 ? 's' : ''}`];
    if (p.rage) parts.push(`${formatNumber(p.rage)} rage`);
    if (p.dead) parts.push(`${formatNumber(p.dead)} sans effet`);
    return parts.join(' · ');
  }

  /** Compteur à droite de l'option : nombre de clics. */
  protected pageMeta(p: ClickmapPage) {
    return `${formatNumber(p.clicks)} clic${p.clicks > 1 ? 's' : ''}`;
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
    this.reportSub?.unsubscribe();
    this.snapshotSub?.unsubscribe();
  }
}
