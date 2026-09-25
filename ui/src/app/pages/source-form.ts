import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { Api, LogSourceConfig, SourcePreview } from '../core/api';
import { TimePipe } from '../core/format';
import { CodeBlock } from '../shared/widgets';

const FORMATS = [
  { value: 'auto', label: 'Détection automatique', hint: 'Chaque ligne est reconnue : texte, JSON, IIS, Docker, Kubernetes' },
  { value: 'plain', label: 'Texte', hint: 'Une entrée par ligne ; date et niveau reconnus s’ils sont en tête' },
  { value: 'json', label: 'JSON', hint: 'Une entrée JSON par ligne (Serilog compact, pino, bunyan…)' },
  { value: 'iis', label: 'IIS (W3C)', hint: 'Chaque ligne devient une requête HTTP dans Vigil' },
  { value: 'docker', label: 'Docker', hint: 'Pilote json-file : /var/lib/docker/containers/…' },
  { value: 'cri', label: 'Kubernetes', hint: 'containerd / CRI-O : /var/log/containers/…' },
];

const PRESETS = [
  { label: 'IIS', path: 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log', format: 'iis', name: 'IIS' },
  { label: 'Fichiers Linux', path: '/var/log/mon-app/*.log', format: 'auto', name: 'mon-app' },
  { label: 'Docker', path: '/var/lib/docker/containers/**/*-json.log', format: 'docker', name: 'docker' },
  { label: 'Kubernetes', path: '/var/log/containers/*.log', format: 'cri', name: 'kubernetes' },
];

const isWindows = navigator.userAgent.includes('Windows');

function blank(): LogSourceConfig {
  return { id: '', name: '', enabled: true, type: 'file', path: '', format: 'auto', startAtEnd: true, port: 5514, protocol: 'both', service: null, env: null };
}

/** Création / modification d'une source : type, emplacement (avec aperçu des lignes lues), puis nom et service. */
@Component({
  selector: 'vg-source-form',
  imports: [FormsModule, RouterLink, TimePipe, CodeBlock],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/sources" class="small">Sources</a>
        <span class="muted">/</span>
        <h1>{{ f().id ? 'Modifier la source' : 'Nouvelle source' }}</h1>
        <span class="spacer"></span>
        <a class="btn" routerLink="/admin/sources">Annuler</a>
        <button class="btn primary" (click)="save()" [disabled]="busy()">{{ f().id ? 'Enregistrer' : 'Ajouter la source' }}</button>
      </div>

      <div class="form-grid">
        <div class="steps">
          <section class="panel step done">
            <div class="step-head"><span class="num">1</span><h2>Quel type de source ?</h2></div>
            <div class="step-body">
              <div class="choices two">
                <button type="button" class="choice" [class.on]="f().type === 'file'" (click)="patch({ type: 'file' })">
                  <strong>Fichiers de logs</strong><span>Sur le serveur Vigil : IIS, fichiers texte ou JSON, Docker, Kubernetes. Autre machine : mode agent.</span>
                </button>
                <button type="button" class="choice" [class.on]="f().type === 'syslog'" (click)="patch({ type: 'syslog' })">
                  <strong>Syslog</strong><span>Équipements réseau, serveurs Linux (rsyslog), appliances : envoi vers Vigil en UDP ou TCP.</span>
                </button>
              </div>
            </div>
          </section>

          @if (f().type === 'file') {
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Quels fichiers ?</h2></div>
              <div class="step-body">
                <div class="presets small">
                  <span class="muted">Exemples :</span>
                  @for (p of presets; track p.label) { <button type="button" class="link" (click)="preset(p)">{{ p.label }}</button> }
                </div>
                <label class="field">Chemin sur le serveur Vigil (* accepté dans le nom, ** pour les sous-dossiers)
                  <input class="mono" [ngModel]="f().path" (ngModelChange)="patch({ path: $event })" [placeholder]="pathHint" /></label>
                <div class="choices">
                  @for (x of formats; track x.value) {
                    <button type="button" class="choice small-choice" [class.on]="f().format === x.value" (click)="patch({ format: x.value })">
                      <strong>{{ x.label }}</strong><span>{{ x.hint }}</span>
                    </button>
                  }
                </div>
                <label class="check"><input type="checkbox" [ngModel]="!f().startAtEnd" (ngModelChange)="patch({ startAtEnd: !$event })" /> Importer aussi le contenu déjà présent (sinon, seulement les nouvelles lignes)</label>
                <details class="agent">
                  <summary class="small">Les fichiers sont sur une autre machine ?</summary>
                  <p class="muted small">Copier le binaire Vigil sur cette machine et lancer le mode agent avec une clé API « serveur » :</p>
                  <vg-code [code]="agentCommand()" />
                </details>
              </div>
            </section>
          } @else {
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Sur quel port écouter ?</h2></div>
              <div class="step-body">
                <div class="sentence">
                  <span>Écouter sur le port</span>
                  <input type="number" class="num-in" min="1" max="65535" [ngModel]="f().port" (ngModelChange)="patch({ port: +$event })" />
                  <span>en</span>
                  <select [ngModel]="f().protocol" (ngModelChange)="patch({ protocol: $event })">
                    <option value="both">UDP et TCP</option><option value="udp">UDP</option><option value="tcp">TCP</option>
                  </select>
                </div>
                <p class="muted small">Sur les machines émettrices (rsyslog, fichier /etc/rsyslog.d/vigil.conf) :</p>
                <vg-code [code]="rsyslog()" />
              </div>
            </section>
          }

          <section class="panel step done">
            <div class="step-head"><span class="num">3</span><h2>Nom et service</h2></div>
            <div class="step-body">
              <div class="options">
                <label class="field">Nom <input [ngModel]="f().name" (ngModelChange)="patch({ name: $event })" [placeholder]="autoName()" /></label>
                <label class="field">Service <input [ngModel]="f().service ?? ''" (ngModelChange)="patch({ service: $event || null })" [placeholder]="f().name || autoName()" />
                  <span class="muted small">Nom sous lequel les logs apparaissent dans Vigil.</span></label>
                <label class="field">Environnement <input [ngModel]="f().env ?? ''" (ngModelChange)="patch({ env: $event || null })" placeholder="facultatif, ex. prod" /></label>
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
              <h3>Aperçu des dernières lignes</h3>
              @if (preview(); as p) {
                @if (p.error) {
                  <span class="danger small">{{ p.error }}</span>
                } @else if (!p.total) {
                  <span class="muted small">Aucun fichier ne correspond pour l'instant : la source les suivra dès qu'ils apparaîtront.</span>
                } @else {
                  <span class="muted small">{{ p.total }} fichier(s), dont {{ fileName(p.newest) }} :</span>
                  @for (e of p.entries; track $index) {
                    <div class="entry">
                      <span class="mono muted">{{ e.ts | time }}</span>
                      <span [class]="'lvl lvl-' + e.level">{{ e.level }}</span>
                      <span class="mono ellipsis" [title]="e.body">
                        @if (e.http) { {{ e.http.method }} {{ e.http.path }} {{ e.http.status }} }
                        @else { @if (e.exception) { <span class="tag err">{{ e.exception }}</span> } {{ e.body }} }
                      </span>
                    </div>
                  } @empty { <span class="muted small">Fichier vide pour l'instant.</span> }
                }
              } @else {
                <span class="muted small">{{ f().path ? 'Lecture…' : 'Indiquez le chemin des fichiers.' }}</span>
              }
            </div>
          }
          @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
          <div class="actions">
            <button class="btn primary" (click)="save()" [disabled]="busy()">{{ f().id ? 'Enregistrer' : 'Ajouter la source' }}</button>
            <a class="btn" routerLink="/admin/sources">Annuler</a>
            <span class="spacer"></span>
            @if (f().id) { <button class="btn ghost" (click)="remove()">Supprimer</button> }
          </div>
        </aside>
      </div>
    </div>
  `,
  styles: `
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .choices .small-choice { padding: 8px 10px; }
    .presets { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .link { border: 0; background: none; padding: 0; color: var(--accent); font: inherit; cursor: pointer; }
    .num-in { width: 90px; }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: 220px; }
    label.check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-1); cursor: pointer; }
    .agent summary { cursor: pointer; color: var(--text-2); }
    .agent p { margin: 8px 0; }
    .entry { display: grid; grid-template-columns: 90px 40px minmax(0, 1fr); gap: 6px; font-size: 11.5px; align-items: baseline; }
    .entry .tag { margin-right: 4px; }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class SourceFormPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  /** /admin/sources/:id ou /admin/sources/new */
  readonly id = input<string>('');

  protected readonly f = signal<LogSourceConfig>(blank());
  protected readonly preview = signal<(SourcePreview & { error?: string }) | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly formats = FORMATS;
  protected readonly presets = PRESETS;
  protected readonly pathHint = isWindows ? 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\*.log' : '/var/log/mon-app/*.log';
  private readonly previews = new Subject<LogSourceConfig>();

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
      return `Vigil écoutera les messages syslog sur le port ${f.port} (${proto}) ; le service est le nom de l'application émettrice, à défaut « ${service} ».`;
    }
    const format = FORMATS.find((x) => x.value === f.format)?.label.toLowerCase() ?? f.format;
    return `Vigil suivra ${f.path || '…'} (${format}) ${f.startAtEnd ? 'à partir des nouvelles lignes' : 'depuis le début'}, sous le service « ${service} ».`;
  });

  protected readonly agentCommand = computed(() => {
    const f = this.f();
    const path = f.path || this.pathHint;
    const exe = path.includes('\\') ? 'vigil.exe' : './vigil';
    // Une seule ligne sous Windows (pas de continuation « \\ » dans cmd / PowerShell).
    const sep = exe === 'vigil.exe' ? ' ' : ' \\\n  ';
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
    this.previews
      .pipe(
        debounceTime(400),
        switchMap((f) => this.api.previewSource(f).pipe(catchError((e) => of({ files: [], total: 0, newest: null, entries: [], error: e?.error?.error ?? 'Lecture impossible.' })))),
      )
      .subscribe((p) => this.preview.set(p));
    effect(() => {
      const f = this.f();
      untracked(() => {
        if (f.type === 'file' && f.path) this.previews.next(f);
        else this.preview.set(null);
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
    this.api.saveSource({ ...f, name: f.name.trim() || this.autoName() }).subscribe({
      next: () => this.router.navigate(['/admin/sources']),
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
      },
    });
  }

  protected remove() {
    this.api.deleteSource(this.f().id).subscribe(() => this.router.navigate(['/admin/sources']));
  }
}
