import { Component, ElementRef, OnDestroy, afterNextRender, effect, inject, input, output, viewChild } from '@angular/core';
import uPlot from 'uplot';
import { formatDuration, formatNumber } from '../core/format';
import { Deployments } from '../core/state';

export interface ChartSeries {
  label: string;
  color: string;
  values: (number | null)[];
}

const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#ff9e64', '#c0caf5', '#b4f9f8'];

export function paletteColor(i: number): string {
  return PALETTE[i % PALETTE.length];
}

/** Graphique temporel (uPlot) : barres empilées ou courbes, sélection d'une plage à la souris. */
@Component({
  selector: 'vg-chart',
  template: `<div #host class="chart"></div>`,
  styles: `
    :host { display: block; }
    .chart { width: 100%; }
    :host ::ng-deep .u-legend { font-size: 12px; color: var(--text-2); }
    :host ::ng-deep .u-legend .u-marker { border-radius: 2px; }
    :host ::ng-deep .u-select { background: var(--accent-soft); }
    :host ::ng-deep .deploy { position: absolute; top: 0; bottom: 0; width: 9px; margin-left: -4px; cursor: help; z-index: 5; }
    :host ::ng-deep .deploy::before { content: ''; position: absolute; left: 4px; top: 0; bottom: 0; border-left: 1px dashed var(--accent); opacity: .8; }
    :host ::ng-deep .deploy::after { content: ''; position: absolute; left: 1px; top: -1px; border: 4px solid transparent; border-top: 5px solid var(--accent); }
    :host ::ng-deep .deploy:hover::before { opacity: 1; border-left-style: solid; }
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
  readonly rangeSelect = output<{ from: Date; to: Date }>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private plot: uPlot | null = null;
  private observer: ResizeObserver | null = null;
  private ready = false;
  private readonly deploys = inject(Deployments);

  constructor() {
    afterNextRender(() => {
      this.ready = true;
      this.render();
      this.observer = new ResizeObserver(() => this.plot?.setSize({ width: this.width(), height: this.height() }));
      this.observer.observe(this.host().nativeElement);
    });
    effect(() => {
      this.times();
      this.series();
      this.kind();
      if (this.ready) this.render();
    });
    effect(() => {
      this.deploys.list();
      if (this.ready) this.placeMarkers();
    });
  }

  private width() {
    return Math.max(200, this.host().nativeElement.clientWidth);
  }

  private render() {
    this.plot?.destroy();
    const el = this.host().nativeElement;
    const xs = this.times().map((t) => new Date(t).getTime() / 1000);
    const raw = this.series();
    const style = getComputedStyle(document.documentElement);
    const grid = style.getPropertyValue('--grid').trim() || '#2a2f3a';
    const axis = style.getPropertyValue('--text-3').trim() || '#8a93a3';
    const unit = this.unit();
    const bars = this.kind() === 'bars';

    // Empilement : chaque série est tracée au cumul des séries précédentes (tracées de haut en bas).
    let data: (number | null)[][] = raw.map((s) => s.values);
    let order = raw.map((_, i) => i);
    if (this.stacked()) {
      const acc = xs.map(() => 0);
      data = raw.map((s) =>
        s.values.map((v, i) => {
          acc[i] += v ?? 0;
          return acc[i];
        }),
      );
      order = order.reverse();
    }

    // Nombres au format français ; durées lisibles (ms → s).
    const fmt = (v: number | null) => {
      if (v === null || v === undefined) return '–';
      if (unit === 'ms') return formatDuration(v);
      const n = Math.abs(v) >= 100 ? formatNumber(Math.round(v)) : formatNumber(Number(v.toPrecision(3)));
      return unit ? `${n} ${unit}` : n;
    };

    const barPaths = uPlot.paths.bars!({ size: [0.85, 40], gap: 1 });
    const series: uPlot.Series[] = [{ label: 'Heure', value: (_u, v) => (v ? new Date(v * 1000).toLocaleString('fr-FR') : '–') }];
    for (const i of order) {
      const s = raw[i];
      series.push({
        label: s.label,
        stroke: s.color,
        fill: bars ? s.color : undefined,
        width: bars ? 0 : 1.5,
        paths: bars ? barPaths : undefined,
        points: { show: false },
        spanGaps: false,
        value: (_u, _v, _sidx, idx) => (idx === null ? '–' : fmt(raw[i].values[idx] ?? null)),
      });
    }

    const opts: uPlot.Options = {
      width: this.width(),
      height: this.height(),
      series,
      legend: { show: this.legend() },
      cursor: { drag: { x: true, y: false, setScale: false }, points: { show: !bars } },
      scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max > 0 ? max * 1.1 : 1] } },
      axes: [
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { stroke: grid }, font: '11px system-ui', values: timeTicks },
        { stroke: axis, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui', size: 50, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      hooks: {
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

    const aligned: uPlot.AlignedData = [xs, ...order.map((i) => data[i])] as uPlot.AlignedData;
    el.innerHTML = '';
    this.plot = new uPlot(opts, aligned, el);
    this.placeMarkers();
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
