import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { CopyText } from '../shared/widgets';
import { IntegrationSnippets } from '../shared/integration-snippets';

/** Connecter une application : type, nom (et sites autorisés), puis la clé et le code prêt à coller. */
@Component({
  selector: 'wl-key-form',
  imports: [FormsModule, RouterLink, CopyText, IntegrationSnippets],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/keys" class="small">Clés API</a>
        <span class="muted">/</span>
        <h1>Connecter une application</h1>
        <span class="spacer"></span>
        @if (!created()) {
          <a class="btn" routerLink="/admin/keys">Annuler</a>
          <button class="btn primary" (click)="create()" [disabled]="busy() || !name.trim()">Créer la clé</button>
        } @else {
          <a class="btn primary" routerLink="/admin/keys">Terminé</a>
        }
      </div>

      @if (created(); as c) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Clé de « {{ c.name }} »</h2><span class="hint">copiez-la maintenant : elle ne sera plus affichée</span></div>
              <div class="step-body">
                <div class="key"><code>{{ c.key }}</code> <wl-copy [text]="c.key" /></div>
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">4</span><h2>{{ c.kind === 'browser' ? 'À ajouter dans les pages du site' : 'À ajouter dans l’application' }}</h2><span class="hint">la clé est déjà insérée</span></div>
              <div class="step-body">
                <wl-integration-snippets [endpoint]="endpoint" [apiKey]="c.key" [kind]="c.kind" [service]="c.name" />
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Ensuite</h3>
              <p class="small">Dès que l'application envoie ses premières données, elle apparaît dans la vue d'ensemble et dans la liste des services.
                La date de dernière utilisation de la clé s'affiche dans Clés API.</p>
            </div>
            <div class="actions"><a class="btn primary" routerLink="/admin/keys">Terminé</a><a class="btn" routerLink="/">Vue d'ensemble</a></div>
          </aside>
        </div>
      } @else {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done">
              <div class="step-head"><span class="num">1</span><h2>Que connecter ?</h2></div>
              <div class="step-body">
                <div class="choices two">
                  <button type="button" class="choice" [class.on]="kind() === 'server'" (click)="kind.set('server')">
                    <strong>Une application serveur</strong><span>.NET avec Wolflog.Client, ou tout SDK OpenTelemetry. La clé reste secrète sur le serveur.</span>
                  </button>
                  <button type="button" class="choice" [class.on]="kind() === 'browser'" (click)="kind.set('browser')">
                    <strong>Un site web (navigateur)</strong><span>Erreurs JavaScript, pages, Web Vitals. La clé est visible dans les pages : elle ne sert qu'à cela.</span>
                  </button>
                </div>
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Nom de l'application</h2></div>
              <div class="step-body">
                <label class="field">Nom <input [(ngModel)]="name" placeholder="ex. api-commandes" autocomplete="off" />
                  <span class="muted small">Sert à reconnaître la clé ; c'est aussi le nom de service proposé dans le code.</span></label>
                @if (kind() === 'browser') {
                  <label class="field">Sites autorisés <input [(ngModel)]="origins" placeholder="https://app.mondomaine.fr, https://www.mondomaine.fr" autocomplete="off" />
                    <span class="muted small">Seules les pages de ces adresses pourront utiliser la clé.</span></label>
                }
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Résumé</h3>
              <p class="phrase">{{ summary() }}</p>
            </div>
            @if (error()) { <div class="block"><span class="danger small">{{ error() }}</span></div> }
            <div class="actions">
              <button class="btn primary" (click)="create()" [disabled]="busy() || !name.trim()">Créer la clé</button>
              <a class="btn" routerLink="/admin/keys">Annuler</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    .choices.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .key { display: flex; align-items: center; gap: 6px; }
    .key code { font-size: 14px; padding: 6px 10px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); user-select: all; }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }
  `,
})
export class KeyFormPage {
  private readonly api = inject(Api);
  protected readonly kind = signal<'server' | 'browser'>('server');
  protected readonly created = signal<{ name: string; key: string; kind: 'server' | 'browser' } | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly endpoint = location.origin;
  protected name = '';
  protected origins = '';

  protected readonly summary = computed(() =>
    this.kind() === 'browser'
      ? 'Une clé « navigateur », utilisable seulement depuis les sites indiqués, pour le suivi côté navigateur.'
      : 'Une clé « serveur » pour envoyer logs, traces, métriques et crashs. Révocable à tout moment sans toucher aux autres applications.');

  protected create() {
    this.error.set('');
    this.busy.set(true);
    const origins = this.origins.split(/[,\s]+/).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
    this.api.createApiKey({ name: this.name.trim(), kind: this.kind(), origins }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.created.set({ name: r.name, key: r.key, kind: this.kind() });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Création impossible.');
      },
    });
  }
}
