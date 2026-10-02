import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ActiveAlert, AlertChannel, AlertEventItem, AlertRule, AlertRuleInfo, ChannelType, NotificationSettings } from '../core/models';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { formatTime, timeAgo } from '../core/format';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { CHANNEL_TYPES, channelIcon, describeRule, kindIcon, kindLabel } from '../shared/alert-rules';
import { MessageComposer } from '../shared/message-composer';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

type Tab = 'active' | 'rules' | 'history' | 'channels';

/** Clé de jour (date locale) d'un horodatage. */
const dayKey = (iso: string) => new Date(iso).toDateString();

/** « Aujourd'hui », « Hier », sinon « Lundi 28 septembre » (avec l'année si ce n'est pas l'année en cours). */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Aujourd’hui';
  if (diff === 1) return 'Hier';
  const label = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Alertes : en cours, règles, historique (groupé par jour) et canaux de notification,
 * avec les réglages d'envoi et le message par défaut pour les administrateurs.
 */
@Component({
  selector: 'wl-alerts',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, AgoPipe, TimePipe, MessageComposer, NavIcon, Skeleton],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Alertes</h1>
        <div class="seg tabs">
          <button [class.on]="tab() === 'active'" (click)="go('active')">
            <wl-nav-icon name="bolt" [size]="14" />En cours
            @if (active().length) { <span class="count" [class.hot]="firing() > 0" [title]="firingTitle()">{{ active().length }}</span> }
          </button>
          <button [class.on]="tab() === 'rules'" (click)="go('rules')">
            <wl-nav-icon name="list" [size]="14" />Règles
            @if (rules().length) { <span class="count">{{ rules().length }}</span> }
          </button>
          <button [class.on]="tab() === 'history'" (click)="go('history')"><wl-nav-icon name="clock" [size]="14" />Historique</button>
          <button [class.on]="tab() === 'channels'" (click)="go('channels')"><wl-nav-icon name="chat" [size]="14" />Canaux</button>
        </div>
        <span class="spacer"></span>
        @if (session.canEdit()) {
          <a class="btn primary" routerLink="/alerts/new"><wl-nav-icon name="plus" [size]="15" />Nouvelle alerte</a>
        }
      </div>

      <ng-template #startersTpl>
        @if (session.canEdit()) {
          <div class="starters">
            <p>Pour commencer, choisissez une alerte courante : elle s'ouvre pré-remplie, avec la valeur actuelle.</p>
            @for (s of starters; track s.label) {
              <a class="btn starter" routerLink="/alerts/new" [queryParams]="s.query" [style.--i]="$index"><wl-nav-icon [name]="s.icon" [size]="15" />{{ s.label }}</a>
            }
          </div>
        }
      </ng-template>

      <div class="split">
        <div class="main">
          @switch (tab()) {
            @case ('active') {
              <section class="panel" animate.enter="tab-in">
                @if (!loaded().active) {
                  <wl-skeleton [rows]="4" />
                } @else if (active().length) {
                  <table class="list">
                    <thead><tr><th>État</th><th>Alerte</th><th>Depuis</th><th></th></tr></thead>
                    <tbody>
                      @for (a of active(); track a.id) {
                        <tr [class]="a.status === 'firing' ? 'firing ' + a.severity : 'waiting'">
                          <td class="nowrap">
                            <span class="pill" [class]="a.status === 'firing' ? a.severity : 'pending'">
                              <wl-nav-icon [name]="a.status === 'firing' ? (a.severity === 'critical' ? 'siren' : 'warning') : 'clock'" [size]="12" />{{ a.status === 'firing' ? (a.severity === 'critical' ? 'Critique' : 'Avertissement') : 'En attente' }}
                            </span>
                            @if (a.muted) { <span class="snooze" title="Notifications coupées pour cette règle"><wl-nav-icon name="mute" [size]="12" />sourdine</span> }
                          </td>
                          <td class="msg">
                            <div>{{ a.message }}</div>
                            <div class="muted small sub">
                              <span>{{ a.ruleName }}</span>
                              @if (a.runbook) { <span class="runbook" [title]="'Consigne : ' + a.runbook"><wl-nav-icon name="info" [size]="12" />{{ a.runbook }}</span> }
                            </div>
                          </td>
                          <td class="nowrap muted" [title]="a.since | time: true">{{ a.since | ago }}</td>
                          <td class="acts nowrap">
                            @if (a.link) { <a class="btn" [routerLink]="path(a.link)" [queryParams]="query(a.link)"><wl-nav-icon name="eye" [size]="13" />Voir les données</a> }
                            @if (session.canEdit()) {
                              <button class="btn ghost" (click)="mute(a.ruleId, a.muted ? 0 : 60)"><wl-nav-icon [name]="a.muted ? 'bell' : 'mute'" [size]="13" />{{ a.muted ? 'Réactiver' : 'Sourdine 1 h' }}</button>
                              <button class="btn ghost" (click)="editById(a.ruleId)"><wl-nav-icon name="edit" [size]="13" />Modifier la règle</button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">
                    Aucune alerte en cours.
                    @if (loaded().rules && !rules().length) {
                      <ng-container *ngTemplateOutlet="startersTpl" />
                    } @else if (rules().length) {
                      <span class="calm">Les règles sont surveillées en continu ; les alertes apparaîtront ici dès qu'une condition sera remplie.</span>
                      <div class="cta"><button class="btn" (click)="go('rules')"><wl-nav-icon name="list" [size]="15" />Voir les règles ({{ rules().length }})</button></div>
                    }
                  </div>
                }
              </section>
            }

            @case ('rules') {
              <section class="panel" animate.enter="tab-in">
                @if (!loaded().rules) {
                  <wl-skeleton [rows]="5" />
                } @else if (rules().length) {
                  <table class="list">
                    <thead><tr><th>État</th><th>Nom</th><th>Condition</th><th>Prévient</th><th></th><th></th></tr></thead>
                    <tbody>
                      @for (i of rules(); track i.rule.id) {
                        <tr [class.click]="session.canEdit()" [class.hot]="i.status === 'firing' && i.rule.severity === 'critical'"
                            [class.warm]="i.status === 'firing' && i.rule.severity === 'warning'" [class.off]="i.status === 'disabled'" (click)="edit(i.rule)">
                          <td class="nowrap">
                            <span class="pill" [class]="stateClass(i)" [title]="stateTitle(i)">
                              <wl-nav-icon [name]="stateIcon(i)" [size]="12" />
                              {{ stateLabel(i) }}
                            </span>
                          </td>
                          <td>
                            <div class="name">
                              <span class="kind" [title]="kindLabel(i.rule.kind)"><wl-nav-icon [name]="kindIcon(i.rule.kind)" [size]="14" /></span>
                              <span>{{ i.rule.name }}</span>
                            </div>
                          </td>
                          <td class="muted small cond">{{ sameAsName(i.rule) ? '' : describe(i.rule) }}</td>
                          <td class="small">
                            <div class="chips">
                              @for (c of ruleChannels(i.rule); track c.id) {
                                <span class="chip" [title]="channelType(c.type).label + ' · ' + c.target"><wl-nav-icon [name]="channelIcon(c.type)" [size]="12" /><span class="ellipsis">{{ c.name }}</span></span>
                              } @empty {
                                <span class="muted nowrap" title="Visible dans Wolflog (barre du haut, page Alertes), sans notification">Wolflog seulement</span>
                              }
                            </div>
                          </td>
                          <td class="acts nowrap" (click)="$event.stopPropagation()">
                            @if (session.canEdit()) {
                              <input type="checkbox" class="switch" [checked]="i.rule.enabled" (change)="toggle(i.rule, $event)"
                                     [title]="i.rule.enabled ? 'Désactiver la règle' : 'Activer la règle'" [attr.aria-label]="i.rule.enabled ? 'Désactiver la règle' : 'Activer la règle'" />
                            }
                          </td>
                          <td class="chev">@if (session.canEdit()) { <wl-nav-icon name="chevron-right" [size]="15" /> }</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">
                    Aucune règle d'alerte.
                    <ng-container *ngTemplateOutlet="startersTpl" />
                  </div>
                }
              </section>
            }

            @case ('history') {
              <section class="panel" animate.enter="tab-in">
                @if (!loaded().history) {
                  <wl-skeleton [rows]="5" />
                } @else if (history().length) {
                  <table class="list">
                    <thead><tr><th>Heure</th><th>Évènement</th><th>Message</th><th>Prévenus</th></tr></thead>
                    <tbody>
                      @for (h of historyRows(); track h.e.id) {
                        @if (h.day) {
                          <tr class="day"><td colspan="4"><span>{{ h.day }}</span><em>{{ h.count }} évènement{{ h.count > 1 ? 's' : '' }}</em></td></tr>
                        }
                        <tr>
                          <td class="mono small nowrap" [title]="exact(h.e.at)">{{ h.e.at | time }}</td>
                          <td class="nowrap">
                            <span class="pill" [class]="h.e.status === 'firing' ? h.e.severity : 'ok'">
                              <wl-nav-icon [name]="h.e.status === 'firing' ? (h.e.severity === 'critical' ? 'siren' : 'warning') : 'check'" [size]="12" />
                              {{ h.e.status === 'firing' ? 'Déclenchée' : 'Résolue' }}
                            </span>
                          </td>
                          <td class="msg">
                            <div>{{ h.e.message }}</div>
                            <div class="muted small">{{ h.e.ruleName }}</div>
                          </td>
                          <td class="small">
                            <div class="chips">
                              @for (n of h.e.notifiedChannels; track $index) {
                                <span class="chip" [title]="n"><wl-nav-icon name="bell" [size]="11" /><span class="ellipsis">{{ n }}</span></span>
                              } @empty {
                                <span class="muted">–</span>
                              }
                            </div>
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">
                    Aucune alerte déclenchée sur cette période.
                    <span class="calm">Élargissez la période pour remonter plus loin dans l'historique.</span>
                  </div>
                }
              </section>
            }

            @case ('channels') {
              <section class="panel" animate.enter="tab-in">
                <div class="panel-head">
                  <span class="head-icon"><wl-nav-icon name="chat" /></span>
                  <h2>Canaux de notification</h2>
                  <span class="spacer"></span>
                  @if (session.isAdmin()) { <a class="btn" routerLink="/alerts/channels/new"><wl-nav-icon name="plus" [size]="15" />Ajouter un canal</a> }
                </div>
                @if (!loaded().channels) {
                  <wl-skeleton [rows]="3" />
                } @else if (channels().length) {
                  <table class="list">
                    <thead><tr><th>Nom</th><th>Type</th><th>Destination</th><th>Dernier envoi</th><th></th></tr></thead>
                    <tbody>
                      @for (c of channels(); track c.id) {
                        <tr [class.click]="session.isAdmin()" (click)="session.isAdmin() && router.navigate(['/alerts/channels', c.id])">
                          <td>
                            <div class="name">
                              <span class="kind"><wl-nav-icon [name]="channelIcon(c.type)" [size]="14" /></span>
                              <span>{{ c.name }}</span>
                              @if (c.default) { <span class="tag def" title="Coché d'office sur les nouvelles alertes">par défaut</span> }
                            </div>
                          </td>
                          <td class="small nowrap">{{ channelType(c.type).label }}</td>
                          <td class="small mono ellipsis target" [title]="c.target">{{ c.target }}</td>
                          <td class="small nowrap">
                            @if (c.lastErrorAt && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt)) {
                              <span class="sent ko" [title]="failTitle(c)"><wl-nav-icon name="warning" [size]="13" />échec {{ c.lastErrorAt | ago }}</span>
                            } @else if (c.lastSentAt) {
                              <span class="sent" [title]="exact(c.lastSentAt)"><wl-nav-icon name="check" [size]="13" />{{ c.lastSentAt | ago }}</span>
                            } @else {
                              <span class="muted">jamais</span>
                            }
                          </td>
                          <td class="chev">@if (session.isAdmin()) { <wl-nav-icon name="chevron-right" [size]="15" /> }</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">
                    Aucun canal. Sans canal, les alertes restent visibles ici et dans la barre du haut.
                    @if (session.isAdmin()) {
                      <div class="cta"><a class="btn primary" routerLink="/alerts/channels/new"><wl-nav-icon name="plus" [size]="15" />Ajouter un canal</a></div>
                    }
                  </div>
                }
              </section>

              @if (session.isAdmin() && settings(); as s) {
                <section class="panel" animate.enter="tab-in">
                  <div class="panel-head">
                    <span class="head-icon"><wl-nav-icon name="mail" /></span>
                    <h2>Envoi des e-mails et liens</h2>
                    <span class="spacer"></span>
                    <span class="smtp" [class.on]="smtpReady()" [title]="smtpReady() ? 'Les e-mails partent par le serveur SMTP enregistré' : 'Renseignez le serveur SMTP pour envoyer les e-mails'">
                      <wl-nav-icon [name]="smtpReady() ? 'ok' : 'warning'" [size]="12" />{{ smtpReady() ? 'SMTP configuré' : 'SMTP à configurer' }}
                    </span>
                  </div>
                  <form class="panel-body settings" (ngSubmit)="saveSettings()">
                    <label class="wide">Adresse publique de Wolflog <input name="url" [(ngModel)]="s.publicUrl" [placeholder]="origin" />
                      <span class="muted small">Utilisée pour les liens « Voir dans Wolflog » des notifications.</span></label>
                    <label>Serveur SMTP <input name="host" [(ngModel)]="s.smtpHost" placeholder="smtp.office365.com" /></label>
                    <label>Port <input name="port" type="number" [(ngModel)]="s.smtpPort" /></label>
                    <label class="check" title="Connexion chiffrée avec le serveur SMTP"><input type="checkbox" class="switch" name="ssl" [(ngModel)]="s.smtpSsl" /> TLS</label>
                    <label>Utilisateur <input name="user" [(ngModel)]="s.smtpUser" autocomplete="off" /></label>
                    <label>Mot de passe <input name="pwd" type="password" [(ngModel)]="s.smtpPassword" autocomplete="new-password"
                      [placeholder]="s.hasPassword ? 'inchangé' : ''" /></label>
                    <label>Expéditeur <input name="from" [(ngModel)]="s.from" placeholder="wolflog@mondomaine.fr" /></label>
                    <div class="actions wide">
                      <button class="btn primary" type="submit" [disabled]="savingSettings()" [class.done]="settingsSaved()">
                        @if (savingSettings()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="settingsSaved() ? 'ok' : 'check'" [size]="15" /> }
                        {{ settingsSaved() ? 'Enregistré' : 'Enregistrer' }}
                      </button>
                    </div>
                  </form>
                </section>

                <section class="panel" animate.enter="tab-in">
                  <div class="panel-head">
                    <span class="head-icon"><wl-nav-icon name="text" /></span>
                    <h2>Message par défaut</h2>
                    <span class="muted small">utilisé par toutes les alertes sans message personnalisé</span>
                    <span class="spacer"></span>
                    @if (templateError()) { <span class="danger small err" animate.enter="fade-in"><wl-nav-icon name="warning" [size]="13" />{{ templateError() }}</span> }
                    <button class="btn primary" (click)="saveTemplates()" [disabled]="savingTemplates()" [class.done]="templateSaved()">
                      @if (savingTemplates()) { <span class="spinner"></span> } @else { <wl-nav-icon [name]="templateSaved() ? 'ok' : 'check'" [size]="15" /> }
                      {{ templateSaved() ? 'Message enregistré' : 'Enregistrer le message' }}
                    </button>
                  </div>
                  <div class="panel-body">
                    <wl-message-composer mode="default" [title]="s.titleTemplate ?? null" [body]="s.bodyTemplate ?? null" [channels]="channels()"
                      (titleChange)="patchSettings({ titleTemplate: $event })" (bodyChange)="patchSettings({ bodyTemplate: $event })" />
                  </div>
                </section>
              }
            }
          }
        </div>

      </div>
    </div>
  `,
  styles: `
    /* Onglets : icône qui s'anime, compteur en pastille (rouge et pulsant si une alerte est déclenchée). */
    .tabs button { display: inline-flex; align-items: center; gap: 6px; }
    .tabs wl-nav-icon { opacity: .7; transition: transform .35s var(--spring), opacity .2s, color .2s; }
    .tabs button:hover wl-nav-icon { opacity: 1; transform: scale(1.12) rotate(-6deg); }
    .tabs button.on wl-nav-icon { opacity: 1; color: var(--accent); }
    .count { position: relative; display: inline-grid; place-items: center; min-width: 18px; height: 17px; padding: 0 5px; border-radius: 999px;
      background: var(--surface-3); color: var(--text-2); font: 650 10.5px/1 var(--mono); font-variant-numeric: tabular-nums; animation: pop-in .45s var(--spring) backwards; }
    .count.hot { background: var(--danger); color: var(--on-accent); }

    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .main { display: grid; gap: 14px; min-width: 0; }
    .tab-in { animation: tab-in .4s var(--ease) backwards; }
    .main > .tab-in:nth-child(2) { animation-delay: 70ms; }
    .main > .tab-in:nth-child(3) { animation-delay: 140ms; }
    @keyframes tab-in { from { opacity: 0; transform: translateY(8px); } }

    /* États en pastille : point de couleur, qui pulse pour une alerte déclenchée. */
    .pill { --tone: var(--text-3); display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 8px; border-radius: 999px;
      font: 600 11.5px/1 var(--sans); white-space: nowrap; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 26%, transparent); }
    .pill.critical { --tone: var(--danger); }
    .pill.warning, .pill.pending { --tone: var(--warn); }
    .pill.pending { opacity: .85; }
    .pill.ok { --tone: var(--ok); }
    .pill.disabled, .pill.snoozed { --tone: var(--text-3); }
    .pill wl-nav-icon { flex: none; }
    .snooze { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; color: var(--text-3); font-size: 11.5px; }

    /* Lignes : liseré de gravité, règles désactivées estompées, chevron qui glisse au survol. */
    tr.firing.critical td:first-child, tr.hot td:first-child { box-shadow: inset 3px 0 0 var(--danger); }
    tr.firing.warning td:first-child, tr.warm td:first-child { box-shadow: inset 3px 0 0 var(--warn); }
    tr.off td:not(.acts) { opacity: .55; transition: opacity .25s; }
    tr.off:hover td { opacity: 1; }
    .msg { max-width: 0; width: 60%; overflow-wrap: anywhere; }
    .sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 2px; }
    .runbook { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; color: var(--text-2); }
    .cond { max-width: 0; width: 40%; }
    .target { max-width: 0; width: 40%; }
    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 26px; padding: 0 10px; gap: 5px; font-size: 12px; }
    .acts .switch { vertical-align: middle; }
    .chev { width: 1%; padding-left: 0; color: var(--text-3); }
    .chev wl-nav-icon { transition: transform .3s var(--spring), color .2s; }
    tr.click:hover .chev wl-nav-icon { transform: translateX(4px); color: var(--accent); }
    .name { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .kind { display: grid; place-items: center; width: 26px; height: 26px; flex: none; border-radius: 8px; color: var(--accent);
      background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); transition: transform .4s var(--spring); }
    tr.click:hover .kind { transform: scale(1.1) rotate(-8deg); }
    .tag.def { color: var(--accent); font-size: 10px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; max-width: 190px; height: 21px; padding: 0 8px; border-radius: 999px;
      border: 1px solid var(--border-soft); background: var(--surface-2); color: var(--text-2); font-size: 11.5px; white-space: nowrap; }
    .chip wl-nav-icon { color: var(--accent); }
    .sent { display: inline-flex; align-items: center; gap: 5px; color: var(--text-2); }
    .sent wl-nav-icon { color: var(--ok); }
    .sent.ko, .sent.ko wl-nav-icon { color: var(--danger); }

    /* Historique : séparateurs de jour. */
    tr.day td { padding: 16px 16px 6px; border-bottom: 1px solid var(--border); background: none; }
    tr.day span { font: 650 11px var(--sans); color: var(--text-2); text-transform: uppercase; letter-spacing: .07em; }
    tr.day em { margin-left: 10px; font-style: normal; font-size: 11.5px; color: var(--text-3); }

    /* États vides : suggestions d'alertes courantes, en cascade. */
    .calm { display: block; margin-top: 4px; font-size: 12px; }
    .cta { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
    .starters { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px; }
    .starters p { flex-basis: 100%; margin: 0 0 4px; }
    .starter { animation: pop-in .45s var(--spring) backwards; animation-delay: calc(150ms + var(--i) * 60ms); }
    .starter wl-nav-icon { color: var(--accent); transition: transform .4s var(--spring); }
    .starter:hover wl-nav-icon { transform: scale(1.18) rotate(-8deg); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(6px) scale(.92); } }

    /* Réglages d'envoi et message par défaut. */
    .head-icon { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 9px; color: var(--accent); background: var(--accent-soft); }
    .smtp { display: inline-flex; align-items: center; gap: 7px; height: 22px; padding: 0 10px; border-radius: 999px; font-size: 11.5px;
      color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
    .smtp.on { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
    .settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; max-width: 820px; align-items: end; }
    .settings .wide { grid-column: 1 / -1; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); height: 32px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .btn.done wl-nav-icon { animation: pop-in .45s var(--spring); }
    .err { display: inline-flex; align-items: center; gap: 5px; }
    .fade-in { animation: pop-in .35s var(--spring); }
    .spinner { width: 13px; height: 13px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(1turn); } }
    p { margin: 0; }
    @media (max-width: 900px) {
      .settings { grid-template-columns: minmax(0, 1fr); }
    }
  `,
})
export class AlertsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly router = inject(Router);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);

  // Paramètres d'URL : onglet, et création pré-remplie depuis une autre page (?edit=new&kind=http&service=…).
  readonly tabParam = input<string>('', { alias: 'tab' });
  readonly editParam = input<string>('', { alias: 'edit' });

  protected readonly tab = signal<Tab>('active');
  protected readonly rules = signal<AlertRuleInfo[]>([]);
  protected readonly active = signal<ActiveAlert[]>([]);
  protected readonly history = signal<AlertEventItem[]>([]);
  protected readonly channels = signal<AlertChannel[]>([]);
  protected readonly settings = signal<NotificationSettings | null>(null);
  protected readonly settingsSaved = signal(false);
  protected readonly savingSettings = signal(false);
  /** Serveur SMTP enregistré (et non simplement saisi). */
  protected readonly smtpReady = signal(false);
  /** Première réponse reçue pour chaque liste : squelette de chargement avant, état vide ou tableau après. */
  protected readonly loaded = signal({ rules: false, active: false, history: false, channels: false });
  protected readonly origin = location.origin;
  protected readonly firing = computed(() => this.active().filter((a) => a.status === 'firing').length);
  protected readonly firingTitle = computed(() => {
    const firing = this.firing();
    const pending = this.active().length - firing;
    return [firing ? `${firing} déclenchée${firing > 1 ? 's' : ''}` : '', pending ? `${pending} en attente` : ''].filter(Boolean).join(', ');
  });
  private readonly channelsById = computed(() => new Map(this.channels().map((c) => [c.id, c])));
  /** Historique avec un séparateur au début de chaque jour (et le nombre d'évènements du groupe). */
  protected readonly historyRows = computed(() => {
    const list = this.history();
    const rows: { e: AlertEventItem; day: string | null; count: number }[] = [];
    let head = -1;
    list.forEach((e, i) => {
      if (i === 0 || dayKey(list[i - 1].at) !== dayKey(e.at)) {
        head = rows.length;
        rows.push({ e, day: dayLabel(e.at), count: 1 });
      } else {
        rows.push({ e, day: null, count: 0 });
        rows[head].count++;
      }
    });
    return rows;
  });
  private loadedOnce = false;

  protected readonly kindIcon = kindIcon;
  protected readonly kindLabel = kindLabel;
  protected readonly channelIcon = channelIcon;

  protected readonly starters: { label: string; icon: string; query: Record<string, string> }[] = [
    { label: "Taux d'erreur HTTP trop élevé", icon: 'percent', query: { kind: 'http', stat: 'errorRate' } },
    { label: 'Nouvelle erreur ou erreur réapparue', icon: 'errors', query: { kind: 'error' } },
    { label: 'Service muet', icon: 'mute', query: { kind: 'silence' } },
    { label: 'Latence p95 trop élevée', icon: 'timer', query: { kind: 'http', stat: 'p95' } },
    { label: 'Santé de Wolflog', icon: 'system', query: { kind: 'health' } },
  ];

  constructor() {
    effect(() => {
      const t = this.tabParam();
      const edit = this.editParam();
      untracked(() => {
        if (t && ['active', 'rules', 'history', 'channels'].includes(t)) this.tab.set(t as Tab);
        // Anciens liens (?edit=new&kind=…, ?edit=<id>) : pages dédiées.
        if (edit === 'new') {
          const query = Object.fromEntries(new URLSearchParams(location.search));
          delete query['edit'];
          delete query['tab'];
          this.router.navigate(['/alerts/new'], { queryParams: query, replaceUrl: true });
        } else if (edit) {
          this.router.navigate(['/alerts', edit], { replaceUrl: true });
        }
      });
    });
    effect(() => {
      this.state.tick();
      this.state.range();
      untracked(() => this.load());
    });
  }

  private load() {
    this.api.alerts().subscribe({
      next: (r) => {
        this.rules.set(r.rules);
        this.markLoaded('rules');
      },
      error: () => this.markLoaded('rules'),
    });
    this.api.activeAlerts().subscribe({
      next: (a) => {
        this.active.set(a.items);
        // Première visite sans alerte en cours : afficher les règles.
        if (!this.loadedOnce && !this.tabParam() && !a.items.length) this.tab.set('rules');
        this.loadedOnce = true;
        this.markLoaded('active');
      },
      error: () => this.markLoaded('active'),
    });
    this.api.alertHistory(this.state.range()).subscribe({
      next: (h) => {
        this.history.set(h);
        this.markLoaded('history');
      },
      error: () => this.markLoaded('history'),
    });
    this.api.channels().subscribe({
      next: (c) => {
        this.channels.set(c);
        this.markLoaded('channels');
      },
      error: () => this.markLoaded('channels'),
    });
    if (this.session.isAdmin() && !this.settings()) {
      this.api.notificationSettings().subscribe((s) => {
        this.settings.set({ ...s, smtpPassword: '' });
        this.smtpReady.set(!!s.smtpHost);
      });
    }
  }

  private markLoaded(list: 'rules' | 'active' | 'history' | 'channels') {
    this.loaded.update((l) => (l[list] ? l : { ...l, [list]: true }));
  }

  protected go(t: Tab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t, edit: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected edit(rule: AlertRule) {
    if (this.session.canEdit()) this.router.navigate(['/alerts', rule.id]);
  }

  protected editById(id: string) {
    this.router.navigate(['/alerts', id]);
  }

  /** Interrupteur d'une règle : en cas d'échec, l'interrupteur revient à l'état réel. */
  protected toggle(rule: AlertRule, event?: Event) {
    const enabled = !rule.enabled;
    this.api.saveAlert({ ...rule, enabled }).subscribe({
      next: () => {
        this.toasts.ok(enabled ? 'Règle activée' : 'Règle désactivée', enabled ? 'bell' : 'pause');
        this.state.refresh();
      },
      error: (e) => {
        if (event?.target instanceof HTMLInputElement) event.target.checked = rule.enabled;
        this.toasts.error(e?.error?.error ?? 'Modification impossible.');
      },
    });
  }

  protected mute(ruleId: string, minutes: number) {
    this.api.muteAlert(ruleId, minutes).subscribe({
      next: () => {
        if (minutes) this.toasts.ok(`Alerte en sourdine pendant ${minutes >= 60 ? minutes / 60 + ' h' : minutes + ' min'}`, 'mute');
        else this.toasts.ok('Notifications réactivées', 'bell');
        this.state.refresh();
      },
      error: (e) => this.toasts.error(e?.error?.error ?? 'Action impossible.'),
    });
  }

  protected describe(rule: AlertRule) {
    return describeRule(rule);
  }

  /** Nom généré automatiquement : inutile de répéter la condition. */
  protected sameAsName(rule: AlertRule) {
    return describeRule(rule).toLowerCase() === rule.name.toLowerCase();
  }

  /** Canaux prévenus par une règle (ceux qui existent encore). */
  protected ruleChannels(rule: AlertRule) {
    const byId = this.channelsById();
    return rule.channels.map((id) => byId.get(id)).filter((c): c is AlertChannel => !!c);
  }

  protected isMuted(rule: AlertRule) {
    return !!rule.mutedUntil && new Date(rule.mutedUntil) > new Date();
  }

  protected stateLabel(i: AlertRuleInfo) {
    if (i.status === 'disabled') return 'Désactivée';
    if (this.isMuted(i.rule)) return 'Sourdine';
    return { firing: i.firing > 1 ? `Active (${i.firing})` : 'Active', pending: 'En attente', ok: 'OK' }[i.status];
  }

  /** Icône de l'état d'une règle (pastille de la liste). */
  protected stateIcon(i: AlertRuleInfo) {
    return ({ critical: 'siren', warning: 'warning', pending: 'clock', ok: 'ok', disabled: 'pause', snoozed: 'mute' } as Record<string, string>)[this.stateClass(i)] ?? 'ok';
  }

  protected stateClass(i: AlertRuleInfo) {
    if (i.status === 'disabled') return 'disabled';
    if (this.isMuted(i.rule)) return 'snoozed';
    if (i.status === 'firing') return i.rule.severity;
    return i.status;
  }

  /** Infobulle de l'état : fin de la sourdine, ou nombre d'alertes déclenchées. */
  protected stateTitle(i: AlertRuleInfo) {
    if (i.status !== 'disabled' && this.isMuted(i.rule)) {
      const until = new Date(i.rule.mutedUntil!).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      return `En sourdine jusqu’au ${until}`;
    }
    if (i.status === 'firing') return `${i.firing} alerte${i.firing > 1 ? 's' : ''} déclenchée${i.firing > 1 ? 's' : ''}`;
    return '';
  }

  /** Date et heure exactes, avec le temps écoulé. */
  protected exact(iso: string) {
    return `${formatTime(iso, true)} · ${timeAgo(iso)}`;
  }

  protected failTitle(c: AlertChannel) {
    return `${c.lastError ?? 'Échec de l’envoi'} · ${formatTime(c.lastErrorAt!, true)}`;
  }

  /** Lien interne « /page?x=y » découpé pour routerLink. */
  protected path(link: string) {
    return link.split('?')[0];
  }

  protected query(link: string) {
    return Object.fromEntries(new URLSearchParams(link.split('?')[1] ?? ''));
  }

  // ------------------------------------------------------------ canaux

  protected channelType(t: ChannelType) {
    return CHANNEL_TYPES.find((x) => x.value === t) ?? CHANNEL_TYPES[3];
  }

  protected readonly templateSaved = signal(false);
  protected readonly templateError = signal<string | null>(null);
  protected readonly savingTemplates = signal(false);

  protected patchSettings(change: Partial<NotificationSettings>) {
    this.settings.update((s) => (s ? { ...s, ...change } : s));
  }

  protected saveTemplates() {
    const s = this.settings();
    if (!s) return;
    this.templateError.set(null);
    this.savingTemplates.set(true);
    this.api.saveMessageTemplates(s.titleTemplate ?? null, s.bodyTemplate ?? null).subscribe({
      next: () => {
        this.savingTemplates.set(false);
        this.toasts.ok('Message par défaut enregistré');
        this.templateSaved.set(true);
        setTimeout(() => this.templateSaved.set(false), 2000);
      },
      error: (e) => {
        this.savingTemplates.set(false);
        const message = e?.error?.error ?? 'Enregistrement impossible.';
        this.templateError.set(message);
        this.toasts.error(message);
      },
    });
  }

  protected saveSettings() {
    const s = this.settings();
    if (!s) return;
    this.savingSettings.set(true);
    this.api.saveNotificationSettings(s).subscribe({
      next: () => {
        this.savingSettings.set(false);
        this.smtpReady.set(!!s.smtpHost);
        this.toasts.ok('Réglages d’envoi enregistrés', 'mail');
        this.settingsSaved.set(true);
        setTimeout(() => this.settingsSaved.set(false), 2000);
      },
      error: (e) => {
        this.savingSettings.set(false);
        this.toasts.error(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }
}
