import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { Toasts } from '../core/toasts';
import { CopyText } from '../shared/copy-text';
import { GrafanaGuide } from '../shared/grafana-guide';
import { IntegrationSnippets } from '../shared/integration-snippets';
import { NavIcon } from '../shared/nav-icon';

type KeyKind = 'server' | 'browser' | 'read';

/** Les trois sortes de clé : titre, explication, icône et teinte des cartes de choix. */
const KIND_CHOICES: { value: KeyKind; title: string; hint: string; icon: string; tone: string }[] = [
  { value: 'server', title: 'Une application serveur', icon: 'server', tone: 'var(--accent)',
    hint: '.NET avec Wolflog.Client, ou tout SDK OpenTelemetry. La clé reste secrète sur le serveur.' },
  { value: 'browser', title: 'Un site web (navigateur)', icon: 'globe', tone: 'var(--accent-3)',
    hint: 'Erreurs JavaScript, pages, Web Vitals. La clé est visible dans les pages : elle ne sert qu\'à cela.' },
  { value: 'read', title: 'Grafana ou un outil de lecture', icon: 'eye', tone: 'var(--ok)',
    hint: 'Lecture seule des données (logs, requêtes, métriques, erreurs, audience) ; n\'envoie rien.' },
];

/** Connecter une application : type, nom (et sites autorisés), puis la clé et le code prêt à coller. */
@Component({
  selector: 'wl-key-form',
  imports: [FormsModule, RouterLink, CopyText, IntegrationSnippets, GrafanaGuide, NavIcon],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/keys" class="small crumb"><wl-nav-icon name="keys" [size]="14" />Clés API</a>
        <span class="muted">/</span>
        <h1>Connecter une application</h1>
        <span class="spacer"></span>
        @if (!created()) {
          <a class="btn" routerLink="/admin/keys">Annuler</a>
          <button class="btn primary" (click)="create()" [disabled]="busy() || !name.trim()">
            <wl-nav-icon [name]="busy() ? 'refresh' : 'keys'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Création…' : 'Créer la clé' }}
          </button>
        } @else {
          <a class="btn primary" routerLink="/admin/keys"><wl-nav-icon name="check" [size]="14" />Terminé</a>
        }
      </div>

      @if (created(); as c) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Clé de « {{ c.name }} »</h2><span class="hint">copiez-la maintenant : elle ne sera plus affichée</span></div>
              <div class="step-body">
                <div class="key-box">
                  <span class="badge"><wl-nav-icon name="keys" [size]="20" /></span>
                  <code class="key">{{ c.key }}</code>
                  <wl-copy [text]="c.key" />
                </div>
                <p class="warn small"><wl-nav-icon name="warning" [size]="13" />Conservez-la dans un endroit sûr : seule son empreinte est enregistrée par Wolflog.</p>
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">4</span><h2>{{ c.kind === 'read' ? 'Connecter Grafana' : c.kind === 'browser' ? 'À ajouter dans les pages du site' : 'À ajouter dans l’application' }}</h2><span class="hint">la clé est déjà insérée</span></div>
              <div class="step-body">
                @if (c.kind === 'read') {
                  <wl-grafana-guide [endpoint]="endpoint" [apiKey]="c.key" />
                } @else {
                  <wl-integration-snippets [endpoint]="endpoint" [apiKey]="c.key" [kind]="c.kind" [service]="c.name" />
                }
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Ensuite</h3>
              <p class="small">Dès que l'application envoie ses premières données, elle apparaît dans la vue d'ensemble et dans la liste des services.
                La date de dernière utilisation de la clé s'affiche dans Clés API.</p>
            </div>
            <div class="actions"><a class="btn primary" routerLink="/admin/keys"><wl-nav-icon name="check" [size]="14" />Terminé</a>
              <a class="btn" routerLink="/"><wl-nav-icon name="overview" [size]="14" />Vue d'ensemble</a></div>
          </aside>
        </div>
      } @else {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">1</span><h2>Que connecter ?</h2></div>
              <div class="step-body">
                <div class="choices two">
                  @for (k of kinds; track k.value) {
                    <button type="button" class="choice" [class.on]="kind() === k.value" (click)="kind.set(k.value)" [style.--tone]="k.tone">
                      <span class="choice-icon"><wl-nav-icon [name]="k.icon" [size]="18" /></span>
                      <strong>{{ k.title }}</strong><span>{{ k.hint }}</span>
                    </button>
                  }
                </div>
              </div>
            </section>
            <section class="panel step" [class.done]="!!name.trim()">
              <div class="step-head"><span class="num">2</span><h2>Nom de l'application</h2></div>
              <div class="step-body">
                <label class="field">Nom
                  <span class="control"><wl-nav-icon name="hash" [size]="14" /><input [(ngModel)]="name" placeholder="ex. api-commandes" autocomplete="off" spellcheck="false" /></span>
                  <span class="muted small">Sert à reconnaître la clé ; c'est aussi le nom de service proposé dans le code.</span></label>
                @if (kind() === 'browser') {
                  <label class="field" animate.enter="field-in">Sites autorisés
                    <span class="control"><wl-nav-icon name="globe" [size]="14" /><input [(ngModel)]="origins" placeholder="https://app.mondomaine.fr, https://www.mondomaine.fr" autocomplete="off" spellcheck="false" /></span>
                    <span class="muted small">Seules les pages de ces adresses pourront utiliser la clé.</span></label>
                  @if (originList().length) {
                    <div class="origins">
                      @for (o of originList(); track o.url) {
                        <span class="origin" [class.bad]="!o.valid" [title]="o.valid ? 'Site autorisé' : 'Adresse attendue : https://exemple.fr (sans chemin)'">
                          <wl-nav-icon [name]="o.valid ? 'lock' : 'warning'" [size]="12" />{{ o.url }}
                        </span>
                      }
                    </div>
                  }
                }
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Résumé</h3>
              <div class="sum">
                <span class="sum-icon" [style.--tone]="current().tone"><wl-nav-icon [name]="current().icon" [size]="16" /></span>
                <p class="phrase">{{ summary() }}</p>
              </div>
            </div>
            @if (error()) { <div class="block"><span class="error small" role="alert" animate.enter="field-in"><wl-nav-icon name="warning" [size]="14" />{{ error() }}</span></div> }
            <div class="actions">
              <button class="btn primary" (click)="create()" [disabled]="busy() || !name.trim()">
                <wl-nav-icon [name]="busy() ? 'refresh' : 'keys'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Création…' : 'Créer la clé' }}
              </button>
              <a class="btn" routerLink="/admin/keys">Annuler</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .choices.two { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    @media (max-width: 900px) { .choices.two { grid-template-columns: minmax(0, 1fr); } }
    .choice-icon { display: grid; place-items: center; width: 36px; height: 36px; margin-bottom: 6px; border-radius: 11px;
      transition: transform .45s var(--spring), background-color .25s, color .25s; }
    .choice .choice-icon { color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); }
    .choice:hover .choice-icon { transform: scale(1.08) rotate(-6deg); }
    .choice.on .choice-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--tone), color-mix(in srgb, var(--tone) 55%, var(--accent-2)));
      box-shadow: 0 8px 18px -8px var(--tone); animation: chosen .5s var(--spring); }
    @keyframes chosen { 40% { transform: scale(1.18) rotate(-8deg); } }

    .control { position: relative; display: block; }
    .control input { width: 100%; padding-left: 32px; }
    .control wl-nav-icon { position: absolute; left: 11px; top: 0; bottom: 0; margin: auto 0; height: 14px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within wl-nav-icon { color: var(--accent); transform: translateY(-1px) scale(1.12); }
    .origins { display: flex; flex-wrap: wrap; gap: 6px; }
    .origin { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px 0 8px; border-radius: 999px; font: 11.5px var(--mono);
      color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 26%, transparent);
      animation: chip-in .35s var(--spring) backwards; }
    .origin.bad { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 30%, transparent); }
    @keyframes chip-in { from { opacity: 0; transform: scale(.8); } }
    .field-in { animation: field-in .4s var(--spring); }
    @keyframes field-in { from { opacity: 0; transform: translateY(-6px); } }

    .sum { display: flex; align-items: flex-start; gap: 10px; }
    .sum-icon { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 15%, transparent); animation: chosen .5s var(--spring); }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    .error { display: inline-flex; align-items: center; gap: 7px; color: var(--danger); }

    .key-box { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border);
      background: var(--code-bg); box-shadow: inset 0 1px 0 var(--highlight); }
    .badge { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 10px 22px -10px var(--accent);
      animation: badge-in .7s var(--spring) .1s backwards; }
    @keyframes badge-in { from { opacity: 0; transform: scale(.3) rotate(-35deg); } }
    .key { flex: 1; min-width: 0; font-size: 14px; letter-spacing: .02em; overflow-wrap: anywhere; user-select: all; }
    .warn { display: flex; align-items: center; gap: 6px; color: var(--warn); }
    .btn wl-nav-icon.spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { margin: 0; }
  `,
})
export class KeyFormPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly kinds = KIND_CHOICES;
  protected readonly kind = signal<KeyKind>('server');
  protected readonly created = signal<{ name: string; key: string; kind: KeyKind } | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly endpoint = location.origin;
  protected name = '';
  protected origins = '';

  protected readonly current = computed(() => KIND_CHOICES.find((k) => k.value === this.kind()) ?? KIND_CHOICES[0]);

  protected readonly summary = computed(() =>
    this.kind() === 'read'
      ? 'Une clé « lecture » pour Grafana (plugin Infinity) ou vos scripts : accès en lecture seule à /api/grafana, aucun envoi possible.'
      : this.kind() === 'browser'
      ? 'Une clé « navigateur », utilisable seulement depuis les sites indiqués, pour le suivi côté navigateur.'
      : 'Une clé « serveur » pour envoyer logs, traces, métriques et crashs. Révocable à tout moment sans toucher aux autres applications.');

  /** Sites autorisés tels qu'ils seront enregistrés, avec un avertissement si l'adresse n'est pas une origine. Relu à chaque saisie. */
  protected originList() {
    return this.parseOrigins().map((url) => ({ url, valid: /^https?:\/\/[^/\s]+$/i.test(url) }));
  }

  private parseOrigins() {
    return this.origins.split(/[,\s]+/).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
  }

  protected create() {
    this.error.set('');
    this.busy.set(true);
    const origins = this.parseOrigins();
    this.api.createApiKey({ name: this.name.trim(), kind: this.kind(), origins }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.created.set({ name: r.name, key: r.key, kind: this.kind() });
        this.toasts.ok(`Clé de « ${r.name} » créée`, 'keys');
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Création impossible.');
        this.toasts.error(this.error());
      },
    });
  }
}
