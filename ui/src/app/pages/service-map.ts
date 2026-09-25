import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api, MapEdge, MapNode, ServiceMap } from '../core/api';
import { AppState } from '../core/state';
import { DurPipe, NumPipe } from '../core/format';

interface PlacedNode extends MapNode {
  x: number;
  y: number;
  rate: number;
  errorRate: number;
}

interface PlacedEdge extends MapEdge {
  path: string;
  lx: number;
  ly: number;
  rate: number;
  errorRate: number;
  width: number;
}

const W = 200;
const H = 58;
const COL = 290;
const ROW = 86;
const PAD = 24;

const KIND_LABEL: Record<string, string> = { service: 'service', database: 'base de données', queue: 'file de messages', external: 'API externe' };

function fmt(v: number, digits = 1) {
  return v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 ? 0 : digits });
}

@Component({
  selector: 'vg-service-map',
  imports: [RouterLink, NumPipe, DurPipe],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Carte des services</h1>
        <span class="muted small">qui appelle qui, calculé à partir des traces · {{ state.label() }}</span>
        <span class="spacer"></span>
        <span class="legend small muted"><span class="sw bad"></span> plus de 5 % d'erreurs</span>
      </div>

      <div class="split" [class.with-side]="selectedNode() || selectedEdge()">
        <section class="panel canvas">
          @if (layout(); as l) {
            @if (l.nodes.length) {
              <svg [attr.viewBox]="'0 0 ' + l.width + ' ' + l.height" [style.height.px]="l.height" [style.max-width.px]="l.width" role="img" aria-label="Carte des services">
                <defs>
                  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="arrow" />
                  </marker>
                  <marker id="arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="arrow bad" />
                  </marker>
                </defs>
                @for (e of l.edges; track e.source + e.target) {
                  <g class="edge" [class.bad]="e.errorRate > 5" [class.sel]="selectedEdge() === e" [class.dim]="dimmed(e)" (click)="selectEdge(e)">
                    <path [attr.d]="e.path" class="hit" />
                    <path [attr.d]="e.path" class="line" [attr.stroke-width]="e.width" [attr.marker-end]="e.errorRate > 5 ? 'url(#arrow-bad)' : 'url(#arrow)'" />
                    <text [attr.x]="e.lx" [attr.y]="e.ly - 6" text-anchor="middle">{{ rateLabel(e.rate) }}@if (e.errors) { · {{ pct(e.errorRate) }} }</text>
                  </g>
                }
                @for (n of l.nodes; track n.id) {
                  <g class="node" [class.ext]="n.kind !== 'service'" [class.bad]="n.errorRate > 5" [class.sel]="selectedNode()?.id === n.id"
                     [class.dim]="dimmedNode(n)" [attr.transform]="'translate(' + n.x + ',' + n.y + ')'" (click)="selectNode(n)">
                    <rect [attr.width]="w" [attr.height]="h" rx="3" />
                    <text x="10" y="22" class="name">{{ clip(n.name, 24) }}</text>
                    <text x="10" y="42" class="meta">
                      @if (n.kind === 'service') {
                        {{ n.requests ? rateLabel(n.rate) + ' · ' + pct(n.errorRate) + ' err.' + (n.p95Ms !== null ? ' · p95 ' + dur(n.p95Ms) : '') : 'aucune requête reçue' }}
                      } @else {
                        {{ kindLabel(n.kind) }}{{ n.detail && n.detail !== n.name ? ' · ' + clip(n.detail, 16) : '' }}
                      }
                    </text>
                  </g>
                }
              </svg>
            } @else {
              <div class="empty">
                Aucun appel sur cette période. La carte se construit à partir des traces : chaque application instrumentée
                (AddVigil) et chaque appel HTTP, SQL ou de file de messages apparaît automatiquement.
              </div>
            }
          }
        </section>

        @if (selectedNode(); as n) {
          <aside class="panel side">
            <div class="panel-head">
              <strong class="ellipsis">{{ n.name }}</strong><span class="muted small">{{ kindLabel(n.kind) }}</span>
              <span class="spacer"></span><button class="btn ghost" (click)="clear()">Fermer</button>
            </div>
            <div class="panel-body detail">
              <div class="facts small">
                <div><span>{{ n.kind === 'service' ? 'Requêtes reçues' : 'Appels' }}</span><strong>{{ n.requests | num }}</strong></div>
                <div><span>Débit</span><strong>{{ rateLabel(n.rate) }}</strong></div>
                <div><span>Erreurs</span><strong [class.danger]="n.errorRate > 5">{{ pct(n.errorRate) }}</strong></div>
                @if (n.p95Ms !== null) { <div><span>p95</span><strong>{{ n.p95Ms | dur }}</strong></div> }
              </div>
              @if (callers().length) {
                <h3>Appelé par</h3>
                @for (e of callers(); track e.source) {
                  <button class="rel" (click)="selectEdge(e)"><span>{{ nameOf(e.source) }}</span><span class="muted small">{{ rateLabel(e.rate) }} · {{ pct(e.errorRate) }}</span></button>
                }
              }
              @if (callees().length) {
                <h3>Appelle</h3>
                @for (e of callees(); track e.target) {
                  <button class="rel" (click)="selectEdge(e)"><span>{{ nameOf(e.target) }}</span><span class="muted small">{{ rateLabel(e.rate) }} · {{ pct(e.errorRate) }} · p95 {{ e.p95Ms | dur }}</span></button>
                }
              }
              <div class="links small">
                @if (n.kind === 'service') {
                  <a routerLink="/requests" [queryParams]="{ service: n.id }">Requêtes</a>
                  <a routerLink="/traces" [queryParams]="{ service: n.id }">Traces</a>
                  <a routerLink="/logs" [queryParams]="{ service: n.id }">Logs</a>
                  <a routerLink="/errors" [queryParams]="{ service: n.id }">Erreurs</a>
                } @else {
                  <a routerLink="/traces" [queryParams]="{ q: n.name }">Traces qui l'appellent</a>
                }
              </div>
            </div>
          </aside>
        } @else if (selectedEdge(); as e) {
          <aside class="panel side">
            <div class="panel-head">
              <strong class="ellipsis">{{ nameOf(e.source) }} → {{ nameOf(e.target) }}</strong>
              <span class="spacer"></span><button class="btn ghost" (click)="clear()">Fermer</button>
            </div>
            <div class="panel-body detail">
              <div class="facts small">
                <div><span>Appels</span><strong>{{ e.calls | num }}</strong></div>
                <div><span>Débit</span><strong>{{ rateLabel(e.rate) }}</strong></div>
                <div><span>En erreur</span><strong [class.danger]="e.errorRate > 5">{{ e.errors | num }} ({{ pct(e.errorRate) }})</strong></div>
                <div><span>p95</span><strong>{{ e.p95Ms | dur }}</strong></div>
              </div>
              <div class="links small">
                @if (isService(e.target)) {
                  <a routerLink="/requests" [queryParams]="{ service: e.target }">Requêtes reçues par {{ e.target }}</a>
                  <a routerLink="/traces" [queryParams]="{ service: e.source, errors: e.errors ? 'true' : null }">Traces{{ e.errors ? ' en erreur' : '' }}</a>
                } @else {
                  <a routerLink="/requests" [queryParams]="{ service: e.source, direction: 'out', q: nameOf(e.target) }">Appels sortants de {{ e.source }}</a>
                  <a routerLink="/traces" [queryParams]="{ service: e.source, q: nameOf(e.target) }">Traces</a>
                }
              </div>
            </div>
          </aside>
        }
      </div>
    </div>
  `,
  styles: `
    .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
    .split.with-side { grid-template-columns: minmax(0, 1fr) minmax(320px, 30%); }
    .canvas { padding: 12px; overflow: hidden; }
    svg { display: block; width: 100%; margin: 0 auto; }
    .legend { display: inline-flex; align-items: center; gap: 6px; }
    .sw { display: inline-block; width: 16px; height: 0; border-top: 2px solid var(--danger); }
    .node { cursor: pointer; }
    .node rect { fill: var(--surface-2); stroke: var(--border); stroke-width: 1; }
    .node.ext rect { fill: var(--surface); stroke-dasharray: 4 3; }
    .node.bad rect { stroke: var(--danger); }
    .node:hover rect, .node.sel rect { stroke: var(--accent); stroke-width: 1.5; }
    .node .name { fill: var(--text-1); font: 600 12.5px var(--sans); }
    .node .meta { fill: var(--text-3); font: 11px var(--sans); }
    .edge { cursor: pointer; }
    .edge .line { fill: none; stroke: var(--text-3); opacity: .55; }
    .edge .hit { fill: none; stroke: transparent; stroke-width: 12; }
    .edge text { fill: var(--text-3); font: 10.5px var(--sans); }
    .edge.bad .line { stroke: var(--danger); opacity: .8; }
    .edge.bad text { fill: var(--danger); }
    .edge:hover .line, .edge.sel .line { stroke: var(--accent); opacity: 1; }
    .edge:hover text, .edge.sel text { fill: var(--text-1); }
    .dim { opacity: .25; }
    .arrow { fill: var(--text-3); }
    .arrow.bad { fill: var(--danger); }
    .side { position: sticky; top: 60px; }
    .detail { display: grid; gap: 8px; }
    .facts { display: flex; flex-wrap: wrap; gap: 8px 20px; }
    .facts > div { display: grid; gap: 2px; }
    .facts span { color: var(--text-3); }
    h3 { margin-top: 8px; }
    .rel { display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 5px 8px; border: 0; border-radius: 3px; background: none;
      color: var(--text-1); font: 13px var(--sans); text-align: left; cursor: pointer; }
    .rel:hover { background: var(--row-hover); }
    .links { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
    @media (max-width: 1100px) { .split.with-side { grid-template-columns: minmax(0, 1fr); } .side { position: static; } }
  `,
})
export class ServiceMapPage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  protected readonly data = signal<ServiceMap | null>(null);
  protected readonly loading = signal(false);
  protected readonly selectedNode = signal<PlacedNode | null>(null);
  protected readonly selectedEdge = signal<PlacedEdge | null>(null);
  protected readonly w = W;
  protected readonly h = H;

  constructor() {
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.env();
      untracked(() => this.load());
    });
  }

  private load() {
    this.loading.set(true);
    this.api.serviceMap(this.state.range()).subscribe({
      next: (m) => {
        this.data.set(m);
        this.loading.set(false);
        // Garde la sélection après actualisation.
        const n = this.selectedNode();
        if (n) this.selectedNode.set(this.layout()?.nodes.find((x) => x.id === n.id) ?? null);
        const e = this.selectedEdge();
        if (e) this.selectedEdge.set(this.layout()?.edges.find((x) => x.source === e.source && x.target === e.target) ?? null);
      },
      error: () => this.loading.set(false),
    });
  }

  /** Disposition en colonnes : appelants à gauche, appelés à droite, dépendances externes après leur premier appelant. */
  protected readonly layout = computed(() => {
    const m = this.data();
    if (!m) return null;
    const service = this.state.service();
    let edges = m.edges;
    let nodes = m.nodes;
    // Filtre de service global : le service, ses appelants et ses appelés.
    if (service) {
      const keep = new Set([service]);
      for (const e of edges) if (e.source === service || e.target === service) { keep.add(e.source); keep.add(e.target); }
      edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
      nodes = nodes.filter((n) => keep.has(n.id));
    }
    const ids = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => ids.has(e.source) && ids.has(e.target));

    const incoming = new Map<string, string[]>();
    for (const e of edges) incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source]);
    const depth = new Map<string, number>();
    const visit = (id: string, stack: Set<string>): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (stack.has(id)) return 0; // cycle
      stack.add(id);
      const parents = incoming.get(id) ?? [];
      const d = parents.length ? Math.max(...parents.map((p) => visit(p, stack))) + 1 : 0;
      stack.delete(id);
      depth.set(id, d);
      return d;
    };
    nodes.forEach((n) => visit(n.id, new Set()));
    // Chaque dépendance se place juste après son appelant le plus profond : liens courts, sans traverser de nœud.

    const columns = new Map<number, MapNode[]>();
    for (const n of nodes) columns.set(depth.get(n.id)!, [...(columns.get(depth.get(n.id)!) ?? []), n]);
    const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
    const height = PAD * 2 + tallest * ROW - (ROW - H);
    const seconds = m.seconds;
    const placed = new Map<string, PlacedNode>();
    for (const [col, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
      // Ordre dans la colonne : celui des appelants (moins de croisements), puis par volume.
      list.sort((a, b) => avgParentY(a) - avgParentY(b) || b.requests - a.requests);
      const offset = (height - (list.length * ROW - (ROW - H))) / 2;
      list.forEach((n, i) => placed.set(n.id, {
        ...n, x: PAD + col * COL, y: offset + i * ROW,
        rate: n.requests / seconds, errorRate: n.requests ? (100 * n.errors) / n.requests : 0,
      }));
    }
    function avgParentY(n: MapNode) {
      const ys = (incoming.get(n.id) ?? []).map((p) => placed.get(p)?.y).filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    }
    const maxCalls = Math.max(1, ...edges.map((e) => e.calls));
    const placedEdges: PlacedEdge[] = edges.map((e) => {
      const a = placed.get(e.source)!;
      const b = placed.get(e.target)!;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
      const back = x2 <= x1; // appel vers une colonne précédente (cycle)
      const c = back ? 80 : Math.max(40, (x2 - x1) / 2);
      const path = back
        ? `M${x1},${y1} C${x1 + c},${y1 - 70} ${x2 - c},${y2 - 70} ${x2},${y2}`
        : `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
      // Étiquette dans le premier espace entre colonnes (pas sur un nœud traversé).
      const t = back ? 0.5 : Math.min(0.5, (COL - W) / 2 / Math.max(1, x2 - x1) + 0.12);
      const bez = (p0: number, p1: number, p2: number, p3: number) =>
        (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
      const [c1y, c2y] = back ? [y1 - 70, y2 - 70] : [y1, y2];
      return {
        ...e, path, lx: bez(x1, x1 + c, x2 - c, x2), ly: bez(y1, c1y, c2y, y2),
        rate: e.calls / seconds, errorRate: e.calls ? (100 * e.errors) / e.calls : 0,
        width: 1 + 3 * Math.sqrt(e.calls / maxCalls),
      };
    });
    const width = PAD * 2 + (Math.max(0, ...[...placed.values()].map((n) => n.x)) - PAD) + W;
    return { nodes: [...placed.values()], edges: placedEdges, width: Math.max(width, 400), height };
  });

  protected readonly callers = computed(() => {
    const n = this.selectedNode();
    return n ? (this.layout()?.edges ?? []).filter((e) => e.target === n.id) : [];
  });
  protected readonly callees = computed(() => {
    const n = this.selectedNode();
    return n ? (this.layout()?.edges ?? []).filter((e) => e.source === n.id) : [];
  });

  protected selectNode(n: PlacedNode) {
    this.selectedEdge.set(null);
    this.selectedNode.set(this.selectedNode()?.id === n.id ? null : n);
  }

  protected selectEdge(e: PlacedEdge) {
    this.selectedNode.set(null);
    this.selectedEdge.set(this.selectedEdge() === e ? null : e);
  }

  protected clear() {
    this.selectedNode.set(null);
    this.selectedEdge.set(null);
  }

  /** Mise en avant des voisins du nœud sélectionné. */
  protected dimmed(e: PlacedEdge) {
    const n = this.selectedNode();
    return !!n && e.source !== n.id && e.target !== n.id;
  }

  protected dimmedNode(node: PlacedNode) {
    const n = this.selectedNode();
    if (!n || n.id === node.id) return false;
    return !(this.layout()?.edges ?? []).some((e) => (e.source === n.id && e.target === node.id) || (e.target === n.id && e.source === node.id));
  }

  protected nameOf(id: string) {
    return this.data()?.nodes.find((n) => n.id === id)?.name ?? id;
  }

  protected isService(id: string) {
    return this.data()?.nodes.find((n) => n.id === id)?.kind === 'service';
  }

  protected kindLabel(k: string) {
    return KIND_LABEL[k] ?? k;
  }

  protected rateLabel(perSecond: number) {
    return perSecond >= 1 ? `${fmt(perSecond)} /s` : `${fmt(perSecond * 60)} /min`;
  }

  protected pct(v: number) {
    return `${fmt(v)} %`;
  }

  protected dur(ms: number) {
    return ms >= 1000 ? `${fmt(ms / 1000, 2)} s` : `${fmt(ms, 0)} ms`;
  }

  protected clip(s: string, n: number) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }
}
