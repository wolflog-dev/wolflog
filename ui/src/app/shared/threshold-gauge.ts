import { Component, computed, input } from '@angular/core';

/**
 * Jauge « valeur actuelle face au seuil » de l'éditeur d'alerte : barre qui se remplit (transform), repère du seuil,
 * couleur selon la marge (vert, ambre à l'approche, rouge au-delà), valeur et écart en clair.
 */
@Component({
  selector: 'wl-threshold-gauge',
  template: `
    <div class="gauge" [attr.data-state]="state()">
      <div class="head">
        <span class="value num">{{ valueText() }}</span>
        <span class="verdict">{{ verdict() }}</span>
      </div>
      <div class="track" role="meter" [attr.aria-valuenow]="value()" [attr.aria-label]="label()">
        <i class="fill" [style.transform]="'scaleX(' + fill() + ')'"></i>
        <i class="mark" [style.left.%]="markAt() * 100" [title]="'Seuil : ' + thresholdText()"></i>
      </div>
      <div class="foot"><span>0</span><span class="seuil">seuil {{ thresholdText() }}</span></div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .gauge { --c: var(--ok); display: grid; gap: 6px; }
    .gauge[data-state='near'] { --c: var(--warn); }
    .gauge[data-state='breach'] { --c: var(--danger); }
    .gauge[data-state='none'] { --c: var(--text-3); }
    .head { display: flex; align-items: baseline; gap: 10px; }
    .value { font-size: 22px; font-weight: 700; letter-spacing: -.02em; color: var(--c); transition: color .3s; }
    .verdict { font-size: 12px; color: var(--text-3); }
    .track { position: relative; height: 8px; border-radius: 999px; background: var(--surface-3); overflow: visible; }
    .fill { position: absolute; inset: 0; border-radius: inherit; transform-origin: left;
      background: linear-gradient(90deg, color-mix(in srgb, var(--c) 55%, transparent), var(--c));
      box-shadow: 0 0 12px -2px var(--c); transition: transform .8s var(--spring), background-color .3s; }
    .mark { position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px; border-radius: 2px; background: var(--text-1);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-1) 15%, transparent); transition: left .5s var(--spring); }
    .foot { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-3); }
    .seuil { color: var(--text-2); }
  `,
})
export class ThresholdGauge {
  readonly value = input<number | null>(null);
  readonly threshold = input(0);
  /** above : alerte au-dessus du seuil ; below : en dessous. */
  readonly comparison = input<'above' | 'below'>('above');
  readonly unit = input('');
  readonly label = input('Valeur actuelle');

  /** Le seuil est placé aux deux tiers de la barre : on voit la marge avant et le dépassement après. */
  private readonly scale = computed(() => Math.max(this.threshold() * 1.5, (this.value() ?? 0) * 1.05, 1e-9));
  protected readonly fill = computed(() => Math.min(1, Math.max(0, (this.value() ?? 0) / this.scale())));
  protected readonly markAt = computed(() => Math.min(1, this.threshold() / this.scale()));

  protected readonly state = computed(() => {
    const v = this.value();
    if (v === null) return 'none';
    const t = this.threshold();
    const breach = this.comparison() === 'below' ? v < t : v > t;
    if (breach) return 'breach';
    const near = this.comparison() === 'below' ? v < t * 1.2 : v > t * 0.8;
    return near ? 'near' : 'ok';
  });

  protected readonly verdict = computed(() => {
    const v = this.value();
    if (v === null) return 'pas de donnée';
    const t = this.threshold();
    if (!t) return '';
    const ratio = Math.round((v / t) * 100);
    switch (this.state()) {
      case 'breach': return `dépasse le seuil (${ratio} %)`;
      case 'near': return `proche du seuil (${ratio} %)`;
      default: return `${ratio} % du seuil`;
    }
  });

  protected readonly valueText = computed(() => this.format(this.value()));
  protected readonly thresholdText = computed(() => this.format(this.threshold()));

  private format(v: number | null) {
    if (v === null) return '–';
    const n = Math.abs(v) >= 100 ? Math.round(v).toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    return this.unit() ? `${n} ${this.unit()}` : n;
  }
}
