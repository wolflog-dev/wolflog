import { Component, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { ClickmapFrustration, ClickmapPage, ClickmapReport } from '../core/models';
import { readSetting, writeSetting } from '../core/settings';
import { NumPipe } from '../core/pipes/num-pipe';
import { ClickmapView } from '../shared/clickmap-view';

/** Cartes de chaleur à la Microsoft Clarity : clics et défilement superposés à la page, rage clicks et dead clicks. */
@Component({
  selector: 'wl-clickmaps',
  imports: [FormsModule, NumPipe, ClickmapView],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Clics &amp; défilement</h1>
        <span class="spacer"></span>
        <div class="seg">
          <button [class.on]="mode() === 'clicks'" (click)="mode.set('clicks')">Clics</button>
          <button [class.on]="mode() === 'scroll'" (click)="mode.set('scroll')">Défilement</button>
        </div>
        <div class="seg">
          @for (d of devices; track d.value) {
            <button [class.on]="device() === d.value" (click)="device.set(d.value)">{{ d.label }}</button>
          }
        </div>
      </div>

      @if (!pages().length && !loading()) {
        <div class="blank">
          <strong>Aucun clic sur cette période</strong>
          <span>La collecte démarre avec le script navigateur (désactivable avec <code>data-heatmaps="false"</code>).</span>
        </div>
      } @else if (report(); as r) {
        <div class="layout">
          <div class="main">
            <div class="bar-top">
              <select [ngModel]="path()" (ngModelChange)="path.set($event)" class="page-select" aria-label="Page">
                @for (p of pages(); track p.path) {
                  <option [value]="p.path">{{ p.path }}</option>
                }
              </select>
              <div class="stats">
                <span><b class="num">{{ r.clicks | num }}</b> clic{{ r.clicks > 1 ? 's' : '' }}</span>
                <span><b class="num">{{ r.views | num }}</b> vue{{ r.views > 1 ? 's' : '' }}</span>
                <span><b class="num">{{ round(r.avgScroll) }} %</b> défilé</span>
                @if (r.rage) { <span class="bad" title="3 clics ou plus en moins d'une seconde au même endroit"><b class="num">{{ r.rage | num }}</b> rage</span> }
                @if (r.dead) { <span title="Clic sans aucune réaction de la page"><b class="num">{{ r.dead | num }}</b> sans effet</span> }
              </div>
            </div>

            <wl-clickmap-view [report]="r" [url]="pageUrl()" [mode]="mode()" [showPage]="showPage()" (reachable)="reachable.set($event)" />

            <div class="bar-bottom">
              <label class="site" [class.warn]="!reachable()"
                     title="Le site doit autoriser Wolflog en iframe : app.UseWolflogHeatmapPreview() (Wolflog.Client.Blazor) ou frame-ancestors">
                <span>Site</span>
                <input [ngModel]="siteOrigin()" (ngModelChange)="setOrigin($event)" placeholder="https://www.exemple.fr" spellcheck="false" />
              </label>
              <span class="spacer"></span>
              <span class="legend" [class.scroll]="mode() === 'scroll'">{{ mode() === 'clicks' ? 'Peu' : 'Vu par tous' }}<i></i>{{ mode() === 'clicks' ? 'Beaucoup' : 'Vu par peu' }}</span>
              <label class="check"><input type="checkbox" [checked]="showPage()" (change)="showPage.set(!showPage())" /> Page</label>
            </div>
          </div>

          <aside class="side">
            <h2>Éléments cliqués</h2>
            <div class="rows">
              @for (e of topElements(); track e.selector; let i = $index) {
                <div class="row" [style.--w]="share(e.clicks, r.elements[0].clicks)" [style.--i]="i" [title]="e.selector ?? ''">
                  <span class="fill"></span>
                  <span class="text"><span class="ellipsis">{{ e.label ?? short(e.selector) }}</span>@if (duplicated().has(e.label ?? '')) { <small class="ellipsis">{{ context(e.selector) }}</small> }</span>
                  @if (e.rage) { <span class="dot bad" title="Rage clicks">{{ e.rage }}</span> }
                  @if (e.dead) { <span class="dot" title="Clics sans effet">{{ e.dead }}</span> }
                  <span class="num val">{{ e.clicks | num }}</span>
                </div>
              } @empty {
                <div class="none">Aucun élément</div>
              }
            </div>

            <h2>Frustrations <span>tout le site</span></h2>
            <div class="rows">
              @for (f of frustrations(); track f.path + f.selector; let i = $index) {
                <button class="row click" [style.--i]="i" (click)="path.set(f.path)" [title]="'Voir ' + f.path">
                  <span class="text"><span class="ellipsis">{{ f.label ?? short(f.selector) }}</span><small class="ellipsis">{{ f.path }}</small></span>
                  @if (f.rage) { <span class="dot bad" title="Rage clicks">{{ f.rage }}</span> }
                  @if (f.dead) { <span class="dot" title="Clics sans effet">{{ f.dead }}</span> }
                </button>
              } @empty {
                <div class="none">Rien à signaler</div>
              }
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    h1 { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
    .blank { display: grid; gap: 6px; place-items: center; padding: 80px 20px; color: var(--text-3); text-align: center; }
    .blank strong { color: var(--text-1); font-weight: 600; font-size: 14px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; align-items: start; }
    .main { display: grid; gap: 10px; min-width: 0; }
    .bar-top, .bar-bottom { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; min-width: 0; }
    .page-select { min-width: 220px; max-width: 100%; font-weight: 500; }
    .stats { display: flex; gap: 18px; flex-wrap: wrap; color: var(--text-3); font-size: 12.5px; }
    .stats b { color: var(--text-1); font-weight: 600; font-size: 14px; margin-right: 3px; }
    .stats .bad b { color: var(--danger); }
    .site { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12px; }
    .site input { width: 240px; height: 26px; font-size: 12px; background: none; }
    .site.warn input { border-color: var(--danger); }
    .legend { display: inline-flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 11.5px; }
    .legend i { width: 64px; height: 6px; border-radius: 3px; background: linear-gradient(90deg, rgba(250, 178, 25, .5), #eb6834, #d03b3b, #7a1d1d); }
    .legend.scroll i { background: linear-gradient(90deg, rgba(16, 16, 12, .05), rgba(16, 16, 12, .75)); }
    .check { font-size: 12px; }
    .side { display: grid; gap: 8px; min-width: 0; position: sticky; top: 12px; }
    .side h2 { display: flex; align-items: baseline; gap: 8px; margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--text-2); }
    .side h2 span { font-weight: 400; color: var(--text-3); font-size: 11px; }
    .side h2:not(:first-child) { margin-top: 18px; }
    .rows { display: grid; gap: 2px; }
    .row { position: relative; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 30px; padding: 4px 8px;
      border: 0; border-radius: 6px; background: none; color: var(--text-1); font: 12.5px var(--sans); text-align: left;
      animation: row-in .35s ease-out both; animation-delay: calc(var(--i) * 25ms); }
    .row.click { cursor: pointer; }
    .row.click:hover { background: var(--surface-2); }
    .fill { position: absolute; inset: 0 auto 0 0; width: calc(var(--w) * 100%); background: var(--accent-soft); border-radius: 6px; transition: width .5s ease-out; }
    .text, .dot, .val { position: relative; }
    .text { flex: 1; min-width: 0; display: grid; }
    .text small { color: var(--text-3); font-size: 11px; }
    .val { font-weight: 600; flex: none; }
    .dot { flex: none; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--surface-3); color: var(--text-2);
      font: 600 10.5px/18px var(--mono); text-align: center; }
    .dot.bad { background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
    .none { padding: 6px 8px; color: var(--text-3); font-size: 12px; }
    @keyframes row-in { from { opacity: 0; transform: translateX(-4px); } }
    @media (prefers-reduced-motion: reduce) { .row { animation: none; } .fill { transition: none; } }
    @media (max-width: 1100px) { .layout { grid-template-columns: minmax(0, 1fr); } .side { position: static; } }
  `,
})
export class ClickmapsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);

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
  protected readonly frustrations = signal<ClickmapFrustration[]>([]);
  protected readonly loading = signal(false);
  protected readonly reachable = signal(true);
  private readonly originOverride = signal<string | null>(null);
  private subs: Subscription[] = [];
  private reportSub?: Subscription;

  /** Origine du site affiché : réglage local par service, sinon déduite de l'hôte mesuré. */
  protected readonly siteOrigin = computed(() => {
    const custom = this.originOverride();
    if (custom) return custom;
    const host = this.report()?.host;
    if (!host) return '';
    const local = /^(localhost|127\.|\[::1\])/.test(host) || host.endsWith('.localhost');
    return `${local ? 'http' : 'https'}://${host}`;
  });

  protected readonly topElements = computed(() => this.report()?.elements.slice(0, 10) ?? []);

  /** Libellés répétés (ex. « Ajouter au panier » sur chaque carte) : on affiche alors leur emplacement. */
  protected readonly duplicated = computed(() => {
    const seen = new Set<string>(), dup = new Set<string>();
    for (const e of this.topElements()) if (e.label) (seen.has(e.label) ? dup : seen).add(e.label);
    return dup;
  });

  protected readonly pageUrl = computed(() => {
    const origin = this.siteOrigin().replace(/\/$/, '');
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
    if (!path) { this.report.set(null); return; }
    this.reportSub = this.api.clickmap(this.state.range(), this.state.service(), path, this.device()).subscribe((r) => this.report.set(r));
  }

  protected setOrigin(value: string) {
    const v = value.trim();
    this.originOverride.set(v || null);
    writeSetting(`wolflog.clickmap.origin.${this.state.service()}`, v);
  }

  protected share(n: number, max: number) {
    return max ? Math.min(1, n / max).toFixed(4) : '0';
  }

  protected short(selector: string | null) {
    return selector ? selector.split(' > ').pop() ?? selector : '(élément)';
  }

  /** Dernier conteneur numéroté du sélecteur : « article.carte:nth-of-type(3) » → « carte 3 ». */
  protected context(selector: string | null) {
    const parts = (selector ?? '').split(' > ').slice(0, -1).reverse();
    const m = parts.map((p) => /^[a-z0-9]*\.?([\w-]*)[^:]*:nth-of-type\((\d+)\)/i.exec(p)).find((x) => x);
    return m ? `${m[1] || 'élément'} ${m[2]}` : this.short(selector);
  }

  protected round(n: number) {
    return Math.round(n);
  }

  ngOnDestroy() {
    this.subs.forEach((s) => s.unsubscribe());
    this.reportSub?.unsubscribe();
  }
}
