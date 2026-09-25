import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ActiveAlert, AlertChannel, AlertEventItem, AlertKind, AlertRule, AlertRuleInfo, Api, ChannelType, NotificationSettings } from '../core/api';
import { AppState, Session } from '../core/state';
import { AgoPipe, TimePipe } from '../core/format';
import { AlertEditor, describeRule, newRule } from '../shared/alert-editor';

type Tab = 'active' | 'rules' | 'history' | 'channels';

const CHANNEL_TYPES: { value: ChannelType; label: string; placeholder: string; hint: string }[] = [
  { value: 'email', label: 'E-mail', placeholder: 'astreinte@mondomaine.fr, dev@mondomaine.fr', hint: 'Adresses séparées par des virgules. Serveur SMTP à renseigner ci-dessous.' },
  { value: 'teams', label: 'Microsoft Teams', placeholder: 'https://….webhook.office.com/… ou URL de workflow', hint: "Dans Teams : canal > Workflows > « Publier dans un canal lorsqu'une requête webhook est reçue », puis coller l'URL." },
  { value: 'slack', label: 'Slack', placeholder: 'https://hooks.slack.com/services/…', hint: 'Application « Incoming Webhooks » de Slack, un webhook par canal.' },
  { value: 'webhook', label: 'Webhook', placeholder: 'https://mon-outil/alertes', hint: 'Requête POST JSON : status, rule, severity, message, link, at.' },
];

@Component({
  selector: 'vg-alerts',
  imports: [FormsModule, RouterLink, NgTemplateOutlet, AgoPipe, TimePipe, AlertEditor],
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
        @if (session.canEdit() && !editing()) {
          <button class="btn primary" (click)="create()">Nouvelle alerte</button>
        }
      </div>

      <ng-template #startersTpl>
        @if (session.canEdit()) {
          <div class="starters">
            <p>Pour commencer, choisissez une alerte courante : elle s'ouvre pré-remplie, avec la valeur actuelle.</p>
            @for (s of starters; track s.label) {
              <button class="btn" (click)="create(s.rule)">{{ s.label }}</button>
            }
          </div>
        }
      </ng-template>

      <div class="split" [class.with-editor]="editing()">
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
                        <tr class="click" [class.sel]="editing()?.id === i.rule.id" (click)="edit(i.rule)">
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
                  @if (session.isAdmin() && !channelForm()) { <button class="btn" (click)="newChannel()">Ajouter un canal</button> }
                </div>
                @if (channelForm(); as f) {
                  <form class="panel-body channel-form" (ngSubmit)="saveChannel()">
                    <div class="seg">
                      @for (t of channelTypes; track t.value) {
                        <button type="button" [class.on]="f.type === t.value" (click)="setChannel({ type: t.value })">{{ t.label }}</button>
                      }
                    </div>
                    <label>Nom <input name="n" [ngModel]="f.name" (ngModelChange)="setChannel({ name: $event })" placeholder="ex. Astreinte, #prod-alertes" /></label>
                    <label>{{ f.type === 'email' ? 'Destinataires' : 'URL du webhook' }}
                      <input name="t" [ngModel]="f.target" (ngModelChange)="setChannel({ target: $event })" [placeholder]="channelType(f.type).placeholder" />
                      <span class="muted small">{{ channelType(f.type).hint }}</span>
                    </label>
                    <label class="check"><input type="checkbox" name="d" [ngModel]="f.default" (ngModelChange)="setChannel({ default: $event })" /> Cocher par défaut sur les nouvelles alertes</label>
                    @if (channelMessage(); as m) { <p class="small" [class.danger]="m.error" [class.ok]="!m.error">{{ m.text }}</p> }
                    <div class="actions">
                      <button class="btn primary" type="submit">Enregistrer</button>
                      <button class="btn" type="button" (click)="testChannel()">Envoyer un test</button>
                      <button class="btn ghost" type="button" (click)="channelForm.set(null)">Annuler</button>
                      <span class="spacer"></span>
                      @if (f.id) { <button class="btn ghost" type="button" (click)="deleteChannel(f.id)">Supprimer</button> }
                    </div>
                  </form>
                }
                @if (channels().length) {
                  <table class="list">
                    <thead><tr><th>Nom</th><th>Type</th><th>Destination</th><th>Dernier envoi</th></tr></thead>
                    <tbody>
                      @for (c of channels(); track c.id) {
                        <tr [class.click]="session.isAdmin()" (click)="session.isAdmin() && editChannel(c)">
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
                } @else if (!channelForm()) {
                  <div class="empty">Aucun canal. Sans canal, les alertes restent visibles ici et dans la barre du haut.</div>
                }
              </section>

              @if (session.isAdmin() && settings(); as s) {
                <section class="panel">
                  <div class="panel-head"><h2>Envoi des e-mails et liens</h2></div>
                  <form class="panel-body settings" (ngSubmit)="saveSettings()">
                    <label class="wide">Adresse publique de Vigil <input name="url" [(ngModel)]="s.publicUrl" [placeholder]="origin" />
                      <span class="muted small">Utilisée pour les liens « Voir dans Vigil » des notifications.</span></label>
                    <label>Serveur SMTP <input name="host" [(ngModel)]="s.smtpHost" placeholder="smtp.office365.com" /></label>
                    <label>Port <input name="port" type="number" [(ngModel)]="s.smtpPort" /></label>
                    <label class="check"><input type="checkbox" name="ssl" [(ngModel)]="s.smtpSsl" /> TLS</label>
                    <label>Utilisateur <input name="user" [(ngModel)]="s.smtpUser" autocomplete="off" /></label>
                    <label>Mot de passe <input name="pwd" type="password" [(ngModel)]="s.smtpPassword" autocomplete="new-password"
                      [placeholder]="s.hasPassword ? 'inchangé' : ''" /></label>
                    <label>Expéditeur <input name="from" [(ngModel)]="s.from" placeholder="vigil@mondomaine.fr" /></label>
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

        @if (editing(); as rule) {
          <aside class="panel editor-panel">
            <div class="panel-head">
              <h2>{{ rule.id ? 'Modifier l’alerte' : 'Nouvelle alerte' }}</h2>
              <span class="spacer"></span>
              <button class="btn ghost" (click)="closeEditor()">Fermer</button>
            </div>
            <div class="panel-body">
              <vg-alert-editor [rule]="rule" (saved)="onSaved()" (closed)="closeEditor()" (deleted)="onSaved()" />
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .count { color: var(--text-3); margin-left: 2px; font-variant-numeric: tabular-nums; }
    .count.danger { color: var(--danger); font-weight: 600; }
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-editor { grid-template-columns: minmax(0, 1fr) minmax(460px, 46%); }
    .main { display: grid; gap: 14px; min-width: 0; }
    .editor-panel { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
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
    .channel-form { display: grid; gap: 10px; max-width: 620px; border-bottom: 1px solid var(--border); }
    .channel-form .seg { justify-self: start; }
    .settings { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 14px; max-width: 820px; align-items: end; }
    .settings .wide { grid-column: 1 / -1; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); height: 28px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    p { margin: 0; }
    @media (max-width: 1200px) {
      .split.with-editor { grid-template-columns: minmax(0, 1fr); }
      .editor-panel { position: fixed; top: 0; right: 0; bottom: 0; max-height: none; width: min(640px, 100%); z-index: 60; border-radius: 0; box-shadow: -12px 0 32px rgba(0, 0, 0, .35); }
    }
  `,
})
export class AlertsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly state = inject(AppState);
  protected readonly session = inject(Session);

  // Paramètres d'URL : onglet, et création pré-remplie depuis une autre page (?edit=new&kind=http&service=…).
  readonly tabParam = input<string>('', { alias: 'tab' });
  readonly editParam = input<string>('', { alias: 'edit' });
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

  protected readonly tab = signal<Tab>('active');
  protected readonly rules = signal<AlertRuleInfo[]>([]);
  protected readonly active = signal<ActiveAlert[]>([]);
  protected readonly history = signal<AlertEventItem[]>([]);
  protected readonly channels = signal<AlertChannel[]>([]);
  protected readonly editing = signal<AlertRule | null>(null);
  protected readonly channelForm = signal<AlertChannel | null>(null);
  protected readonly channelMessage = signal<{ text: string; error: boolean } | null>(null);
  protected readonly settings = signal<NotificationSettings | null>(null);
  protected readonly settingsSaved = signal(false);
  protected readonly channelTypes = CHANNEL_TYPES;
  protected readonly origin = location.origin;
  protected readonly firing = computed(() => this.active().filter((a) => a.status === 'firing').length);
  private loadedOnce = false;

  protected readonly starters: { label: string; rule: Partial<AlertRule> }[] = [
    { label: "Taux d'erreur HTTP > 5 % (par service)", rule: { kind: 'http', stat: 'errorRate', threshold: 5, perService: true, minCount: 20 } },
    { label: 'Nouvelle erreur ou erreur réapparue', rule: { kind: 'error', includeRegressions: true } },
    { label: 'Service muet depuis 15 min', rule: { kind: 'silence', windowMinutes: 15 } },
    { label: 'Latence p95 > 1 s (par service)', rule: { kind: 'http', stat: 'p95', threshold: 1000, perService: true, forMinutes: 5 } },
    { label: 'Santé de Vigil', rule: { kind: 'health' } },
  ];

  constructor() {
    effect(() => {
      const t = this.tabParam();
      const edit = this.editParam();
      untracked(() => {
        if (t && ['active', 'rules', 'history', 'channels'].includes(t)) this.tab.set(t as Tab);
        if (edit === 'new') {
          const prefill: Partial<AlertRule> = { kind: (this.kind() || 'http') as AlertKind };
          if (this.service()) prefill.service = this.service();
          if (this.stat()) prefill.stat = this.stat();
          if (this.source()) prefill.source = this.source() as AlertRule['source'];
          if (this.filter()) prefill.filter = this.filter();
          if (this.agg()) prefill.aggregate = this.agg();
          if (this.field()) prefill.field = this.field();
          if (this.groupBy()) prefill.groupBy = this.groupBy();
          if (this.route()) prefill.route = this.route();
          if (this.target()) prefill.targetId = this.target();
          if (this.name()) prefill.name = this.name();
          this.create(prefill);
        } else if (edit) {
          this.editById(edit);
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
      if (this.editParam() && this.editParam() !== 'new' && !this.editing()) this.editById(this.editParam());
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

  protected create(prefill: Partial<AlertRule> = {}) {
    this.editing.set({ ...newRule(prefill.kind ?? 'http'), ...prefill });
  }

  protected edit(rule: AlertRule) {
    if (!this.session.canEdit()) return;
    this.editing.set(rule);
  }

  protected editById(id: string) {
    const r = this.rules().find((x) => x.rule.id === id);
    if (r) this.edit(r.rule);
  }

  protected closeEditor() {
    this.editing.set(null);
    if (this.editParam()) this.router.navigate([], { queryParams: { edit: null, kind: null, service: null, stat: null, source: null, filter: null, agg: null, field: null, groupBy: null, route: null, target: null, name: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected onSaved() {
    this.closeEditor();
    // Évaluation immédiate pour voir tout de suite l'état de la nouvelle règle.
    // (le rafraîchissement global met aussi à jour le compteur de la navigation)
    this.api.runAlerts().subscribe({ next: () => this.state.refresh(), error: () => this.state.refresh() });
    if (this.tab() === 'active' && !this.active().length) this.tab.set('rules');
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
    return names.length ? names.join(', ') : 'Vigil seulement';
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

  protected newChannel() {
    this.channelMessage.set(null);
    this.channelForm.set({ id: '', name: '', type: 'email', target: '', default: this.channels().length === 0 });
  }

  protected editChannel(c: AlertChannel) {
    this.channelMessage.set(null);
    this.channelForm.set({ ...c });
  }

  protected setChannel(change: Partial<AlertChannel>) {
    this.channelForm.update((f) => (f ? { ...f, ...change } : f));
  }

  protected saveChannel() {
    const f = this.channelForm();
    if (!f) return;
    this.api.saveChannel(f).subscribe({
      next: () => {
        this.channelForm.set(null);
        this.load();
      },
      error: (e) => this.channelMessage.set({ text: e?.error?.error ?? 'Enregistrement impossible.', error: true }),
    });
  }

  protected testChannel() {
    const f = this.channelForm();
    if (!f) return;
    this.channelMessage.set({ text: 'Envoi…', error: false });
    this.api.testChannel(f).subscribe({
      next: () => this.channelMessage.set({ text: 'Message de test envoyé.', error: false }),
      error: (e) => this.channelMessage.set({ text: e?.error?.error ?? 'Échec de l’envoi.', error: true }),
    });
  }

  protected deleteChannel(id: string) {
    this.api.deleteChannel(id).subscribe(() => {
      this.channelForm.set(null);
      this.load();
    });
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
