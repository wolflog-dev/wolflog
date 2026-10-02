import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, distinctUntilChanged, of, switchMap, tap } from 'rxjs';
import { Api } from '../core/api';
import { LogSourceConfig, SourcePreview } from '../core/models';
import { Toasts } from '../core/toasts';
import { TimePipe } from '../core/pipes/time-pipe';
import { CodeBlock } from '../shared/code-block';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

const FORMATS = [
  { value: 'auto', label: 'Détection automatique', hint: 'Chaque ligne est reconnue : texte, JSON, IIS, Docker, Kubernetes', icon: 'sparkles' },
  { value: 'plain', label: 'Texte', hint: 'Une entrée par ligne ; date et niveau reconnus s’ils sont en tête', icon: 'text' },
  { value: 'json', label: 'JSON', hint: 'Une entrée JSON par ligne (Serilog compact, pino, bunyan…)', icon: 'code' },
  { value: 'iis', label: 'IIS (W3C)', hint: 'Chaque ligne devient une requête HTTP dans Wolflog', icon: 'requests' },
  { value: 'docker', label: 'Docker', hint: 'Pilote json-file : /var/lib/docker/containers/…', icon: 'layers' },
  { value: 'cri', label: 'Kubernetes', hint: 'containerd / CRI-O : /var/log/containers/…', icon: 'server' },
];

const PRESETS = [
  { label: 'IIS', path: 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log', format: 'iis', name: 'IIS', icon: 'globe' },
  { label: 'Fichiers Linux', path: '/var/log/mon-app/*.log', format: 'auto', name: 'mon-app', icon: 'terminal' },
  { label: 'Docker', path: '/var/lib/docker/containers/**/*-json.log', format: 'docker', name: 'docker', icon: 'layers' },
  { label: 'Kubernetes', path: '/var/log/containers/*.log', format: 'cri', name: 'kubernetes', icon: 'server' },
];

const isWindows = navigator.userAgent.includes('Windows');

function blank(): LogSourceConfig {
  return { id: '', name: '', enabled: true, type: 'file', path: '', format: 'auto', startAtEnd: true, port: 5514, protocol: 'both', service: null, env: null };
}

/** Création / modification d'une source : type, emplacement (avec aperçu des lignes lues), puis nom et service. */
@Component({
  selector: 'wl-source-form',
  imports: [FormsModule, RouterLink, TimePipe, CodeBlock, NavIcon, RichOption, Skeleton],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/sources" class="small crumb"><wl-nav-icon name="sources" [size]="14" />Sources</a>
        <span class="muted">/</span>
        <h1>{{ f().id ? 'Modifier la source' : 'Nouvelle source' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/admin/sources">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">
          <wl-nav-icon [name]="busy() ? 'refresh' : f().id ? 'check' : 'plus'" [class.spin]="busy()" [size]="14" />{{ f().id ? 'Enregistrer' : 'Ajouter la source' }}
        </button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Quel type de source ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice" [class.on]="f().type === 'file'" (click)="patch({ type: 'file' })">
                  <span class="choice-icon"><wl-nav-icon name="file" [size]="18" /></span>
                  <strong>Fichiers de logs</strong><span>Sur le serveur Wolflog : IIS, fichiers texte ou JSON, Docker, Kubernetes. Autre machine : mode agent.</span>
                </button>
                <button type="button" class="choice" [class.on]="f().type === 'syslog'" (click)="patch({ type: 'syslog' })">
                  <span class="choice-icon"><wl-nav-icon name="server" [size]="18" /></span>
                  <strong>Syslog</strong><span>Équipements réseau, serveurs Linux (rsyslog), appliances : envoi vers Wolflog en UDP ou TCP.</span>
                </button>
              </div>
            </div>
          </section>

          @if (f().type === 'file') {
            <section class="panel step" [class.done]="!!f().path">
              <div class="step-head"><span class="num">2</span><h2>Quels fichiers ?</h2></div>
              <div class="step-body">
                <div class="presets small">
                  <span class="muted">Exemples :</span>
                  @for (p of presets; track p.label) {
                    <button type="button" class="preset" [class.on]="f().path === p.path" (click)="preset(p)" [title]="p.path">
                      <wl-nav-icon [name]="p.icon" [size]="13" />{{ p.label }}
                    </button>
                  }
                </div>
                <label class="field">Chemin sur le serveur Wolflog (* accepté dans le nom, ** pour les sous-dossiers)
                  <span class="control"><wl-nav-icon name="file" [size]="14" />
                    <input class="mono" [ngModel]="f().path" (ngModelChange)="patch({ path: $event })" [placeholder]="pathHint" spellcheck="false" /></span></label>
                <div class="choices">
                  @for (x of formats; track x.value) {
                    <button type="button" class="choice small-choice" [class.on]="f().format === x.value" (click)="patch({ format: x.value })">
                      <strong><wl-nav-icon [name]="x.icon" [size]="14" />{{ x.label }}</strong><span>{{ x.hint }}</span>
                    </button>
                  }
                </div>
                <label class="check"><input type="checkbox" class="switch" [ngModel]="!f().startAtEnd" (ngModelChange)="patch({ startAtEnd: !$event })" /> Importer aussi le contenu déjà présent (sinon, seulement les nouvelles lignes)</label>
                <details class="agent">
                  <summary class="small"><wl-nav-icon class="chev" name="chevron-right" [size]="13" />Les fichiers sont sur une autre machine ?</summary>
                  <div class="agent-body">
                    <p class="muted small">Copier le binaire Wolflog sur cette machine et lancer le mode agent avec une clé API « serveur » :</p>
                    <wl-code [code]="agentCommand()" />
                  </div>
                </details>
              </div>
            </section>
          } @else {
            <section class="panel step" [class.done]="portValid()">
              <div class="step-head"><span class="num">2</span><h2>Sur quel port écouter ?</h2></div>
              <div class="step-body">
                <div class="sentence">
                  <span>Écouter sur le port</span>
                  <input type="number" class="num-in" min="1" max="65535" [ngModel]="f().port" (ngModelChange)="patch({ port: +$event })" />
                  <span>en</span>
                  <select class="proto" [ngModel]="f().protocol" (ngModelChange)="patch({ protocol: $event })" aria-label="Protocole">
                    <option value="both" wlOpt="UDP et TCP" icon="split" desc="Le plus compatible : chaque émetteur choisit"></option>
                    <option value="udp" wlOpt="UDP" icon="bolt" tone="warn" desc="Léger, sans accusé de réception (rsyslog : @)"></option>
                    <option value="tcp" wlOpt="TCP" icon="link" tone="ok" desc="Fiable, messages longs (rsyslog : @@)"></option>
                  </select>
                </div>
                @if (!portValid()) { <p class="error small" animate.enter="step-in"><wl-nav-icon name="warning" [size]="13" />Port attendu entre 1 et 65535.</p> }
                <p class="muted small">Sur les machines émettrices (rsyslog, fichier /etc/rsyslog.d/wolflog.conf) :</p>
                <wl-code [code]="rsyslog()" lang="rsyslog" />
              </div>
            </section>
          }

          <section class="panel step done">
            <div class="step-head"><span class="num">3</span><h2>Nom et service</h2></div>
            <div class="step-body">
              <div class="options">
                <label class="field">Nom
                  <span class="control"><wl-nav-icon name="hash" [size]="14" /><input [ngModel]="f().name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></span></label>
                <label class="field">Service
                  <span class="control"><wl-nav-icon name="layers" [size]="14" /><input [ngModel]="f().service ?? ''" (ngModelChange)="patch({ service: $event || null })" [placeholder]="f().name || autoName()" /></span>
                  <span class="muted small">Nom sous lequel les logs apparaissent dans Wolflog.</span></label>
                <label class="field">Environnement
                  <span class="control"><wl-nav-icon name="globe" [size]="14" /><input [ngModel]="f().env ?? ''" (ngModelChange)="patch({ env: $event || null })" placeholder="facultatif, ex. prod" /></span></label>
              </div>
            </div>
          </section>
        </div>

        <aside class="panel summary">
          <div class="block">
            <h3>Résumé</h3>
            <p class="phrase">{{ summary() }}</p>
          </div>
          @if (f().type === 'file') {
            <div class="block">
              <h3 class="preview-title">Aperçu des dernières lignes
                @if (reading()) { <wl-nav-icon class="spin" name="refresh" [size]="12" title="Lecture en cours" /> }
              </h3>
              @if (preview(); as p) {
                <div class="preview" [class.stale]="reading()">
                  @if (p.error) {
                    <span class="error small"><wl-nav-icon name="warning" [size]="13" />{{ p.error }}</span>
                  } @else if (!p.total) {
                    <span class="muted small">Aucun fichier ne correspond pour l'instant : la source les suivra dès qu'ils apparaîtront.</span>
                  } @else {
                    <span class="files small"><span class="pill">{{ p.total }} fichier{{ p.total > 1 ? 's' : '' }}</span>dont
                      <span class="mono ellipsis" [title]="p.newest ?? ''">{{ fileName(p.newest) }}</span></span>
                    @for (e of p.entries; track $index; let j = $index) {
                      <div class="entry" [style.--j]="j">
                        <span class="mono muted">{{ e.ts | time }}</span>
                        <span [class]="'lvl lvl-' + e.level">{{ e.level }}</span>
                        <span class="mono ellipsis" [title]="e.body">
                          @if (e.http) { {{ e.http.method }} {{ e.http.path }} {{ e.http.status }} }
                          @else { @if (e.exception) { <span class="tag err">{{ e.exception }}</span> } {{ e.body }} }
                        </span>
                      </div>
                    } @empty { <span class="muted small">Fichier vide pour l'instant.</span> }
                  }
                </div>
              } @else if (f().path) {
                <wl-skeleton [rows]="4" />
              } @else {
                <span class="muted small placeholder"><wl-nav-icon name="file" [size]="13" />Indiquez le chemin des fichiers.</span>
              }
            </div>
          }
          @if (error()) { <div class="block"><span class="error small" role="alert" animate.enter="step-in"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div> }
          <div class="actions">
            @if (confirmDelete()) {
              <span class="confirm" animate.enter="step-in">
                <span class="small">Supprimer cette source ?</span>
                <button class="btn danger-btn" (click)="remove()" [disabled]="busy()"><wl-nav-icon name="trash" [size]="13" />Supprimer</button>
                <button class="btn ghost" (click)="confirmDelete.set(false)">Annuler</button>
              </span>
            } @else {
              <button class="btn primary" (click)="save()" [disabled]="busy()">
                <wl-nav-icon [name]="busy() ? 'refresh' : f().id ? 'check' : 'plus'" [class.spin]="busy()" [size]="14" />{{ f().id ? 'Enregistrer' : 'Ajouter la source' }}
              </button>
              <a class="btn" routerLink="/admin/sources">Annuler</a>
              <span class="spacer"></span>
              @if (f().id) { <button class="btn ghost del" (click)="confirmDelete.set(true)" title="Supprimer la source" aria-label="Supprimer la source"><wl-nav-icon name="trash" [size]="14" /></button> }
            }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .choices .small-choice { padding: 8px 10px; }
    .small-choice strong { display: flex; align-items: center; gap: 7px; }
    .small-choice strong wl-nav-icon { color: var(--accent); transition: transform .4s var(--spring); }
    .small-choice:hover strong wl-nav-icon { transform: scale(1.15) rotate(-8deg); }
    .choice-icon { display: grid; place-items: center; width: 36px; height: 36px; margin-bottom: 6px; border-radius: 11px;
      transition: transform .45s var(--spring), background-color .25s, color .25s; }
    .choice .choice-icon { color: var(--accent); background: var(--accent-soft); }
    .choice:hover .choice-icon { transform: scale(1.08) rotate(-6deg); }
    .choice.on .choice-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 8px 18px -8px var(--accent); animation: chosen .5s var(--spring); }
    @keyframes chosen { 40% { transform: scale(1.18) rotate(-8deg); } }
    .step-in { animation: step-in .45s var(--spring); }
    @keyframes step-in { from { opacity: 0; transform: translateY(-6px); } }

    .presets { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .presets .muted { margin-right: 2px; }
    .preset { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 9px; border-radius: 999px; cursor: pointer;
      border: 1px solid var(--border); background: var(--surface-2); color: var(--text-2); font: 500 12px var(--sans);
      transition: border-color .2s, color .2s, background-color .2s, transform .3s var(--spring); }
    .preset wl-nav-icon { color: var(--accent); }
    .preset:hover { color: var(--text-1); border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); transform: translateY(-1px); }
    .preset:active { transform: scale(.95); }
    .preset.on { color: var(--text-1); border-color: var(--accent); background: var(--accent-soft); }
    .control { position: relative; display: block; }
    .control input { width: 100%; padding-left: 32px; }
    .control wl-nav-icon { position: absolute; left: 11px; top: 0; bottom: 0; margin: auto 0; height: 14px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within wl-nav-icon { color: var(--accent); transform: translateY(-1px) scale(1.12); }
    .num-in { width: 90px; }
    .proto { min-width: 150px; }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; flex: 1; }
    label.check { display: inline-flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-1); cursor: pointer; white-space: normal; }
    .agent summary { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--text-2); list-style: none; transition: color .2s; }
    .agent summary::-webkit-details-marker { display: none; }
    .agent summary:hover { color: var(--accent); }
    .agent .chev { transition: transform .35s var(--spring); }
    .agent[open] .chev { transform: rotate(90deg); }
    .agent[open] .agent-body { animation: step-in .4s var(--ease); }
    .agent p { margin: 8px 0; }

    .preview-title { display: flex; align-items: center; gap: 6px; }
    .preview { display: grid; gap: 4px; min-width: 0; transition: opacity .3s; }
    .preview.stale { opacity: .55; }
    .files { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text-3); margin-bottom: 4px; }
    .pill { flex: none; padding: 0 8px; border-radius: 999px; font: 600 11px/18px var(--sans); color: var(--accent); background: var(--accent-soft); }
    .entry { display: grid; grid-template-columns: 90px 40px minmax(0, 1fr); gap: 6px; padding: 2px 4px; margin: 0 -4px; border-radius: 6px; font-size: 11.5px;
      align-items: baseline; transition: background-color .15s; animation: entry-in .35s var(--ease) backwards; animation-delay: calc(var(--j) * 30ms); }
    .entry:hover { background-color: var(--row-hover); }
    @keyframes entry-in { from { opacity: 0; transform: translateX(-4px); } }
    .entry .tag { margin-right: 4px; }
    .placeholder { display: inline-flex; align-items: center; gap: 6px; }
    wl-skeleton { padding: 4px 0; }
    .error { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--danger); }
    .error wl-nav-icon { flex: none; margin-top: 2px; }
    p.error { margin: 0; }
    .confirm { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
    .danger-btn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); }
    .danger-btn:hover { border-color: var(--danger); background-color: color-mix(in srgb, var(--danger) 18%, transparent); }
    .del { width: 32px; padding: 0; justify-content: center; }
    .del:hover { color: var(--danger); }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class SourceFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  /** /admin/sources/:id ou /admin/sources/new */
  readonly id = input<string>('');

  protected readonly f = signal<LogSourceConfig>(blank());
  protected readonly preview = signal<(SourcePreview & { error?: string }) | null>(null);
  /** Aperçu demandé, pas encore reçu. */
  protected readonly reading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Suppression demandée : confirmation en place des boutons. */
  protected readonly confirmDelete = signal(false);
  protected readonly formats = FORMATS;
  protected readonly presets = PRESETS;
  protected readonly pathHint = isWindows ? 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log' : '/var/log/mon-app/*.log';
  private readonly previews = new Subject<LogSourceConfig | null>();

  protected readonly portValid = computed(() => Number.isInteger(this.f().port) && this.f().port >= 1 && this.f().port <= 65535);

  protected readonly autoName = computed(() => {
    const f = this.f();
    if (f.type === 'syslog') return 'syslog';
    // Nom du fichier sans motif ni extension (app-*.log → app), sinon le dossier.
    const parts = (f.path ?? '').split(/[\\/]/).filter(Boolean);
    const file = (parts.at(-1) ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[*?]/g, '').replace(/[-_.]+$/, '');
    return file || parts.filter((p) => !p.includes('*')).at(-1) || 'fichiers';
  });

  protected readonly summary = computed(() => {
    const f = this.f();
    const service = f.service || f.name || this.autoName();
    if (f.type === 'syslog') {
      const proto = f.protocol === 'both' ? 'UDP et TCP' : f.protocol.toUpperCase();
      return `Wolflog écoutera les messages syslog sur le port ${f.port} (${proto}) ; le service est le nom de l'application émettrice, à défaut « ${service} ».`;
    }
    const format = FORMATS.find((x) => x.value === f.format)?.label.toLowerCase() ?? f.format;
    return `Wolflog suivra ${f.path || '…'} (${format}) ${f.startAtEnd ? 'à partir des nouvelles lignes' : 'depuis le début'}, sous le service « ${service} ».`;
  });

  protected readonly agentCommand = computed(() => {
    const f = this.f();
    const path = f.path || this.pathHint;
    const exe = path.includes('\\') ? 'wolflog.exe' : './wolflog';
    // Une seule ligne sous Windows (pas de continuation « \\ » dans cmd / PowerShell).
    const sep = exe === 'wolflog.exe' ? ' ' : ' \\\n  ';
    return `${exe} agent --endpoint ${location.origin} --key <clé API>${sep}--file "${path}" --format ${f.format} --service ${f.service || f.name || this.autoName()}`;
  });

  protected readonly rsyslog = computed(() => {
    const f = this.f();
    const host = location.hostname;
    return f.protocol === 'udp' ? `*.* @${host}:${f.port}` : `*.* @@${host}:${f.port}`;
  });

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        if (!id) return;
        this.api.sources().subscribe((l) => {
          const found = l.find((x) => x.source.id === id)?.source;
          if (found) this.f.set({ ...found });
          else this.error.set('Source introuvable.');
        });
      });
    });
    // Seuls le type, le chemin et le format changent l'aperçu : le nom ou le service saisis ne relisent pas les fichiers.
    this.previews
      .pipe(
        distinctUntilChanged((a, b) => a === b || (!!a && !!b && a.type === b.type && a.path === b.path && a.format === b.format)),
        tap((f) => this.reading.set(!!f)),
        debounceTime(400),
        switchMap((f) => f
          ? this.api.previewSource(f).pipe(catchError((e) => of({ files: [], total: 0, newest: null, entries: [], error: e?.error?.error ?? 'Lecture impossible.' })))
          : of(null)),
      )
      .subscribe((p) => {
        this.preview.set(p);
        this.reading.set(false);
      });
    effect(() => {
      const f = this.f();
      untracked(() => {
        if (f.type === 'file' && f.path) this.previews.next(f);
        else {
          this.previews.next(null);
          this.preview.set(null);
        }
      });
    });
  }

  protected patch(change: Partial<LogSourceConfig>) {
    this.f.update((f) => ({ ...f, ...change }));
  }

  protected preset(p: (typeof PRESETS)[number]) {
    this.patch({ path: p.path, format: p.format, name: this.f().name || p.name });
  }

  protected fileName(p: string | null) {
    return p?.split(/[\\/]/).at(-1) ?? '';
  }

  protected save() {
    this.busy.set(true);
    this.error.set('');
    const f = this.f();
    const name = f.name.trim() || this.autoName();
    this.api.saveSource({ ...f, name }).subscribe({
      next: () => {
        this.toasts.ok(f.id ? `Source « ${name} » enregistrée` : `Source « ${name} » ajoutée`, 'sources');
        this.router.navigate(['/admin/sources']);
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
        this.toasts.error(this.error());
      },
    });
  }

  protected remove() {
    const name = this.f().name;
    this.busy.set(true);
    this.api.deleteSource(this.f().id).subscribe({
      next: () => {
        this.toasts.ok(`Source « ${name} » supprimée`, 'trash');
        this.router.navigate(['/admin/sources']);
      },
      error: (e) => {
        this.busy.set(false);
        this.confirmDelete.set(false);
        this.toasts.error(e?.error?.error ?? 'Suppression impossible.');
      },
    });
  }
}
