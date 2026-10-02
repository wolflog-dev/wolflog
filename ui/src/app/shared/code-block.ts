import { Component, OnDestroy, computed, inject, input, signal } from '@angular/core';
import { Toasts } from '../core/toasts';
import { copyToClipboard } from './copy-text';
import { NavIcon } from './nav-icon';

/** Langage affiché dans l'en-tête, deviné d'après le code : balise, JSON, YAML, commandes, C#. */
function detectLanguage(code: string): { label: string; icon: string } {
  const c = code.trim();
  if (c.startsWith('<')) return { label: 'HTML', icon: 'code' };
  if (/^[{["]/.test(c) && c.includes('":')) return { label: 'JSON', icon: 'file' };
  if (/^\*\.\*\s+@/m.test(c)) return { label: 'rsyslog', icon: 'file' };
  const shell = /^(dotnet|curl|docker|kubectl|grafana|npm|\.\/wolflog|wolflog(\.exe)?)\s/m.test(c);
  const csharp = /^\s*(var |builder\.|using |app\.)/m.test(c) || /\);\s*$/m.test(c);
  if (!shell && !csharp && /^(#|apiVersion:|[\w-]+:\s)/.test(c) && /^\s*[\w-]+:(\s|$)/m.test(c)) return { label: 'YAML', icon: 'file' };
  if (shell && csharp) return { label: '.NET', icon: 'code' };
  if (shell) return { label: 'Terminal', icon: 'terminal' };
  if (csharp) return { label: 'C#', icon: 'code' };
  return { label: 'Code', icon: 'code' };
}

/**
 * Bloc de code : langage en en-tête (deviné, ou imposé par lang), numéros de ligne, survol de ligne
 * et bouton copier dont l'icône se change en coche.
 */
@Component({
  selector: 'wl-code',
  imports: [NavIcon],
  template: `
    <div class="code">
      <div class="bar">
        <span class="lang"><wl-nav-icon [name]="language().icon" [size]="12" />{{ language().label }}</span>
        @if (lines().length > 1) { <span class="count">{{ lines().length }} lignes</span> }
        <span class="spacer"></span>
        <button type="button" class="btn ghost copy" [class.done]="copied()" (click)="copy()" [attr.aria-label]="copied() ? 'Copié' : 'Copier le code'">
          <span class="icons"><wl-nav-icon class="i-copy" name="copy" [size]="13" /><wl-nav-icon class="i-check" name="check" [size]="13" /></span>
          {{ copied() ? 'Copié' : 'Copier' }}
        </button>
      </div>
      <pre [class.numbered]="lines().length > 1"><code>@for (line of lines(); track $index) {<span class="line">{{ line }}</span>}</code></pre>
    </div>
  `,
  styles: `
    :host { display: block; min-width: 0; }
    .code { overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--code-bg);
      box-shadow: inset 0 1px 0 var(--highlight); transition: border-color .25s; }
    .code:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .bar { display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 4px 0 10px; border-bottom: 1px solid var(--border-soft); background: var(--surface-2); }
    .lang { display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: 999px; font: 650 10.5px var(--mono);
      letter-spacing: .02em; color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
    .count { font-size: 11px; color: var(--text-3); }
    .copy { height: 24px; padding: 0 9px 0 7px; gap: 5px; font-size: 11.5px; }
    .icons { display: inline-grid; }
    .icons wl-nav-icon { grid-area: 1 / 1; transition: opacity .2s, transform .45s var(--spring); }
    .i-check { opacity: 0; transform: scale(.3) rotate(-60deg); }
    .copy.done { color: var(--ok); }
    .copy.done .i-copy { opacity: 0; transform: scale(.3) rotate(60deg); }
    .copy.done .i-check { opacity: 1; transform: none; }
    pre { margin: 0; padding: 9px 0; overflow: auto; font: 12px/1.6 var(--mono); color: var(--text-1); }
    /* Le code prend la largeur de la plus longue ligne : le survol d'une ligne couvre toute la zone défilée. */
    code { display: block; width: max-content; min-width: 100%; font: inherit; counter-reset: line; }
    .line { display: block; padding: 0 14px; transition: background-color .15s; }
    .line:empty::after { content: ' '; }
    .line:hover { background-color: var(--row-hover); }
    /* Numéros de ligne : contenu généré, donc jamais copié avec la sélection. */
    .numbered .line::before { counter-increment: line; content: counter(line); display: inline-block; width: 2ch; margin-right: 14px; text-align: right;
      color: var(--text-3); opacity: .55; user-select: none; transition: opacity .15s, color .15s; }
    .numbered .line:hover::before { opacity: 1; color: var(--accent); }
  `,
})
export class CodeBlock implements OnDestroy {
  readonly code = input.required<string>();
  /** Langage affiché (« Terminal », « JSON »…) ; deviné d'après le code si absent. */
  readonly lang = input<string | null>(null);
  private readonly toasts = inject(Toasts);
  protected readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly lines = computed(() => this.code().split('\n'));
  protected readonly language = computed(() => {
    const detected = detectLanguage(this.code());
    const lang = this.lang();
    return lang ? { label: lang, icon: /terminal|shell|bash|cmd|powershell/i.test(lang) ? 'terminal' : detected.icon } : detected;
  });

  copy() {
    copyToClipboard(this.code()).then(
      () => {
        this.copied.set(true);
        this.toasts.info('Copié dans le presse-papiers', 'copy');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.copied.set(false), 1800);
      },
      () => this.toasts.error('Copie impossible : le navigateur refuse l’accès au presse-papiers.'),
    );
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
  }
}
