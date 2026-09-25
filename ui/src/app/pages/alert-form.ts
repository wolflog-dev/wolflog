import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { AlertChannel, AlertEvaluation, AlertKind, AlertRule, MetricData, CustomResult, Probe, Slo } from '../core/models';
import { Api } from '../core/api';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Chart, ChartSeries, paletteColor } from '../shared/chart';
import { AGGREGATES } from '../shared/dashboard-panel';
import { ALERT_KINDS, HTTP_STATS, WINDOWS, channelTypeLabel, describeNotification, describeRule, newRule } from '../shared/alert-rules';

const REPEATS = [
  { value: 0, label: 'jamais' }, { value: 30, label: 'toutes les 30 min' }, { value: 60, label: 'toutes les heures' },
  { value: 240, label: 'toutes les 4 h' }, { value: 1440, label: 'tous les jours' },
];

/**
 * Création et modification d'une alerte sur une page dédiée :
 * 1. que surveiller, 2. quand déclencher, 3. qui prévenir, 4. nom et consigne.
 * À droite, en permanence : la règle en une phrase, la valeur actuelle et un graphique avec le seuil.
 */
@Component({
  selector: 'wl-alert-form',
  imports: [FormsModule, RouterLink, Chart],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/alerts" [queryParams]="{ tab: 'rules' }" class="small">Alertes</a>
        <span class="muted">/</span>
        <h1>{{ r().id ? 'Modifier l’alerte' : 'Nouvelle alerte' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'rules' }">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">{{ r().id ? 'Enregistrer' : 'Créer l’alerte' }}</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <!-- 1 -->
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Que surveiller ?</h2></div>
            <div class="step-body">
              <div class="choices">
                @for (k of kinds; track k.value) {
                  <button type="button" class="choice" [class.on]="r().kind === k.value" (click)="setKind(k.value)">
                    <strong>{{ k.label }}</strong>
                    <span>{{ k.hint }}</span>
                  </button>
                }
              </div>
            </div>
          </section>

          <!-- 2 -->
          <section class="panel step done">
            <div class="step-head"><span class="num">2</span><h2>Quand déclencher ?</h2><span class="hint">complétez la phrase</span></div>
            <div class="step-body">
              <div class="sentence">
                @switch (r().kind) {
                  @case ('http') {
                    <span>Quand</span>
                    <select [ngModel]="r().stat" (ngModelChange)="patch({ stat: $event, threshold: defaultThreshold($event), minCount: $event === 'errorRate' ? 20 : 0 })">
                      @for (s of httpStats; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
                    </select>
                    <span>des requêtes de</span>
                    <select [ngModel]="serviceChoice()" (ngModelChange)="setServiceChoice($event)">
                      <option value="">tous les services ensemble</option>
                      <option value="*">chaque service, séparément</option>
                      @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                    </select>
                    <span>dépasse</span>
                    <span class="unit-input"><input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" /><em>{{ httpUnit() }}</em></span>
                    <span>pendant</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
                    </select>
                  }
                  @case ('error') {
                    <span>Quand une nouvelle erreur apparaît dans</span>
                    <select [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="">n'importe quel service</option>
                      @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                    </select>
                  }
                  @case ('silence') {
                    <span>Quand</span>
                    <select [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                      <option value="">un des services actifs ces dernières 24 h</option>
                      @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
                    </select>
                    <span>n'envoie plus rien depuis</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
                    </select>
                  }
                  @case ('query') {
                    <span>Quand</span>
                    <select [ngModel]="r().aggregate" (ngModelChange)="patch({ aggregate: $event })">
                      @for (a of aggregates; track a.value) { <option [value]="a.value">{{ a.label.toLowerCase() }}</option> }
                    </select>
                    @if (needsField()) {
                      <input class="field-in mono" [ngModel]="r().field ?? ''" (ngModelChange)="patch({ field: $event })" placeholder="champ, ex. duration" />
                    }
                    <span>des</span>
                    <select [ngModel]="r().source" (ngModelChange)="patch({ source: $event })">
                      <option value="logs">logs</option><option value="spans">spans (traces)</option><option value="metrics">métriques</option>
                    </select>
                    <select [ngModel]="r().comparison" (ngModelChange)="patch({ comparison: $event })">
                      <option value="above">dépasse</option><option value="below">passe sous</option>
                    </select>
                    <input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" />
                    <span>sur</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
                    </select>
                  }
                  @case ('probe') {
                    <span>Quand</span>
                    <select [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                      <option value="">une des sondes</option>
                      @for (p of probes(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
                    </select>
                    <span>ne répond plus</span>
                  }
                  @case ('slo') {
                    <span>Quand</span>
                    <select [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                      <option value="">un des objectifs</option>
                      @for (s of slos(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }
                    </select>
                    <span>consomme son budget d'erreur plus de</span>
                    <span class="unit-input"><input type="number" class="num-in" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" min="1" /><em>fois trop vite</em></span>
                    <span>sur</span>
                    <select [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                      @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
                    </select>
                  }
                  @case ('health') {
                    <span>Quand Wolflog lui-même a un problème : disque presque plein, écriture en échec, plus aucune donnée reçue, notification impossible.</span>
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
                    <label class="check"><input type="checkbox" [ngModel]="r().includeRegressions" (ngModelChange)="patch({ includeRegressions: $event })" /> Aussi quand une erreur marquée résolue réapparaît</label>
                    <label class="check"><input type="checkbox" [ngModel]="r().crashesOnly" (ngModelChange)="patch({ crashesOnly: $event })" /> Seulement les crashs (arrêt de l'application)</label>
                  </div>
                }
                @case ('probe') {
                  <div class="options">
                    <label class="field">Prévenir aussi si le certificat TLS expire dans moins de
                      <span class="unit-input"><input type="number" class="num-in" min="0" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" /><em>jours</em></span></label>
                    @if (!probes().length) { <p class="muted small">Aucune sonde pour l'instant. <a routerLink="/uptime/new">Créer une sonde</a></p> }
                  </div>
                }
                @case ('slo') {
                  <p class="muted small">Repères : 14,4× pendant 1 h ou 6× pendant 6 h épuiseraient le budget d'un mois en 2 ou 5 jours.
                    @if (!slos().length) { <a routerLink="/slos/new">Créer un objectif</a> }</p>
                }
              }

              <div class="options">
                @if (r().kind !== 'error') {
                  <label class="field">Attendre avant de déclencher
                    <select [ngModel]="r().forMinutes" (ngModelChange)="patch({ forMinutes: +$event })">
                      <option [value]="0">non, dès que la condition est vraie</option><option [value]="2">2 min</option><option [value]="5">5 min</option>
                      <option [value]="10">10 min</option><option [value]="30">30 min</option>
                    </select>
                    <span class="muted small">Ignore les pics très courts.</span></label>
                }
                @if (r().kind !== 'health' && environments().length) {
                  <label class="field">Environnement
                    <select [ngModel]="r().env ?? ''" (ngModelChange)="patch({ env: $event || null })">
                      <option value="">tous</option>
                      @for (e of environments(); track e) { <option [value]="e">{{ e }}</option> }
                    </select></label>
                }
              </div>
            </div>
          </section>

          <!-- 3 -->
          <section class="panel step" [class.done]="r().channels.length">
            <div class="step-head"><span class="num">3</span><h2>Qui prévenir ?</h2></div>
            <div class="step-body">
              @if (channels().length) {
                <div class="channel-list">
                  @for (c of channels(); track c.id) {
                    <label class="check channel"><input type="checkbox" [checked]="r().channels.includes(c.id)" (change)="toggleChannel(c.id)" />
                      <strong>{{ c.name }}</strong> <span class="muted small">{{ channelType(c.type) }} · {{ c.target }}</span></label>
                  }
                </div>
              } @else {
                <p class="muted small">Aucun canal de notification : l'alerte sera visible dans Wolflog (barre du haut, page Alertes) mais personne ne sera prévenu.</p>
              }
              @if (session.isAdmin()) {
                @if (newChannel(); as c) {
                  <div class="new-channel">
                    <div class="seg">
                      @for (t of channelTypes; track t.value) {
                        <button type="button" [class.on]="c.type === t.value" (click)="patchChannel({ type: t.value })">{{ t.label }}</button>
                      }
                    </div>
                    <div class="options">
                      <label class="field">Nom <input [ngModel]="c.name" (ngModelChange)="patchChannel({ name: $event })" placeholder="ex. Astreinte, #prod-alertes" /></label>
                      <label class="field wide">{{ c.type === 'email' ? 'Adresses (séparées par des virgules)' : 'URL du webhook' }}
                        <input [ngModel]="c.target" (ngModelChange)="patchChannel({ target: $event })" [placeholder]="c.type === 'email' ? 'astreinte@mondomaine.fr' : 'https://…'" /></label>
                    </div>
                    @if (channelError()) { <span class="danger small">{{ channelError() }}</span> }
                    <div class="row-actions">
                      <button type="button" class="btn" (click)="createChannel()">Ajouter et cocher</button>
                      <button type="button" class="btn ghost" (click)="newChannel.set(null)">Annuler</button>
                      @if (c.type === 'email') { <span class="muted small">Le serveur d'envoi se règle dans Alertes > Canaux.</span> }
                    </div>
                  </div>
                } @else {
                  <button type="button" class="link small" (click)="startChannel()">+ Ajouter un canal (e-mail, Teams, Slack, webhook)</button>
                }
              }
              <div class="options">
                <label class="field">Gravité
                  <span class="seg">
                    <button type="button" [class.on]="r().severity === 'critical'" (click)="patch({ severity: 'critical' })">Critique</button>
                    <button type="button" [class.on]="r().severity === 'warning'" (click)="patch({ severity: 'warning' })">Avertissement</button>
                  </span></label>
                <label class="field">Rappeler tant que c'est actif
                  <select [ngModel]="r().repeatMinutes" (ngModelChange)="patch({ repeatMinutes: +$event })">
                    @for (x of repeats; track x.value) { <option [value]="x.value">{{ x.label }}</option> }
                  </select></label>
              </div>
              @if (r().kind !== 'error') {
                <label class="check"><input type="checkbox" [ngModel]="r().notifyResolved" (ngModelChange)="patch({ notifyResolved: $event })" /> Prévenir aussi quand tout redevient normal</label>
              }
            </div>
          </section>

          <!-- 4 -->
          <section class="panel step done">
            <div class="step-head"><span class="num">4</span><h2>Nom et consigne</h2><span class="hint">facultatif</span></div>
            <div class="step-body">
              <label class="field">Nom <input [ngModel]="customName()" (ngModelChange)="customName.set($event)" [placeholder]="autoName()" />
                <span class="muted small">Vide : « {{ autoName() }} ».</span></label>
              <label class="field">Consigne pour la personne prévenue <input [ngModel]="r().runbook ?? ''" (ngModelChange)="patch({ runbook: $event || null })"
                placeholder="ex. Vérifier la connexion à la base ; procédure : https://wiki/…" />
                <span class="muted small">Affichée dans la notification.</span></label>
            </div>
          </section>
        </div>

        <!-- Résumé permanent -->
        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase"><strong>{{ severityLabel() }}</strong> si {{ autoName().charAt(0).toLowerCase() + autoName().slice(1) }}{{ r().forMinutes ? ', pendant ' + r().forMinutes + ' min' : '' }}.</p>
            <p class="muted small">Prévenir : {{ notification() }}.</p>
          </div>
          <div class="block">
            <h3>En ce moment</h3>
            @if (previewError()) {
              <span class="danger small">{{ previewError() }}</span>
            } @else if (preview() === null) {
              <span class="muted small">Calcul…</span>
            } @else if (!preview()!.length) {
              <span class="muted small">{{ r().kind === 'error' ? 'Aucune nouvelle erreur en ce moment.' : 'Pas de donnée pour ces critères.' }}</span>
            } @else {
              <div class="verdict" [class.on]="breaching().length">
                {{ breaching().length ? 'Se déclencherait maintenant' : 'Ne se déclencherait pas maintenant' }}
              </div>
              @for (e of preview()!.slice(0, 5); track e.key) {
                <div class="ev" [class.on]="e.breach">{{ e.message }}</div>
              }
              @if (preview()!.length > 5) { <div class="muted small">et {{ preview()!.length - 5 }} autre(s)</div> }
            }
          </div>
          @if (chartTimes().length) {
            <div class="block">
              <h3>{{ chartTitle() }}</h3>
              <wl-chart [times]="chartTimes()" [series]="chartSeries()" [height]="150" [unit]="chartUnit()" [legend]="false" [deployments]="false" />
              <span class="muted small">Pointillés : le seuil.</span>
            </div>
          }
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">{{ r().id ? 'Enregistrer' : 'Créer l’alerte' }}</button>
            <a class="btn" routerLink="/alerts" [queryParams]="{ tab: 'rules' }">Annuler</a>
            <span class="spacer"></span>
            @if (r().id) {
              @if (confirmDelete()) {
                <button class="btn danger-btn" (click)="remove()">Confirmer</button>
              } @else {
                <button class="btn ghost" (click)="confirmDelete.set(true)">Supprimer</button>
              }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .num-in { width: 90px; }
    .field-in { width: 150px; }
    .unit-input { display: inline-flex; align-items: center; gap: 6px; }
    .unit-input em { font-style: normal; color: var(--text-2); }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    .options .field.wide { flex: 1; min-width: 320px; }
    .options.checks { display: grid; gap: 6px; }
    label.check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .channel-list { display: grid; gap: 6px; }
    .channel .muted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
    .phrase { margin: 0; font-size: 13.5px; line-height: 1.5; }
    .summary p { margin: 0; }
    .verdict { font-weight: 600; color: var(--ok); }
    .verdict.on { color: var(--danger); }
    .ev { font-size: 12.5px; color: var(--text-2); }
    .ev.on { color: var(--danger); }
    .danger-btn { color: var(--danger); border-color: var(--danger); }
    .new-channel { display: grid; gap: 10px; padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius); }
    .new-channel .seg { justify-self: start; }
    .row-actions { display: flex; gap: 8px; align-items: center; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); cursor: pointer; justify-self: start; font-family: inherit; }
    p { margin: 0; }
  `,
})
export class AlertFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly state = inject(AppState);
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

  protected readonly r = signal<AlertRule>(newRule());
  protected readonly customName = signal('');
  protected readonly services = signal<string[]>([]);
  protected readonly environments = signal<string[]>([]);
  protected readonly channels = signal<AlertChannel[]>([]);
  protected readonly probes = signal<Probe[]>([]);
  protected readonly slos = signal<Slo[]>([]);
  protected readonly preview = signal<AlertEvaluation[] | null>(null);
  protected readonly previewError = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly confirmDelete = signal(false);
  protected readonly newChannel = signal<AlertChannel | null>(null);
  protected readonly channelError = signal('');
  protected readonly channelTypes = [
    { value: 'email' as const, label: 'E-mail' }, { value: 'teams' as const, label: 'Teams' },
    { value: 'slack' as const, label: 'Slack' }, { value: 'webhook' as const, label: 'Webhook' },
  ];
  protected readonly chart = signal<{ times: string[]; series: ChartSeries[]; unit: string | null; title: string } | null>(null);
  private readonly previews = new Subject<AlertRule>();

  protected readonly breaching = computed(() => (this.preview() ?? []).filter((e) => e.breach));
  protected readonly needsField = computed(() => AGGREGATES.find((a) => a.value === this.r().aggregate)?.numeric ?? false);
  protected readonly httpUnit = computed(() => HTTP_STATS.find((s) => s.value === this.r().stat)?.unit ?? '');
  protected readonly serviceChoice = computed(() => (this.r().perService ? '*' : (this.r().service ?? '')));
  protected readonly autoName = computed(() => {
    const d = describeRule(this.r(), this.probes(), this.slos());
    return d.charAt(0).toUpperCase() + d.slice(1);
  });
  protected readonly severityLabel = computed(() => (this.r().severity === 'critical' ? 'Alerte critique' : 'Avertissement'));
  protected readonly notification = computed(() => describeNotification(this.r(), this.channels()));
  protected readonly chartTimes = computed(() => this.chart()?.times ?? []);
  protected readonly chartSeries = computed(() => this.chart()?.series ?? []);
  protected readonly chartUnit = computed(() => this.chart()?.unit ?? null);
  protected readonly chartTitle = computed(() => this.chart()?.title ?? '');

  constructor() {
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    this.api.environments().subscribe((e) => this.environments.set(e));
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
          this.customName.set(this.name());
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

    // Aperçu et graphique suivent chaque modification de la règle.
    effect(() => {
      const rule = this.r();
      untracked(() => {
        this.previews.next({ ...rule, name: rule.name || 'aperçu' });
        this.loadChart(rule);
      });
    });
  }

  private chartTimer: ReturnType<typeof setTimeout> | null = null;

  /** Historique de la valeur surveillée, avec la ligne de seuil. */
  private loadChart(rule: AlertRule) {
    if (this.chartTimer) clearTimeout(this.chartTimer);
    this.chartTimer = setTimeout(() => {
      const from = rule.windowMinutes >= 360 ? '7d' : rule.windowMinutes >= 60 ? '24h' : '6h';
      const range = { from, to: '' };
      const withThreshold = (times: string[], series: ChartSeries[], unit: string | null, title: string) => {
        const threshold: ChartSeries = { label: 'seuil', color: '#e06c6c', values: times.map(() => rule.threshold), dash: [5, 4] };
        this.chart.set({ times, series: [...series, threshold], unit, title });
      };
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
    this.api.saveChannel(c).subscribe({
      next: (saved) => {
        this.channels.update((l) => [...l, saved]);
        this.patch({ channels: [...this.r().channels, saved.id] });
        this.newChannel.set(null);
      },
      error: (e) => this.channelError.set(e?.error?.error ?? 'Canal invalide.'),
    });
  }

  protected channelType(t: string) {
    return channelTypeLabel(t);
  }

  protected save() {
    this.busy.set(true);
    this.error.set('');
    const rule = { ...this.r(), name: this.customName().trim() || this.autoName() };
    this.api.saveAlert(rule).subscribe({
      next: () => {
        // Évaluation immédiate : l'état de la règle est à jour en arrivant sur la liste.
        this.api.runAlerts().subscribe({ complete: () => this.done(), error: () => this.done() });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  private done() {
    this.state.refresh();
    this.router.navigate(['/alerts'], { queryParams: { tab: 'rules' } });
  }

  protected remove() {
    this.api.deleteAlert(this.r().id).subscribe(() => this.done());
  }
}
