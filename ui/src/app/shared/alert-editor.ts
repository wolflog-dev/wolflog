import { Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subscription, debounceTime, Subject, switchMap, catchError, of } from 'rxjs';
import { AlertChannel, AlertEvaluation, AlertKind, AlertRule, Api, Probe, Slo } from '../core/api';
import { AppState, Session } from '../core/state';
import { AGGREGATES } from './dashboard-panel';

export const ALERT_KINDS: { value: AlertKind; label: string; hint: string }[] = [
  { value: 'http', label: 'Requêtes HTTP', hint: "Taux d'erreur, latence ou débit des requêtes reçues" },
  { value: 'error', label: 'Nouvelle erreur', hint: 'Une exception jamais vue, ou une erreur résolue qui revient' },
  { value: 'silence', label: 'Service muet', hint: "Un service n'envoie plus de logs ni de traces" },
  { value: 'query', label: 'Requête personnalisée', hint: 'Un calcul sur les logs, spans ou métriques comparé à un seuil' },
  { value: 'probe', label: 'Sonde', hint: 'Un site ou un port ne répond plus, certificat qui expire' },
  { value: 'slo', label: 'Objectif (SLO)', hint: "Le budget d'erreur d'un objectif se consomme trop vite" },
  { value: 'health', label: 'Santé de Vigil', hint: 'Disque presque plein, écriture en échec, plus aucune donnée reçue' },
];

export const WINDOWS = [
  { value: 1, label: '1 min' }, { value: 5, label: '5 min' }, { value: 10, label: '10 min' }, { value: 15, label: '15 min' },
  { value: 30, label: '30 min' }, { value: 60, label: '1 h' }, { value: 360, label: '6 h' }, { value: 1440, label: '24 h' },
];

const HTTP_STATS = [
  { value: 'errorRate', label: "le taux d'erreur (5xx)", unit: '%' },
  { value: 'p95', label: 'la latence p95', unit: 'ms' },
  { value: 'p99', label: 'la latence p99', unit: 'ms' },
  { value: 'p50', label: 'la latence médiane', unit: 'ms' },
  { value: 'rate', label: 'le débit', unit: 'req/s' },
];

export function newRule(kind: AlertKind = 'http'): AlertRule {
  return {
    id: '', name: '', enabled: true, kind, severity: 'critical', comparison: 'above', threshold: kind === 'http' ? 5 : 0,
    windowMinutes: kind === 'silence' ? 15 : kind === 'slo' ? 60 : 5, forMinutes: 0, repeatMinutes: 0, minCount: kind === 'http' ? 20 : 0,
    channels: [], notifyResolved: true, stat: 'errorRate', source: 'logs', aggregate: 'count', includeRegressions: true,
  };
}

/** Description courte d'une règle, en français. */
export function describeRule(r: AlertRule, probes: Probe[] = [], slos: Slo[] = []): string {
  const win = WINDOWS.find((w) => w.value === r.windowMinutes)?.label ?? `${r.windowMinutes} min`;
  const scope = r.service ? ` de ${r.service}` : r.perService ? ' par service' : '';
  const cmp = r.comparison === 'below' ? '<' : '>';
  switch (r.kind) {
    case 'http': {
      const s = HTTP_STATS.find((x) => x.value === (r.stat ?? 'errorRate'));
      return `${s?.label ?? r.stat}${scope}${r.route ? ' ' + r.route : ''} ${cmp} ${r.threshold.toLocaleString('fr-FR')} ${s?.unit ?? ''} sur ${win}`;
    }
    case 'error':
      return `${r.crashesOnly ? 'nouveau crash' : 'nouvelle erreur'}${r.includeRegressions ? ' ou erreur réapparue' : ''}${r.service ? ' dans ' + r.service : ''}`;
    case 'silence':
      return `${r.service ?? 'un service'} muet depuis ${win}`;
    case 'probe':
      return `${probes.find((p) => p.id === r.targetId)?.name ?? 'une sonde'} en panne${r.threshold > 0 ? `, certificat < ${r.threshold} j` : ''}`;
    case 'slo':
      return `${slos.find((s) => s.id === r.targetId)?.name ?? 'un objectif'} : budget consommé > ${(r.threshold || 14.4).toLocaleString('fr-FR')}× sur ${win}`;
    case 'health':
      return r.severity === 'warning' ? 'Vigil : avertissement ou problème critique' : 'Vigil : problème critique';
    default: {
      const agg = AGGREGATES.find((a) => a.value === r.aggregate)?.label.replace('…', r.field ?? '') ?? r.aggregate;
      return `${agg} de ${r.source}${r.filter ? ' « ' + r.filter + ' »' : ''}${r.groupBy ? ' par ' + r.groupBy : ''}${scope} ${cmp} ${r.threshold.toLocaleString('fr-FR')} sur ${win}`;
    }
  }
}

/** Éditeur de règle : une phrase à compléter, un aperçu de la valeur actuelle, puis qui prévenir. */
@Component({
  selector: 'vg-alert-editor',
  imports: [FormsModule, RouterLink],
  template: `
    <form class="editor" (ngSubmit)="save()">
      <div class="block">
        <h3>Me prévenir quand</h3>
        <div class="kinds">
          @for (k of kinds; track k.value) {
            <button type="button" class="kind" [class.on]="r().kind === k.value" (click)="setKind(k.value)" [title]="k.hint">{{ k.label }}</button>
          }
        </div>

        <div class="sentence">
          @switch (r().kind) {
            @case ('http') {
              <select name="stat" [ngModel]="r().stat" (ngModelChange)="patch({ stat: $event, threshold: defaultThreshold($event), minCount: $event === 'errorRate' ? 20 : 0 })">
                @for (s of httpStats; track s.value) { <option [value]="s.value">{{ s.label }}</option> }
              </select>
              <span>des requêtes de</span>
              <select name="svc" [ngModel]="serviceChoice()" (ngModelChange)="setServiceChoice($event)">
                <option value="">tous les services (ensemble)</option>
                <option value="*">chaque service (séparément)</option>
                @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
              </select>
              <input name="route" class="route" [ngModel]="r().route ?? ''" (ngModelChange)="patch({ route: $event })" placeholder="route (facultatif)" />
              <span>{{ r().comparison === 'below' ? 'passe sous' : 'dépasse' }}</span>
              <input name="th" type="number" class="num" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" />
              <span>{{ httpUnit() }} sur</span>
              <select name="win" [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
              </select>
              @if (r().stat === 'errorRate') {
                <span class="muted">avec au moins</span>
                <input name="min" type="number" class="num" [ngModel]="r().minCount" (ngModelChange)="patch({ minCount: +$event })" min="0" />
                <span class="muted">requêtes</span>
              }
            }
            @case ('error') {
              <span>une nouvelle erreur apparaît dans</span>
              <select name="svc" [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                <option value="">n'importe quel service</option>
                @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
              </select>
              <label class="check"><input type="checkbox" name="reg" [ngModel]="r().includeRegressions" (ngModelChange)="patch({ includeRegressions: $event })" /> ou une erreur résolue réapparaît</label>
              <label class="check"><input type="checkbox" name="crash" [ngModel]="r().crashesOnly" (ngModelChange)="patch({ crashesOnly: $event })" /> crashs seulement</label>
            }
            @case ('silence') {
              <select name="svc" [ngModel]="r().service ?? ''" (ngModelChange)="patch({ service: $event || null })">
                <option value="">un des services actifs (24 h)</option>
                @for (s of services(); track s) { <option [value]="s">{{ s }}</option> }
              </select>
              <span>n'envoie plus rien depuis</span>
              <select name="win" [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
              </select>
            }
            @case ('query') {
              <select name="agg" [ngModel]="r().aggregate" (ngModelChange)="patch({ aggregate: $event })">
                @for (a of aggregates; track a.value) { <option [value]="a.value">{{ a.label }}</option> }
              </select>
              @if (needsField()) {
                <input name="field" class="field" [ngModel]="r().field ?? ''" (ngModelChange)="patch({ field: $event })" placeholder="champ, ex. duration" />
              }
              <span>des</span>
              <select name="src" [ngModel]="r().source" (ngModelChange)="patch({ source: $event })">
                <option value="logs">logs</option><option value="spans">spans</option><option value="metrics">métriques</option>
              </select>
              <input name="filter" class="filter mono" [ngModel]="r().filter ?? ''" (ngModelChange)="patch({ filter: $event })" placeholder='filtre, ex. level:error "paiement"' />
              <input name="group" class="group" [ngModel]="r().groupBy ?? ''" (ngModelChange)="patch({ groupBy: $event })" placeholder="par (facultatif), ex. service" />
              <select name="cmp" [ngModel]="r().comparison" (ngModelChange)="patch({ comparison: $event })">
                <option value="above">dépasse</option><option value="below">passe sous</option>
              </select>
              <input name="th" type="number" class="num" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" />
              <span>sur</span>
              <select name="win" [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
              </select>
            }
            @case ('probe') {
              <select name="probe" [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                <option value="">une des sondes</option>
                @for (p of probes(); track p.id) { <option [value]="p.id">{{ p.name }}</option> }
              </select>
              <span>ne répond plus, ou son certificat TLS expire dans moins de</span>
              <input name="th" type="number" class="num" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" min="0" />
              <span>jours</span>
              @if (!probes().length) { <a routerLink="/uptime" class="small">Créer une sonde</a> }
            }
            @case ('slo') {
              <select name="slo" [ngModel]="r().targetId ?? ''" (ngModelChange)="patch({ targetId: $event || null })">
                <option value="">un des objectifs</option>
                @for (s of slos(); track s.id) { <option [value]="s.id">{{ s.name }}</option> }
              </select>
              <span>consomme son budget d'erreur plus de</span>
              <input name="th" type="number" class="num" [ngModel]="r().threshold" (ngModelChange)="patch({ threshold: +$event })" step="any" min="1" />
              <span>fois trop vite sur</span>
              <select name="win" [ngModel]="r().windowMinutes" (ngModelChange)="patch({ windowMinutes: +$event })">
                @for (w of windows; track w.value) { <option [value]="w.value">{{ w.label }}</option> }
              </select>
              <span class="muted small full">14,4× sur 1 h ou 6× sur 6 h : le budget d'un mois serait épuisé en 2 jours ou en 5 jours.</span>
            }
            @case ('health') {
              <span>Vigil lui-même a un problème (disque, écriture, réception, notifications).</span>
            }
          }
        </div>
        @if (r().kind !== 'health' && environments().length) {
          <div class="sentence">
            <span class="muted">Environnement</span>
            <select name="env" [ngModel]="r().env ?? ''" (ngModelChange)="patch({ env: $event || null })">
              <option value="">tous</option>
              @for (e of environments(); track e) { <option [value]="e">{{ e }}</option> }
            </select>
          </div>
        }
      </div>

      <div class="preview" [class.breach]="breaching().length">
        @if (previewError()) {
          <span class="danger">{{ previewError() }}</span>
        } @else if (preview() === null) {
          <span class="muted">Calcul de la valeur actuelle…</span>
        } @else if (!preview()!.length) {
          <span class="muted">{{ r().kind === 'error' ? 'Aucune nouvelle erreur en ce moment.' : 'Pas de donnée en ce moment pour ces critères.' }}</span>
        } @else {
          <div class="muted small">Maintenant{{ breaching().length ? ' : se déclencherait' : ' : ne se déclencherait pas' }}</div>
          @for (e of preview()!.slice(0, 6); track e.key) {
            <div class="ev" [class.on]="e.breach">{{ e.message }}</div>
          }
          @if (preview()!.length > 6) { <div class="muted small">et {{ preview()!.length - 6 }} autre(s)</div> }
        }
      </div>

      <div class="block">
        <h3>Prévenir</h3>
        @if (channels().length) {
          <div class="channels">
            @for (c of channels(); track c.id) {
              <label class="check"><input type="checkbox" [name]="'ch' + c.id" [ngModel]="r().channels.includes(c.id)" (ngModelChange)="toggleChannel(c.id)" />
                {{ c.name }} <span class="muted small">{{ channelType(c.type) }}</span></label>
            }
          </div>
        } @else {
          <p class="muted small">Aucun canal de notification : l'alerte sera visible dans Vigil seulement.
            @if (session.isAdmin()) { <a routerLink="/alerts" [queryParams]="{ tab: 'channels' }">Ajouter un canal (e-mail, Teams, Slack)</a> }</p>
        }
        <div class="grid">
          <label>Gravité
            <div class="seg">
              <button type="button" [class.on]="r().severity === 'critical'" (click)="patch({ severity: 'critical' })">Critique</button>
              <button type="button" [class.on]="r().severity === 'warning'" (click)="patch({ severity: 'warning' })">Avertissement</button>
            </div>
          </label>
          @if (r().kind !== 'error') {
            <label>Déclencher après
              <select name="for" [ngModel]="r().forMinutes" (ngModelChange)="patch({ forMinutes: +$event })">
                <option [value]="0">immédiatement</option><option [value]="2">2 min</option><option [value]="5">5 min</option>
                <option [value]="10">10 min</option><option [value]="30">30 min</option>
              </select>
            </label>
          }
          <label>Rappel
            <select name="repeat" [ngModel]="r().repeatMinutes" (ngModelChange)="patch({ repeatMinutes: +$event })">
              <option [value]="0">jamais</option><option [value]="30">toutes les 30 min</option><option [value]="60">toutes les heures</option>
              <option [value]="240">toutes les 4 h</option><option [value]="1440">tous les jours</option>
            </select>
          </label>
          @if (r().kind !== 'error') {
            <label class="check inline"><input type="checkbox" name="res" [ngModel]="r().notifyResolved" (ngModelChange)="patch({ notifyResolved: $event })" /> Prévenir aussi au retour à la normale</label>
          }
        </div>
        <label>Consigne pour la personne prévenue <input name="runbook" [ngModel]="r().runbook ?? ''" (ngModelChange)="patch({ runbook: $event })"
          placeholder="ex. Vérifier la connexion à la base, procédure : https://wiki/…" /></label>
        <label>Nom <input name="name" [ngModel]="name()" (ngModelChange)="customName.set($event)" [placeholder]="autoName()" /></label>
      </div>

      @if (error()) { <p class="danger small">{{ error() }}</p> }
      <div class="actions">
        <button class="btn primary" type="submit" [disabled]="busy()">{{ r().id ? 'Enregistrer' : "Créer l'alerte" }}</button>
        <button class="btn" type="button" (click)="closed.emit()">Annuler</button>
        <span class="spacer"></span>
        @if (r().id) {
          @if (confirmDelete()) {
            <span class="small">Supprimer cette alerte ?</span>
            <button class="btn danger-btn" type="button" (click)="remove()">Supprimer</button>
            <button class="btn ghost" type="button" (click)="confirmDelete.set(false)">Non</button>
          } @else {
            <button class="btn ghost" type="button" (click)="confirmDelete.set(true)">Supprimer</button>
          }
        }
      </div>
    </form>
  `,
  styles: `
    .editor { display: grid; gap: 14px; }
    .block { display: grid; gap: 10px; }
    h3 { margin: 0; }
    .kinds { display: flex; flex-wrap: wrap; gap: 6px; }
    .kind { height: 28px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2);
      color: var(--text-2); font: 500 12.5px var(--sans); cursor: pointer; }
    .kind:hover { color: var(--text-1); }
    .kind.on { border-color: var(--accent); color: var(--text-1); background: var(--accent-soft); }
    .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 13px; }
    .sentence .num { width: 80px; }
    .sentence .route, .sentence .group { width: 170px; }
    .sentence .field { width: 150px; }
    .sentence .filter { flex: 1; min-width: 220px; }
    .full { flex-basis: 100%; }
    .preview { padding: 10px 12px; border: 1px dashed var(--border); border-radius: var(--radius); font-size: 12.5px; display: grid; gap: 4px; }
    .preview.breach { border-color: var(--danger); }
    .ev { color: var(--text-2); }
    .ev.on { color: var(--danger); }
    .channels { display: flex; flex-wrap: wrap; gap: 6px 16px; }
    .grid { display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: end; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); }
    label.inline { height: 28px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .danger-btn { color: var(--danger); border-color: var(--danger); }
    p { margin: 0; }
  `,
})
export class AlertEditor {
  private readonly api = inject(Api);
  private readonly state = inject(AppState);
  protected readonly session = inject(Session);

  /** Règle à modifier (ou pré-remplie pour une création). */
  readonly rule = input.required<AlertRule>();
  readonly saved = output<AlertRule>();
  readonly closed = output<void>();
  readonly deleted = output<void>();

  protected readonly kinds = ALERT_KINDS;
  protected readonly windows = WINDOWS;
  protected readonly httpStats = HTTP_STATS;
  protected readonly aggregates = AGGREGATES;

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
  private readonly previews = new Subject<AlertRule>();
  private sub: Subscription;

  protected readonly breaching = computed(() => (this.preview() ?? []).filter((e) => e.breach));
  protected readonly needsField = computed(() => AGGREGATES.find((a) => a.value === this.r().aggregate)?.numeric ?? false);
  protected readonly httpUnit = computed(() => HTTP_STATS.find((s) => s.value === this.r().stat)?.unit ?? '');
  protected readonly serviceChoice = computed(() => (this.r().perService ? '*' : (this.r().service ?? '')));
  protected readonly autoName = computed(() => {
    const d = describeRule(this.r(), this.probes(), this.slos());
    return d.charAt(0).toUpperCase() + d.slice(1);
  });
  protected readonly name = computed(() => this.customName() || '');

  constructor() {
    effect(() => {
      const rule = this.rule();
      untracked(() => {
        this.r.set({ ...newRule(rule.kind), ...rule, channels: [...(rule.channels ?? [])] });
        this.customName.set(rule.name ?? '');
        this.confirmDelete.set(false);
        this.error.set('');
      });
    });
    this.api.services({ from: '7d', to: '' }).subscribe((s) => this.services.set(s.map((x) => x.name)));
    this.api.environments().subscribe((e) => this.environments.set(e));
    this.api.channels().subscribe((c) => {
      this.channels.set(c);
      // Nouvelle règle : canaux « par défaut » déjà cochés.
      if (!this.rule().id && !this.rule().channels?.length) this.patch({ channels: c.filter((x) => x.default).map((x) => x.id) });
    });
    this.api.probes({ from: '1h', to: '' }).subscribe((p) => this.probes.set(p.map((x) => x.probe)));
    this.api.slos().subscribe((s) => this.slos.set(s.map((x) => x.slo)));

    this.sub = this.previews
      .pipe(
        debounceTime(400),
        switchMap((rule) =>
          this.api.previewAlert(rule).pipe(
            catchError((e) => {
              this.previewError.set(e?.error?.error ?? 'Aperçu impossible.');
              return of(null);
            }),
          ),
        ),
      )
      .subscribe((p) => {
        if (p) {
          this.previewError.set('');
          this.preview.set(p);
        }
      });
    effect(() => {
      const rule = this.r();
      untracked(() => this.previews.next({ ...rule, name: rule.name || 'aperçu' }));
    });
  }

  ngOnDestroy() {
    this.sub.unsubscribe();
  }

  protected patch(change: Partial<AlertRule>) {
    this.r.update((r) => ({ ...r, ...change }));
  }

  protected setKind(kind: AlertKind) {
    if (kind === this.r().kind) return;
    const fresh = newRule(kind);
    this.r.update((r) => ({
      ...r, kind, threshold: kind === 'slo' ? 14.4 : kind === 'probe' ? 14 : fresh.threshold, windowMinutes: fresh.windowMinutes,
      minCount: fresh.minCount, comparison: 'above', stat: r.stat ?? 'errorRate',
    }));
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

  protected channelType(t: string) {
    return ({ email: 'e-mail', teams: 'Teams', slack: 'Slack', webhook: 'webhook' } as Record<string, string>)[t] ?? t;
  }

  protected save() {
    this.busy.set(true);
    this.error.set('');
    const rule = { ...this.r(), name: this.customName().trim() || this.autoName() };
    this.api.saveAlert(rule).subscribe({
      next: (saved) => {
        this.busy.set(false);
        this.saved.emit(saved);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  protected remove() {
    this.api.deleteAlert(this.r().id).subscribe(() => this.deleted.emit());
  }
}
