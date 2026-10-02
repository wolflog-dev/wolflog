import { Component, inject, output } from '@angular/core';
import { sectionForUrl } from '../core/access';
import { Session } from '../core/session';
import { NavIcon } from './nav-icon';

/** Raccourcis de navigation « g » puis une lettre (gérés par app.ts). */
export const GO_SHORTCUTS: { key: string; path: string; label: string; icon: string }[] = [
  { key: 'o', path: '/', label: "Vue d'ensemble", icon: 'overview' },
  { key: 'd', path: '/dashboards', label: 'Tableaux de bord', icon: 'dashboards' },
  { key: 'l', path: '/logs', label: 'Logs', icon: 'logs' },
  { key: 'r', path: '/requests', label: 'Requêtes HTTP', icon: 'requests' },
  { key: 't', path: '/traces', label: 'Traces', icon: 'traces' },
  { key: 'e', path: '/errors', label: 'Erreurs', icon: 'errors' },
  { key: 'm', path: '/metrics', label: 'Métriques', icon: 'metrics' },
  { key: 'u', path: '/audience', label: 'Audience', icon: 'audience' },
  { key: 'c', path: '/clickmaps', label: 'Clics & défilement', icon: 'clickmaps' },
  { key: 'a', path: '/alerts', label: 'Alertes', icon: 'alerts' },
];

/** Aide des raccourcis clavier (touche « ? ») : fenêtre en verre, lignes en cascade. */
@Component({
  selector: 'wl-shortcuts-help',
  imports: [NavIcon],
  template: `
    <div class="backdrop" (click)="close.emit()"></div>
    <div class="dialog panel" role="dialog" aria-label="Raccourcis clavier">
      <div class="panel-head"><wl-nav-icon name="terminal" /><h2>Raccourcis clavier</h2><span class="spacer"></span>
        <button class="btn ghost icon-btn" (click)="close.emit()" title="Fermer" aria-label="Fermer"><wl-nav-icon name="close" /></button></div>
      <div class="cols">
        <section>
          <h3>Partout</h3>
          <div class="row" style="--i: 0"><span>Recherche globale</span><span><kbd>Ctrl</kbd> <kbd>K</kbd></span></div>
          <div class="row" style="--i: 1"><span>Cette aide</span><kbd>?</kbd></div>
          <div class="row" style="--i: 2"><span>Fermer un panneau, un menu</span><kbd>Échap</kbd></div>
          <div class="row" style="--i: 3"><span>Recherche des logs</span><kbd>/</kbd></div>
        </section>
        <section>
          <h3>Aller à…</h3>
          @for (s of shortcuts; track s.key; let i = $index) {
            <div class="row" [style.--i]="i + 4"><span class="go"><wl-nav-icon [name]="s.icon" [size]="14" />{{ s.label }}</span><span><kbd>g</kbd> <kbd>{{ s.key }}</kbd></span></div>
          }
        </section>
      </div>
    </div>
  `,
  styles: `
    .backdrop { position: fixed; inset: 0; z-index: 95; background: rgb(4 6 14 / .35); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
      animation: fade .2s ease-out backwards; }
    .dialog { position: fixed; z-index: 96; top: 50%; left: 50%; width: min(640px, calc(100% - 32px)); translate: -50% -50%;
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); box-shadow: var(--shadow-pop);
      animation: pop .4s var(--spring) backwards; }
    .panel-head { gap: 10px; color: var(--accent); }
    .panel-head h2 { color: var(--text-1); }
    .icon-btn { width: 30px; padding: 0; justify-content: center; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; padding: 14px 18px 18px; }
    h3 { margin: 4px 0 8px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 0; font-size: 12.5px; color: var(--text-2);
      border-bottom: 1px solid var(--border-soft); animation: row .35s var(--ease) backwards; animation-delay: calc(var(--i) * 25ms + 80ms); }
    .go { display: inline-flex; align-items: center; gap: 8px; }
    .go wl-nav-icon { color: var(--text-3); }
    @keyframes fade { from { opacity: 0; } }
    @keyframes pop { from { opacity: 0; scale: .94; } }
    @keyframes row { from { opacity: 0; transform: translateY(4px); } }
    @media (max-width: 640px) { .cols { grid-template-columns: 1fr; } }
  `,
})
export class ShortcutsHelp {
  readonly close = output<void>();
  private readonly session = inject(Session);
  /** Seulement les parties du profil d'accès. */
  protected readonly shortcuts = GO_SHORTCUTS.filter((s) => this.session.can(sectionForUrl(s.path)));
}
