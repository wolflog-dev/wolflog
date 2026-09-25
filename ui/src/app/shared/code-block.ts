import { Component, input, signal } from '@angular/core';

/** Bloc de code avec bouton copier. */
@Component({
  selector: 'wl-code',
  template: `
    <div class="code">
      <button class="btn ghost copy" (click)="copy()">{{ copied() ? 'Copié' : 'Copier' }}</button>
      <pre>{{ code() }}</pre>
    </div>
  `,
  styles: `
    .code { position: relative; }
    pre { margin: 0; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; overflow: auto;
      font: 12px/1.55 var(--mono); color: var(--text-1); }
    .copy { position: absolute; top: 4px; right: 4px; height: 24px; font-size: 11.5px; }
  `,
})
export class CodeBlock {
  readonly code = input.required<string>();
  protected readonly copied = signal(false);

  copy() {
    navigator.clipboard?.writeText(this.code()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
