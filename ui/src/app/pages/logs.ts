import { Component, ElementRef, OnDestroy, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import { Subscription } from 'rxjs';
import { Api } from '../core/api';
import { Histogram, LogItem, Panel } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { LEVEL_COLORS, LEVELS, parseJson } from '../core/format';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { Chart, ChartSeries } from '../shared/chart';
import { Attributes } from '../shared/attributes';
import { CopyText } from '../shared/copy-text';
import { CountUp } from '../shared/count-up';
import { LevelBadge } from '../shared/level-badge';
import { AddToDashboard } from '../shared/add-to-dashboard';
import { NavIcon } from '../shared/nav-icon';
import { envColor, envLabel } from '../shared/rich-option';
import { SavedSearches } from '../shared/saved-searches';
import { Skeleton } from '../shared/skeleton';

const LEVEL_FILTERS = [
  { value: '', label: 'Tout', tone: '', hint: 'Tous les niveaux' },
  { value: 'info', label: '≥ Info', tone: 'var(--ok)', hint: 'Information et plus grave (masque trace et débogage)' },
  { value: 'warn', label: '≥ Warn', tone: 'var(--warn)', hint: 'Avertissements, erreurs et crashs' },
  { value: 'error', label: '≥ Error', tone: 'var(--danger)', hint: 'Erreurs et crashs seulement' },
];

const MAX_LIVE = 5000;
/** Hauteur d'une ligne (défilement virtuel) : sur téléphone, le message passe sous l'heure et le service. */
const ROW_HEIGHT = matchMedia('(max-width: 640px)').matches ? 46 : 26;

/** Format des infobulles de date (créé une fois : appelé pour chaque ligne affichée). */
const FULL_DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });

/** Niveaux .NET (LogLevel) des logs précédant un crash → niveaux de Wolflog. */
const CRUMB_LEVELS: Record<string, string> = {
  trace: 'trace', verbose: 'trace', debug: 'debug', information: 'info', info: 'info', warning: 'warn', warn: 'warn', error: 'error', critical: 'fatal', fatal: 'fatal',
};

/** Morceau de message : texte simple ou terme recherché (surligné). */
interface Part {
  text: string;
  hit: boolean;
}

function splitHits(text: string, re: RegExp): Part[] {
  const out: Part[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (!m[0]) continue;
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

@Component({
  selector: 'wl-logs',
  imports: [FormsModule, ScrollingModule, Chart, LevelBadge, Attributes, CopyText, CountUp, NavIcon, Skeleton, NumPipe, TimePipe, RouterLink, AddToDashboard, SavedSearches],
  host: { '(document:keydown)': 'onKey($event)', class: 'fill-host' },
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page fill">
      <div class="page-head">
        <div class="searchbar">
          <wl-nav-icon name="search" [size]="15" class="s-icon" />
          <input #searchBox class="search" [ngModel]="query" (ngModelChange)="typed($event)" (keydown.enter)="searchNow()"
                 placeholder='Rechercher : timeout  service:api  http.route:/users/*  "texte exact"  -exclure' aria-label="Recherche" />
          @if (query) {
            <button type="button" class="clear" (click)="clear()" title="Effacer la recherche" aria-label="Effacer la recherche"><wl-nav-icon name="close" [size]="12" /></button>
          }
          <kbd class="shortcut">/</kbd>
        </div>
        <div class="seg levels">
          @for (l of levelFilters; track l.value) {
            <button [class.on]="level() === l.value" (click)="level.set(l.value)" [title]="l.hint">{{ l.label }}</button>
          }
        </div>
        <button class="btn live-btn" [class.on]="live()" (click)="toggleLive()" [title]="live() ? 'Revenir à la recherche sur la période' : 'Afficher les nouveaux logs en temps réel'">
          <wl-nav-icon [name]="live() ? 'pause' : 'play'" [size]="14" />{{ live() ? 'Arrêter le direct' : 'Suivre en direct' }}
        </button>
        <wl-saved-searches page="logs" [params]="searchParams()" (apply)="applySaved($event)" />
        <wl-add-to-dashboard [panel]="panelForSearch()" />
      </div>

      @if (!live()) {
        <div class="panel chart-panel" animate.leave="chart-out">
          <wl-chart [times]="histTimes()" [series]="histSeries()" kind="bars" [stacked]="true" [height]="84" [legend]="false" (rangeSelect)="zoom($event)" />
        </div>
      }

      <div class="split grow" [class.with-detail]="selected()">
        <section class="panel results" [class.busy]="loading() && items().length > 0">
          <div class="panel-head small">
            @if (live()) {
              <span class="count-line"><wl-nav-icon name="wifi" [size]="14" class="live-icon" /><strong class="num">{{ items().length | num }}</strong> logs reçus depuis l'ouverture du flux</span>
            } @else {
              <span class="count-line"><strong class="total" [wlCountUp]="total() | num"></strong> logs</span>
              @if (stats(); as s) { <span class="pill" title="Durée de la recherche côté serveur"><wl-nav-icon name="timer" [size]="11" />{{ s.elapsedMs }} ms</span> }
            }
            <span class="spacer"></span>
            @if (error()) { <span class="danger err"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span> }
            @else if (items().length) { <span class="muted hide-narrow">Clic ou <kbd>↑</kbd> <kbd>↓</kbd> pour le détail</span> }
            @if (!live() && items().length) {
              <span class="export"><wl-nav-icon name="download" [size]="13" />Exporter
                <a class="chip" [href]="exportUrl('csv')" download (click)="exported('CSV')" title="Jusqu'à 10 000 logs, séparateur point-virgule (Excel)">CSV</a>
                <a class="chip" [href]="exportUrl('json')" download (click)="exported('JSON')" title="Jusqu'à 10 000 logs">JSON</a>
              </span>
              @if (session.canEdit()) {
                <a class="chip" routerLink="/alerts/new" [queryParams]="alertParams()" title="Être prévenu quand des logs correspondent à cette recherche">
                  <wl-nav-icon name="bell" [size]="12" />Alerter
                </a>
              }
            }
          </div>
          @if (items().length) {
            <cdk-virtual-scroll-viewport [itemSize]="rowHeight" class="viewport" (scrolledIndexChange)="onScroll($event)">
              <div *cdkVirtualFor="let log of items(); trackBy: trackLog" class="row" [class.sel]="log === selected()" [attr.data-lvl]="log.level" (click)="select(log)">
                <span class="ts mono" [title]="fullDate(log.ts)">{{ log.ts | time: true }}</span>
                <wl-level [level]="log.level" />
                <span class="svc ellipsis" [title]="log.service">{{ log.service }}</span>
                <span class="msg mono ellipsis">@if (log.isCrash) {<span class="tag crash">crash</span>}@for (p of parts(log.body); track $index) {<span [class.hit]="p.hit">{{ p.text }}</span>}</span>
              </div>
            </cdk-virtual-scroll-viewport>
          } @else if (loading() && !live()) {
            <wl-skeleton [rows]="14" class="grow-skeleton" />
          } @else {
            <div class="empty" [class.waiting]="live()">
              @if (live()) {
                <p class="lead-text">En attente de nouveaux logs…</p>
                <p class="hint">Ils s'affichent ici dès leur réception@if (appliedQuery() || level()) {, s'ils correspondent à la recherche}.</p>
              } @else if (error()) {
                <p class="lead-text">{{ error() }}</p>
                <p class="hint">Vérifiez la syntaxe de la recherche, puis réessayez.</p>
              } @else if (query || level()) {
                <p class="lead-text">Aucun log ne correspond.</p>
                <p class="hint syntax">Syntaxe : <code>mot</code> <code>service:api</code> <code>"texte exact"</code> <code>-exclure</code> <code>attribut:valeur*</code></p>
                <div class="cta">
                  <button class="btn" (click)="clear(); level.set('')"><wl-nav-icon name="close" [size]="14" />Effacer les filtres</button>
                  @if (canWiden()) { <button class="btn ghost" (click)="state.setRelative('24h')"><wl-nav-icon name="calendar" [size]="14" />Élargir à 24 h</button> }
                </div>
              } @else {
                <p class="lead-text">Aucun log sur cette période.</p>
                <p class="hint">Élargissez la période, ou suivez les nouveaux logs en direct.</p>
                <div class="cta">
                  @if (canWiden()) { <button class="btn" (click)="state.setRelative('24h')"><wl-nav-icon name="calendar" [size]="14" />Élargir à 24 h</button> }
                  <button class="btn ghost" (click)="toggleLive()"><wl-nav-icon name="play" [size]="14" />Suivre en direct</button>
                </div>
              }
            </div>
          }
        </section>

        @if (selected(); as log) {
          <aside class="panel detail" animate.enter="detail-in" animate.leave="detail-out" aria-label="Détail du log">
            <div class="panel-head">
              <wl-level [level]="log.level" />
              <span class="mono small" [title]="fullDate(log.ts)">{{ log.ts | time: true }}</span>
              <span class="svc-name small ellipsis" [title]="log.service">{{ log.service }}</span>
              <span class="spacer"></span>
              <span class="muted small hide-narrow"><kbd>↑</kbd> <kbd>↓</kbd> <kbd>Échap</kbd></span>
              <button class="btn ghost square" (click)="selected.set(null)" title="Fermer (Échap)" aria-label="Fermer le détail"><wl-nav-icon name="close" [size]="15" /></button>
            </div>
            <div class="detail-body">
              <div class="copyable">
                <pre class="body">@for (p of parts(log.body); track $index) {<span [class.hit]="p.hit">{{ p.text }}</span>}</pre>
                <button type="button" class="icon" (click)="copy(log.body, 'Message copié')" title="Copier le message" aria-label="Copier le message"><wl-nav-icon name="copy" [size]="13" /></button>
              </div>

              <div class="links small">
                @if (log.traceId && session.can(['traces', 'requests'])) {
                  <a class="btn" [routerLink]="['/traces', log.traceId]" [queryParams]="{ around: log.ts, span: log.spanId }"><wl-nav-icon name="traces" [size]="14" />Ouvrir la trace</a>
                }
                @if (log.fingerprint && session.can('errors')) {
                  <a class="btn" [routerLink]="['/errors', log.fingerprint]"><wl-nav-icon name="errors" [size]="14" />Voir le regroupement d'erreurs</a>
                }
                <span class="muted pick-hint"><wl-nav-icon name="filter" [size]="12" />Cliquer une valeur l'ajoute au filtre.</span>
              </div>

              @if (log.exceptionType) {
                <h3>Exception</h3>
                <div class="exc mono small">
                  <strong class="pick" tabindex="0" role="button" (click)="addFilter('exception', log.exceptionType)" (keydown.enter)="addFilter('exception', log.exceptionType)"
                          title="Ajouter ce type d'exception au filtre">{{ log.exceptionType }}</strong>: {{ log.exceptionMessage }}
                </div>
                @if (log.exceptionStack) {
                  <div class="copyable">
                    <pre class="stack">{{ log.exceptionStack }}</pre>
                    <button type="button" class="icon" (click)="copy(log.exceptionStack, 'Pile d’appels copiée')" title="Copier la pile d'appels" aria-label="Copier la pile d'appels">
                      <wl-nav-icon name="copy" [size]="13" />
                    </button>
                  </div>
                }
              }

              @if (crumbs().length) {
                <h3>Logs précédant le crash <span class="count">{{ crumbs().length }}</span></h3>
                <div class="crumbs mono">
                  @for (c of crumbs(); track $index) {
                    <div class="crumb-row" [title]="c.Category ?? ''">
                      <span class="muted">{{ c.Ts | time }}</span><wl-level [level]="crumbLevel(c.Level)" /><span class="crumb-msg">{{ c.Message }}</span>
                    </div>
                  }
                </div>
              }

              <h3>Contexte</h3>
              <table class="ctx">
                <tr><td>Service</td><td>
                  <span class="pick" tabindex="0" role="button" title="Ajouter au filtre" (click)="addFilter('service', log.service)" (keydown.enter)="addFilter('service', log.service)">{{ log.service }}</span>
                </td></tr>
                @if (log.version) {
                  <tr><td>Version</td><td>
                    <span class="pick" tabindex="0" role="button" title="Ajouter au filtre" (click)="addFilter('version', log.version)" (keydown.enter)="addFilter('version', log.version)">{{ log.version }}</span>
                  </td></tr>
                }
                @if (log.host) {
                  <tr><td>Hôte</td><td>
                    <span class="pick" tabindex="0" role="button" title="Ajouter au filtre" (click)="addFilter('host', log.host)" (keydown.enter)="addFilter('host', log.host)">{{ log.host }}</span>
                  </td></tr>
                }
                @if (log.env) {
                  <tr><td>Environnement</td><td>
                    <span class="env"><i [style.background]="envColor(log.env, log.service)"></i>
                      <span class="pick" tabindex="0" role="button" title="Ajouter au filtre" (click)="addFilter('env', log.env)" (keydown.enter)="addFilter('env', log.env)">{{ log.env }}</span>
                      @if (envLabel(log.env, log.service) !== log.env) { <span class="muted small" title="Environnement configuré">{{ envLabel(log.env, log.service) }}</span> }
                    </span>
                  </td></tr>
                }
                @if (log.category) {
                  <tr><td>Catégorie</td><td class="mono">
                    <span class="pick" tabindex="0" role="button" title="Ajouter au filtre" (click)="addFilter('category', log.category)" (keydown.enter)="addFilter('category', log.category)">{{ log.category }}</span>
                  </td></tr>
                }
                @if (log.traceId) {
                  <tr><td>Trace</td><td class="mono">
                    <span class="pick" tabindex="0" role="button" title="Logs de la même trace" (click)="addFilter('trace', log.traceId)" (keydown.enter)="addFilter('trace', log.traceId)">{{ log.traceId }}</span>
                    <wl-copy [text]="log.traceId" />
                  </td></tr>
                }
                @if (log.spanId) {
                  <tr><td>Span</td><td class="mono">{{ log.spanId }} <wl-copy [text]="log.spanId" /></td></tr>
                }
              </table>

              <h3>Attributs</h3>
              <wl-attributes [json]="log.attributes" [exclude]="['wolflog.breadcrumbs']" [pickable]="true" (pick)="addFilter($event.key, $event.value)" />

              <details class="res">
                <summary class="small muted"><wl-nav-icon name="chevron-right" [size]="12" class="chev" />Ressource (attributs de l'application)</summary>
                <wl-attributes [json]="log.resource" />
              </details>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    :host { flex: 1 1 0 !important; min-height: 0; }
    .searchbar { position: relative; display: flex; align-items: center; flex: 1; min-width: 320px; }
    .searchbar .search { flex: 1; padding-left: 35px; padding-right: 64px; }
    .s-icon { position: absolute; left: 12px; z-index: 1; color: var(--text-3); pointer-events: none; transition: color .25s, transform .4s var(--spring); }
    .searchbar:focus-within .s-icon { color: var(--accent); transform: scale(1.1); }
    .clear { position: absolute; right: 34px; z-index: 1; display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%;
      background: var(--surface-3); color: var(--text-2); cursor: pointer; animation: pop-in .3s var(--spring); transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .clear:hover { color: var(--text-1); background: var(--accent-soft); transform: rotate(90deg); }
    @keyframes pop-in { from { opacity: 0; transform: scale(.5); } }
    .shortcut { position: absolute; right: 8px; z-index: 1; pointer-events: none; transition: opacity .2s; }
    .searchbar:focus-within .shortcut { opacity: .35; }
    .levels button { display: inline-flex; align-items: center; gap: 6px; }
    .live-btn wl-nav-icon { transition: transform .35s var(--spring); }
    .live-btn:hover wl-nav-icon { transform: scale(1.18); }
    .btn.live-btn.on { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, var(--border)); background-color: color-mix(in srgb, var(--ok) 10%, transparent); }
    .chart-panel { padding: 4px 10px 0; }
    .chart-out { animation: chart-out .2s ease-in forwards; }
    @keyframes chart-out { to { opacity: 0; transform: translateY(-6px); } }
    .count-line { display: inline-flex; align-items: center; gap: 6px; }
    .count-line strong { color: var(--text-1); font-size: 14px; font-weight: 650; }
    .live-icon { flex: none; color: var(--ok); }
    .pill { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px; font: 11px var(--mono);
      color: var(--text-3); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .err { display: inline-flex; align-items: center; gap: 6px; }
    .export { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); }
    .chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font: 550 11.5px var(--sans);
      color: var(--accent); background: var(--accent-soft); border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
      transition: background-color .2s, transform .3s var(--spring); }
    .chip:hover { text-decoration: none; transform: translateY(-1px); background: color-mix(in srgb, var(--accent) 24%, transparent); }
    .chip:active { transform: scale(.95); }
    .split { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 14px; }
    .split.with-detail { grid-template-columns: minmax(0, 1fr) minmax(400px, 42%); }
    .results { display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .results .panel-head { gap: 12px; flex: none; flex-wrap: wrap; }
    .viewport { flex: 1; min-height: 120px; transition: opacity .25s; }
    .results.busy .viewport { opacity: .55; }
    .grow-skeleton { flex: 1; align-content: start; overflow: hidden; }
    .row { height: 26px; display: grid; grid-template-columns: 148px 36px 120px minmax(0, 1fr) 12px; align-items: center; gap: 12px;
      padding: 0 12px; border-bottom: 1px solid var(--border-soft); cursor: pointer; font-size: 12.5px; transition: background-color .12s; }
    .row::after {
      content: ''; width: 12px; height: 12px; color: var(--text-3); background: currentColor; opacity: 0; transform: translateX(-4px);
      -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='m9 6 6 6-6 6'/></svg>") center / contain no-repeat;
      mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='m9 6 6 6-6 6'/></svg>") center / contain no-repeat;
      transition: opacity .2s, transform .3s var(--spring); }
    .row[data-lvl='error'] { background: color-mix(in srgb, var(--danger) 5%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--danger) 55%, transparent); }
    .row[data-lvl='fatal'] { background: color-mix(in srgb, var(--crash) 8%, transparent); box-shadow: inset 2px 0 0 var(--crash); }
    .row:hover { background: var(--row-hover); }
    .row:hover::after { opacity: .8; transform: none; }
    .row.sel { background: var(--row-selected); box-shadow: inset 2px 0 0 var(--accent); }
    .row.sel::after { opacity: 1; transform: none; color: var(--accent); }
    .ts { color: var(--text-3); font-size: 12px; }
    .svc { color: var(--text-2); }
    .msg .tag { margin-right: 6px; }
    .hit { border-radius: 3px; color: var(--text-1); background: color-mix(in srgb, var(--warn) 28%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--warn) 40%, transparent); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 520px; margin: 6px auto 0; font-size: 12.5px; }
    .syntax code { padding: 1px 6px; margin: 0 2px; border-radius: 6px; background: var(--surface-3); color: var(--text-2); font-size: 11.5px; white-space: nowrap; }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .cta:empty { display: none; }
    .empty.waiting::before {
      -webkit-mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01'/></svg>");
      mask-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0M12 20h.01'/></svg>");
      background: linear-gradient(135deg, var(--ok), var(--accent-3)); }
    .detail { display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .detail .panel-head { flex: none; gap: 8px; padding: 10px 10px 10px 16px; }
    .svc-name { min-width: 0; color: var(--text-2); }
    .detail-in { animation: detail-in .38s var(--ease) backwards; }
    .detail-out { animation: detail-out .2s ease-in forwards; }
    @keyframes detail-in { from { opacity: 0; transform: translateX(24px); } }
    @keyframes detail-out { to { opacity: 0; transform: translateX(24px); } }
    @media (min-width: 1201px) { .split > .detail-out { position: absolute; top: 0; right: 0; bottom: 0; width: 42%; min-width: 400px; } }
    .btn.square { width: 30px; height: 30px; padding: 0; justify-content: center; }
    .detail-body { overflow: auto; padding: 12px; min-height: 0; }
    .detail-body > * + * { margin-top: 10px; }
    .copyable { position: relative; }
    .copyable > .icon { position: absolute; top: 6px; right: 6px; }
    .copyable > pre.stack { padding-right: 38px; }
    .body { margin: 0; padding: 10px 38px 10px 12px; max-height: 320px; overflow: auto; border-radius: var(--radius-sm); background: var(--code-bg);
      border: 1px solid var(--border-soft); white-space: pre-wrap; overflow-wrap: anywhere; font: 12.5px/1.55 var(--mono); color: var(--text-1); }
    .icon { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 8px; color: var(--text-3);
      background: var(--surface-solid); cursor: pointer; opacity: .75; transition: color .2s, background-color .2s, opacity .2s, transform .3s var(--spring); }
    .copyable:hover > .icon, .icon:focus-visible { opacity: 1; }
    .icon:hover { color: var(--accent); background: var(--accent-soft); }
    .icon:active { transform: scale(.86); }
    .links { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .links .btn { height: 28px; }
    .links .btn wl-nav-icon { transition: transform .4s var(--spring); }
    .links .btn:hover wl-nav-icon { transform: scale(1.12) rotate(-8deg); }
    .pick-hint { display: inline-flex; align-items: center; gap: 5px; }
    h3 { display: flex; align-items: center; gap: 6px; margin-top: 16px !important; }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/17px var(--mono); text-align: center; letter-spacing: 0; text-transform: none;
      color: var(--text-2); background: var(--surface-3); }
    .exc { overflow-wrap: anywhere; }
    .exc strong { color: var(--danger); }
    .crumbs { font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; max-height: 220px; overflow: auto; }
    .crumb-row { display: grid; grid-template-columns: 84px 30px minmax(0, 1fr); gap: 8px; align-items: center; padding: 2px 4px; border-radius: 6px; }
    .crumb-row:hover { background: var(--row-hover); }
    .crumb-msg { overflow-wrap: anywhere; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { padding: 3px 16px 3px 0; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--border-soft); }
    .ctx tr:last-child td { border-bottom: 0; }
    .ctx td:first-child { color: var(--text-3); white-space: nowrap; width: 110px; }
    .ctx .pick { padding: 0 2px; }
    .ctx .pick::after {
      content: ''; display: inline-block; width: 10px; height: 10px; margin-left: 5px; vertical-align: -1px; background: currentColor; opacity: 0; transform: scale(.6);
      -webkit-mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 5h18l-7 8v6l-4 2v-8Z'/></svg>") center / contain no-repeat;
      mask: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M3 5h18l-7 8v6l-4 2v-8Z'/></svg>") center / contain no-repeat;
      transition: opacity .2s, transform .3s var(--spring); }
    .ctx .pick:hover::after, .ctx .pick:focus-visible::after { opacity: .75; transform: none; }
    .env { display: inline-flex; align-items: center; gap: 7px; }
    .env i { width: 8px; height: 8px; border-radius: 50%; }
    .res summary { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; cursor: pointer; list-style: none; transition: color .2s; }
    .res summary::-webkit-details-marker { display: none; }
    .res summary:hover { color: var(--text-1); }
    .res .chev { transition: transform .35s var(--spring); }
    .res[open] .chev { transform: rotate(90deg); color: var(--accent); }
    .res[open] summary { margin-bottom: 8px; }
    .res::details-content { opacity: 0; transition: opacity .3s var(--ease), content-visibility .3s allow-discrete; }
    .res[open]::details-content { opacity: 1; }
    @media (max-width: 640px) {
      .row { height: 46px; grid-template-columns: auto auto minmax(0, 1fr); grid-template-rows: 18px 18px; column-gap: 8px; row-gap: 2px; padding: 4px 10px; }
      .row::after { display: none; }
      .row .ts { font-size: 11px; }
      .row .svc { font-size: 11.5px; }
      .row .msg { grid-column: 1 / -1; }
    }
    @media (max-width: 1200px) {
      .split.with-detail { grid-template-columns: minmax(0, 1fr); }
      .detail { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100%); z-index: 60; border-radius: 0; box-shadow: var(--shadow-pop); }
      .hide-narrow { display: none; }
    }
  `,
})
export class LogsPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly state = inject(AppState);
  /** Couleur et libellé des environnements configurés (selon l'application de la ligne). */
  protected readonly envColor = envColor;
  protected readonly envLabel = envLabel;

  /** Paramètres d'URL (liens partageables). */
  readonly q = input<string>('');
  readonly levelParam = input<string>('', { alias: 'level' });
  readonly level = signal('');

  protected readonly levelFilters = LEVEL_FILTERS;
  protected readonly rowHeight = ROW_HEIGHT;
  protected query = '';
  protected readonly appliedQuery = signal('');
  protected readonly items = signal<LogItem[]>([]);
  protected readonly selected = signal<LogItem | null>(null);
  protected readonly histogram = signal<Histogram | null>(null);
  protected readonly stats = signal<{ elapsedMs: number } | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly live = signal(false);
  private nextBefore: string | null = null;
  private loadingMore = false;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private subs: Subscription[] = [];
  private source: EventSource | null = null;
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  /** La recherche courante, sous forme de panneau de tableau de bord. */
  protected readonly panelForSearch = computed<Panel>(() => {
    const q = [this.appliedQuery(), this.level() ? 'level:' + this.level() : ''].filter(Boolean).join(' ');
    return {
      id: '', title: q ? `Logs : ${q}` : 'Logs par niveau', type: 'custom', width: 6, height: 'm',
      dataSource: 'logs', query: q || null, aggregate: 'count', groupBy: 'level', view: 'bars', limit: 10,
      service: this.state.service() || null,
    };
  });

  protected readonly searchParams = computed(() => ({ q: this.appliedQuery(), level: this.level() }));

  protected applySaved(p: Record<string, string>) {
    this.query = p['q'] ?? '';
    this.level.set(p['level'] ?? '');
    this.searchNow();
  }

  protected readonly session = inject(Session);

  protected alertParams() {
    const filter = [this.appliedQuery(), this.level() ? 'level:' + this.level() : ''].filter(Boolean).join(' ');
    const p: Record<string, string> = { kind: 'query', source: 'logs', agg: 'count' };
    if (filter) p['filter'] = filter;
    if (this.state.service()) p['service'] = this.state.service();
    return p;
  }

  protected exportUrl(format: 'csv' | 'json') {
    return this.api.exportUrl('logs', format, {
      ...this.state.range(), q: this.appliedQuery(), level: this.level(), service: this.state.service(), env: this.state.env(),
    });
  }

  protected exported(format: string) {
    this.toasts.info(`Export ${format} en cours de téléchargement (jusqu'à 10 000 logs)`, 'download');
  }

  protected copy(text: string, done: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.toasts.ok(done, 'copy'),
      () => this.toasts.error('Copie impossible : accès au presse-papiers refusé.'),
    );
  }

  /** Date et heure complètes, en infobulle des heures abrégées. */
  protected fullDate(iso: string) {
    return FULL_DATE.format(new Date(iso));
  }

  /** Période relative de moins de 24 h : on propose de l'élargir. */
  protected readonly canWiden = computed(() => this.state.isRelative() && ['5m', '15m', '1h', '6h'].includes(this.state.from()));

  /**
   * Termes libres de la recherche, surlignés dans les messages : mots et « texte exact », sans les filtres
   * clé:valeur, les exclusions (-mot) ni les opérateurs. Null quand il n'y a rien à surligner.
   */
  private readonly highlight = computed(() => {
    const terms: string[] = [];
    for (const m of this.appliedQuery().matchAll(/(-?)(?:"([^"]+)"|(\S+))/g)) {
      const word = m[3];
      if (m[1] || (word && (word.includes(':') || /^(AND|OR|NOT)$/.test(word)))) continue;
      const term = (m[2] ?? word ?? '').replace(/\*/g, '').trim();
      if (term.length >= 2) terms.push(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    return terms.length ? new RegExp(`(${terms.join('|')})`, 'gi') : null;
  });
  private readonly partsCache = new Map<string, Part[]>();
  private partsFor: RegExp | null = null;

  /** Message découpé en morceaux, les termes recherchés à part (mémorisé : appelé pour chaque ligne affichée). */
  protected parts(text: string): Part[] {
    const re = this.highlight();
    if (re !== this.partsFor) {
      this.partsCache.clear();
      this.partsFor = re;
    }
    let parts = this.partsCache.get(text);
    if (!parts) {
      parts = re ? splitHits(text, re) : [{ text, hit: false }];
      if (this.partsCache.size > 2000) this.partsCache.clear();
      this.partsCache.set(text, parts);
    }
    return parts;
  }

  /** Logs précédant le crash du log ouvert (analysés une fois par sélection). */
  protected readonly crumbs = computed(() => {
    const log = this.selected();
    return log ? this.breadcrumbs(log) : [];
  });

  protected crumbLevel(level: string | null | undefined) {
    const l = (level ?? '').toLowerCase();
    return CRUMB_LEVELS[l] ?? l;
  }

  protected readonly total = computed(() => {
    const h = this.histogram();
    return h ? h.buckets.reduce((s, b) => s + b.trace + b.debug + b.info + b.warn + b.error + b.fatal, 0) : this.items().length;
  });
  protected readonly histTimes = computed(() => this.histogram()?.buckets.map((b) => b.t) ?? []);
  protected readonly histSeries = computed<ChartSeries[]>(() => {
    const buckets = this.histogram()?.buckets ?? [];
    return LEVELS.map((l) => ({ label: l, color: LEVEL_COLORS[l], values: buckets.map((b) => b[l]) }));
  });

  constructor() {
    // Paramètres d'URL → état initial.
    effect(() => {
      const q = this.q();
      const level = this.levelParam();
      untracked(() => {
        this.query = q ?? '';
        this.appliedQuery.set(this.query.trim());
        if (level) this.level.set(level);
      });
    });
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.service();
      this.state.env();
      this.appliedQuery();
      this.level();
      untracked(() => (this.live() ? this.startLive() : this.load()));
    });
  }

  protected trackLog = (_: number, l: LogItem) => l.ts + l.body.length + l.service;

  /** Recherche pendant la frappe (petit délai pour ne pas lancer une requête par touche). */
  protected typed(value: string) {
    this.query = value;
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.searchNow(), 300);
  }

  protected searchNow() {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    const q = this.query.trim();
    if (q === this.appliedQuery()) return;
    this.appliedQuery.set(q);
    this.router.navigate([], { queryParams: { q: q || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected clear() {
    this.query = '';
    this.searchNow();
  }

  addFilter(key: string, value: string) {
    const token = /\s/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
    if (!this.query.includes(token)) this.query = (this.query + ' ' + token).trim();
    this.searchNow();
  }

  /** "/" : recherche ; ↑ ↓ : log précédent / suivant ; Échap : fermer le détail. */
  protected onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      this.searchBox()?.nativeElement.focus();
    } else if (e.key === 'Escape') {
      if (typing) (target as HTMLInputElement).blur();
      else this.selected.set(null);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing && this.items().length) {
      e.preventDefault();
      const list = this.items();
      const current = this.selected() ? list.indexOf(this.selected()!) : -1;
      const next = Math.max(0, Math.min(list.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
      this.selected.set(list[next]);
      this.ensureVisible(next);
    }
  }

  private ensureVisible(index: number) {
    const vp = this.viewport();
    if (!vp) return;
    const top = vp.measureScrollOffset('top');
    const height = vp.getViewportSize();
    const y = index * ROW_HEIGHT;
    if (y < top) vp.scrollToOffset(y);
    else if (y + ROW_HEIGHT > top + height) vp.scrollToOffset(y + ROW_HEIGHT - height);
  }

  zoom(r: { from: Date; to: Date }) {
    this.state.setAbsolute(r.from, r.to);
  }

  select(log: LogItem) {
    this.selected.set(this.selected() === log ? null : log);
  }

  breadcrumbs(log: LogItem): { Ts: string; Level: string; Category?: string | null; Message: string }[] {
    const raw = parseJson(log.attributes)['wolflog.breadcrumbs'];
    if (typeof raw !== 'string') return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  private load() {
    this.subs.forEach((s) => s.unsubscribe());
    this.loading.set(true);
    this.error.set('');
    this.nextBefore = null;
    const r = this.state.range();
    const q = this.appliedQuery();
    const level = this.level();
    const service = this.state.service();
    this.subs = [
      this.api.logs(r, q, level, service).subscribe({
        next: (page) => {
          // On garde le log ouvert s'il fait encore partie des résultats (actualisation automatique).
          const open = this.selected();
          this.items.set(page.items);
          this.selected.set(open ? (page.items.find((i) => i.ts === open.ts && i.body === open.body) ?? null) : null);
          this.nextBefore = page.nextBefore;
          this.stats.set(page);
          this.loading.set(false);
          if (!open) this.viewport()?.scrollToIndex(0);
        },
        error: (e) => {
          this.loading.set(false);
          this.error.set(e?.status === 400 ? 'Requête invalide.' : 'Erreur lors de la recherche.');
        },
      }),
      this.api.logHistogram(r, q, level, service).subscribe({ next: (h) => this.histogram.set(h), error: () => {} }),
    ];
  }

  onScroll(index: number) {
    if (this.live() || this.loadingMore || !this.nextBefore) return;
    if (index + 60 < this.items().length) return;
    this.loadingMore = true;
    this.api.logs(this.state.range(), this.appliedQuery(), this.level(), this.state.service(), this.nextBefore).subscribe({
      next: (page) => {
        this.items.update((list) => [...list, ...page.items]);
        this.nextBefore = page.nextBefore;
        this.loadingMore = false;
      },
      error: () => (this.loadingMore = false),
    });
  }

  toggleLive() {
    this.live.update((v) => !v);
    if (this.live()) this.startLive();
    else {
      this.stopLive();
      this.load();
    }
  }

  private startLive() {
    this.stopLive();
    this.items.set([]);
    this.selected.set(null);
    const params = new URLSearchParams();
    if (this.appliedQuery()) params.set('q', this.appliedQuery());
    if (this.level()) params.set('level', this.level());
    if (this.state.service()) params.set('service', this.state.service());
    if (this.state.env()) params.set('env', this.state.env());
    this.source = new EventSource('/api/logs/tail?' + params.toString(), { withCredentials: true });
    this.source.onmessage = (ev) => {
      const batch = JSON.parse(ev.data) as LogItem[];
      batch.reverse();
      this.items.update((list) => [...batch, ...list].slice(0, MAX_LIVE));
    };
    this.source.onerror = () => this.error.set(this.source?.readyState === EventSource.CLOSED ? 'Flux interrompu.' : '');
  }

  private stopLive() {
    this.source?.close();
    this.source = null;
  }

  ngOnDestroy() {
    this.stopLive();
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.subs.forEach((s) => s.unsubscribe());
  }
}
