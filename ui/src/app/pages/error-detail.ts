import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { ErrorDetail, ErrorOccurrence, Person } from '../core/models';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { parseJson } from '../core/format';
import { Chart, ChartSeries } from '../shared/chart';
import { Attributes } from '../shared/attributes';
import { CopyText } from '../shared/copy-text';
import { CountUp } from '../shared/count-up';
import { ErrorStatusTag } from '../shared/error-status-tag';
import { LevelBadge } from '../shared/level-badge';
import { NavIcon } from '../shared/nav-icon';
import { RichOption, envColor, envLabel } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

/** Ligne de pile d'appels : en-tête d'exception, exception interne, cadre de votre code ou du framework, séparateur, lignes repliées. */
interface StackLine {
  text: string;
  /** Emplacement dans le code source (« in Fichier.cs:line 42 », « (fichier.js:10:5) »), mis en valeur. */
  loc: string;
  kind: 'head' | 'inner' | 'frame' | 'fw' | 'sep' | 'text' | 'fold';
}

/** Cadres du framework et des bibliothèques courantes (.NET, Java, Node, Python), repliables. */
const FRAMEWORK = /^at (?:async )?(?:System|Microsoft|Npgsql|Grpc|Polly|Newtonsoft|Swashbuckle|Serilog|NLog|Castle|StackExchange|MongoDB|Dapper|Hangfire|MediatR|AutoMapper|FluentValidation|OpenTelemetry|Azure|Amazon|RabbitMQ|Confluent|Quartz|java|javax|jdk|sun|kotlin|org\.springframework|org\.apache)\.|node:internal|node_modules|site-packages|lambda_method/;
const LOCATION = /( in .+:line \d+|\s\([^()]*:\d+(?::\d+)?\))$/;

/** Niveaux .NET (LogLevel) des logs précédant un crash → niveaux de Wolflog. */
const CRUMB_LEVELS: Record<string, string> = {
  trace: 'trace', verbose: 'trace', debug: 'debug', information: 'info', info: 'info', warning: 'warn', warn: 'warn', error: 'error', critical: 'fatal', fatal: 'fatal',
};

function parseStack(stack: string): StackLine[] {
  const lines = stack.replace(/\s+$/, '').split(/\r?\n/);
  let seenFrame = false;
  return lines.map((raw): StackLine => {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (/^---.*---$/.test(t)) return { text: line, loc: '', kind: 'sep' };
    if (/^-{2,3}>/.test(t)) return { text: line, loc: '', kind: 'inner' };
    if (t.startsWith('at ') || t.startsWith('File "')) {
      seenFrame = true;
      const loc = LOCATION.exec(line)?.[1] ?? '';
      return { text: loc ? line.slice(0, line.length - loc.length) : line, loc, kind: FRAMEWORK.test(t) ? 'fw' : 'frame' };
    }
    return { text: line, loc: '', kind: seenFrame ? 'text' : 'head' };
  });
}

@Component({
  selector: 'wl-error-detail',
  imports: [RouterLink, Chart, Attributes, ErrorStatusTag, NumPipe, AgoPipe, TimePipe, NavIcon, CountUp, CopyText, LevelBadge, RichOption, Skeleton],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <a routerLink="/errors" class="crumb small"><wl-nav-icon name="errors" [size]="13" />Erreurs</a>
        <wl-nav-icon name="chevron-right" [size]="12" class="sep" />
        @if (detail(); as d) {
          <h1 class="mono ellipsis" [title]="d.group.exceptionType">{{ d.group.exceptionType }}</h1>
          @if (d.group.crashes) { <span class="tag crash">crash</span> }
          <wl-error-status [status]="d.group.status" />
          <span class="spacer"></span>
          <a class="btn" routerLink="/logs" [queryParams]="{ q: 'fingerprint:' + d.group.fingerprint }" title="Tous les logs de cette erreur"><wl-nav-icon name="logs" [size]="14" />Logs</a>
          @if (session.canEdit()) {
            <a class="btn" routerLink="/alerts/new" [queryParams]="{ kind: 'query', source: 'logs', agg: 'count', filter: 'fingerprint:' + d.group.fingerprint, name: d.group.exceptionType + ' se reproduit' }"
               title="Être prévenu à chaque nouvelle occurrence"><wl-nav-icon name="bell" [size]="14" />M'alerter</a>
          }
          @if (d.latest?.traceId && session.can(['traces', 'requests'])) {
            <a class="btn" [routerLink]="['/traces', d.latest!.traceId]" [queryParams]="{ around: d.latest!.ts }" title="Trace de la dernière occurrence">
              <wl-nav-icon name="traces" [size]="14" />Dernière trace
            </a>
          }
        } @else if (loading()) {
          <i class="skeleton title-sk"></i>
        }
      </div>

      @if (detail(); as d) {
        <div class="panel triage">
          <div class="field">
            <span class="label"><wl-nav-icon name="target" [size]="12" />Statut</span>
            @if (session.canEdit()) {
              <div class="seg status-seg">
                <button [class.on]="d.group.status === 'open' || d.group.status === 'regressed'" (click)="setStatus('open')"
                        [title]="d.group.status === 'regressed' ? 'Réapparue après avoir été marquée résolue' : 'Nouvelle ou en cours de traitement'">
                  <wl-nav-icon [name]="d.group.status === 'regressed' ? 'refresh' : 'inbox'" [size]="13" />À traiter
                </button>
                <button [class.on]="d.group.status === 'resolved'" (click)="setStatus('resolved')" title="Si l'erreur se reproduit, elle repassera « réapparue »"><wl-nav-icon name="ok" [size]="13" />Résolue</button>
                <button [class.on]="d.group.status === 'ignored'" (click)="setStatus('ignored')" title="Masquée de la vue d'ensemble et de la liste à traiter"><wl-nav-icon name="mute" [size]="13" />Ignorée</button>
              </div>
            } @else {
              <strong>{{ statusLabel(d.group.status) }}</strong>
            }
          </div>
          <div class="field">
            <span class="label"><wl-nav-icon name="account" [size]="12" />Assignée à</span>
            @if (session.canEdit()) {
              <select (change)="assign($any($event.target).value)" aria-label="Personne assignée">
                <option value="" [selected]="!d.group.assignedTo" wlOpt="Personne" icon="users" tone="muted" desc="Non assignée"></option>
                @if (session.me()?.user; as me) {
                  <option [value]="me" [selected]="d.group.assignedTo === me" wlOpt="Moi" icon="account" [desc]="personName(me)"></option>
                }
                @for (p of people(); track p.username) {
                  @if (p.username !== session.me()?.user) {
                    <option [value]="p.username" [selected]="d.group.assignedTo === p.username" [wlOpt]="p.displayName" avatar
                            [desc]="p.username !== p.displayName ? p.username : null"></option>
                  }
                }
              </select>
            } @else {
              <strong>{{ personName(d.group.assignedTo) || 'Personne' }}</strong>
            }
          </div>
          <div class="field note">
            <span class="label"><wl-nav-icon name="pencil" [size]="12" />Note</span>
            @if (session.canEdit()) {
              <input [value]="d.state?.note ?? ''" (change)="saveNote($any($event.target).value)" (keydown.enter)="$any($event.target).blur()"
                     placeholder="Cause, ticket, correctif prévu… (Entrée pour enregistrer)" aria-label="Note" />
            } @else {
              <strong>{{ d.state?.note || '–' }}</strong>
            }
          </div>
          @if (d.state?.history?.length) {
            <button type="button" class="field history" [class.open]="showHistory()" (click)="showHistory.set(!showHistory())" [attr.aria-expanded]="showHistory()"
                    [title]="showHistory() ? 'Masquer l’historique' : historyText()">
              <span class="label"><wl-nav-icon name="clock" [size]="12" />Dernière action<wl-nav-icon name="chevron" [size]="11" class="chev" /></span>
              <strong class="small">{{ personName(d.state!.history[0].by) || 'Quelqu’un' }} {{ d.state!.history[0].action }}, {{ d.state!.history[0].at | ago }}</strong>
            </button>
          }
        </div>

        @if (showHistory() && d.state?.history?.length) {
          <section class="panel history-panel" animate.leave="hist-out">
            <div class="panel-head">
              <h2>Historique</h2><span class="count">{{ d.state!.history.length }}</span>
              <span class="spacer"></span>
              <button class="btn ghost square" (click)="showHistory.set(false)" title="Fermer l’historique" aria-label="Fermer l’historique"><wl-nav-icon name="close" [size]="14" /></button>
            </div>
            <ol class="timeline">
              @for (h of d.state!.history; track $index) {
                <li [style.--i]="$index">
                  <i class="avatar">{{ initials(personName(h.by) || '?') }}</i>
                  <span><strong>{{ personName(h.by) || 'Quelqu’un' }}</strong> {{ h.action }}</span>
                  <span class="muted small when" [title]="fullDate(h.at)">{{ h.at | ago }}</span>
                </li>
              }
            </ol>
          </section>
        }

        <div class="panel facts">
          @if (d.group.message) {
            <div class="msg">
              <wl-nav-icon name="warning" [size]="15" class="msg-icon" />
              <span class="mono">{{ d.group.message }}</span>
              <button type="button" class="icon" (click)="copy(d.group.message, 'Message copié')" title="Copier le message" aria-label="Copier le message"><wl-nav-icon name="copy" [size]="13" /></button>
            </div>
          }
          <div><span>Occurrences</span><strong class="big" [wlCountUp]="d.group.count | num"></strong></div>
          <div><span>Dont crashs</span><strong class="big" [class.crash]="d.group.crashes" [wlCountUp]="d.group.crashes | num"></strong></div>
          <div [title]="fullDate(d.group.firstSeen)"><span>Première</span><strong>{{ d.group.firstSeen | ago }}</strong></div>
          <div [title]="fullDate(d.group.lastSeen)"><span>Dernière</span><strong>{{ d.group.lastSeen | ago }}</strong></div>
          <div><span>Service</span><strong>{{ d.group.service }}@if (d.group.services > 1) { <span class="more" [title]="'Touche ' + d.group.services + ' services'">+{{ d.group.services - 1 }}</span> }</strong></div>
          @if (versions().length) {
            <div class="versions">
              <span>Versions touchées</span>
              <div class="chips">
                @for (v of versions(); track v; let last = $last) {
                  <span class="chip mono" [class.latest]="last" [title]="last ? 'Dernière version touchée' : ''">{{ v }}</span>
                }
              </div>
            </div>
          }
          <div class="fp"><span>Empreinte</span><strong class="mono small" [title]="d.group.fingerprint">{{ d.group.fingerprint.slice(0, 10) }}… <wl-copy [text]="d.group.fingerprint" /></strong></div>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h2>Occurrences dans le temps</h2>
            <span class="spacer"></span>
            <span class="muted small zoom-hint"><wl-nav-icon name="cursor" [size]="12" />Sélectionnez une zone pour zoomer</span>
          </div>
          <div class="panel-body">
            <wl-chart [times]="times()" [series]="series()" kind="bars" [height]="100" [legend]="false" (rangeSelect)="state.setAbsolute($event.from, $event.to)" />
          </div>
        </section>

        @if (d.latest; as l) {
          <div class="cols">
            <section class="panel">
              <div class="panel-head">
                <h2>Pile d'appels</h2>
                <span class="muted small" [title]="fullDate(l.ts)">dernière occurrence, {{ l.ts | time: true }}</span>
                <span class="spacer"></span>
                @if (frameworkLines()) {
                  <label class="check small" title="Replier les lignes du framework et des bibliothèques pour ne garder que votre code">
                    <input type="checkbox" class="switch" [checked]="hideFramework()" (change)="hideFramework.set(!hideFramework())" />Mon code
                  </label>
                }
                @if (l.exceptionStack) {
                  <button class="btn ghost square" (click)="copy(l.exceptionStack, 'Pile d’appels copiée')" title="Copier la pile d'appels" aria-label="Copier la pile d'appels">
                    <wl-nav-icon name="copy" [size]="14" />
                  </button>
                }
              </div>
              <div class="panel-body">
                @if (l.exceptionStack) {
                  <div class="trace">
                    @for (ln of stackLines(); track $index) {
                      @if (ln.kind === 'fold') {
                        <button type="button" class="fold" (click)="hideFramework.set(false)" title="Afficher toute la pile d'appels"><wl-nav-icon name="layers" [size]="12" />{{ ln.text }}</button>
                      } @else {
                        <div class="ln" [class]="ln.kind">{{ ln.text }}@if (ln.loc) {<span class="loc">{{ ln.loc }}</span>}</div>
                      }
                    }
                  </div>
                } @else {
                  <p class="note"><wl-nav-icon name="info" [size]="14" />
                    <span>Pas de pile d'appels : le processus s'est arrêté sans passer par un gestionnaire d'exception.
                      Les logs émis juste avant l'arrêt sont listés à côté.</span></p>
                }
              </div>
            </section>
            <section class="panel">
              <div class="panel-head"><h2>Contexte</h2></div>
              <div class="panel-body stack-y">
                <table class="ctx">
                  <tr><td>Hôte</td><td>{{ l.host ?? '–' }}</td></tr>
                  <tr><td>Version</td><td class="mono">{{ l.version ?? '–' }}</td></tr>
                  <tr><td>Environnement</td><td>@if (l.env) { <span class="env"><i [style.background]="envColor(l.env, l.service)"></i>{{ l.env }}@if (envLabel(l.env, l.service) !== l.env) { <span class="muted"> · {{ envLabel(l.env, l.service) }}</span> }</span> } @else { – }</td></tr>
                  <tr><td>Catégorie</td><td class="mono">{{ l.category ?? '–' }}</td></tr>
                  <tr><td>Message</td><td class="mono">{{ l.body }}</td></tr>
                </table>
                @if (breadcrumbs().length) {
                  <h3>Logs précédant le crash <span class="count">{{ breadcrumbs().length }}</span></h3>
                  <div class="crumbs mono">
                    @for (c of breadcrumbs(); track $index) {
                      <div class="crumb-row" [title]="c.Category ?? ''">
                        <span class="muted">{{ c.Ts | time }}</span><wl-level [level]="crumbLevel(c.Level)" /><span class="crumb-msg">{{ c.Message }}</span>
                      </div>
                    }
                  </div>
                }
                <h3>Attributs</h3>
                <wl-attributes [json]="l.attributes" [exclude]="['wolflog.breadcrumbs']" />
              </div>
            </section>
          </div>
        }

        <section class="panel">
          <div class="panel-head"><h2>Occurrences récentes</h2><span class="count">{{ d.occurrences.length }}</span></div>
          @if (d.occurrences.length) {
            <table class="list">
              <thead><tr><th>Date</th><th>Service</th><th>Hôte</th><th>Version</th><th>Message</th><th class="go"></th></tr></thead>
              <tbody>
                @for (o of d.occurrences; track $index) {
                  <tr [class.click]="!!o.traceId" (click)="openTrace(o)">
                    <td class="mono small nowrap" [title]="fullDate(o.ts)">{{ o.ts | time: true }}</td>
                    <td class="nowrap">{{ o.service }}</td>
                    <td class="nowrap">{{ o.host ?? '–' }}</td>
                    <td class="nowrap mono small">{{ o.version ?? '–' }}</td>
                    <td class="m ellipsis" [title]="o.message ?? ''">@if (o.isCrash) { <span class="tag crash">crash</span> } {{ o.message }}</td>
                    <td class="go nowrap">
                      @if (o.traceId && session.can(['traces', 'requests'])) {
                        <a class="trace-link" [routerLink]="['/traces', o.traceId]" [queryParams]="{ around: o.ts }" (click)="$event.stopPropagation()" title="Ouvrir la trace de cette occurrence">
                          <wl-nav-icon name="traces" [size]="13" />trace<wl-nav-icon name="chevron-right" [size]="13" class="chev" />
                        </a>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty small">Aucune occurrence récente à afficher.</div>
          }
        </section>
      } @else if (!loading()) {
        <div class="panel empty">
          <p class="lead-text">Aucune occurrence de cette erreur sur la période choisie.</p>
          <p class="hint">Elle a peut-être eu lieu plus tôt : élargissez la période pour la retrouver.</p>
          <div class="cta">
            @if (canWiden()) { <button class="btn" (click)="state.setRelative('30d')"><wl-nav-icon name="calendar" [size]="14" />Élargir à 30 jours</button> }
            <a class="btn ghost" routerLink="/errors"><wl-nav-icon name="errors" [size]="14" />Retour aux erreurs</a>
          </div>
        </div>
      } @else {
        <div class="panel"><wl-skeleton [rows]="3" /></div>
        <div class="panel"><wl-skeleton [rows]="6" /></div>
      }
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); transition: color .2s; }
    .crumb:hover { color: var(--accent); text-decoration: none; }
    .crumb wl-nav-icon { transition: transform .4s var(--spring); }
    .crumb:hover wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .sep { color: var(--text-3); }
    h1 { max-width: 50vw; }
    .title-sk { width: 280px; height: 22px; }
    .page-head .btn wl-nav-icon { transition: transform .4s var(--spring); }
    .page-head .btn:hover wl-nav-icon { transform: scale(1.12) rotate(-8deg); }
    .triage { display: flex; flex-wrap: wrap; align-items: stretch; }
    .triage .field { display: grid; gap: 6px; align-content: start; padding: 10px 16px; border-right: 1px solid var(--border-soft); }
    .triage .field:last-child { border-right: 0; }
    .label { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .field:focus-within .label { color: var(--accent); }
    .status-seg button { display: inline-flex; align-items: center; gap: 6px; }
    .status-seg wl-nav-icon { transition: transform .4s var(--spring); }
    .status-seg button.on wl-nav-icon { color: var(--accent); }
    .status-seg button:hover wl-nav-icon { transform: scale(1.15); }
    .triage .note { flex: 1; min-width: 220px; }
    .triage .note input { width: 100%; }
    .triage select { min-width: 180px; }
    .history { max-width: 340px; border: 0; border-right: 0; background: none; color: var(--text-1); font: inherit; text-align: left; cursor: pointer;
      border-radius: 0 var(--radius) var(--radius) 0; transition: background-color .2s; }
    .history:hover { background: var(--row-hover); }
    .history .chev { transition: transform .4s var(--spring); }
    .history.open .chev { transform: rotate(180deg); color: var(--accent); }
    .history-panel .panel-head { padding: 8px 12px 8px 16px; }
    .hist-out { animation: hist-out .2s ease-in forwards; }
    @keyframes hist-out { to { opacity: 0; transform: translateY(-8px); } }
    .timeline { list-style: none; margin: 0; padding: 8px 16px 12px; display: grid; gap: 2px; max-height: 260px; overflow: auto; }
    .timeline li { position: relative; display: flex; align-items: center; gap: 10px; padding: 5px 0; font-size: 12.5px;
      animation: item-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 12) * 30ms + 80ms); }
    .timeline li:not(:last-child)::after { content: ''; position: absolute; left: 10px; top: 27px; bottom: -7px; width: 1px; background: var(--border); }
    .timeline .when { margin-left: auto; white-space: nowrap; }
    @keyframes item-in { from { opacity: 0; transform: translateX(-6px); } }
    .avatar { flex: none; display: inline-grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; font: 700 8.5px/1 var(--sans); font-style: normal;
      color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: inset 0 1px 0 var(--highlight); }
    .count { min-width: 18px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/17px var(--mono); text-align: center; letter-spacing: 0; text-transform: none;
      color: var(--text-2); background: var(--surface-3); }
    wl-error-status { margin-left: 2px; }
    .facts { display: flex; flex-wrap: wrap; }
    .facts > div { display: grid; gap: 2px; align-content: start; padding: 10px 16px; border-right: 1px solid var(--border-soft); }
    .facts > div:last-child { border-right: 0; }
    .facts > div > span { font-size: 11.5px; color: var(--text-3); }
    .facts strong { font-weight: 600; }
    .facts strong.big { font-size: 18px; letter-spacing: -.01em; }
    .facts strong.crash { color: var(--crash); }
    .facts .msg { flex: 1 1 100%; display: flex; align-items: flex-start; gap: 10px; border-right: 0; border-bottom: 1px solid var(--border-soft);
      padding: 12px 12px 12px 16px; color: var(--text-1); font-size: 12.5px; }
    .msg .mono { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .msg-icon { margin-top: 1px; color: var(--danger); }
    .more { margin-left: 6px; padding: 0 6px; border-radius: 999px; font: 600 10.5px/16px var(--mono); color: var(--text-2); background: var(--surface-3); }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--text-2); background: var(--surface-3); }
    .chip.latest { color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent); }
    .facts .fp { margin-left: auto; }
    .zoom-hint { display: inline-flex; align-items: center; gap: 6px; }
    .icon { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 7px; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s, transform .3s var(--spring); }
    .icon:hover { color: var(--accent); background: var(--accent-soft); }
    .icon:active { transform: scale(.86); }
    .btn.square { width: 30px; height: 30px; padding: 0; justify-content: center; }
    .trace { margin: 0; padding: 12px 14px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: auto;
      font: 12px/1.6 var(--mono); color: var(--text-2); max-height: 440px; }
    .ln { white-space: pre-wrap; word-break: break-word; }
    .ln.head { color: var(--danger); font-weight: 600; }
    .ln.inner { color: var(--warn); font-weight: 600; }
    .ln.frame { color: var(--text-1); }
    .ln.fw { color: var(--text-3); }
    .ln.sep { color: var(--text-3); font-style: italic; opacity: .8; }
    .loc { color: var(--accent-3); }
    .ln.fw .loc { color: inherit; }
    .fold { display: flex; align-items: center; gap: 6px; width: 100%; margin: 2px 0; padding: 1px 8px; border: 1px dashed var(--border); border-radius: 7px;
      background: none; color: var(--text-3); font: 11.5px var(--mono); text-align: left; cursor: pointer; transition: color .2s, border-color .2s, background-color .2s; }
    .fold:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: var(--accent-soft); }
    .note { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 12px; color: var(--text-3); }
    .note wl-nav-icon { margin-top: 2px; color: var(--accent); }
    .stack-y > * + * { margin-top: 8px; }
    .ctx { font-size: 12px; border-collapse: collapse; width: 100%; table-layout: fixed; }
    .ctx td { padding: 3px 16px 3px 0; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--border-soft); }
    .ctx tr:last-child td { border-bottom: 0; }
    .ctx td:first-child { width: 110px; color: var(--text-3); white-space: nowrap; }
    .env { display: inline-flex; align-items: center; gap: 7px; }
    .env i { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 8px currentColor; }
    h3 { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
    .crumbs { font-size: 11.5px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; max-height: 260px; overflow: auto; }
    .crumb-row { display: grid; grid-template-columns: 84px 30px minmax(0, 1fr); gap: 8px; align-items: center; padding: 2px 4px; border-radius: 6px; }
    .crumb-row:hover { background: var(--row-hover); }
    .crumb-row:last-child { background: color-mix(in srgb, var(--crash) 9%, transparent); }
    .crumb-msg { overflow-wrap: anywhere; }
    .m { max-width: 0; width: 45%; }
    .go { width: 1%; text-align: right; }
    .trace-link { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; }
    .trace-link .chev { transition: transform .35s var(--spring); }
    tr:hover .trace-link .chev { transform: translateX(3px); }
    .empty .lead-text { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 550; }
    .empty .hint { max-width: 460px; margin: 6px auto 0; font-size: 12.5px; }
    .empty.small { padding: 16px; }
    .cta { display: flex; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    p { margin: 0; }
    .tag { margin-right: 6px; }
  `,
})
export class ErrorDetailPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly state = inject(AppState);
  readonly fingerprint = input.required<string>();
  protected readonly detail = signal<ErrorDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly session = inject(Session);
  protected readonly people = signal<Person[]>([]);
  protected readonly showHistory = signal(false);
  /** Lignes du framework repliées : on ne garde que votre code (comme « In App » de Sentry). */
  protected readonly hideFramework = signal(true);
  /** Couleur et libellé des environnements configurés (selon l'application). */
  protected readonly envColor = envColor;
  protected readonly envLabel = envLabel;

  private readonly parsedStack = computed(() => {
    const stack = this.detail()?.latest?.exceptionStack;
    return stack ? parseStack(stack) : [];
  });
  protected readonly frameworkLines = computed(() => this.parsedStack().filter((l) => l.kind === 'fw').length);
  /** Pile affichée : les suites de lignes du framework deviennent une ligne repliée cliquable. */
  protected readonly stackLines = computed<StackLine[]>(() => {
    const lines = this.parsedStack();
    if (!this.hideFramework()) return lines;
    const out: StackLine[] = [];
    let folded = 0;
    const flush = () => {
      if (folded) out.push({ text: `${folded} ligne${folded > 1 ? 's' : ''} du framework masquée${folded > 1 ? 's' : ''}`, loc: '', kind: 'fold' });
      folded = 0;
    };
    for (const l of lines) {
      if (l.kind === 'fw') folded++;
      else {
        flush();
        out.push(l);
      }
    }
    flush();
    return out;
  });
  protected readonly canWiden = computed(() => this.state.isRelative() && this.state.from() !== '30d');

  protected readonly versions = computed(() => {
    const seen: string[] = [];
    for (const o of [...(this.detail()?.occurrences ?? [])].reverse()) if (o.version && !seen.includes(o.version)) seen.push(o.version);
    return seen;
  });
  protected readonly historyText = computed(() =>
    (this.detail()?.state?.history ?? []).map((h) => `${new Date(h.at).toLocaleString('fr-FR')} : ${this.personName(h.by) || '?'} ${h.action}`).join(String.fromCharCode(10)));

  protected statusLabel(s: string) {
    return ({ open: 'À traiter', regressed: 'Réapparue', resolved: 'Résolue', ignored: 'Ignorée' } as Record<string, string>)[s] ?? s;
  }

  protected personName(username: string | null | undefined) {
    if (!username) return '';
    return this.people().find((p) => p.username === username)?.displayName ?? username;
  }

  /** Initiales d'une personne pour sa pastille : « Marie Curie » → « MC ». */
  protected initials(name: string) {
    const parts = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    return (parts.length >= 2 ? parts[0][0] + parts[1][0] : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
  }

  /** Date et heure complètes, en infobulle des dates relatives ou abrégées. */
  protected fullDate(iso: string) {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' });
  }

  protected crumbLevel(level: string | null | undefined) {
    const l = (level ?? '').toLowerCase();
    return CRUMB_LEVELS[l] ?? l;
  }

  protected setStatus(status: string) {
    if (this.detail()?.group.status === status) return;
    const done: Record<string, [string, string]> = {
      open: ['Erreur remise à traiter', 'inbox'], resolved: ['Erreur marquée résolue', 'ok'], ignored: ['Erreur ignorée', 'mute'],
    };
    const [text, icon] = done[status] ?? ['Statut modifié', 'ok'];
    this.change({ status }, text, icon);
  }

  protected assign(username: string) {
    if (!username) this.change({ unassign: true }, 'Assignation retirée', 'users');
    else if (username === this.session.me()?.user) this.change({ assignedTo: username }, 'Erreur assignée à vous', 'account');
    else this.change({ assignedTo: username }, `Erreur assignée à ${this.personName(username)}`, 'account');
  }

  protected saveNote(note: string) {
    this.change({ note }, note.trim() ? 'Note enregistrée' : 'Note effacée', 'pencil');
  }

  protected copy(text: string, done: string) {
    navigator.clipboard?.writeText(text).then(
      () => this.toasts.ok(done, 'copy'),
      () => this.toasts.error('Copie impossible : accès au presse-papiers refusé.'),
    );
  }

  protected openTrace(o: ErrorOccurrence) {
    if (o.traceId && this.session.can(['traces', 'requests'])) this.router.navigate(['/traces', o.traceId], { queryParams: { around: o.ts } });
  }

  private change(c: { status?: string; assignedTo?: string; unassign?: boolean; note?: string }, done: string, icon: string) {
    const d = this.detail();
    if (!d) return;
    this.api.setErrorState(d.group.fingerprint, c).subscribe({
      next: () => {
        this.toasts.ok(done, icon);
        this.reload();
      },
      error: () => {
        this.toasts.error('Modification impossible : réessayez dans un instant.');
        this.reload();
      },
    });
  }

  protected readonly times = computed(() => this.detail()?.histogram.buckets.map((b) => b.t) ?? []);
  protected readonly series = computed<ChartSeries[]>(() => {
    const b = this.detail()?.histogram.buckets ?? [];
    return [{ label: 'occurrences', color: '#d45f5f', values: b.map((x) => x.trace + x.debug + x.info + x.warn + x.error + x.fatal) }];
  });
  protected readonly breadcrumbs = computed<{ Ts: string; Level: string; Category?: string | null; Message: string }[]>(() => {
    const raw = parseJson(this.detail()?.latest?.attributes)['wolflog.breadcrumbs'];
    if (typeof raw !== 'string') return [];
    try { return JSON.parse(raw); } catch { return []; }
  });

  constructor() {
    this.api.people().subscribe({ next: (p) => this.people.set(p), error: () => {} });
    effect(() => {
      this.fingerprint();
      this.state.range();
      this.state.tick();
      untracked(() => this.reload());
    });
  }

  private reload() {
    this.loading.set(true);
    this.api.error(this.fingerprint(), this.state.range()).subscribe({
      next: (d) => {
        this.detail.set(d);
        this.loading.set(false);
      },
      error: () => {
        this.detail.set(null);
        this.loading.set(false);
      },
    });
  }
}
