import { Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavIcon } from './nav-icon';

export interface FlameNode {
  name: string;
  value: number;
  self: number;
  children: FlameNode[];
  depth: number;
  parent: FlameNode | null;
}

/** Ce qui ne dépend que du nœud : calculé une fois (le survol redessine sans rien recalculer). */
interface Look {
  color: string;
  label: string;
  fw: boolean;
  title: string;
}

interface Box {
  node: FlameNode;
  x: number;
  w: number;
  depth: number;
  match: boolean;
  look: Look;
  /** Nom court affiché dans le bloc (vide s'il est trop étroit). */
  text: string;
}

/** Nom lisible : sans le module ni les paramètres (le nom complet reste dans l'info-bulle). */
export function shortName(full: string): string {
  let n = full.includes('!') ? full.slice(full.indexOf('!') + 1) : full;
  const paren = n.indexOf('(');
  if (paren > 0) n = n.slice(0, paren);
  const parts = n.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : n;
}

export function buildTree(stacks: { s: string; v: number }[]): FlameNode {
  const root: FlameNode = { name: 'total', value: 0, self: 0, children: [], depth: 0, parent: null };
  for (const { s, v } of stacks) {
    root.value += v;
    let node = root;
    for (const frame of s.split(';')) {
      let child = node.children.find((c) => c.name === frame);
      if (!child) {
        child = { name: frame, value: 0, self: 0, children: [], depth: node.depth + 1, parent: node };
        node.children.push(child);
      }
      child.value += v;
      node = child;
    }
    node.self += v;
  }
  const sort = (n: FlameNode) => { n.children.sort((a, b) => b.value - a.value); n.children.forEach(sort); };
  sort(root);
  return root;
}

// Couleur stable par espace de noms : on repère d'un coup d'œil son propre code et celui du framework.
function colorFor(name: string, framework: boolean): string {
  if (name === 'total') return 'var(--surface-3)';
  let h = 0;
  const ns = name.split('(')[0].split('.').slice(0, 2).join('.');
  for (let i = 0; i < ns.length; i++) h = (h * 31 + ns.charCodeAt(i)) >>> 0;
  return framework ? `hsl(${210 + (h % 30)}, 12%, ${34 + (h % 10)}%)` : `hsl(${15 + (h % 40)}, 55%, ${48 + (h % 10)}%)`;
}

const FRAMEWORK = /^(System\.|Microsoft\.|Npgsql\.|Newtonsoft\.|Grpc\.|Google\.|Serilog\.|OpenTelemetry\.|DuckDB\.|\[|Unknown|\?)/;

/** Position (0–1) d'un nœud dans la largeur d'un de ses ancêtres ; null s'il n'en descend pas. */
function span(node: FlameNode, ancestor: FlameNode): { x: number; w: number } | null {
  let x = 0;
  let n = node;
  while (n !== ancestor) {
    const parent = n.parent;
    if (!parent) return null;
    for (const c of parent.children) {
      if (c === n) break;
      x += c.value;
    }
    n = parent;
  }
  const total = ancestor.value || 1;
  return { x: x / total, w: node.value / total };
}

/**
 * Transformation de départ d'un zoom : la nouvelle vue part de la place qu'occupait le bloc choisi (zoom avant)
 * ou de la vue précédente agrandie (zoom arrière), puis se déploie (transform uniquement).
 */
function zoomFrom(current: FlameNode, next: FlameNode): string {
  const inner = span(next, current);
  if (inner && inner.w > 0) return `translateX(${inner.x * 100}%) scaleX(${Math.max(inner.w, 0.02)})`;
  const outer = span(current, next);
  if (outer && outer.w > 0) {
    const s = Math.min(1 / outer.w, 40);
    return `translateX(${-outer.x * s * 100}%) scaleX(${s})`;
  }
  return 'none';
}

/** Graphe en flammes (racine en haut) : largeur = part du temps ou des octets ; clic = zoom animé, recherche = surlignage. */
@Component({
  selector: 'wl-flamegraph',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="bar">
      <div class="crumbs small">
        @for (c of crumbs(); track $index; let last = $last; let first = $first) {
          <button class="crumb" type="button" [disabled]="last" (click)="zoomTo(c)" [title]="c.name">
            @if (first) { <wl-nav-icon name="layers" [size]="12" /> }<span class="c-text">{{ c === root() ? 'Tout' : short(c.name) }}</span>
          </button>
          @if (!last) { <wl-nav-icon name="chevron-right" [size]="12" class="sep" /> }
        }
      </div>
      <span class="spacer"></span>
      <div class="search-wrap">
        <wl-nav-icon name="search" [size]="13" class="s-icon" />
        <input class="search" [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Surligner une méthode…" aria-label="Surligner une méthode" />
        @if (search()) {
          <button class="clear" type="button" (click)="search.set('')" title="Effacer" aria-label="Effacer la recherche"><wl-nav-icon name="close" [size]="11" /></button>
        }
      </div>
      @if (search()) { <span class="match small" [class.none]="!matchCount()">{{ matchCount() ? matchPct() + ' du total' : 'aucun bloc' }}</span> }
    </div>
    <div class="flame" [style.height.px]="height()" (mouseleave)="hover.set(null)">
      <div class="layer" [class.zoom-a]="zooms() % 2 === 1" [class.zoom-b]="zooms() > 0 && zooms() % 2 === 0" [style.--from]="from()">
        @for (b of boxes(); track $index) {
          <div class="box" [class.dim]="search() && !b.match" [class.match]="b.match" [class.fw]="b.look.fw"
               [style.left.%]="b.x * 100" [style.width.%]="b.w * 100" [style.top.px]="b.depth * rowHeight"
               [style.background]="b.look.color" [title]="b.look.title" (click)="zoomTo(b.node)" (mouseenter)="hover.set(b.node)">
            @if (b.text) { <span>{{ b.text }}</span> }
          </div>
        }
      </div>
    </div>
    <div class="tip small">
      @if (hover(); as h) {
        <span class="swatch" [style.background]="lookOf(h).color"></span>
        <span class="mono ellipsis tip-name">{{ h.name }}</span>
        <span class="muted nowrap">{{ format(h.value) }} ({{ pct(h.value) }}) · propre : {{ format(h.self) }}</span>
        <span class="share"><i [style.transform]="'scaleX(' + share(h.value) + ')'"></i></span>
      } @else {
        <wl-nav-icon name="cursor" [size]="13" class="muted" />
        <span class="muted ellipsis">Survoler un bloc pour le détail, cliquer pour zoomer. Couleurs chaudes : votre code ; grises : .NET et bibliothèques.</span>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; min-width: 0; }
    .crumb { display: inline-flex; align-items: center; gap: 5px; border: 0; background: none; color: var(--accent); font: 12px var(--mono); cursor: pointer;
      padding: 3px 7px; border-radius: 7px; max-width: 220px; white-space: nowrap;
      transition: background-color .15s, color .15s; animation: crumb-in .3s var(--ease) backwards; }
    @keyframes crumb-in { from { opacity: 0; transform: translateX(-6px); } }
    .crumb .c-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .crumb:hover:not(:disabled) { background: var(--accent-soft); }
    .crumb:disabled { color: var(--text-1); cursor: default; font-weight: 600; }
    .sep { color: var(--text-3); opacity: .6; }
    .search-wrap { position: relative; display: flex; align-items: center; }
    .s-icon { position: absolute; left: 10px; color: var(--text-3); pointer-events: none; transition: color .2s; }
    .search-wrap:focus-within .s-icon { color: var(--accent); }
    .search { width: 250px; min-width: 0; padding-left: 30px; padding-right: 28px; }
    .clear { position: absolute; right: 6px; display: grid; place-items: center; width: 18px; height: 18px; border: 0; border-radius: 50%;
      background: var(--surface-3); color: var(--text-2); cursor: pointer; animation: pop .3s var(--spring); }
    .clear:hover { color: var(--text-1); background: var(--accent-soft); }
    @keyframes pop { from { opacity: 0; transform: scale(.4); } }
    .match { padding: 1px 9px; border-radius: 999px; color: var(--accent); background: var(--accent-soft); font-weight: 600; animation: pop .35s var(--spring); }
    .match.none { color: var(--text-3); background: var(--surface-3); }
    .flame { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--code-bg); }
    /* Calque des blocs : apparition, puis zoom animé (un seul calque transformé, rapide même avec beaucoup de blocs). */
    .layer { position: absolute; inset: 0; transform-origin: 0 0; animation: flame-in .5s var(--ease) backwards; }
    .layer.zoom-a { animation: zoom-a .45s var(--ease); }
    .layer.zoom-b { animation: zoom-b .45s var(--ease); }
    @keyframes flame-in { from { opacity: 0; transform: translateY(8px); } }
    @keyframes zoom-a { from { transform: var(--from); opacity: .55; } }
    @keyframes zoom-b { from { transform: var(--from); opacity: .55; } }
    .box { position: absolute; height: 17px; box-sizing: border-box; border-right: 1px solid var(--code-bg); border-bottom: 1px solid var(--code-bg);
      cursor: pointer; overflow: hidden; font: 11px/17px var(--mono); color: #111; padding: 0 3px; white-space: nowrap; border-radius: 3px; }
    .box.fw { color: #e6e6e6; }
    /* Survol et correspondances : voile clair et liseré (pas de filtre, rien d'animé en boucle). */
    .box:hover { box-shadow: inset 0 0 0 100px rgb(255 255 255 / .2), inset 0 0 0 1px rgb(255 255 255 / .7); }
    .box.match { box-shadow: inset 0 0 0 1.5px rgb(255 255 255 / .9); }
    .box.dim { opacity: .25; }
    .tip { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-height: 22px; min-width: 0; }
    .swatch { width: 10px; height: 10px; flex: none; border-radius: 3px; }
    .tip-name { min-width: 0; color: var(--text-1); }
    .share { flex: none; width: 70px; height: 4px; margin-left: auto; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .share i { display: block; width: 100%; height: 100%; background: var(--accent); transform-origin: left; transition: transform .3s var(--ease); }
  `,
})
export class FlameGraph {
  readonly root = input.required<FlameNode>();
  /** cpu : échantillons (≈ ms) ; alloc : octets. */
  readonly kind = input<'cpu' | 'alloc'>('cpu');
  readonly search = signal('');
  readonly zoom = signal<FlameNode | null>(null);
  protected readonly hover = signal<FlameNode | null>(null);
  protected readonly rowHeight = 18;
  /** Nombre de zooms (alterne deux animations identiques pour relancer l'effet) et transformation de départ. */
  protected readonly zooms = signal(0);
  protected readonly from = signal('none');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private looks = new WeakMap<FlameNode, Look>();

  protected readonly focus = computed(() => {
    const z = this.zoom();
    // Zoom conservé seulement s'il appartient à l'arbre affiché.
    let n = z;
    while (n?.parent) n = n.parent;
    return z && n === this.root() ? z : this.root();
  });

  protected readonly crumbs = computed(() => {
    const list: FlameNode[] = [];
    for (let n: FlameNode | null = this.focus(); n; n = n.parent) list.unshift(n);
    return list;
  });

  protected readonly boxes = computed<Box[]>(() => {
    const focus = this.focus();
    const term = this.search().trim().toLowerCase();
    const out: Box[] = [];
    const total = focus.value || 1;
    // Ancêtres du nœud zoomé, pleine largeur, pour garder le contexte.
    for (let a = focus.parent; a; a = a.parent) {
      const look = this.lookOf(a);
      out.push({ node: a, x: 0, w: 1, depth: a.depth, match: false, look, text: look.label });
    }
    const walk = (n: FlameNode, x: number) => {
      const w = n.value / total;
      if (w < 0.001) return;
      const look = this.lookOf(n);
      out.push({ node: n, x, w, depth: n.depth, match: !!term && n.name.toLowerCase().includes(term), look, text: w > 0.04 ? look.label : '' });
      let cx = x;
      for (const c of n.children) {
        walk(c, cx);
        cx += c.value / total;
      }
    };
    walk(focus, 0);
    return out;
  });

  protected readonly height = computed(() => (Math.max(0, ...this.boxes().map((b) => b.depth)) + 1) * this.rowHeight + 2);

  /** Blocs correspondant à la recherche (sans double compte des récursions) : nombre et part du total. */
  private readonly matches = computed(() => {
    const term = this.search().trim().toLowerCase();
    let sum = 0;
    let count = 0;
    if (!term) return { sum, count };
    const walk = (n: FlameNode) => {
      if (n.name.toLowerCase().includes(term)) { sum += n.value; count++; return; }
      n.children.forEach(walk);
    };
    walk(this.root());
    return { sum, count };
  });
  protected readonly matchCount = computed(() => this.matches().count);
  protected readonly matchPct = computed(() => (this.search().trim() ? this.pct(this.matches().sum) : ''));

  /** Zoom sur un bloc (ou retour à un ancêtre), avec une transition qui part de sa place actuelle. */
  zoomTo(node: FlameNode) {
    const current = this.focus();
    if (node === current) return;
    this.from.set(zoomFrom(current, node));
    this.zooms.update((z) => z + 1);
    this.zoom.set(node);
  }

  /** Amène le graphe dans la partie visible (ex. après un clic dans la liste des méthodes). */
  reveal() {
    const behavior: ScrollBehavior = document.documentElement.dataset['motion'] === 'off' ? 'auto' : 'smooth';
    this.host.scrollIntoView({ behavior, block: 'nearest' });
  }

  protected lookOf(n: FlameNode): Look {
    let look = this.looks.get(n);
    if (!look) {
      const name = n.name.includes('!') ? n.name.slice(n.name.indexOf('!') + 1) : n.name;
      const fw = FRAMEWORK.test(name);
      look = { color: colorFor(name, fw), label: shortName(n.name), fw, title: `${n.name}\n${this.format(n.value)} (${this.pct(n.value)}) · propre : ${this.format(n.self)}` };
      this.looks.set(n, look);
    }
    return look;
  }

  protected short(name: string) { return shortName(name); }
  /** Part du total (0–1), pour la petite barre du détail. */
  protected share(v: number) {
    return Math.max(0.01, Math.min(1, v / (this.root().value || 1)));
  }
  protected pct(v: number) {
    return ((100 * v) / (this.root().value || 1)).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %';
  }
  protected format(v: number) {
    if (this.kind() === 'alloc') {
      const units = ['o', 'Ko', 'Mo', 'Go'];
      let i = 0;
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
      return `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[i]}`;
    }
    return `${v.toLocaleString('fr-FR')} échantillon${v > 1 ? 's' : ''}`;
  }
}
