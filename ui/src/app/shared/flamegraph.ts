import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface FlameNode {
  name: string;
  value: number;
  self: number;
  children: FlameNode[];
  depth: number;
  parent: FlameNode | null;
}

interface Box {
  node: FlameNode;
  x: number;
  w: number;
  depth: number;
  match: boolean;
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

/** Graphe en flammes (racine en haut) : largeur = part du temps ou des octets ; clic = zoom, recherche = surlignage. */
@Component({
  selector: 'vg-flamegraph',
  imports: [FormsModule],
  template: `
    <div class="bar">
      <div class="crumbs small">
        @for (c of crumbs(); track $index; let last = $last) {
          <button class="crumb" [disabled]="last" (click)="zoom.set(c)" [title]="c.name">{{ c === root() ? 'Tout' : short(c.name) }}</button>
          @if (!last) { <span class="muted">›</span> }
        }
      </div>
      <span class="spacer"></span>
      <input class="search" [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Surligner une méthode…" />
      @if (search()) { <span class="small muted">{{ matchPct() }} du total</span> }
    </div>
    <div class="flame" [style.height.px]="height()" (mouseleave)="hover.set(null)">
      @for (b of boxes(); track $index) {
        <div class="box" [class.dim]="search() && !b.match" [class.fw]="isFramework(b.node.name)"
             [style.left.%]="b.x * 100" [style.width.%]="b.w * 100" [style.top.px]="b.depth * rowHeight"
             [style.background]="color(b.node)" (click)="zoom.set(b.node)" (mouseenter)="hover.set(b.node)">
          @if (b.w > 0.04) { <span>{{ short(b.node.name) }}</span> }
        </div>
      }
    </div>
    <div class="tip small">
      @if (hover(); as h) {
        <span class="mono">{{ h.name }}</span>
        <span class="muted"> · {{ format(h.value) }} ({{ pct(h.value) }}) · propre : {{ format(h.self) }}</span>
      } @else {
        <span class="muted">Survoler un bloc pour le détail, cliquer pour zoomer. Couleurs chaudes : votre code ; grises : .NET et bibliothèques.</span>
      }
    </div>
  `,
  styles: `
    .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
    .crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
    .crumb { border: 0; background: none; color: var(--accent); font: 12px var(--mono); cursor: pointer; padding: 0; max-width: 220px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .crumb:disabled { color: var(--text-1); cursor: default; }
    .search { width: 240px; }
    .flame { position: relative; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--code-bg); }
    .box { position: absolute; height: 17px; box-sizing: border-box; border-right: 1px solid var(--code-bg); border-bottom: 1px solid var(--code-bg);
      cursor: pointer; overflow: hidden; font: 11px/17px var(--mono); color: #111; padding: 0 3px; white-space: nowrap; }
    .box.fw { color: #e6e6e6; }
    .box:hover { filter: brightness(1.2); }
    .box.dim { opacity: .25; }
    .tip { margin-top: 6px; min-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
    for (let a = focus.parent; a; a = a.parent) out.push({ node: a, x: 0, w: 1, depth: a.depth, match: false });
    const walk = (n: FlameNode, x: number) => {
      const w = n.value / total;
      if (w < 0.001) return;
      out.push({ node: n, x, w, depth: n.depth, match: !!term && n.name.toLowerCase().includes(term) });
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

  /** Part du total des blocs correspondant à la recherche (sans double compte des récursions). */
  protected readonly matchPct = computed(() => {
    const term = this.search().trim().toLowerCase();
    if (!term) return '';
    let sum = 0;
    const walk = (n: FlameNode) => {
      if (n.name.toLowerCase().includes(term)) { sum += n.value; return; }
      n.children.forEach(walk);
    };
    walk(this.root());
    return this.pct(sum);
  });

  protected short(name: string) { return shortName(name); }
  protected isFramework(name: string) { return FRAMEWORK.test(name.includes('!') ? name.slice(name.indexOf('!') + 1) : name); }
  protected color(n: FlameNode) {
    const name = n.name.includes('!') ? n.name.slice(n.name.indexOf('!') + 1) : n.name;
    return colorFor(name, this.isFramework(n.name));
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
