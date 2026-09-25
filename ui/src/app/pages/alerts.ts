import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ActiveAlert, AlertChannel, AlertEventItem, AlertKind, AlertRule, AlertRuleInfo, ChannelType, NotificationSettings } from '../core/models';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { TimePipe } from '../core/pipes/time-pipe';
import { CHANNEL_TYPES, describeRule } from '../shared/alert-rules';

type Tab = 'active' | 'rules' | 'history' | 'channels';

@Component({
  selector: 'wl-alerts',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, AgoPipe, TimePipe],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Alertes</h1>
        <div class="seg">
          <button [class.on]="tab() === 'active'" (click)="go('active')">En cours <span class="count" [class.danger]="firing() > 0">{{ active().length || '' }}</span></button>
          <button [class.on]="tab() === 'rules'" (click)="go('rules')">Règles <span class="count">{{ rules().length || '' }}</span></button>
          <button [class.on]="tab() === 'history'" (click)="go('history')">Historique</button>
          <button [class.on]="tab() === 'channels'" (click)="go('channels')">Canaux</button>
        </div>
        <span class="spacer"></span>
        @if (session.canEdit()) {
          <a class="btn primary" routerLink="/alerts/new">Nouvelle alerte</a>
        }
      </div>

      <ng-template #startersTpl>
        @if (session.canEdit()) {
          <div class="starters">
            <p>Pour commencer, choisissez une alerte courante : elle s'ouvre pré-remplie, avec la valeur actuelle.</p>
            @for (s of starters; track s.label) {
              <a class="btn" routerLink="/alerts/new" [queryParams]="s.query">{{ s.label }}</a>
            }
          </div>
        }
      </ng-template>

      <div class="split">
        <div class="main">
          @switch (tab()) {
            @case ('active') {
              <section class="panel">
                @if (active().length) {
                  <table class="list">
                    <thead><tr><th>État</th><th>Alerte</th><th>Depuis</th><th></th></tr></thead>
                    <tbody>
                      @for (a of active(); track a.id) {
                        <tr>
                          <td class="nowrap">
                            <span class="state" [class]="a.status === 'firing' ? a.severity : 'pending'">{{ a.status === 'firing' ? (a.severity === 'critical' ? 'Critique' : 'Avertissement') : 'En attente' }}</span>
                            @if (a.muted) { <span class="muted small"> · sourdine</span> }
                          </td>
                          <td class="msg">
                            <div>{{ a.message }}</div>
                            <div class="muted small">{{ a.ruleName }}@if (a.runbook) { · {{ a.runbook }} }</div>
                          </td>
                          <td class="nowrap muted" [title]="a.since | time: true">{{ a.since | ago }}</td>
                          <td class="acts nowrap">
                            @if (a.link) { <a class="btn" [routerLink]="path(a.link)" [queryParams]="query(a.link)">Voir les données</a> }
                            @if (session.canEdit()) {
                              <button class="btn ghost" (click)="mute(a.ruleId, a.muted ? 0 : 60)">{{ a.muted ? 'Réactiver' : 'Sourdine 1 h' }}</button>
                              <button class="btn ghost" (click)="editById(a.ruleId)">Modifier la règle</button>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">
                    Aucune alerte en cours.
                    @if (!rules().length) { <ng-container *ngTemplateOutlet="startersTpl" /> }
                  </div>
                }
              </section>
            }

            @case ('rules') {
              <section class="panel">
                @if (rules().length) {
                  <table class="list">
                    <thead><tr><th>État</th><th>Nom</th><th>Condition</th><th>Prévient</th><th></th></tr></thead>
                    <tbody>
                      @for (i of rules(); track i.rule.id) {
                        <tr class="click" (click)="edit(i.rule)">
                          <td class="nowrap"><span class="state" [class]="stateClass(i)">{{ stateLabel(i) }}</span></td>
                          <td>{{ i.rule.name }}</td>
                          <td class="muted small cond">{{ sameAsName(i.rule) ? '' : describe(i.rule) }}</td>
                          <td class="small nowrap">{{ channelNames(i.rule) }}</td>
                          <td class="acts nowrap" (click)="$event.stopPropagation()">
                            @if (session.canEdit()) {
                              <button class="btn ghost" (click)="toggle(i.rule)">{{ i.rule.enabled ? 'Désactiver' : 'Activer' }}</button>
                            }
                          </td>
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
              <section class="panel">
                @if (history().length) {
                  <table class="list">
                    <thead><tr><th>Date</th><th>Évènement</th><th>Message</th><th>Prévenus</th></tr></thead>
                    <tbody>
                      @for (e of history(); track e.id) {
                        <tr>
                          <td class="mono small nowrap">{{ e.at | time: true }}</td>
                          <td class="nowrap"><span class="state" [class]="e.status === 'firing' ? e.severity : 'ok'">{{ e.status === 'firing' ? 'Déclenchée' : 'Résolue' }}</span></td>
                          <td class="msg">
                            <div>{{ e.message }}</div>
                            <div class="muted small">{{ e.ruleName }}</div>
                          </td>
                          <td class="small">{{ e.notifiedChannels.join(', ') || '–' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">Aucune alerte déclenchée sur cette période.</div>
                }
              </section>
            }

            @case ('channels') {
              <section class="panel">
                <div class="panel-head">
                  <h2>Canaux de notification</h2>
                  <span class="spacer"></span>
                  @if (session.isAdmin()) { <a class="btn" routerLink="/alerts/channels/new">Ajouter un canal</a> }
                </div>
                @if (channels().length) {
                  <table class="list">
                    <thead><tr><th>Nom</th><th>Type</th><th>Destination</th><th>Dernier envoi</th></tr></thead>
                    <tbody>
                      @for (c of channels(); track c.id) {
                        <tr [class.click]="session.isAdmin()" (click)="session.isAdmin() && router.navigate(['/alerts/channels', c.id])">
                          <td>{{ c.name }}@if (c.default) { <span class="muted small"> · par défaut</span> }</td>
                          <td class="small">{{ channelType(c.type).label }}</td>
                          <td class="small mono ellipsis target">{{ c.target }}</td>
                          <td class="small nowrap">
                            @if (c.lastErrorAt && (!c.lastSentAt || c.lastErrorAt > c.lastSentAt)) {
                              <span class="danger" [title]="c.lastError ?? ''">échec {{ c.lastErrorAt | ago }}</span>
                            } @else {
                              <span class="muted">{{ c.lastSentAt ? (c.lastSentAt | ago) : 'jamais' }}</span>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                } @else {
                  <div class="empty">Aucun canal. Sans canal, les alertes restent visibles ici et dans la barre du haut.</div>
                }
              </section>

              @if (session.isAdmin() && settings(); as s) {
                <section class="panel">
                  <div class="panel-head"><h2>Envoi des e-mails et liens</h2></div>
                  <form class="panel-body settings" (ngSubmit)="saveSettings()">
                    <label class="wide">Adresse publique de Wolflog <input name="url" [(ngModel)]="s.publicUrl" [placeholder]="origin" />
                      <span class="muted small">Utilisée pour les liens « Voir dans Wolflog » des notifications.</span></label>
                    <label>Serveur SMTP <input name="host" [(ngModel)]="s.smtpHost" placeholder="smtp.office365.com" /></label>
                    <label>Port <input name="port" type="number" [(ngModel)]="s.smtpPort" /></label>
                    <label class="check"><input type="checkbox" name="ssl" [(ngModel)]="s.smtpSsl" /> TLS</label>
                    <label>Utilisateur <input name="user" [(ngModel)]="s.smtpUser" autocomplete="off" /></label>
                    <label>Mot de passe <input name="pwd" type="password" [(ngModel)]="s.smtpPassword" autocomplete="new-password"
                      [placeholder]="s.hasPassword ? 'inchangé' : ''" /></label>
                    <label>Expéditeur <input name="from" [(ngModel)]="s.from" placeholder="wolflog@mondomaine.fr" /></label>
                    <div class="actions wide">
                      <button class="btn primary" type="submit">Enregistrer</button>
                      @if (settingsSaved()) { <span class="ok small">Enregistré.</span> }
                    </div>
                  </form>
                </section>
              }
            }
          }
        </div>

      </div>
    </div>
  `,
  styles: `
    .count { color: var(--text-3); margin-left: 2px; font-variant-numeric: tabular-nums; }
    .count.danger { color: var(--danger); font-weight: 600; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .main { display: grid; gap: 14px; min-width: 0; }
    .state { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .state.critical { color: var(--danger); }
    .state.warning { color: var(--warn); }
    .state.pending { color: var(--warn); opacity: .8; }
    .state.ok { color: var(--ok); }
    .state.disabled { color: var(--text-3); }
    .msg { max-width: 0; width: 60%; overflow-wrap: anywhere; }
    .cond { max-width: 0; width: 45%; }
    .target { max-width: 0; width: 40%; }
    .acts { text-align: right; width: 1%; }
    .acts .btn { height: 24px; font-size: 12px; }
    tr.sel td { background: var(--row-selected); }
    .starters { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 14px; }
    .starters p { flex-basis: 100%; margin: 0 0 4px; }
    .settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; max-width: 820px; align-items: end; }
    .settings .wide { grid-column: 1 / -1; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); height: 28px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    p { margin: 0; }
    @media (max-width: 1200px) {
    }
  `,
})
export class AlertsPage {
  private readonly api = inject(Api);
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
  protected readonly origin = location.origin;
  protected readonly firing = computed(() => this.active().filter((a) => a.status === 'firing').length);
  private loadedOnce = false;

  protected readonly starters: { label: string; query: Record<string, string> }[] = [
    { label: "Taux d'erreur HTTP trop élevé", query: { kind: 'http', stat: 'errorRate' } },
    { label: 'Nouvelle erreur ou erreur réapparue', query: { kind: 'error' } },
    { label: 'Service muet', query: { kind: 'silence' } },
    { label: 'Latence p95 trop élevée', query: { kind: 'http', stat: 'p95' } },
    { label: 'Santé de Wolflog', query: { kind: 'health' } },
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
    this.api.alerts().subscribe((r) => {
      this.rules.set(r.rules);
    });
    this.api.activeAlerts().subscribe((a) => {
      this.active.set(a.items);
      // Première visite sans alerte en cours : afficher les règles.
      if (!this.loadedOnce && !this.tabParam() && !a.items.length) this.tab.set('rules');
      this.loadedOnce = true;
    });
    this.api.alertHistory(this.state.range()).subscribe((h) => this.history.set(h));
    this.api.channels().subscribe((c) => this.channels.set(c));
    if (this.session.isAdmin() && !this.settings()) this.api.notificationSettings().subscribe((s) => this.settings.set({ ...s, smtpPassword: '' }));
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

  protected toggle(rule: AlertRule) {
    this.api.saveAlert({ ...rule, enabled: !rule.enabled }).subscribe(() => this.state.refresh());
  }

  protected mute(ruleId: string, minutes: number) {
    this.api.muteAlert(ruleId, minutes).subscribe(() => this.state.refresh());
  }

  protected describe(rule: AlertRule) {
    return describeRule(rule);
  }

  /** Nom généré automatiquement : inutile de répéter la condition. */
  protected sameAsName(rule: AlertRule) {
    return describeRule(rule).toLowerCase() === rule.name.toLowerCase();
  }

  protected channelNames(rule: AlertRule) {
    const names = rule.channels.map((id) => this.channels().find((c) => c.id === id)?.name).filter(Boolean);
    return names.length ? names.join(', ') : 'Wolflog seulement';
  }

  protected stateLabel(i: AlertRuleInfo) {
    if (i.status === 'disabled') return 'Désactivée';
    if (i.rule.mutedUntil && new Date(i.rule.mutedUntil) > new Date()) return 'Sourdine';
    return { firing: i.firing > 1 ? `Active (${i.firing})` : 'Active', pending: 'En attente', ok: 'OK' }[i.status];
  }

  protected stateClass(i: AlertRuleInfo) {
    if (i.status === 'firing') return i.rule.severity;
    return i.status;
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

  protected saveSettings() {
    const s = this.settings();
    if (!s) return;
    this.api.saveNotificationSettings(s).subscribe(() => {
      this.settingsSaved.set(true);
      setTimeout(() => this.settingsSaved.set(false), 2000);
    });
  }
}
