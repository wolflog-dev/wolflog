import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, switchMap, catchError, of } from 'rxjs';
import { Api, LogSourceConfig, SourceInfo, SourcePreview } from '../core/api';
import { AgoPipe, NumPipe, TimePipe } from '../core/format';
import { CodeBlock } from '../shared/widgets';

const FORMATS = [
  { value: 'auto', label: 'Détection automatique' },
  { value: 'plain', label: 'Texte' },
  { value: 'json', label: 'JSON (une ligne par entrée)' },
  { value: 'iis', label: 'IIS (W3C)' },
  { value: 'docker', label: 'Docker (json-file)' },
  { value: 'cri', label: 'Kubernetes (containerd, CRI-O)' },
];

const isWindows = navigator.userAgent.includes('Windows');

const PRESETS: { label: string; path: string; format: string; name: string }[] = [
  { label: 'IIS', path: 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log', format: 'iis', name: 'IIS' },
  { label: 'Fichiers Linux', path: '/var/log/mon-app/*.log', format: 'auto', name: 'mon-app' },
  { label: 'Docker', path: '/var/lib/docker/containers/**/*-json.log', format: 'docker', name: 'docker' },
  { label: 'Kubernetes', path: '/var/log/containers/*.log', format: 'cri', name: 'kubernetes' },
];

function blank(): LogSourceConfig {
  return { id: '', name: '', enabled: true, type: 'file', path: '', format: 'auto', startAtEnd: true, port: 5514, protocol: 'both', service: null, env: null };
}

@Component({
  selector: 'vg-admin-sources',
  imports: [FormsModule, AgoPipe, NumPipe, TimePipe, CodeBlock],
  template: `
    <div class="page">
      <div class="page-head">
        <h1>Sources</h1>
        <span class="muted small">logs lus directement par Vigil, sans bibliothèque dans l'application : fichiers, IIS, Docker, Kubernetes, syslog</span>
        <span class="spacer"></span>
        @if (!form()) { <button class="btn primary" (click)="create()">Ajouter une source</button> }
      </div>

      <div class="split" [class.with-side]="form()">
        <section class="panel">
          @if (items().length) {
            <table class="list">
              <thead><tr><th>État</th><th>Source</th><th class="hide-side">Service</th><th class="r">Entrées</th><th>Dernière entrée</th></tr></thead>
              <tbody>
                @for (i of items(); track i.source.id) {
                  <tr class="click" [class.sel]="form()?.id === i.source.id" (click)="edit(i.source)">
                    <td class="nowrap"><span class="state" [class]="stateClass(i)">{{ stateLabel(i) }}</span></td>
                    <td class="main">
                      <div>{{ i.source.name }}</div>
                      <div class="muted small mono ellipsis">{{ i.source.type === 'syslog' ? 'syslog, port ' + i.source.port : i.source.path }}</div>
                      @if (i.status.lastError && (!i.status.lastEntryAt || i.status.lastErrorAt! > i.status.lastEntryAt)) {
                        <div class="danger small">{{ i.status.lastError }}</div>
                      } @else if (i.status.detail) {
                        <div class="muted small">{{ i.status.detail }}</div>
                      }
                    </td>
                    <td class="hide-side">{{ i.source.service || i.source.name }}</td>
                    <td class="r mono">{{ i.status.entries | num }}</td>
                    <td class="muted small nowrap">{{ i.status.lastEntryAt ? (i.status.lastEntryAt | ago) : 'aucune' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty">
              Aucune source. Pour une application .NET, le paquet Vigil.Client reste le plus complet (traces, métriques, crashs) ;
              les sources servent pour le reste : IIS, services Windows ou Linux existants, conteneurs, équipements réseau (syslog).
            </div>
          }
        </section>

        @if (form(); as f) {
          <aside class="panel side">
            <div class="panel-head">
              <h2>{{ f.id ? 'Modifier la source' : 'Nouvelle source' }}</h2><span class="spacer"></span>
              <button class="btn ghost" (click)="form.set(null)">Fermer</button>
            </div>
            <form class="panel-body form" (ngSubmit)="save()">
              <div class="seg">
                <button type="button" [class.on]="f.type === 'file'" (click)="patch({ type: 'file' })">Fichiers</button>
                <button type="button" [class.on]="f.type === 'syslog'" (click)="patch({ type: 'syslog' })">Syslog</button>
              </div>

              @if (f.type === 'file') {
                <div class="presets small">
                  <span class="muted">Exemples :</span>
                  @for (p of presets; track p.label) { <button type="button" class="link" (click)="preset(p)">{{ p.label }}</button> }
                </div>
                <label>Fichiers (chemin sur le serveur Vigil, * accepté)
                  <input name="path" class="mono" [ngModel]="f.path" (ngModelChange)="patch({ path: $event })" [placeholder]="pathHint" />
                </label>
                <label>Format
                  <select name="fmt" [ngModel]="f.format" (ngModelChange)="patch({ format: $event })">
                    @for (x of formats; track x.value) { <option [value]="x.value">{{ x.label }}</option> }
                  </select>
                </label>

                <div class="preview">
                  @if (preview(); as p) {
                    @if (p.error) {
                      <span class="danger small">{{ p.error }}</span>
                    } @else if (!p.total) {
                      <span class="muted small">Aucun fichier ne correspond (pour l'instant) : la source les suivra dès qu'ils apparaîtront.</span>
                    } @else {
                      <div class="muted small">{{ p.total }} fichier(s), dont <span class="mono">{{ fileName(p.newest) }}</span> ; dernières entrées telles qu'elles seront lues :</div>
                      @for (e of p.entries; track $index) {
                        <div class="entry">
                          <span class="mono muted">{{ e.ts | time }}</span>
                          <span [class]="'lvl lvl-' + e.level">{{ e.level }}</span>
                          <span class="mono ellipsis" [title]="e.body">
                            @if (e.http) { <strong>{{ e.http.method }} {{ e.http.path }} {{ e.http.status }}</strong> {{ e.http.durationMs }} ms }
                            @else { @if (e.exception) { <span class="tag err">{{ e.exception }}</span> } {{ e.body }} }
                          </span>
                        </div>
                      } @empty { <div class="muted small">Fichier vide pour l'instant.</div> }
                    }
                  } @else if (f.path) {
                    <span class="muted small">Lecture…</span>
                  }
                </div>
                <label class="check"><input type="checkbox" name="all" [ngModel]="!f.startAtEnd" (ngModelChange)="patch({ startAtEnd: !$event })" /> Importer aussi le contenu déjà présent</label>
              } @else {
                <div class="row">
                  <label>Port <input name="port" type="number" min="1" max="65535" [ngModel]="f.port" (ngModelChange)="patch({ port: +$event })" /></label>
                  <label>Protocole
                    <select name="proto" [ngModel]="f.protocol" (ngModelChange)="patch({ protocol: $event })">
                      <option value="both">UDP et TCP</option><option value="udp">UDP</option><option value="tcp">TCP</option>
                    </select>
                  </label>
                </div>
                <p class="muted small">Sur les machines émettrices (rsyslog) : <code>*.* &#64;&#64;{{ host }}:{{ f.port }}</code> (TCP) ou <code>&#64;{{ host }}:{{ f.port }}</code> (UDP).
                  Le service est le nom de l'application syslog, à défaut celui indiqué ci-dessous.</p>
              }

              <div class="row">
                <label>Nom <input name="n" [ngModel]="f.name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
                <label>Service <input name="svc" [ngModel]="f.service ?? ''" (ngModelChange)="patch({ service: $event || null })" [placeholder]="f.name || autoName()" /></label>
                <label>Environnement <input name="env" [ngModel]="f.env ?? ''" (ngModelChange)="patch({ env: $event || null })" placeholder="facultatif" /></label>
              </div>
              @if (error()) { <p class="danger small">{{ error() }}</p> }
              <div class="actions">
                <button class="btn primary" type="submit">{{ f.id ? 'Enregistrer' : 'Ajouter' }}</button>
                @if (f.id) {
                  <button class="btn" type="button" (click)="toggle(f)">{{ f.enabled ? 'Mettre en pause' : 'Reprendre' }}</button>
                  <span class="spacer"></span>
                  <button class="btn ghost" type="button" (click)="remove(f.id)">Supprimer</button>
                }
              </div>

              @if (f.type === 'file') {
                <details class="agent">
                  <summary class="small">Fichiers sur un autre serveur : mode agent</summary>
                  <p class="muted small">Le binaire Vigil, copié sur ce serveur, lit les fichiers et les envoie ici (clé API « serveur », voir Clés API).</p>
                  <vg-code [code]="agentCommand()" />
                </details>
              }
            </form>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(460px, 46%); }
    .split.with-side .hide-side { display: none; }
    .side { position: sticky; top: 60px; max-height: calc(100vh - 80px); overflow: auto; }
    .state { font: 600 11px var(--mono); text-transform: uppercase; white-space: nowrap; }
    .state.ok { color: var(--ok); }
    .state.idle, .state.paused { color: var(--text-3); }
    .state.error { color: var(--danger); }
    .main { max-width: 0; width: 55%; }
    tr.sel td { background: var(--row-selected); }
    .form { display: grid; gap: 10px; }
    .form .seg { justify-self: start; }
    .presets { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
    .link:hover { text-decoration: underline; }
    .row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    label.check { display: inline-flex; font-size: 13px; color: var(--text-1); }
    .preview { border: 1px dashed var(--border); border-radius: var(--radius); padding: 8px 10px; display: grid; gap: 3px; min-height: 36px; }
    .entry { display: grid; grid-template-columns: 96px 44px minmax(0, 1fr); gap: 8px; font-size: 12px; align-items: baseline; }
    .entry .tag { margin-right: 4px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .agent { margin-top: 6px; border-top: 1px solid var(--border); padding-top: 10px; }
    .agent summary { cursor: pointer; color: var(--text-2); }
    .agent p { margin: 6px 0; }
    p { margin: 0; }
  `,
})
export class AdminSourcesPage {
  private readonly api = inject(Api);
  protected readonly items = signal<SourceInfo[]>([]);
  protected readonly form = signal<LogSourceConfig | null>(null);
  protected readonly preview = signal<(SourcePreview & { error?: string }) | null>(null);
  protected readonly error = signal('');
  protected readonly formats = FORMATS;
  protected readonly presets = PRESETS;
  protected readonly host = location.hostname;
  protected readonly pathHint = isWindows ? 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log' : '/var/log/mon-app/*.log';
  private readonly previews = new Subject<LogSourceConfig>();

  protected readonly autoName = computed(() => {
    const f = this.form();
    if (!f) return '';
    if (f.type === 'syslog') return 'syslog';
    // Nom du fichier sans motif ni extension (vux-*.log → vux), sinon le dossier.
    const parts = (f.path ?? '').split(/[\\/]/).filter(Boolean);
    const file = (parts.at(-1) ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[*?]/g, '').replace(/[-_.]+$/, '');
    return file || parts.filter((p) => !p.includes('*')).at(-1) || 'fichiers';
  });

  protected readonly agentCommand = computed(() => {
    const f = this.form();
    const path = f?.path || this.pathHint;
    const exe = path.includes('\\') ? 'vigil.exe' : './vigil';
    // Une seule ligne sous Windows (le « \\ » de continuation n'existe pas dans cmd / PowerShell).
    const sep = exe === 'vigil.exe' ? ' ' : ' \\\n  ';
    return `${exe} agent --endpoint ${location.origin} --key <clé API>${sep}--file "${path}" --format ${f?.format ?? 'auto'} --service ${f?.service || f?.name || this.autoName()}`;
  });

  constructor() {
    this.load();
    const timer = setInterval(() => this.load(), 5000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
    this.previews
      .pipe(
        debounceTime(400),
        switchMap((f) => this.api.previewSource(f).pipe(catchError((e) => of({ files: [], total: 0, newest: null, entries: [], error: e?.error?.error ?? 'Lecture impossible.' })))),
      )
      .subscribe((p) => this.preview.set(p));
    effect(() => {
      const f = this.form();
      untracked(() => {
        if (f?.type === 'file' && f.path) this.previews.next(f);
        else this.preview.set(null);
      });
    });
  }

  private load() {
    this.api.sources().subscribe((l) => this.items.set(l));
  }

  protected stateLabel(i: SourceInfo) {
    if (!i.source.enabled) return 'En pause';
    if (i.status.state === 'error') return 'Erreur';
    if (i.status.lastEntryAt) return 'Reçoit';
    return 'En attente';
  }

  protected stateClass(i: SourceInfo) {
    if (!i.source.enabled) return 'paused';
    if (i.status.state === 'error') return 'error';
    return i.status.lastEntryAt ? 'ok' : 'idle';
  }

  protected fileName(p: string | null) {
    return p?.split(/[\\/]/).at(-1) ?? '';
  }

  protected create() {
    this.error.set('');
    this.form.set(blank());
  }

  protected edit(s: LogSourceConfig) {
    this.error.set('');
    this.form.set({ ...s });
  }

  protected preset(p: (typeof PRESETS)[number]) {
    this.patch({ path: p.path, format: p.format, name: this.form()?.name || p.name });
  }

  protected patch(change: Partial<LogSourceConfig>) {
    this.form.update((f) => (f ? { ...f, ...change } : f));
  }

  protected save() {
    const f = this.form();
    if (!f) return;
    this.api.saveSource({ ...f, name: f.name.trim() || this.autoName() }).subscribe({
      next: () => {
        this.form.set(null);
        this.load();
      },
      error: (e) => this.error.set(e?.error?.error ?? 'Enregistrement impossible.'),
    });
  }

  protected toggle(f: LogSourceConfig) {
    this.api.saveSource({ ...f, enabled: !f.enabled }).subscribe(() => {
      this.form.set(null);
      this.load();
    });
  }

  protected remove(id: string) {
    this.api.deleteSource(id).subscribe(() => {
      this.form.set(null);
      this.load();
    });
  }
}
