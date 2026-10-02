import { Directive, ElementRef, OnDestroy, effect, inject, input } from '@angular/core';

/**
 * Chiffre qui défile jusqu'à sa valeur, à l'affichage puis à chaque actualisation (depuis la valeur précédente).
 * Seul le premier nombre du texte est animé ; le reste (unité, « k », « % », séparateurs) est conservé.
 * Usage : <strong [wlCountUp]="total | num"></strong>. Le texte est écrit directement, une fois par image.
 */
@Directive({ selector: '[wlCountUp]' })
export class CountUp implements OnDestroy {
  readonly wlCountUp = input<string | number | null | undefined>('');

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private frame = 0;
  private last: number | null = null;
  private lastSuffix = '';

  constructor() {
    effect(() => this.update(String(this.wlCountUp() ?? '')));
  }

  private update(text: string) {
    cancelAnimationFrame(this.frame);
    const match = /-?\d[\d\s  ]*(?:[.,]\d+)?/.exec(text);
    if (!match) {
      this.el.textContent = text;
      this.last = null;
      return;
    }
    const raw = match[0].trimEnd();
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(match.index + raw.length);
    const target = Number(raw.replace(/[\s  ]/g, '').replace(',', '.'));
    // Même unité qu'avant : on part de la valeur affichée ; sinon (première fois, ms → s…) depuis zéro.
    const from = this.last !== null && this.lastSuffix === suffix ? this.last : 0;
    this.last = target;
    this.lastSuffix = suffix;
    if (from === target || document.documentElement.dataset['motion'] === 'off') {
      this.el.textContent = text;
      return;
    }
    const decimals = /[.,](\d+)$/.exec(raw)?.[1].length ?? 0;
    const decimalSeparator = raw.includes(',') ? ',' : '.';
    const group = /\d([\s  ])\d/.exec(raw)?.[1] ?? null;
    const format = (v: number) => {
      const [int, frac] = Math.abs(v).toFixed(decimals).split('.');
      const grouped = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, group) : int;
      return (v < 0 ? '-' : '') + grouped + (frac ? decimalSeparator + frac : '');
    };
    const start = performance.now();
    const duration = 900;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      this.el.textContent = t < 1 ? prefix + format(from + (target - from) * eased) + suffix : text;
      if (t < 1) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
  }
}
