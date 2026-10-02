import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, output, untracked, viewChild } from '@angular/core';
import uPlot from 'uplot';
import { formatDuration, formatNumber } from '../core/format';
import { Deployments } from '../core/deployments';

export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
  /** Pointillés (ex. ligne de seuil). */
  dash?: number[];
}

const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#ff9e64', '#c0caf5', '#b4f9f8'];

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/** Dégradé sous une courbe (couleur hexadécimale seulement) : la teinte de la série qui s'efface vers le bas. */
function areaFill(color: string): uPlot.Series.Fill | undefined {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return (u: uPlot) => {
    const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    g.addColorStop(0, color + '3d');
    g.addColorStop(1, color + '00');
    return g;
  };
}

/**
 * Graphique temporel (uPlot) : barres empilées ou courbes, sélection d'une plage à la souris.
 * Actualisation sans clignotement : tant que les séries, le type, l'unité et le thème ne changent pas, seules les données
 * sont remplacées (les séries masquées depuis la légende le restent) ; sinon le graphique est reconstruit, avec un fondu.
 */
@Component({
  selector: 'wl-chart',
  template: `<div #host class="chart"></div>`,
  styles: `
    :host { display: block; }
    .chart { width: 100%; }
    /* Fondu d'entrée à chaque construction (pas à chaque actualisation des données). */
    :host ::ng-deep .uplot { font-family: var(--sans); animation: chart-in .5s var(--ease) backwards; }
    @keyframes chart-in { from { opacity: 0; transform: translateY(6px); } }
    :host ::ng-deep .u-legend { font-size: 12px; color: var(--text-2); margin-top: 6px; }
    :host ::ng-deep .u-legend .u-series { border-radius: 999px; transition: background-color .15s, opacity .2s; }
    :host ::ng-deep .u-legend .u-series:hover { background: var(--surface-3); }
    :host ::ng-deep .u-legend .u-series.u-off { opacity: .45; }
    :host ::ng-deep .u-legend .u-series.u-off > * { opacity: 1; }
    :host ::ng-deep .u-legend .u-series.u-off .u-marker { transform: scale(.6); }
    :host ::ng-deep .u-legend .u-marker { width: 9px; height: 9px; border-radius: 50%; border-width: 0 !important; margin-right: 6px; transition: transform .3s var(--spring); }
    :host ::ng-deep .u-legend .u-series:hover .u-marker { transform: scale(1.3); }
    :host ::ng-deep .u-legend .u-label { font-weight: 500; color: var(--text-2); }
    :host ::ng-deep .u-legend .u-value { color: var(--text-1); font-variant-numeric: tabular-nums; }
    :host ::ng-deep .u-select { background: var(--accent-soft); border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); }
    /* Curseur : repère vertical aux couleurs de l'accent, horizontal discret. */
    :host ::ng-deep .u-hz .u-cursor-x { border-right: 1px dashed color-mix(in srgb, var(--accent) 65%, transparent); }
    :host ::ng-deep .u-hz .u-cursor-y { border-bottom: 1px dashed color-mix(in srgb, var(--text-3) 45%, transparent); }
    :host ::ng-deep .u-over { cursor: crosshair; }
    :host ::ng-deep .deploy { position: absolute; top: 0; bottom: 0; width: 9px; margin-left: -4px; cursor: help; z-index: 5; }
    :host ::ng-deep .deploy::before { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; border-left: 1px dashed var(--accent); opacity: .8; transition: opacity .2s; }
    :host ::ng-deep .deploy::after { content: ''; position: absolute; left: 1px; top: -1px; border: 4px solid transparent; border-top: 5px solid var(--accent);
      transform-origin: top center; transition: transform .3s var(--spring); }
    :host ::ng-deep .deploy:hover::before { opacity: 1; border-left-style: solid; }
    :host ::ng-deep .deploy:hover::after { transform: scale(1.5); }
  `,
})
export class Chart implements OnDestroy {
  /** Horodatages (ISO) des points. */
  readonly times = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  readonly kind = input<'bars' | 'lines'>('lines');
  readonly stacked = input(false);
  readonly height = input(160);
  readonly unit = input<string | null>(null);
  readonly legend = input(true);
  /** Affiche les déploiements de la période (lignes verticales). */
  readonly deployments = input(true);
  /** Seuil d'alerte : la zone où l'alerte se déclencherait (au-dessus ou en dessous) est teintée. */
  readonly threshold = input<{ value: number; comparison: 'above' | 'below' } | null>(null);
  readonly rangeSelect = output<{ from: Date; to: Date }>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private plot: uPlot | null = null;
  private observer: ResizeObserver | null = null;
  private themeObserver: MutationObserver | null = null;
  /** Thème du système (quand l'application le suit) : un changement reconstruit aussi le graphique. */
  private readonly scheme = matchMedia('(prefers-color-scheme: light)');
  private readonly onScheme = () => this.render(true);
  private ready = false;
  /** Structure du graphique affiché : inchangée, une actualisation remplace seulement les données. */
  private shape = '';
  /** Séries affichées, lues par la légende au survol (toujours les dernières reçues). */
  private current: ChartSeries[] = [];
  /** Couleur du danger du thème, relue à chaque construction (zone de déclenchement). */
  private danger = '';
  private readonly deploys = inject(Deployments);

  constructor() {
    afterNextRender(() => {
      this.ready = true;
      this.render();
      this.observer = new ResizeObserver(() => this.plot?.setSize({ width: this.width(), height: this.height() }));
      this.observer.observe(this.host().nativeElement);
      // Thème ou palette changés : couleurs des axes et de la grille relues, graphique reconstruit.
      this.themeObserver = new MutationObserver(() => this.render(true));
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-palette'] });
      this.scheme.addEventListener('change', this.onScheme);
    });
    effect(() => {
      this.times();
      this.series();
      this.kind();
      this.stacked();
      this.height();
      this.unit();
      this.legend();
      if (this.ready) untracked(() => this.render());
    });
    effect(() => {
      this.deploys.list();
      this.deployments();
      if (this.ready) untracked(() => this.placeMarkers());
    });
    effect(() => {
      this.threshold();
      if (this.ready) untracked(() => this.plot?.redraw(false, false));
    });
  }

  private width() {
    return Math.max(200, this.host().nativeElement.clientWidth);
  }

  private render(rebuild = false) {
    const el = this.host().nativeElement;
    const xs = this.times().map((t) => new Date(t).getTime() / 1000);
    const raw = this.series();
    this.current = raw;
    const style = getComputedStyle(document.documentElement);
    const grid = style.getPropertyValue('--grid').trim() || '#2a2f3a';
    const axis = style.getPropertyValue('--text-3').trim() || '#8a93a3';
    const font = `11px ${style.getPropertyValue('--sans').trim() || 'system-ui'}`;
    this.danger = style.getPropertyValue('--danger').trim();
    const unit = this.unit();
    const bars = this.kind() === 'bars';
    const stacked = this.stacked();

    // Empilement : chaque série est tracée au cumul des séries précédentes (tracées de haut en bas).
    let data: (number | null)[][] = raw.map((s) => s.values);
    let order = raw.map((_, i) => i);
    if (stacked) {
      const acc = xs.map(() => 0);
      data = raw.map((s) =>
        s.values.map((v, i) => {
          acc[i] += v ?? 0;
          return acc[i];
        }),
      );
      order = order.reverse();
    }
    const aligned: uPlot.AlignedData = [xs, ...order.map((i) => data[i])] as uPlot.AlignedData;

    // Même structure qu'à l'affichage précédent : nouvelles données seulement (pas de clignotement).
    const shape = JSON.stringify([bars, stacked, unit, this.legend(), this.height(), grid, axis, font, raw.map((s) => [s.label, s.color, s.dash ?? null])]);
    if (this.plot && !rebuild && shape === this.shape) {
      this.plot.setData(aligned);
      return;
    }
    this.shape = shape;
    this.plot?.destroy();

    // Nombres au format français ; durées lisibles (ms → s).
    const fmt = (v: number | null) => {
      if (v === null || v === undefined) return '–';
      if (unit === 'ms') return formatDuration(v);
      const n = Math.abs(v) >= 100 ? formatNumber(Math.round(v)) : formatNumber(Number(v.toPrecision(3)));
      return unit ? `${n} ${unit}` : n;
    };

    const barPaths = uPlot.paths.bars!({ size: [0.85, 40], gap: 1 });
    // Dégradé sous les courbes quand elles sont peu nombreuses (au-delà, les aplats se mélangeraient).
    const areas = !bars && !stacked && raw.filter((s) => !s.dash).length <= 3;
    const series: uPlot.Series[] = [{ label: 'Heure', value: (_u, v) => (v ? new Date(v * 1000).toLocaleString('fr-FR') : '–') }];
    for (const i of order) {
      const s = raw[i];
      series.push({
        label: s.label,
        stroke: s.color,
        fill: s.dash ? undefined : bars ? s.color : areas ? areaFill(s.color) : undefined,
        width: s.dash ? 1.2 : bars ? 0 : 1.6,
        dash: s.dash,
        paths: bars && !s.dash ? barPaths : undefined,
        points: { show: false },
        spanGaps: false,
        value: (_u, _v, _sidx, idx) => (idx === null ? '–' : fmt(this.current[i]?.values[idx] ?? null)),
      });
    }

    const opts: uPlot.Options = {
      width: this.width(),
      height: this.height(),
      series,
      legend: { show: this.legend() },
      cursor: { drag: { x: true, y: false, setScale: false }, points: { show: !bars, size: 7 } },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.1 : 1] } },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font, values: timeTicks },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font, size: 50, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      hooks: {
        drawClear: [(u) => this.drawBand(u)],
        setSize: [() => this.placeMarkers()],
        setScale: [() => this.placeMarkers()],
        setSelect: [
          (u) => {
            if (u.select.width < 5) return;
            const from = u.posToVal(u.select.left, 'x');
            const to = u.posToVal(u.select.left + u.select.width, 'x');
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            this.rangeSelect.emit({ from: new Date(from * 1000), to: new Date(to * 1000) });
          },
        ],
      },
    };

    el.innerHTML = '';
    this.plot = new uPlot(opts, aligned, el);
    this.placeMarkers();
  }

  /** Zone de déclenchement : aplat rouge dégradé du seuil vers le bord, sous la grille et les courbes. */
  private drawBand(u: uPlot) {
    const t = this.threshold();
    if (!t || !Number.isFinite(t.value)) return;
    const { left, top, width, height } = u.bbox;
    const y = Math.max(top, Math.min(top + height, u.valToPos(t.value, 'y', true)));
    const above = t.comparison !== 'below';
    const edge = above ? top : top + height;
    if (Math.abs(edge - y) < 1) return;
    const tint = (a: number) => (/^#[0-9a-f]{6}$/i.test(this.danger) ? this.danger + Math.round(a * 255).toString(16).padStart(2, '0') : `rgb(251 113 133 / ${a})`);
    const g = u.ctx.createLinearGradient(0, y, 0, edge);
    g.addColorStop(0, tint(0.2));
    g.addColorStop(1, tint(0.03));
    u.ctx.save();
    u.ctx.fillStyle = g;
    u.ctx.fillRect(left, Math.min(y, edge), width, Math.abs(edge - y));
    u.ctx.restore();
  }

  /** Marqueurs de déploiement : éléments posés sur la zone du graphique, avec une info-bulle native. */
  private placeMarkers() {
    const u = this.plot;
    if (!u) return;
    u.over.querySelectorAll('.deploy').forEach((m) => m.remove());
    if (!this.deployments()) return;
    const min = u.scales['x'].min ?? 0;
    const max = u.scales['x'].max ?? 0;
    for (const d of this.deploys.list()) {
      const x = new Date(d.at).getTime() / 1000;
      if (x < min || x > max) continue;
      const m = document.createElement('div');
      m.className = 'deploy';
      m.style.left = `${u.valToPos(x, 'x')}px`;
      const when = new Date(d.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      m.title = [`Déploiement ${d.service} ${d.version}${d.env ? ' (' + d.env + ')' : ''}`, when, d.description ?? ''].filter(Boolean).join('\n');
      u.over.appendChild(m);
    }
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    this.themeObserver?.disconnect();
    this.scheme.removeEventListener('change', this.onScheme);
    this.plot?.destroy();
  }
}

/** Graduations de l'axe du temps au format français (24 h). */
function timeTicks(u: uPlot, splits: number[], _axis: number, _space: number, incr: number): string[] {
  const span = (u.scales['x'].max ?? 0) - (u.scales['x'].min ?? 0);
  return splits.map((v) => {
    const d = new Date(v * 1000);
    const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: incr < 60 ? '2-digit' : undefined });
    if (incr >= 86400) return date;
    return span > 86400 ? `${date} ${time}` : time;
  });
}
