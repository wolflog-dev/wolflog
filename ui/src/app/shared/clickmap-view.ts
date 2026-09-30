import { Component, ElementRef, OnDestroy, afterNextRender, effect, input, output, signal, viewChild } from '@angular/core';
import { ClickmapReport } from '../core/models';

/** Rampe séquentielle chaude : jaune (peu) → orange → rouge → bordeaux (beaucoup). */
const STOPS: [number, number[]][] = [[0, [250, 178, 25]], [0.35, [235, 104, 52]], [0.7, [208, 59, 59]], [1, [122, 29, 29]]];
const PALETTE = (() => {
  const p = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k];
    const [t1, c1] = STOPS[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) p[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return p;
})();
/** Le canvas est dessiné à mi-résolution (mémoire) puis agrandi. */
const RES = 0.5;
const RADIUS = 22;

/**
 * Carte de chaleur superposée à la page réelle (iframe nommée « wolflog-preview » : le script RUM n'y mesure rien).
 * Mode clics : densité des clics. Mode défilement : la page s'assombrit là où peu de visiteurs sont allés.
 */
@Component({
  selector: 'wl-clickmap-view',
  template: `
    <div class="host" #host>
      <div class="viewport" #viewport>
        <div class="stage" #stage>
          <iframe #frame name="wolflog-preview" title="Aperçu de la page" tabindex="-1" sandbox="allow-scripts allow-same-origin"></iframe>
          <canvas #canvas></canvas>
        </div>
        <div class="labels" #labels></div>
      </div>
      @if (unreachable() && showPage()) {
        <div class="notice">Aperçu indisponible : {{ url() }} ne répond pas.</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .host { position: relative; max-height: 78vh; overflow: auto; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2); }
    .notice { position: sticky; bottom: 12px; width: fit-content; max-width: calc(100% - 24px); margin: -44px auto 12px; padding: 7px 14px;
      border-radius: 16px; background: rgba(11, 11, 11, .85); color: #fff; font: 12px var(--sans); animation: notice-in .3s ease-out both; }
    @keyframes notice-in { from { opacity: 0; transform: translateY(6px); } }
    .viewport { position: relative; margin: 0 auto; overflow: hidden; }
    .stage { position: absolute; top: 0; left: 0; transform-origin: 0 0; background: #fff; }
    iframe { position: absolute; inset: 0; border: 0; pointer-events: none; background: #fff; transition: opacity .3s; }
    iframe.hidden { opacity: 0; }
    canvas { position: absolute; inset: 0; pointer-events: none; }
    canvas.in { animation: map-in .7s ease-out both; }
    @keyframes map-in { from { opacity: 0; filter: blur(6px); } }
    .labels { position: absolute; inset: 0; pointer-events: none; }
    :host ::ng-deep .reach { position: absolute; left: 10px; transform: translateY(-50%); padding: 2px 8px; border-radius: 10px;
      background: rgba(11, 11, 11, .82); color: #fff; font: 600 11px var(--sans); white-space: nowrap; }
    :host ::ng-deep .reach::after { content: ''; position: absolute; left: 100%; top: 50%; width: 3000px; border-top: 1px dashed rgba(255, 255, 255, .7); }
    :host ::ng-deep .reach.fold { background: var(--accent); color: var(--bg); }
    :host ::ng-deep .reach.fold::after { display: none; }
  `,
})
export class ClickmapView implements OnDestroy {
  readonly report = input.required<ClickmapReport>();
  readonly url = input<string | null>(null);
  readonly mode = input<'clicks' | 'scroll'>('clicks');
  readonly showPage = input(true);
  /** Émis quand l'adresse du site ne répond pas (serveur arrêté, mauvaise origine). */
  readonly reachable = output<boolean>();
  protected readonly unreachable = signal(false);

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');
  private readonly viewport = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
  private readonly stage = viewChild.required<ElementRef<HTMLDivElement>>('stage');
  private readonly frame = viewChild.required<ElementRef<HTMLIFrameElement>>('frame');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labels = viewChild.required<ElementRef<HTMLDivElement>>('labels');
  private observer: ResizeObserver | null = null;
  private ready = false;
  private loadedUrl: string | null = null;
  private scale = 1;

  constructor() {
    afterNextRender(() => {
      this.ready = true;
      this.render();
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.host().nativeElement);
    });
    effect(() => {
      this.report();
      this.url();
      this.mode();
      this.showPage();
      if (this.ready) this.render();
    });
  }

  private layout() {
    const r = this.report();
    this.scale = Math.min(1, this.host().nativeElement.clientWidth / r.width) || 1;
    const stage = this.stage().nativeElement;
    stage.style.width = `${r.width}px`;
    stage.style.height = `${r.height}px`;
    stage.style.transform = `scale(${this.scale})`;
    const vp = this.viewport().nativeElement;
    vp.style.width = `${r.width * this.scale}px`;
    vp.style.height = `${r.height * this.scale}px`;
    this.placeLabels();
  }

  private render() {
    const r = this.report();
    const frame = this.frame().nativeElement;
    const url = this.url();
    if (url !== this.loadedUrl) {
      this.loadedUrl = url;
      this.unreachable.set(false);
      if (url) {
        frame.src = url;
        this.probe(url);
      } else frame.removeAttribute('src');
    }
    frame.style.width = `${r.width}px`;
    frame.style.height = `${r.height}px`;
    frame.classList.toggle('hidden', !this.showPage() || !url);
    this.layout();
    this.draw();
  }

  /** Requête opaque (no-cors) : échoue seulement si le site est injoignable, sans exiger CORS. */
  private probe(url: string) {
    fetch(url, { mode: 'no-cors', cache: 'no-store' }).then(
      () => { if (url === this.loadedUrl) { this.unreachable.set(false); this.reachable.emit(true); } },
      () => { if (url === this.loadedUrl) { this.unreachable.set(true); this.reachable.emit(false); } },
    );
  }

  private draw() {
    const r = this.report();
    const canvas = this.canvas().nativeElement;
    const w = Math.round(r.width * RES);
    const h = Math.round(r.height * RES);
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    if (this.mode() === 'scroll') this.drawScroll(ctx, w, h);
    else this.drawClicks(ctx, w, h);
    canvas.classList.remove('in');
    void canvas.offsetWidth;
    canvas.classList.add('in');
  }

  private drawClicks(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const points = this.report().points;
    if (!points.length) return;
    const max = Math.max(...points.map((p) => p.count));
    const radius = RADIUS * RES;
    // 1) densité en niveaux d'alpha, 2) colorisation par la palette.
    for (const p of points) {
      const x = (p.x / 10000) * w;
      const y = p.y * RES;
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(0,0,0,${Math.max(0.08, Math.min(1, Math.sqrt(p.count / max)))})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (!a) continue;
      d[i] = PALETTE[a * 3];
      d[i + 1] = PALETTE[a * 3 + 1];
      d[i + 2] = PALETTE[a * 3 + 2];
      d[i + 3] = Math.min(235, 60 + a);
    }
    ctx.putImageData(img, 0, 0);
  }

  private reachAt(pct: number) {
    const bands = this.report().scroll;
    for (let i = 0; i < bands.length - 1; i++) {
      const a = bands[i], b = bands[i + 1];
      if (pct >= a.depth && pct <= b.depth) return a.share + ((b.share - a.share) * (pct - a.depth)) / (b.depth - a.depth || 1);
    }
    return bands.length ? bands[bands.length - 1].share : 0;
  }

  private drawScroll(ctx: CanvasRenderingContext2D, w: number, h: number) {
    for (let y = 0; y < h; y += 4) {
      ctx.fillStyle = `rgba(16, 16, 12, ${(1 - this.reachAt((y / h) * 100)) * 0.72})`;
      ctx.fillRect(0, y, w, 4);
    }
    ctx.fillStyle = 'rgba(122, 162, 247, .9)';
    ctx.fillRect(0, this.report().fold * RES - 1, w, 2);
  }

  private placeLabels() {
    const el = this.labels().nativeElement;
    el.replaceChildren();
    const r = this.report();
    if (this.mode() !== 'scroll' || !r.views) return;
    const add = (y: number, text: string, cls = '') => {
      const l = document.createElement('div');
      l.className = `reach ${cls}`;
      l.textContent = text;
      l.style.top = `${y * this.scale}px`;
      el.appendChild(l);
    };
    add(r.fold, `Ligne de flottaison moyenne (${r.fold} px)`, 'fold');
    for (const target of [0.75, 0.5, 0.25]) {
      const band = r.scroll.find((b) => b.share < target);
      if (band) add((band.depth / 100) * r.height, `${target * 100} % des visiteurs ont vu jusqu'ici`);
    }
  }

  ngOnDestroy() {
    this.observer?.disconnect();
  }
}
