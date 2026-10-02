import { Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { AlertChannel, AlertEvaluation, AlertKind, AlertRule, MetricData, CustomResult, EnvironmentInfo, Probe, Slo } from '../core/models';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { exactDate, timeAgo } from '../core/format';
import { Chart, ChartSeries, paletteColor } from '../shared/chart';
import { AGGREGATES } from '../shared/dashboard-panel';
import { MessageComposer } from '../shared/message-composer';
import { NavIcon } from '../shared/nav-icon';
import { RichOption, envColor, envLabel } from '../shared/rich-option';
import { ThresholdGauge } from '../shared/threshold-gauge';
import {
  ALERT_KINDS, CHANNEL_TYPES, HTTP_STATS, WINDOWS, aggregateHint, aggregateIcon, channelIcon, channelTypeLabel, describeNotification, describeRule, kindIcon, newRule,
} from '../shared/alert-rules';

const REPEATS = [
  { value: 0, label: 'jamais', icon: 'bell', desc: 'Une seule notification au déclenchement' },
  { value: 30, label: 'toutes les 30 min', icon: 'refresh', desc: 'Insistant : astreinte active' },
  { value: 60, label: 'toutes les heures', icon: 'refresh', desc: 'Un rappel par heure' },
  { value: 240, label: 'toutes les 4 h', icon: 'refresh', desc: 'Quelques rappels par jour' },
  { value: 1440, label: 'tous les jours', icon: 'calendar', desc: 'Un rappel quotidien' },
];

/** Délai avant déclenchement : la condition doit rester vraie pendant cette durée. */
const DELAYS = [
  { value: 0, label: 'non, dès que la condition est vraie', icon: 'bolt', desc: 'Déclenche immédiatement' },
  { value: 2, label: '2 min', icon: 'timer', desc: 'Ignore les pics de moins de 2 min' },
  { value: 5, label: '5 min', icon: 'timer', desc: 'Ignore les pics de moins de 5 min' },
  { value: 10, label: '10 min', icon: 'timer', desc: 'Seulement les problèmes qui durent' },
  { value: 30, label: '30 min', icon: 'timer', desc: 'Seulement les problèmes installés' },
];

const SEVERITIES = [
  { value: 'critical' as const, label: 'Critique', icon: 'siren', desc: 'Touche les utilisateurs : à traiter tout de suite' },
  { value: 'warning' as const, label: 'Avertissement', icon: 'warning', desc: 'À surveiller : à regarder dans la journée' },
];

type StepState = 'ok' | 'warn' | 'todo';

/**
 * Création et modification d'une alerte sur une page dédiée :
 * 1. que surveiller, 2. quand déclencher, 3. qui prévenir, 4. nom et consigne.
 * À droite, en permanence : la règle en une phrase, la valeur actuelle et un graphique avec le seuil.
 */
@Component({
  selector: 'wl-alert-form',
  imports: [FormsModule, RouterLink, Chart, MessageComposer, NavIcon, RichOption, ThresholdGauge],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/alerts" [queryParams]="{ tab: 'rules' }" class="small crumb"><wl-nav-icon name="alerts" [size]="14" />Alertes</a>
        <span class="muted">/</span>
        <h1>{{ r().id ? 'Modifier l’alerte' : 'Nouvelle alerte' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'rules' }"><wl-nav-icon name="close" [size]="15" />Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">
          @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="r().id ? 'check' : 'plus'" [size]="15" /> }
          {{ r().id ? 'Enregistrer' : 'Créer l’alerte' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <!-- 1 -->
          <section class="panel step done" data-step="1">
            <div class="step-head"><span class="num">1</span><h2>Que surveiller ?</h2></div>
            <div class="step-body">
              <div class="choices">
                @for (k of kinds; track k.value) {
                  <button type="button" class="choice kind" [class.on]="r().kind === k.value" (click)="setKind(k.value)" [title]="k.example">
                    <span class="k-icon"><wl-nav-icon [name]="k.icon" [size]="17" /></span>
                    <strong>{{ k.label }}</strong>
                    <span class="k-hint">{{ k.hint }}</span>
                  </button>
                }
              </div>
            </div>
          </section>

          <!-- 2 -->
          <section class="panel step" [class.done]="!conditionIssue()?.blocking" [class.issue]="conditionIssue()?.blocking" data-step="2">
            <div class="step-head"><span class="num">2</span><h2>Quand déclencher ?</h2>
              @if (conditionIssue(); as i) {
                <span class="hint issue" [class.soft]="!i.blocking" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="12" />{{ i.text }}</span>
              } @else {
                <span class="hint">complétez la phrase</span>
              }
            </div>
            <div class="step-body">
              <div class="sentence">
                @switch (r().kind) {
                  @case ('http') {
                    <span>Quand</span>
                    <select [ngModel]="r().stat" (ngModelChange)="patch({ stat: $event, threshold: defaultThreshold($event), minCount: $event === 'errorRate' ? 20 : 0 })">
                      @for (s of httpStats; track s.value) { <option [value]="s.value" [wlOpt]="s.label" [icon]="s.icon" [tone]="s.tone" [desc]="s.desc"></option> }
                    </select>
                    <span>des requêtes de</span>
                    <select [ngModel]="serviceChoice()" (ngModelChange)="setServiceChoice($event)">
                      <option value="" wlOpt="tous les services ensemble" icon="layers" desc="Une seule alerte pour l'ensemble du trafic"></option>
                      <option value="*" wlOpt="chaque service, séparément" icon="split" desc="Une alerte distincte par service"></option>
                      @for (s of services(); track s) { <option [value]="s" [wlOpt]="s" avatar></option> }
                    </select>
                    <span>dépasse</span>
                    <span class="unit-input"><input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" /><em>{{ httpUnit() }}</em></span>
                    <span>pendant</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value" [wlOpt]="w.label" icon="clock" [desc]="w.hint"></option> }
                    </select>
                  }
                  @case ('error') {
                    <span>Quand une nouvelle erreur apparaît dans</span>
                    <select [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="" wlOpt="n'importe quel service" icon="layers" desc="Toutes les applications qui envoient des erreurs"></option>
                      @for (s of services(); track s) { <option [value]="s" [wlOpt]="s" avatar></option> }
                    </select>
                  }
                  @case ('silence') {
                    <span>Quand</span>
                    <select [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="" wlOpt="un des services actifs ces dernières 24 h" icon="layers" desc="Chaque service vu récemment est surveillé"></option>
                      @for (s of services(); track s) { <option [value]="s" [wlOpt]="s" avatar></option> }
                    </select>
                    <span>n'envoie plus rien depuis</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value" [wlOpt]="w.label" icon="clock" [desc]="w.hint"></option> }
                    </select>
                  }
                  @case ('query') {
                    <span>Quand</span>
                    <select [ngModel]="r().aggregate" (ngModelChange)="patch({ aggregate: $event })">
                      @for (a of aggregates; track a.value) {
                        <option [value]="a.value" [wlOpt]="a.label.toLowerCase()" [icon]="aggregateIcon(a.value)" [desc]="aggregateHint(a.value, a.numeric)"></option>
                      }
                    </select>
                    @if (needsField()) {
                      <input class="field-in mono" animate.enter="field-enter" [ngModel]="r().field ?? ''" (ngModelChange)="patch({ field: $event })" placeholder="champ, ex. duration" />
                    }
                    <span>des</span>
                    <select [ngModel]="r().source" (ngModelChange)="patch({ source: $event })">
                      <option value="logs" wlOpt="logs" icon="logs" desc="Lignes de journal"></option>
                      <option value="spans" wlOpt="spans (traces)" icon="traces" desc="Opérations des traces distribuées"></option>
                      <option value="metrics" wlOpt="métriques" icon="metrics" desc="Séries de mesures"></option>
                    </select>
                    <select [ngModel]="r().comparison" (ngModelChange)="patch({ comparison: $event })">
                      <option value="above" wlOpt="dépasse" icon="arrow-up" tone="warn" desc="Alerte au-dessus du seuil"></option>
                      <option value="below" wlOpt="passe sous" icon="arrow-down" tone="info" desc="Alerte en dessous du seuil"></option>
                    </select>
                    <input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" />
                    <span>sur</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value" [wlOpt]="w.label" icon="clock" [desc]="w.hint"></option> }
                    </select>
                  }
                  @case ('probe') {
                    <span>Quand</span>
                    <select [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                      <option value="" wlOpt="une des sondes" icon="layers" desc="N'importe quelle sonde"></option>
                      @for (p of probes(); track p.id) {
                        <option [value]="p.id" [wlOpt]="p.name" [icon]="p.type === 'tcp' ? 'server' : 'globe'" [desc]="p.target"></option>
                      }
                    </select>
                    <span>ne répond plus</span>
                  }
                  @case ('slo') {
                    <span>Quand</span>
                    <select [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                      <option value="" wlOpt="un des objectifs" icon="layers" desc="N'importe quel objectif"></option>
                      @for (s of slos(); track s.id) { <option [value]="s.id" [wlOpt]="s.name" icon="slos" [meta]="pct(s.targetPercent)"></option> }
                    </select>
                    <span>consomme son budget d'erreur plus de</span>
                    <span class="unit-input"><input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" min="1" /><em>fois trop vite</em></span>
                    <span>sur</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value" [wlOpt]="w.label" icon="clock" [desc]="w.hint"></option> }
                    </select>
                  }
                  @case ('health') {
                    <span>Quand Wolflog lui-même a un problème :</span>
                    <span class="health">
                      @for (h of healthChecks; track h.label) { <span class="h-item" [style.--i]="$index"><wl-nav-icon [name]="h.icon" [size]="14" />{{ h.label }}</span> }
                    </span>
                  }
                }
              </div>

              <!-- Options propres au type, sous la phrase -->
              @switch (r().kind) {
                @case ('http') {
                  <div class="options">
                    <label class="field">Route (facultatif) <input [ngModel]="r().route ?? ''" (ngModelChange)="patch({ route: $event || null })" placeholder="ex. /api/orders" /></label>
                    @if (r().stat === 'errorRate') {
                      <label class="field">Nombre minimum de requêtes
                        <input type="number" min="0" [ngModel]="r().minCount" (ngModelChange)="patch({ minCount: +$event })" />
                        <span class="muted small">Évite une alerte pour 1 erreur sur 2 requêtes la nuit.</span></label>
                    }
                  </div>
                }
                @case ('query') {
                  <div class="options">
                    <label class="field wide">Filtre <input class="mono" [ngModel]="r().filter ?? ''" (ngModelChange)="patch({ filter: $event || null })" placeholder='ex. level:error "paiement refusé"' />
                      <span class="muted small">Même syntaxe que la recherche des logs.</span></label>
                    <label class="field">Séparer par (facultatif) <input [ngModel]="r().groupBy ?? ''" (ngModelChange)="patch({ groupBy: $event || null })" placeholder="ex. service, http.route" />
                      <span class="muted small">Une alerte par valeur.</span></label>
                  </div>
                }
                @case ('error') {
                  <div class="options checks">
                    <label class="check"><input type="checkbox" class="switch" [ngModel]="r().includeRegressions" (ngModelChange)="patch({ includeRegressions: $event })" /> Aussi quand une erreur marquée résolue réapparaît</label>
                    <label class="check"><input type="checkbox" class="switch" [ngModel]="r().crashesOnly" (ngModelChange)="patch({ crashesOnly: $event })" /> Seulement les crashs (arrêt de l'application)</label>
                  </div>
                }
                @case ('probe') {
                  <div class="options">
                    <label class="field">Prévenir aussi si le certificat TLS expire dans moins de
                      <span class="unit-input"><input type="number" class="num-in" min="0" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" /><em>jours</em></span></label>
                    @if (!probes().length) {
                      <p class="note"><wl-nav-icon name="info" [size]="14" /><span>Aucune sonde pour l'instant. <a class="inline-cta" routerLink="/uptime/new"><wl-nav-icon name="plus" [size]="13" />Créer une sonde</a></span></p>
                    }
                  </div>
                }
                @case ('slo') {
                  <p class="note"><wl-nav-icon name="info" [size]="14" /><span>Repères : 14,4× pendant 1 h ou 6× pendant 6 h épuiseraient le budget d'un mois en 2 ou 5 jours.
                    @if (!slos().length) { <a class="inline-cta" routerLink="/slos/new"><wl-nav-icon name="plus" [size]="13" />Créer un objectif</a> }</span></p>
                }
              }

              <div class="options">
                @if (r().kind !== 'error') {
                  <label class="field">Attendre avant de déclencher
                    <select [ngModel]="r().forMinutes" (ngModelChange)="patch({ forMinutes: +$event })">
                      @for (d of delays; track d.value) { <option [value]="d.value" [wlOpt]="d.label" [icon]="d.icon" [desc]="d.desc"></option> }
                    </select>
                    <span class="muted small">Ignore les pics très courts.</span></label>
                }
                @if (r().kind !== 'health' && envChoices().length) {
                  <label class="field">Environnement
                    <select [ngModel]="r().env ?? ''" (ngModelChange)="patch({ env: $event || null })">
                      <option value="" wlOpt="tous" icon="globe" desc="Tous les environnements"></option>
                      @for (e of envChoices(); track e.name) { <option [value]="e.name" [wlOpt]="e.label" dot [tone]="e.color" [desc]="e.desc"></option> }
                    </select></label>
                }
              </div>
            </div>
          </section>

          <!-- 3 -->
          <section class="panel step" [class.done]="r().channels.length" data-step="3">
            <div class="step-head">
              <span class="num">3</span><h2>Qui prévenir ?</h2>
              @if (r().channels.length) {
                <span class="hint picked">{{ r().channels.length }} {{ r().channels.length > 1 ? 'canaux cochés' : 'canal coché' }}</span>
              }
            </div>
            <div class="step-body">
              @if (channels().length) {
                <div class="channel-list">
                  @for (c of channels(); track c.id) {
                    <label class="channel" [class.on]="r().channels.includes(c.id)" [style.--i]="$index">
                      <input type="checkbox" [checked]="r().channels.includes(c.id)" (change)="toggleChannel(c.id)" />
                      <span class="ch-icon"><wl-nav-icon [name]="channelIcon(c.type)" [size]="15" /></span>
                      <span class="ch-text">
                        <strong class="ellipsis" [title]="c.name">{{ c.name }}</strong>
                        <span class="muted small ellipsis" [title]="c.target">{{ channelType(c.type) }} · {{ c.target }}</span>
                        @if (failing(c)) {
                          <span class="ch-last bad" [title]="(c.lastError ?? 'Échec') + '  ' + exact(c.lastErrorAt)"><wl-nav-icon name="warning" [size]="11" />échec {{ ago(c.lastErrorAt) }}</span>
                        } @else if (c.lastSentAt) {
                          <span class="ch-last" [title]="exact(c.lastSentAt)">dernier envoi {{ ago(c.lastSentAt) }}</span>
                        } @else {
                          <span class="ch-last">jamais utilisé</span>
                        }
                      </span>
                      @if (c.default) { <span class="ch-default" title="Coché d'office sur les nouvelles alertes">par défaut</span> }
                    </label>
                  }
                </div>
              } @else {
                <p class="note"><wl-nav-icon name="info" [size]="14" /><span>Aucun canal de notification : l'alerte sera visible dans Wolflog (barre du haut, page Alertes) mais personne ne sera prévenu.</span></p>
              }
              @if (session.isAdmin()) {
                @if (newChannel(); as c) {
                  <div class="new-channel" animate.enter="grow-in" animate.leave="grow-out">
                    <div class="seg types">
                      @for (t of channelTypes; track t.value) {
                        <button type="button" [class.on]="c.type === t.value" (click)="patchChannel({ type: t.value })"><wl-nav-icon [name]="t.icon" [size]="13" />{{ t.label }}</button>
                      }
                    </div>
                    <div class="options">
                      <label class="field">Nom <input [ngModel]="c.name" (ngModelChange)="patchChannel({ name: $event })" placeholder="ex. Astreinte, #prod-alertes" /></label>
                      <label class="field wide">{{ c.type === 'email' ? 'Adresses (séparées par des virgules)' : 'URL du webhook' }}
                        <input [ngModel]="c.target" (ngModelChange)="patchChannel({ target: $event })" [placeholder]="c.type === 'email' ? 'astreinte@mondomaine.fr' : 'https://…'" /></label>
                    </div>
                    @if (channelError()) { <span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ channelError() }}</span> }
                    <div class="row-actions">
                      <button type="button" class="btn" (click)="createChannel()" [disabled]="creatingChannel() || !c.target.trim()">
                        @if (creatingChannel()) { <span class="spinner"></span> } @else { <wl-nav-icon name="plus" [size]="14" /> }
                        Ajouter et cocher
                      </button>
                      <button type="button" class="btn ghost" (click)="newChannel.set(null)">Annuler</button>
                      @if (c.type === 'email') { <span class="muted small">Le serveur d'envoi se règle dans Alertes > Canaux.</span> }
                    </div>
                  </div>
                } @else {
                  <button type="button" class="link small add-link" (click)="startChannel()"><wl-nav-icon name="plus" [size]="14" />Ajouter un canal (e-mail, Teams, Slack, webhook)</button>
                }
              }
              <div class="field" role="radiogroup" aria-label="Gravité">Gravité
                <div class="sev-cards">
                  @for (s of severities; track s.value) {
                    <button type="button" class="choice sev-card" role="radio" [attr.data-sev]="s.value" [class.on]="r().severity === s.value"
                            [attr.aria-checked]="r().severity === s.value" (click)="patch({ severity: s.value })">
                      <span class="sev-icon"><wl-nav-icon [name]="s.icon" [size]="16" /></span>
                      <strong>{{ s.label }}</strong>
                      <span>{{ s.desc }}</span>
                    </button>
                  }
                </div>
              </div>
              <div class="options">
                <label class="field">Rappeler tant que c'est actif
                  <select [ngModel]="r().repeatMinutes" (ngModelChange)="patch({ repeatMinutes: +$event })">
                    @for (x of repeats; track x.value) { <option [value]="x.value" [wlOpt]="x.label" [icon]="x.icon" [tone]="x.value ? null : 'muted'" [desc]="x.desc"></option> }
                  </select></label>
              </div>
              @if (r().kind !== 'error') {
                <label class="check"><input type="checkbox" class="switch" [ngModel]="r().notifyResolved" (ngModelChange)="patch({ notifyResolved: $event })" /> Prévenir aussi quand tout redevient normal</label>
              }
            </div>
          </section>

          <!-- 4 -->
          <section class="panel step done" data-step="4">
            <div class="step-head"><span class="num">4</span><h2>Nom, consigne et message</h2><span class="hint">facultatif</span></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="customName()" (ngModelChange)="customName.set($event)" [placeholder]="autoName()" />
                <span class="muted small">Vide : « {{ autoName() }} ».</span></label>
              <label class="field">Consigne pour la personne prévenue <input [ngModel]="r().runbook ?? ''" (ngModelChange)="patch({ runbook: $event || null })"
                placeholder="ex. Vérifier la connexion à la base ; procédure : https://wiki/…" />
                <span class="muted small">Affichée dans la notification.</span></label>
              <div class="message">
                <h3><wl-nav-icon name="chat" [size]="14" />Message envoyé</h3>
                <wl-message-composer [rule]="previewRule()" [channels]="channels()" [title]="r().titleTemplate ?? null" [body]="r().bodyTemplate ?? null"
                  (titleChange)="patch({ titleTemplate: $event })" (bodyChange)="patch({ bodyTemplate: $event })" />
              </div>
            </div>
          </section>
        </div>

        <!-- Résumé permanent -->
        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <div class="sum">
              <span class="sum-icon"><wl-nav-icon [name]="kindIcon(r().kind)" [size]="18" /></span>
              <p class="phrase">
                <span class="sev-badge" [class]="r().severity"><wl-nav-icon [name]="r().severity === 'critical' ? 'siren' : 'warning'" [size]="12" />{{ severityLabel() }}</span>
                si {{ autoName().charAt(0).toLowerCase() + autoName().slice(1) }}{{ r().forMinutes ? ', pendant ' + r().forMinutes + ' min' : '' }}.
              </p>
            </div>
            <p class="muted small notify"><wl-nav-icon name="bell" [size]="13" /><span>Prévenir : {{ notification() }}.</span></p>
          </div>
          <!-- Fil des étapes : état de chaque étape (vérifications avant création) ; l'étape à l'écran est marquée, un clic y mène. -->
          <div class="block">
            <ol class="rail" [style.--progress]="(current() - 1) / 3">
              @for (s of stepStates(); track s.n) {
                <li>
                  <button type="button" class="r-step" [attr.data-state]="s.state" [class.cur]="current() === s.n" (click)="goTo(s.n)"
                          [attr.aria-current]="current() === s.n ? 'step' : null">
                    <span class="r-dot">
                      @switch (s.state) {
                        @case ('ok') { <wl-nav-icon name="check" [size]="12" /> }
                        @case ('todo') { <wl-nav-icon name="warning" [size]="11" /> }
                        @default { {{ s.n }} }
                      }
                    </span>
                    <span class="r-text"><b>{{ s.title }}</b><small [title]="s.detail">{{ s.detail }}</small></span>
                  </button>
                </li>
              }
            </ol>
          </div>
          <div class="block">
            <h3>En ce moment</h3>
            @if (previewError()) {
              <span class="danger small err"><wl-nav-icon name="warning" [size]="13" />{{ previewError() }}</span>
            } @else if (preview() === null) {
              <div class="sk" aria-label="Calcul en cours"><i class="skeleton" style="width: 78%; height: 16px"></i><i class="skeleton" style="width: 92%"></i><i class="skeleton" style="width: 64%"></i></div>
            } @else if (!preview()!.length) {
              <span class="muted small calm"><wl-nav-icon name="ok" [size]="14" />{{ r().kind === 'error' ? 'Aucune nouvelle erreur en ce moment.' : 'Pas de donnée pour ces critères.' }}</span>
            } @else {
              @if (breaching().length) {
                <div class="verdict on" animate.enter="verdict-in"><wl-nav-icon name="alerts" [size]="15" />Se déclencherait maintenant</div>
              } @else {
                <div class="verdict" animate.enter="verdict-in"><wl-nav-icon name="ok" [size]="15" />Ne se déclencherait pas maintenant</div>
              }
              @if (gauge(); as g) {
                <wl-threshold-gauge class="gauge" [value]="g.value" [threshold]="r().threshold" [comparison]="r().comparison" [unit]="g.unit" [label]="g.label" />
              }
              @for (e of preview()!.slice(0, 5); track e.key) {
                <div class="ev" [class.on]="e.breach" [style.--i]="$index"><wl-nav-icon [name]="e.breach ? 'warning' : 'ok'" [size]="12" class="ev-icon" /><span>{{ e.message }}</span></div>
              }
              @if (preview()!.length > 5) { <div class="muted small more">et {{ preview()!.length - 5 }} autre(s)</div> }
            }
          </div>
          @if (chartTimes().length) {
            <div class="block">
              <h3>{{ chartTitle() }}</h3>
              <wl-chart [times]="chartTimes()" [series]="chartSeries()" [height]="150" [unit]="chartUnit()" [legend]="false" [deployments]="false" [threshold]="chartThreshold()" />
              <span class="muted small legend"><i class="dash"></i>seuil<i class="band"></i>zone où l'alerte se déclenche</span>
            </div>
          }
          @if (error()) { <div class="block"><span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
          @if (blocking(); as b) {
            <div class="block">
              <button type="button" class="todo-hint" (click)="goTo(b.n)" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="14" />À compléter : {{ b.detail }}<wl-nav-icon name="arrow-right" [size]="13" /></button>
            </div>
          }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">
              @if (busy()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="r().id ? 'check' : 'plus'" [size]="15" /> }
              {{ r().id ? 'Enregistrer' : 'Créer l’alerte' }}
            </button>
            <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'rules' }">Annuler</a>
            <span class="spacer"></span>
            @if (r().id) {
              @if (confirmDelete()) {
                <span class="confirm" animate.enter="confirm-in">
                  <button class="btn danger-btn" (click)="remove()" [disabled]="deleting()"><wl-nav-icon name="trash" [size]="14" />Confirmer</button>
                  <button class="btn ghost icon" (click)="confirmDelete.set(false)" title="Ne pas supprimer" aria-label="Ne pas supprimer"><wl-nav-icon name="close" [size]="14" /></button>
                </span>
              } @else {
                <button class="btn ghost del" (click)="confirmDelete.set(true)"><wl-nav-icon name="trash" [size]="14" />Supprimer</button>
              }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    /* Étapes : cible du fil (marge sous la barre du haut) et halo quand on y arrive depuis le fil. */
    .step { position: relative; scroll-margin-top: 84px; }
    .step::after { content: ''; position: absolute; inset: -1px; border-radius: inherit; pointer-events: none; opacity: 0;
      box-shadow: 0 0 0 2px var(--accent), 0 0 30px -6px var(--accent); }
    .step-head .hint.issue { display: inline-flex; align-items: center; gap: 5px; color: var(--danger); font-weight: 600; }
    .step-head .hint.issue.soft { color: var(--warn); }
    .step.issue .step-head .num { border-color: var(--danger); color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .crumb wl-nav-icon { transition: transform .35s var(--spring); }
    .crumb:hover wl-nav-icon { transform: translateX(-2px) rotate(-10deg); }
    .num-in { width: 90px; }

    /* Étape 1 : cartes avec une icône qui pivote au survol et se remplit une fois choisie. */
    .choice.kind { grid-template-columns: 34px minmax(0, 1fr); column-gap: 12px; row-gap: 2px; align-items: center; }
    .kind .k-icon { grid-row: span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
      transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .kind:hover .k-icon { transform: scale(1.1) rotate(-8deg); }
    .kind.on .k-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 6px 16px -8px var(--accent);
      animation: icon-pop .5s var(--spring); }
    @keyframes icon-pop { 40% { transform: scale(1.18) rotate(-10deg); } }

    .message { display: grid; gap: 8px; margin-top: 6px; padding-top: 12px; border-top: 1px solid var(--border); }
    .message h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; }
    .message h3 wl-nav-icon { color: var(--accent); }
    .field-in { width: 150px; }
    .field-enter { animation: field-enter .35s var(--spring) backwards; }
    @keyframes field-enter { from { opacity: 0; transform: translateX(-6px) scale(.95); } }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .health { display: flex; flex-wrap: wrap; gap: 6px; flex-basis: 100%; line-height: 1.4; }
    .h-item { display: inline-flex; align-items: center; gap: 6px; padding: 5px 11px; border-radius: 999px; font-size: 12.5px;
      border: 1px solid var(--border-soft); background: var(--surface-2); color: var(--text-2); animation: pop-in .4s var(--spring) backwards;
      animation-delay: calc(var(--i) * 60ms); }
    .h-item wl-nav-icon { color: var(--accent); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    .options .field.wide { flex: 1; min-width: 320px; }
    .options.checks { display: grid; gap: 8px; }
    div.field { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .note { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 9px 12px; border-radius: var(--radius-sm); font-size: 12px; line-height: 1.5;
      color: var(--text-2); background: var(--surface-2); border: 1px solid var(--border-soft); }
    .note > wl-nav-icon { margin-top: 1px; color: var(--accent); }
    .inline-cta { display: inline-flex; align-items: center; gap: 4px; margin-left: 4px; font-weight: 600; }

    /* Étape 3 : canaux en cartes à cocher. */
    .step-head .hint.picked { color: var(--accent); font-weight: 600; animation: pop-in .35s var(--spring); }
    .channel-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 8px; }
    .channel { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--surface-2); cursor: pointer; animation: pop-in .4s var(--ease) backwards; animation-delay: calc(min(var(--i), 10) * 35ms);
      transition: border-color .2s, background-color .2s, transform .3s var(--spring); }
    .channel:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
    .channel.on { border-color: var(--accent); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), color-mix(in srgb, var(--accent-2) 8%, transparent)); }
    .channel:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
    .ch-icon { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 9px; color: var(--accent); background: var(--accent-soft);
      transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .channel:hover .ch-icon { transform: rotate(-8deg) scale(1.08); }
    .channel.on .ch-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .ch-text { display: grid; gap: 1px; min-width: 0; flex: 1; }
    .ch-text strong { font-size: 13px; font-weight: 600; }
    .ch-last { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-3); }
    .ch-last.bad { color: var(--danger); }
    .ch-default { flex: none; align-self: flex-start; padding: 0 7px; border-radius: 999px; font-size: 10.5px; line-height: 18px; color: var(--accent); background: var(--accent-soft); }

    /* Gravité en cartes, à la couleur de la gravité. */
    .sev-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 2px; }
    .choice.sev-card { --tone: var(--danger); grid-template-columns: 34px minmax(0, 1fr); column-gap: 12px; row-gap: 2px; align-items: center; }
    .choice.sev-card[data-sev='warning'] { --tone: var(--warn); }
    .sev-card .sev-icon { grid-row: span 2; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 14%, transparent); transition: transform .4s var(--spring), color .25s, background-color .25s; }
    .sev-card:hover .sev-icon { transform: scale(1.1) rotate(-8deg); }
    .choice.sev-card:hover { border-color: color-mix(in srgb, var(--tone) 55%, var(--border)); }
    .choice.sev-card.on { border-color: var(--tone); box-shadow: inset 0 0 0 1px var(--tone);
      background: linear-gradient(135deg, color-mix(in srgb, var(--tone) 18%, transparent), color-mix(in srgb, var(--tone) 6%, transparent)); }
    .sev-card.on .sev-icon { color: #fff; background: var(--tone); box-shadow: 0 6px 16px -8px var(--tone); animation: icon-pop .5s var(--spring); }
    .new-channel { display: grid; gap: 10px; padding: 12px; border: 1px dashed color-mix(in srgb, var(--accent) 45%, var(--border)); border-radius: var(--radius-sm);
      background: color-mix(in srgb, var(--accent) 4%, transparent); transform-origin: top center; }
    .new-channel .seg { justify-self: start; }
    .types button { display: inline-flex; align-items: center; gap: 6px; }
    .grow-in { animation: grow-in .4s var(--spring) backwards; }
    .grow-out { animation: grow-out .2s ease-in forwards; }
    @keyframes grow-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
    @keyframes grow-out { to { opacity: 0; transform: translateY(-4px) scale(.98); } }
    .row-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; justify-self: start; font-family: inherit; }
    .add-link { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
    .add-link wl-nav-icon { transition: transform .4s var(--spring); }
    .add-link:hover wl-nav-icon { transform: rotate(90deg) scale(1.15); }

    /* Résumé : icône du type, gravité en badge, verdict animé, évaluations en cascade. */
    .sum { display: flex; align-items: flex-start; gap: 12px; }
    .sum-icon { display: grid; place-items: center; width: 36px; height: 36px; flex: none; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -10px var(--accent); }
    .phrase { margin: 0; min-width: 0; font-size: 13.5px; line-height: 1.6; }
    .sev-badge { display: inline-flex; align-items: center; gap: 6px; padding: 0 9px; border-radius: 999px; font-weight: 650; font-size: 12.5px; line-height: 22px;
      vertical-align: 1px; color: var(--danger); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    .sev-badge.warning { color: var(--warn); background: color-mix(in srgb, var(--warn) 13%, transparent); }
    .notify { display: flex; align-items: flex-start; gap: 6px; }
    .notify wl-nav-icon { margin-top: 2px; }
    .summary p { margin: 0; }
    .sk { display: grid; gap: 8px; padding: 2px 0; }
    .calm { display: inline-flex; align-items: center; gap: 6px; }
    .verdict { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--radius-sm); font-weight: 650;
      color: var(--ok); background: color-mix(in srgb, var(--ok) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 24%, transparent); }
    .verdict.on { color: var(--danger); background: color-mix(in srgb, var(--danger) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 26%, transparent); }
    .verdict-in { animation: verdict-in .45s var(--spring); }
    @keyframes verdict-in { from { opacity: 0; transform: scale(.94); } }
    .ev { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--text-2); animation: pop-in .35s var(--ease) backwards; animation-delay: calc(var(--i) * 40ms); }
    .ev.on { color: var(--danger); }
    .ev-icon { flex: none; margin-top: 2px; opacity: .8; }
    .more { padding-left: 14px; }
    .legend { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .dash { width: 18px; height: 0; border-top: 2px dashed var(--danger); opacity: .8; }
    .band { width: 14px; height: 10px; margin-left: 8px; border-radius: 3px;
      background: linear-gradient(color-mix(in srgb, var(--danger) 38%, transparent), color-mix(in srgb, var(--danger) 6%, transparent)); }
    .gauge { margin: 4px 0 2px; }

    /* Fil des étapes : ligne qui se remplit jusqu'à l'étape à l'écran, pastille d'état par étape. */
    .rail { position: relative; display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .rail::before, .rail::after { content: ''; position: absolute; left: 13px; top: 17px; bottom: 17px; width: 2px; border-radius: 2px; background: var(--border); }
    .rail::after { background: linear-gradient(var(--accent), var(--accent-2)); transform-origin: top; transform: scaleY(var(--progress, 0));
      transition: transform .5s var(--spring); }
    .r-step { position: relative; z-index: 1; display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 8px 5px 2px; border: 0;
      border-radius: 10px; background: none; color: var(--text-2); text-align: left; font: inherit; cursor: pointer; transition: background-color .2s, color .2s; }
    .r-step:hover { background: var(--surface-2); color: var(--text-1); }
    .r-step.cur { color: var(--text-1); background: var(--accent-soft); }
    .r-dot { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 50%; font: 650 11px var(--sans); color: var(--text-2);
      background: var(--surface-solid); border: 1px solid var(--border); transition: transform .4s var(--spring), background-color .3s, color .3s, border-color .3s; }
    .r-step[data-state='ok'] .r-dot { color: var(--on-accent); border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .r-step[data-state='warn'] .r-dot { color: var(--warn); border-color: var(--warn); background: var(--surface-solid); }
    .r-step[data-state='todo'] .r-dot { color: #fff; border-color: transparent; background: var(--danger); animation: r-shake .5s var(--ease); }
    .r-step.cur .r-dot { transform: scale(1.12); }
    .r-text { display: grid; min-width: 0; }
    .r-text b { font-size: 12.5px; font-weight: 600; }
    .r-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--text-3); }
    .r-step[data-state='warn'] small { color: var(--warn); }
    .r-step[data-state='todo'] small { color: var(--danger); }
    @keyframes r-shake { 20%, 60% { transform: translateX(-2px); } 40%, 80% { transform: translateX(2px); } }
    .todo-hint { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent);
      border-radius: var(--radius-sm); background: color-mix(in srgb, var(--danger) 9%, transparent); color: var(--danger); font: 600 12.5px var(--sans);
      text-align: left; cursor: pointer; }
    .todo-hint wl-nav-icon:last-child { margin-left: auto; transition: transform .3s var(--spring); }
    .todo-hint:hover wl-nav-icon:last-child { transform: translateX(3px); }
    .err { display: inline-flex; align-items: center; gap: 6px; }
    .fade-in { animation: pop-in .35s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(4px) scale(.96); } }

    /* Actions : suppression en deux temps, bouton de confirmation rouge. */
    .actions { flex-wrap: wrap; }
    .confirm { display: inline-flex; gap: 4px; margin-left: auto; }
    .confirm-in { animation: confirm-in .35s var(--spring); }
    @keyframes confirm-in { from { opacity: 0; transform: translateX(10px) scale(.94); } }
    .danger-btn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 12%, transparent);
      --ripple: color-mix(in srgb, var(--danger) 45%, transparent); }
    .danger-btn:hover { color: var(--on-accent); background: var(--danger); border-color: var(--danger); }
    .del:hover { color: var(--danger); }
    .btn.icon { width: 32px; padding: 0; justify-content: center; }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
    p { margin: 0; }
  `,
})
export class AlertFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly state = inject(AppState);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);

  /** /alerts/:id (modification) ; /alerts/new?kind=…&service=… (création pré-remplie depuis une autre page). */
  readonly id = input<string>('');
  readonly kind = input<string>('');
  readonly service = input<string>('');
  readonly stat = input<string>('');
  readonly source = input<string>('');
  readonly filter = input<string>('');
  readonly agg = input<string>('');
  readonly field = input<string>('');
  readonly groupBy = input<string>('');
  readonly route = input<string>('');
  readonly target = input<string>('');
  readonly name = input<string>('');

  protected readonly kinds = ALERT_KINDS;
  protected readonly windows = WINDOWS;
  protected readonly httpStats = HTTP_STATS;
  protected readonly aggregates = AGGREGATES;
  protected readonly repeats = REPEATS;
  protected readonly delays = DELAYS;
  protected readonly severities = SEVERITIES;
  protected readonly channelIcon = channelIcon;
  protected readonly kindIcon = kindIcon;
  protected readonly aggregateIcon = aggregateIcon;
  protected readonly aggregateHint = aggregateHint;
  /** Ce que surveille l'alerte « Santé de Wolflog ». */
  protected readonly healthChecks = [
    { label: 'disque presque plein', icon: 'database' }, { label: 'écriture en échec', icon: 'file' },
    { label: 'plus aucune donnée reçue', icon: 'wifi' }, { label: 'notification impossible', icon: 'bell' },
  ];

  protected readonly r = signal<AlertRule>(newRule());
  protected readonly customName = signal('');
  protected readonly services = signal<string[]>([]);
  /** Environnements du sélecteur (configurés : libellé, couleur, valeurs regroupées). */
  protected readonly environments = signal<EnvironmentInfo[]>([]);
  /** Choix proposés ; l'environnement de la règle y figure toujours, même masqué ou sans donnée récente. */
  protected readonly envChoices = computed(() => {
    const list = this.environments().map((e) => ({
      name: e.name, label: e.label, color: e.color ?? `var(--${e.tone})`,
      desc: e.raw.some((raw) => raw !== e.name) ? `regroupe ${e.raw.join(', ')}` : null,
    }));
    const current = this.r().env;
    return current && !list.some((e) => e.name === current) ? [{ name: current, label: envLabel(current), color: envColor(current), desc: null }, ...list] : list;
  });
  protected readonly channels = signal<AlertChannel[]>([]);
  protected readonly probes = signal<Probe[]>([]);
  protected readonly slos = signal<Slo[]>([]);
  protected readonly preview = signal<AlertEvaluation[] | null>(null);
  protected readonly previewError = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly confirmDelete = signal(false);
  protected readonly deleting = signal(false);
  protected readonly newChannel = signal<AlertChannel | null>(null);
  protected readonly channelError = signal('');
  protected readonly creatingChannel = signal(false);
  protected readonly channelTypes = CHANNEL_TYPES.map((t) => ({ value: t.value, label: t.value === 'teams' ? 'Teams' : t.label, icon: t.icon }));
  protected readonly chart = signal<{ times: string[]; series: ChartSeries[]; unit: string | null; title: string } | null>(null);
  private readonly previews = new Subject<AlertRule>();

  protected readonly breaching = computed(() => (this.preview() ?? []).filter((e) => e.breach));
  protected readonly needsField = computed(() => AGGREGATES.find((a) => a.value === this.r().aggregate)?.numeric ?? false);
  protected readonly httpUnit = computed(() => HTTP_STATS.find((s) => s.value === this.r().stat)?.unit ?? '');
  protected readonly serviceChoice = computed(() => (this.r().perService ? '*' : (this.r().service ?? '')));
  /** Règle telle qu'elle sera enregistrée (nom compris), pour l'aperçu du message. */
  protected readonly previewRule = computed(() => ({ ...this.r(), name: this.customName().trim() || this.autoName() }));

  protected readonly autoName = computed(() => {
    const d = describeRule(this.r(), this.probes(), this.slos());
    return d.charAt(0).toUpperCase() + d.slice(1);
  });
  protected readonly severityLabel = computed(() => (this.r().severity === 'critical' ? 'Alerte critique' : 'Avertissement'));
  protected readonly notification = computed(() => describeNotification(this.r(), this.channels()));
  protected readonly chartTimes = computed(() => this.chart()?.times ?? []);
  /** Séries chargées, plus la ligne de seuil qui suit la saisie sans attendre un rechargement. */
  protected readonly chartSeries = computed(() => {
    const c = this.chart();
    if (!c) return [];
    const t = this.r().threshold;
    return [...c.series, { label: 'seuil', color: '#e06c6c', values: c.times.map(() => t), dash: [5, 4] }];
  });
  protected readonly chartThreshold = computed(() => ({ value: this.r().threshold, comparison: this.r().comparison }));
  protected readonly chartUnit = computed(() => this.chart()?.unit ?? null);
  protected readonly chartTitle = computed(() => this.chart()?.title ?? '');

  /** Valeur actuelle face au seuil (alertes à seuil) : la plus défavorable quand l'alerte est séparée par service ou valeur. */
  protected readonly gauge = computed(() => {
    const rule = this.r();
    if (rule.kind !== 'http' && rule.kind !== 'query' && rule.kind !== 'slo') return null;
    const values = (this.preview() ?? []).map((e) => e.value).filter((v): v is number => v !== null && Number.isFinite(v));
    if (!values.length) return null;
    const value = rule.comparison === 'below' ? Math.min(...values) : Math.max(...values);
    const unit = rule.kind === 'http' ? this.httpUnit() : rule.kind === 'slo' ? '×' : (this.chartUnit() ?? '');
    return { value, unit, label: values.length > 1 ? 'Valeur la plus défavorable' : 'Valeur actuelle' };
  });

  /** Ce qui manque à la condition (bloquant) ou mérite attention (étape 2). */
  protected readonly conditionIssue = computed<{ text: string; blocking: boolean } | null>(() => {
    const r = this.r();
    if (r.kind === 'query' && this.needsField() && !r.field?.trim()) return { text: 'indiquez le champ à mesurer', blocking: true };
    if ((r.kind === 'http' || r.kind === 'query' || r.kind === 'slo') && !Number.isFinite(r.threshold)) return { text: 'seuil invalide', blocking: true };
    if (r.kind === 'probe' && !this.probes().length) return { text: 'aucune sonde à surveiller', blocking: false };
    if (r.kind === 'slo' && !this.slos().length) return { text: 'aucun objectif à surveiller', blocking: false };
    return null;
  });

  /** Étapes et leur état, pour le fil du résumé : c'est aussi la liste de vérification avant création. */
  protected readonly stepStates = computed(() => {
    const r = this.r();
    const issue = this.conditionIssue();
    const chosen = this.channels().filter((c) => r.channels.includes(c.id)).length;
    const custom = !!(r.titleTemplate || r.bodyTemplate);
    const steps: { n: number; title: string; detail: string; state: StepState }[] = [
      { n: 1, title: 'Que surveiller', detail: ALERT_KINDS.find((k) => k.value === r.kind)?.label ?? r.kind, state: 'ok' },
      { n: 2, title: 'Quand déclencher', detail: issue ? issue.text.charAt(0).toUpperCase() + issue.text.slice(1) : this.conditionShort(),
        state: issue ? (issue.blocking ? 'todo' : 'warn') : 'ok' },
      { n: 3, title: 'Qui prévenir', state: chosen ? 'ok' : 'warn',
        detail: chosen ? `${r.severity === 'critical' ? 'Critique' : 'Avertissement'} · ${chosen} ${chosen > 1 ? 'canaux' : 'canal'}` : 'Personne : visible dans Wolflog seulement' },
      { n: 4, title: 'Nom et message', state: 'ok',
        detail: `${this.customName().trim() ? 'Nom personnalisé' : 'Nom automatique'} · ${custom ? 'message personnalisé' : 'message par défaut'}` },
    ];
    return steps;
  });
  protected readonly blocking = computed(() => this.stepStates().find((s) => s.state === 'todo') ?? null);
  /** Étape la plus visible à l'écran. */
  protected readonly current = signal(1);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const io = new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) this.current.set(+((e.target as HTMLElement).dataset['step'] ?? 1));
      }, { rootMargin: '-30% 0px -60% 0px' });
      this.host.nativeElement.querySelectorAll('section.step[data-step]').forEach((s) => io.observe(s));
      this.destroyRef.onDestroy(() => io.disconnect());
    });

    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    this.api.environmentStats().subscribe((list) => this.environments.set(list));
    this.api.probes({ from: '1h', to: '' }, 1).subscribe((p) => this.probes.set(p.map((x) => x.probe)));
    this.api.slos().subscribe((s) => this.slos.set(s.map((x) => x.slo)));

    effect(() => {
      const id = this.id();
      untracked(() => {
        if (id) {
          this.api.alerts().subscribe((l) => {
            const found = l.rules.find((x) => x.rule.id === id)?.rule;
            if (found) {
              this.r.set({ ...newRule(found.kind), ...found, channels: [...found.channels] });
              this.customName.set(describeRule(found).toLowerCase() === found.name.toLowerCase() ? '' : found.name);
            } else this.error.set('Alerte introuvable.');
          });
        } else {
          const kind = (this.kind() || 'http') as AlertKind;
          const prefill: Partial<AlertRule> = {};
          if (this.service()) prefill.service = this.service();
          if (this.stat()) prefill.stat = this.stat();
          if (this.source()) prefill.source = this.source() as AlertRule['source'];
          if (this.filter()) prefill.filter = this.filter();
          if (this.agg()) prefill.aggregate = this.agg();
          if (this.field()) prefill.field = this.field();
          if (this.groupBy()) prefill.groupBy = this.groupBy();
          if (this.route()) prefill.route = this.route();
          if (this.target()) prefill.targetId = this.target();
          this.r.set({ ...newRule(kind), ...prefill });
          this.customName.set(this.name() ?? '');
        }
      });
    });

    // Canaux « par défaut » cochés d'office sur une nouvelle alerte.
    this.api.channels().subscribe((c) => {
      this.channels.set(c);
      if (!this.id() && !this.r().channels.length) this.patch({ channels: c.filter((x) => x.default).map((x) => x.id) });
    });

    this.previews
      .pipe(
        debounceTime(400),
        switchMap((rule) =>
          this.api.previewAlert(rule).pipe(catchError((e) => {
            this.previewError.set(e?.error?.error ?? 'Aperçu impossible.');
            return of(null);
          })),
        ),
      )
      .subscribe((p) => {
        if (p) {
          this.previewError.set('');
          this.preview.set(p);
        }
      });

    // Aperçu et graphique suivent la condition de la règle (pas son message, ses canaux ni son nom).
    let evaluated = '';
    let charted = '';
    effect(() => {
      const rule = this.r();
      untracked(() => {
        const evalKey = JSON.stringify({ ...rule, name: '', channels: [], titleTemplate: null, bodyTemplate: null, runbook: null, repeatMinutes: 0, notifyResolved: false });
        if (evalKey !== evaluated) {
          evaluated = evalKey;
          this.previews.next({ ...rule, name: rule.name || 'aperçu' });
        }
        const chartKey = JSON.stringify([rule.kind, rule.stat, rule.service, rule.perService, rule.route, rule.source, rule.filter, rule.aggregate, rule.field, rule.groupBy, rule.windowMinutes]);
        if (chartKey !== charted) {
          charted = chartKey;
          this.loadChart(rule);
        }
      });
    });
  }

  /** Condition en quelques mots, pour le fil des étapes. */
  private conditionShort() {
    const r = this.r();
    const win = WINDOWS.find((w) => w.value === r.windowMinutes)?.label ?? `${r.windowMinutes} min`;
    const wait = r.forMinutes ? ` · après ${r.forMinutes} min` : '';
    const n = r.threshold.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    const op = r.comparison === 'below' ? '<' : '>';
    switch (r.kind) {
      case 'http': return `${op} ${n} ${this.httpUnit()} sur ${win}${wait}`;
      case 'query': return `${op} ${n} sur ${win}${wait}`;
      case 'slo': return `budget consommé ${n}× trop vite sur ${win}${wait}`;
      case 'silence': return `rien reçu pendant ${win}${wait}`;
      case 'probe': return `${this.probes().find((p) => p.id === r.targetId)?.name ?? 'une des sondes'} ne répond plus${wait}`;
      case 'error': return r.service ? `nouvelle erreur dans ${r.service}` : 'nouvelle erreur, tous les services';
      default: return 'disque, écriture, réception, envoi';
    }
  }

  /** Va à une étape depuis le fil : défilement doux, halo sur l'étape, focus sur le champ à compléter. */
  protected goTo(n: number) {
    const el = this.host.nativeElement.querySelector<HTMLElement>(`section.step[data-step="${n}"]`);
    if (!el) return;
    const smooth = document.documentElement.dataset['motion'] !== 'off';
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    if (smooth) el.animate({ opacity: [0, 1, 0] }, { duration: 1400, delay: 200, easing: 'ease-out', pseudoElement: '::after' });
    if (n === 2 && this.conditionIssue()?.blocking) el.querySelector<HTMLElement>('.field-in, .num-in')?.focus({ preventScroll: true });
    this.current.set(n);
  }

  protected readonly ago = (iso: string | null | undefined) => timeAgo(iso ?? null);
  protected readonly exact = (iso: string | null | undefined) => exactDate(iso ?? null);

  /** Dernier envoi du canal en échec (plus récent que le dernier succès). */
  protected failing(c: AlertChannel) {
    return !!c.lastErrorAt && (!c.lastSentAt || new Date(c.lastErrorAt) > new Date(c.lastSentAt));
  }

  private chartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Historique de la valeur surveillée, avec la ligne de seuil. */
  private loadChart(rule: AlertRule) {
    if (this.chartTimer) clearTimeout(this.chartTimer);
    this.chartTimer = setTimeout(() => {
      const from = rule.windowMinutes >= 360 ? '7d' : rule.windowMinutes >= 60 ? '24h' : '6h';
      const range = { from, to: '' };
      // La ligne de seuil est ajoutée à l'affichage (chartSeries) : elle suit la saisie.
      const withThreshold = (times: string[], series: ChartSeries[], unit: string | null, title: string) => this.chart.set({ times, series, unit, title });
      if (rule.kind === 'http') {
        const stat = HTTP_STATS.find((s) => s.value === rule.stat) ?? HTTP_STATS[0];
        this.api.requestSeries(range, { service: rule.service ?? '', q: rule.route ?? '', direction: 'in' }, stat.series, rule.perService ? 'service' : 'none')
          .subscribe({
            next: (d: MetricData) => withThreshold(d.times, d.series.slice(0, 6).map((s, i) => ({ label: s.group, color: paletteColor(i), values: s.values })),
              d.unit === 'req/s' ? '/s' : d.unit, `${stat.label.replace(/^l[ae] /, '').replace(/^./, (c) => c.toUpperCase())}, ${from === '6h' ? '6 dernières heures' : from === '24h' ? '24 dernières heures' : '7 derniers jours'}`),
            error: () => this.chart.set(null),
          });
      } else if (rule.kind === 'query') {
        this.api.customQuery(range, {
          source: rule.source ?? 'logs', filter: rule.filter, agg: rule.aggregate ?? 'count', field: rule.field,
          groupBy: rule.groupBy, view: 'timeseries', limit: 6, service: rule.service,
        }).subscribe({
          next: (d: CustomResult) => withThreshold(d.times ?? [], (d.series ?? []).map((s, i) => ({ label: s.group, color: paletteColor(i), values: s.values })),
            d.unit, `Valeur calculée, ${from === '6h' ? '6 dernières heures' : from === '24h' ? '24 dernières heures' : '7 derniers jours'} (par intervalle)`),
          error: () => this.chart.set(null),
        });
      } else {
        this.chart.set(null);
      }
    }, 500);
  }

  protected patch(change: Partial<AlertRule>) {
    this.r.update((r) => ({ ...r, ...change }));
  }

  protected setKind(kind: AlertKind) {
    if (kind === this.r().kind) return;
    const fresh = newRule(kind);
    this.r.update((r) => ({ ...r, kind, threshold: fresh.threshold, windowMinutes: fresh.windowMinutes, minCount: fresh.minCount, comparison: 'above' }));
    this.preview.set(null);
  }

  protected defaultThreshold(stat: string) {
    return stat === 'errorRate' ? 5 : stat === 'rate' ? 1 : stat === 'p50' ? 300 : 1000;
  }

  protected setServiceChoice(v: string) {
    this.patch(v === '*' ? { perService: true, service: null } : { perService: false, service: v || null });
  }

  protected toggleChannel(id: string) {
    const list = this.r().channels;
    this.patch({ channels: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] });
  }

  protected startChannel() {
    this.channelError.set('');
    this.newChannel.set({ id: '', name: '', type: 'email', target: '', default: this.channels().length === 0 });
  }

  protected patchChannel(change: Partial<AlertChannel>) {
    this.newChannel.update((c) => (c ? { ...c, ...change } : c));
  }

  /** Canal créé sans quitter la page, puis coché pour cette alerte. */
  protected createChannel() {
    const c = this.newChannel();
    if (!c) return;
    this.channelError.set('');
    this.creatingChannel.set(true);
    this.api.saveChannel(c).subscribe({
      next: (saved) => {
        this.creatingChannel.set(false);
        this.channels.update((l) => [...l, saved]);
        this.patch({ channels: [...this.r().channels, saved.id] });
        this.newChannel.set(null);
        this.toasts.ok(`Canal « ${saved.name} » ajouté et coché`, channelIcon(saved.type));
      },
      error: (e) => {
        this.creatingChannel.set(false);
        const message = e?.error?.error ?? 'Canal invalide.';
        this.channelError.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected channelType(t: string) {
    return channelTypeLabel(t);
  }

  /** Cible d'un objectif, en pourcentage français (« 99,9 % »). */
  protected pct(v: number) {
    return v.toLocaleString('fr-FR', { maximumFractionDigits: 3 }) + ' %';
  }

  protected save() {
    // Vérification avant création : on mène à l'étape incomplète plutôt que d'envoyer une règle qui ne marcherait pas.
    const missing = this.blocking();
    if (missing) {
      this.goTo(missing.n);
      this.toasts.error(`À compléter : ${missing.detail.charAt(0).toLowerCase() + missing.detail.slice(1)}`);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    const isNew = !this.r().id;
    const rule = { ...this.r(), name: this.customName().trim() || this.autoName() };
    this.api.saveAlert(rule).subscribe({
      next: () => {
        this.toasts.ok(isNew ? 'Alerte créée' : 'Alerte enregistrée', 'bell');
        // Évaluation immédiate : l'état de la règle est à jour en arrivant sur la liste.
        this.api.runAlerts().subscribe({ complete: () => this.done(), error: () => this.done() });
      },
      error: (e) => {
        this.busy.set(false);
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.error.set(message);
        this.toasts.error(message);
      },
    });
  }

  private done() {
    this.state.refresh();
    this.router.navigate(['/alerts'], { queryParams: { tab: 'rules' } });
  }

  protected remove() {
    this.deleting.set(true);
    this.api.deleteAlert(this.r().id).subscribe({
      next: () => {
        this.toasts.ok('Alerte supprimée', 'trash');
        this.done();
      },
      error: (e) => {
        this.deleting.set(false);
        this.confirmDelete.set(false);
        this.toasts.error(e?.error?.error ?? 'Suppression impossible.');
      },
    });
  }
}
