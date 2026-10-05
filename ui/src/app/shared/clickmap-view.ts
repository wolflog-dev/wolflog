import { Component, ElementRef, OnDestroy, afterNextRender, effect, input, output, signal, viewChild } from '@angular/core';
import { ClickmapReport } from '../core/models';
import { NavIcon } from './nav-icon';

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
  imports: [NavIcon],
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
        <div class="notice warn" role="status" animate.enter="notice-in" animate.leave="notice-out">
          <wl-nav-icon name="warning" [size]="14" /><span class="ellipsis">Aperçu indisponible : {{ url() }} ne répond pas.</span>
        </div>
      } @else if (redirectedTo() && showPage()) {
        <div class="notice warn" role="status" animate.enter="notice-in" animate.leave="notice-out"
             title="Dans l'aperçu, le navigateur n'envoie pas votre session du site : ouvrez la carte sur le site lui-même.">
          <wl-nav-icon name="lock" [size]="14" /><span class="ellipsis">Connexion demandée : l'aperçu affiche {{ redirectedTo() }}.</span>
          <button type="button" class="btn small primary" (click)="openOnSite.emit()"><wl-nav-icon name="external" [size]="13" />Ouvrir sur le site</button>
        </div>
      } @else if (frameLoading() && showPage()) {
        <div class="notice" role="status" animate.enter="notice-in" animate.leave="notice-out">
          <wl-nav-icon class="spin" name="refresh" [size]="13" /><span>Chargement de l'aperçu…</span>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .host { position: relative; max-height: 78vh; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2);
      box-shadow: var(--shadow), inset 0 1px 0 var(--highlight); }
    /* Bandeau flottant au-dessus de l'aperçu (verre dépoli : la page défile dessous). */
    .notice { position: sticky; bottom: 12px; z-index: 2; display: flex; align-items: center; gap: 8px; width: fit-content; max-width: calc(100% - 24px);
      margin: -46px auto 12px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-1); font: 500 12px var(--sans);
      background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); box-shadow: var(--shadow-pop); }
    .notice wl-nav-icon { flex: none; color: var(--accent); }
    /* Bouton compact : le bandeau garde la hauteur des autres (rien ne bouge sous la carte). */
    .notice .btn { flex: none; height: 24px; margin: -4px -8px -4px 4px; padding: 0 10px; font-size: 12px; }
    .notice .btn wl-nav-icon { color: inherit; }
    .notice.warn { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
    .notice.warn wl-nav-icon { color: var(--danger); }
    .notice-in { animation: notice-in .45s var(--spring); }
    .notice-out { animation: notice-out .2s ease-in forwards; }
    @keyframes notice-in { from { opacity: 0; transform: translateY(10px) scale(.95); } }
    @keyframes notice-out { to { opacity: 0; transform: translateY(6px) scale(.97); } }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .viewport { position: relative; margin: 0 auto; overflow: hidden; }
    /* Fond blanc : celui de la page affichée dessous (contenu du site, pas un élément de l'interface). */
    .stage { position: absolute; top: 0; left: 0; transform-origin: 0 0; background: #fff; }
    iframe { position: absolute; inset: 0; border: 0; pointer-events: none; background: #fff; transition: opacity .4s var(--ease); }
    iframe.hidden { opacity: 0; }
    canvas { position: absolute; inset: 0; pointer-events: none; }
    canvas.in { animation: map-in .7s ease-out backwards; }
    @keyframes map-in { from { opacity: 0; } }
    .labels { position: absolute; inset: 0; pointer-events: none; }
    /* Repères de défilement : pastilles en verre qui entrent en cascade, ligne pointillée sur toute la largeur. */
    :host ::ng-deep .reach { position: absolute; left: 10px; translate: 0 -50%; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface-solid); color: var(--text-1); font: 600 11px var(--sans); white-space: nowrap; box-shadow: var(--shadow-pop);
      animation: reach-in .5s var(--spring) backwards; animation-delay: calc(var(--n, 0) * 90ms + 150ms); }
    :host ::ng-deep .reach::after { content: ''; position: absolute; left: 100%; top: 50%; width: 3000px; border-top: 1px dashed rgba(255, 255, 255, .7); }
    :host ::ng-deep .reach.fold { border-color: transparent; background: linear-gradient(120deg, var(--accent), var(--accent-2)); color: var(--on-accent); }
    :host ::ng-deep .reach.fold::after { display: none; }
    @keyframes reach-in { from { opacity: 0; transform: translateX(-10px); } }
  `,
})
export class ClickmapView implements OnDestroy {
  readonly report = input.required<ClickmapReport>();
  readonly url = input<string | null>(null);
  readonly mode = input<'clicks' | 'scroll'>('clicks');
  readonly showPage = input(true);
  /** Émis quand l'adresse du site ne répond pas (serveur arrêté, mauvaise origine). */
  readonly reachable = output<boolean>();
  /** « Ouvrir sur le site » demandé depuis l'avertissement de connexion. */
  readonly openOnSite = output<void>();
  /** Page vraiment affichée par l'aperçu (signalée par le script navigateur du site) quand ce n'est pas celle demandée. */
  protected readonly redirectedTo = signal<string | null>(null);
  protected readonly unreachable = signal(false);
  /** Aperçu de la page en cours de chargement dans l'iframe. */
  protected readonly frameLoading = signal(false);

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

  /** Le script navigateur de la page affichée annonce son chemin : une redirection (vers la connexion) se repère. */
  private readonly onMessage = (e: MessageEvent) => {
    const shown = (e.data as { wolflogPreview?: unknown } | null)?.wolflogPreview;
    if (e.source !== this.frame().nativeElement.contentWindow || typeof shown !== 'string' || !this.loadedUrl) return;
    let expected: string;
    try { expected = new URL(this.loadedUrl).pathname; } catch { return; }
    this.redirectedTo.set(shown !== expected ? shown : null);
  };

  constructor() {
    afterNextRender(() => {
      this.ready = true;
      window.addEventListener('message', this.onMessage);
      // Écouteur direct : la fin du chargement de l'aperçu retire le bandeau « Chargement de l'aperçu… ».
      this.frame().nativeElement.addEventListener('load', () => this.frameLoading.set(false));
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
      this.redirectedTo.set(null);
      this.frameLoading.set(!!url);
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
      () => { if (url === this.loadedUrl) { this.unreachable.set(true); this.frameLoading.set(false); this.reachable.emit(false); } },
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
    const r = this.report();
    const wanted: { y: number; text: string; cls: string }[] = [];
    if (this.mode() === 'scroll' && r.views) {
      wanted.push({ y: r.fold, text: `Ligne de flottaison moyenne (${r.fold} px)`, cls: 'fold' });
      for (const target of [0.75, 0.5, 0.25]) {
        const band = r.scroll.find((b) => b.share < target);
        if (band) wanted.push({ y: (band.depth / 100) * r.height, text: `${target * 100} % des visiteurs ont vu jusqu'ici`, cls: '' });
      }
    }
    // Mêmes repères (redimensionnement, actualisation) : seule leur position change, sans rejouer leur entrée.
    const current = [...el.children] as HTMLElement[];
    if (current.length === wanted.length && current.every((c, i) => c.textContent === wanted[i].text)) {
      current.forEach((c, i) => (c.style.top = `${wanted[i].y * this.scale}px`));
      return;
    }
    el.replaceChildren(...wanted.map((w, i) => {
      const l = document.createElement('div');
      l.className = `reach ${w.cls}`;
      l.textContent = w.text;
      l.style.top = `${w.y * this.scale}px`;
      l.style.setProperty('--n', String(i));
      return l;
    }));
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    window.removeEventListener('message', this.onMessage);
  }
}
