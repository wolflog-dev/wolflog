import { Component, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { MapEdge, MapNode, ServiceMap } from '../core/models';
import { AppState } from '../core/app-state';
import { createIcon } from '../core/icons';
import { DurPipe } from '../core/pipes/dur-pipe';
import { NumPipe } from '../core/pipes/num-pipe';
import { CountUp } from '../shared/count-up';
import { NavIcon } from '../shared/nav-icon';
import { hue, initials } from '../shared/rich-option';

interface PlacedNode extends MapNode {
  x: number;
  y: number;
  /** Colonne (profondeur dans la chaîne d'appels) : rythme l'apparition. */
  col: number;
  rate: number;
  errorRate: number;
  title: string;
  meta: string;
  /** Pastille d'un service : teinte stable et initiales (comme dans les listes de services). */
  hue: number;
  initials: string;
}

interface PlacedEdge extends MapEdge {
  path: string;
  /** Position de l'étiquette : null quand elle chevaucherait un nœud ou une autre étiquette (affichée au survol). */
  label: { x: number; y: number } | null;
  hx: number;
  hy: number;
  text: string;
  labelWidth: number;
  rate: number;
  errorRate: number;
  width: number;
}

/** Ce qui est mis en avant : un nœud (sélectionné, sinon survolé) et ses voisins, ou les deux bouts du lien sélectionné. */
interface Focus {
  node: string | null;
  edge: PlacedEdge | null;
  nodes: Set<string>;
}

const W = 232;
const H = 58;
const COL = 372;
const ROW = 90;
const PAD = 28;
/** Début du texte d'un nœud, après sa pastille. */
const TEXT_X = 50;
/** Largeur moyenne d'un caractère (px) : noms en 12,5 px gras, détails et étiquettes en 11 px. */
const NAME_CH = 7.4;
const META_CH = 6.1;
const LABEL_CH = 5.9;
const LABEL_H = 15;

const KIND_LABEL: Record<string, string> = { service: 'service', database: 'base de données', queue: 'file de messages', external: 'API externe' };
const KIND_ICON: Record<string, string> = { service: 'server', database: 'database', queue: 'layers', external: 'globe' };

function fmt(v: number, digits = 1) {
  return v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 ? 0 : digits });
}

function rateLabel(perSecond: number) {
  return perSecond >= 1 ? `${fmt(perSecond)} /s` : `${fmt(perSecond * 60)} /min`;
}

function pct(v: number) {
  return `${fmt(v)} %`;
}

function dur(ms: number) {
  return ms >= 1000 ? `${fmt(ms / 1000, 2)} s` : `${fmt(ms, 0)} ms`;
}

/** Coupe un texte pour qu'il tienne dans une largeur donnée. */
function fit(s: string, width: number, ch: number) {
  const n = Math.floor(width / ch);
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
}

/** Symbole SVG réutilisable (<use>) construit à partir des icônes de l'application. */
function iconSymbol(name: string): SVGSymbolElement {
  const ns = 'http://www.w3.org/2000/svg';
  const icon = createIcon(name, 24);
  const symbol = document.createElementNS(ns, 'symbol');
  symbol.id = 'wl-map-' + name;
  symbol.setAttribute('viewBox', '0 0 24 24');
  const g = document.createElementNS(ns, 'g');
  for (const a of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin']) g.setAttribute(a, icon.getAttribute(a) ?? '');
  g.append(...Array.from(icon.childNodes));
  symbol.append(g);
  return symbol;
}

interface Box { x1: number; y1: number; x2: number; y2: number }
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

@Component({
  selector: 'wl-service-map',
  imports: [RouterLink, NumPipe, DurPipe, NavIcon, CountUp],
  template: `
    @if (loading()) { <div class="progress"></div> }
    <div class="page">
      <div class="page-head">
        <h1>Carte des services</h1>
        <span class="muted small">qui appelle qui, calculé à partir des traces · {{ state.label() }}</span>
        <span class="spacer"></span>
        <div class="legend small" aria-label="Légende">
          <span class="lg"><i class="lg-svc"></i>service</span>
          <span class="lg"><i class="lg-ext"></i>dépendance</span>
          <span class="lg"><i class="lg-line"></i>épaisseur : volume d'appels</span>
          <span class="lg"><i class="lg-bad"></i>plus de 5 % d'erreurs</span>
        </div>
      </div>

      <div class="split" [class.with-side]="selectedNode() || selectedEdge()">
        <section class="panel canvas">
          @if (layout(); as l) {
            @if (l.nodes.length) {
              <svg [attr.viewBox]="'0 0 ' + l.width + ' ' + l.height" [style.height.px]="l.height" [style.max-width.px]="l.width" [style.--w.px]="l.width" role="img" aria-label="Carte des services"
                   (click)="onCanvasClick($event)">
                <defs #defs>
                  <marker id="wl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="arrow" />
                  </marker>
                  <marker id="wl-arrow-on" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="arrow on" />
                  </marker>
                  <marker id="wl-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                    <path d="M0,0 L8,4 L0,8 z" class="arrow bad" />
                  </marker>
                </defs>
                @for (e of l.edges; track e.source + e.target) {
                  <g class="edge" [class.bad]="e.errorRate > 5" [class.sel]="selectedEdge() === e" [class.lit]="lit(e)" [class.dim]="dimmed(e)"
                     (click)="selectEdge(e)" (mouseenter)="hovered.set(e)" (mouseleave)="hovered.set(null)">
                    <title>{{ nameOf(e.source) }} → {{ nameOf(e.target) }} : {{ e.text }}</title>
                    <path [attr.d]="e.path" class="hit" />
                    <path [attr.d]="e.path" class="line" [attr.stroke-width]="e.width" [attr.marker-end]="marker(e)" />
                  </g>
                }
                @for (n of l.nodes; track n.id) {
                  <g class="node" [class.ext]="n.kind !== 'service'" [class.bad]="n.errorRate > 5" [class.sel]="selectedNode()?.id === n.id"
                     [class.dim]="dimmedNode(n)" [attr.transform]="'translate(' + n.x + ',' + n.y + ')'"
                     tabindex="0" role="button" [attr.aria-label]="n.name + ' (' + kindLabel(n.kind) + ')'" [attr.aria-pressed]="selectedNode()?.id === n.id"
                     (click)="selectNode(n)" (keydown.enter)="selectNode(n)" (keydown.space)="$event.preventDefault(); selectNode(n)"
                     (mouseenter)="hoverNode.set(n.id)" (mouseleave)="hoverNode.set(null)" (focus)="hoverNode.set(n.id)" (blur)="hoverNode.set(null)">
                    <title>{{ n.name }}</title>
                    <g class="body" [style.--i]="n.col">
                      <rect class="card" [attr.width]="w" [attr.height]="h" rx="12" />
                      @if (n.kind === 'service') {
                        <circle class="avatar" cx="27" [attr.cy]="h / 2" r="14" [style.--hue]="n.hue" />
                        <text class="initials" x="27" [attr.y]="h / 2 + 3.5" text-anchor="middle">{{ n.initials }}</text>
                      } @else {
                        <rect class="kind-tile" x="13" [attr.y]="h / 2 - 14" width="28" height="28" rx="8" />
                        <use class="kind-icon" [attr.href]="'#wl-map-' + kindIcon(n.kind)" x="19" [attr.y]="h / 2 - 8" width="16" height="16" />
                      }
                      <text [attr.x]="textX" y="25" class="name">{{ n.title }}</text>
                      <text [attr.x]="textX" y="42" class="meta">{{ n.meta }}</text>
                      @if (n.errorRate > 5) {
                        <use class="alarm" href="#wl-map-warning" [attr.x]="w - 21" y="5" width="14" height="14"><title>Plus de 5 % d'erreurs</title></use>
                      }
                    </g>
                  </g>
                }
                <!-- Étiquettes au-dessus de tout, sur un fond : jamais cachées par un nœud, jamais sur un nœud. -->
                @for (e of l.edges; track e.source + e.target) {
                  @let at = e.label ?? ((hovered() === e || selectedEdge() === e) ? { x: e.hx, y: e.hy } : null);
                  @if (at) {
                    <g class="elabel" [class.placed]="!!e.label" [class.bad]="e.errorRate > 5" [class.on]="hovered() === e || selectedEdge() === e" [class.dim]="dimmed(e)"
                       (click)="selectEdge(e)" (mouseenter)="hovered.set(e)" (mouseleave)="hovered.set(null)">
                      <rect [attr.x]="at.x - e.labelWidth / 2" [attr.y]="at.y - 7.5" [attr.width]="e.labelWidth" height="15" rx="7.5" />
                      <text [attr.x]="at.x" [attr.y]="at.y + 4" text-anchor="middle">{{ e.text }}</text>
                    </g>
                  }
                }
              </svg>
              <div class="map-foot small muted">
                <span><wl-nav-icon name="server" [size]="12" />{{ counts().services }} service{{ counts().services > 1 ? 's' : '' }}</span>
                <span><wl-nav-icon name="database" [size]="12" />{{ counts().dependencies }} dépendance{{ counts().dependencies > 1 ? 's' : '' }}</span>
                <span><wl-nav-icon name="link" [size]="12" />{{ l.edges.length }} lien{{ l.edges.length > 1 ? 's' : '' }}</span>
                <span class="spacer"></span>
                <span><wl-nav-icon name="cursor" [size]="12" />cliquer pour le détail · Échap pour désélectionner</span>
              </div>
            } @else {
              <div class="empty">
                <p>Aucun appel sur cette période.</p>
                <p class="small">La carte se construit à partir des traces : chaque application instrumentée (AddWolflog)
                  et chaque appel HTTP, SQL ou de file de messages apparaît automatiquement.</p>
                <a class="btn" routerLink="/traces"><wl-nav-icon name="traces" [size]="14" />Voir les traces</a>
              </div>
            }
          } @else {
            <div class="ghost-map" aria-busy="true">
              @for (col of ghostCols; track $index; let c = $index) {
                <div class="ghost-col" [style.--i]="c">
                  @for (r of col; track $index) { <i class="skeleton ghost-node"></i> }
                </div>
              }
            </div>
          }
        </section>

        @if (selectedNode(); as n) {
          <aside class="panel side" animate.enter="side-in">
            <div class="panel-head">
              @if (n.kind === 'service') { <span class="badge avatar-badge" [style.--hue]="n.hue">{{ n.initials }}</span> }
              @else { <span class="badge kind-badge"><wl-nav-icon [name]="kindIcon(n.kind)" [size]="16" /></span> }
              <div class="side-title">
                <strong class="ellipsis" [title]="n.name">{{ n.name }}</strong>
                <span class="muted small">{{ kindLabel(n.kind) }}{{ n.detail && n.detail !== n.name ? ' · ' + n.detail : '' }}</span>
              </div>
              <span class="spacer"></span>
              <button class="btn ghost square" (click)="clear()" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" /></button>
            </div>
            <div class="panel-body detail">
              <div class="facts">
                <div class="fact"><span class="f-label"><wl-nav-icon name="hash" [size]="12" />{{ n.kind === 'service' ? 'Requêtes reçues' : 'Appels' }}</span><strong [wlCountUp]="n.requests | num"></strong></div>
                <div class="fact"><span class="f-label"><wl-nav-icon name="bolt" [size]="12" />Débit</span><strong [wlCountUp]="rateLabel(n.rate)"></strong></div>
                <div class="fact" [class.bad]="n.errorRate > 5"><span class="f-label"><wl-nav-icon name="errors" [size]="12" />Erreurs</span><strong [wlCountUp]="pct(n.errorRate)"></strong></div>
                @if (n.p95Ms !== null) { <div class="fact"><span class="f-label"><wl-nav-icon name="timer" [size]="12" />p95</span><strong [wlCountUp]="n.p95Ms | dur"></strong></div> }
              </div>
              @if (callers().length) {
                <h3>Appelé par <span class="h-count">{{ callers().length }}</span></h3>
                <div class="rels">
                  @for (e of callers(); track e.source) {
                    @let other = nodeOf(e.source);
                    <button class="rel" type="button" (click)="selectEdge(e)" (mouseenter)="hovered.set(e)" (mouseleave)="hovered.set(null)">
                      @if (!other || other.kind === 'service') { <span class="mini avatar-badge" [style.--hue]="hueOf(e.source)">{{ initialsOf(nameOf(e.source)) }}</span> }
                      @else { <span class="mini kind-badge"><wl-nav-icon [name]="kindIcon(other.kind)" [size]="11" /></span> }
                      <span class="rel-name ellipsis" [title]="nameOf(e.source)">{{ nameOf(e.source) }}</span>
                      <span class="muted small nowrap">{{ rateLabel(e.rate) }} · <span [class.danger]="e.errorRate > 5">{{ pct(e.errorRate) }}</span></span>
                      <wl-nav-icon name="chevron-right" [size]="13" class="go" />
                    </button>
                  }
                </div>
              }
              @if (callees().length) {
                <h3>Appelle <span class="h-count">{{ callees().length }}</span></h3>
                <div class="rels">
                  @for (e of callees(); track e.target) {
                    @let other = nodeOf(e.target);
                    <button class="rel" type="button" (click)="selectEdge(e)" (mouseenter)="hovered.set(e)" (mouseleave)="hovered.set(null)">
                      @if (!other || other.kind === 'service') { <span class="mini avatar-badge" [style.--hue]="hueOf(e.target)">{{ initialsOf(nameOf(e.target)) }}</span> }
                      @else { <span class="mini kind-badge"><wl-nav-icon [name]="kindIcon(other.kind)" [size]="11" /></span> }
                      <span class="rel-name ellipsis" [title]="nameOf(e.target)">{{ nameOf(e.target) }}</span>
                      <span class="muted small nowrap">{{ rateLabel(e.rate) }} · <span [class.danger]="e.errorRate > 5">{{ pct(e.errorRate) }}</span> · p95 {{ e.p95Ms | dur }}</span>
                      <wl-nav-icon name="chevron-right" [size]="13" class="go" />
                    </button>
                  }
                </div>
              }
              <div class="links">
                @if (n.kind === 'service') {
                  <a class="btn small" routerLink="/requests" [queryParams]="{ service: n.id }"><wl-nav-icon name="requests" [size]="13" />Requêtes</a>
                  <a class="btn small" routerLink="/traces" [queryParams]="{ service: n.id }"><wl-nav-icon name="traces" [size]="13" />Traces</a>
                  <a class="btn small" routerLink="/logs" [queryParams]="{ service: n.id }"><wl-nav-icon name="logs" [size]="13" />Logs</a>
                  <a class="btn small" routerLink="/errors" [queryParams]="{ service: n.id }"><wl-nav-icon name="errors" [size]="13" />Erreurs</a>
                } @else {
                  <a class="btn small" routerLink="/traces" [queryParams]="{ q: n.name }"><wl-nav-icon name="traces" [size]="13" />Traces qui l'appellent</a>
                }
              </div>
            </div>
          </aside>
        } @else if (selectedEdge(); as e) {
          <aside class="panel side" animate.enter="side-in">
            <div class="panel-head">
              <span class="pair">
                @let src = nodeOf(e.source);
                @let dst = nodeOf(e.target);
                @if (!src || src.kind === 'service') { <span class="badge avatar-badge" [style.--hue]="hueOf(e.source)">{{ initialsOf(nameOf(e.source)) }}</span> }
                @else { <span class="badge kind-badge"><wl-nav-icon [name]="kindIcon(src.kind)" [size]="16" /></span> }
                <wl-nav-icon name="arrow-right" [size]="14" class="pair-arrow" />
                @if (!dst || dst.kind === 'service') { <span class="badge avatar-badge" [style.--hue]="hueOf(e.target)">{{ initialsOf(nameOf(e.target)) }}</span> }
                @else { <span class="badge kind-badge"><wl-nav-icon [name]="kindIcon(dst.kind)" [size]="16" /></span> }
              </span>
              <div class="side-title">
                <strong class="ellipsis" [title]="nameOf(e.source) + ' → ' + nameOf(e.target)">{{ nameOf(e.source) }} → {{ nameOf(e.target) }}</strong>
                <span class="muted small">{{ isService(e.target) ? 'appels entre services' : 'appels vers une dépendance' }}</span>
              </div>
              <span class="spacer"></span>
              <button class="btn ghost square" (click)="clear()" title="Fermer (Échap)" aria-label="Fermer"><wl-nav-icon name="close" /></button>
            </div>
            <div class="panel-body detail">
              <div class="facts">
                <div class="fact"><span class="f-label"><wl-nav-icon name="hash" [size]="12" />Appels</span><strong [wlCountUp]="e.calls | num"></strong></div>
                <div class="fact"><span class="f-label"><wl-nav-icon name="bolt" [size]="12" />Débit</span><strong [wlCountUp]="rateLabel(e.rate)"></strong></div>
                <div class="fact" [class.bad]="e.errorRate > 5">
                  <span class="f-label"><wl-nav-icon name="errors" [size]="12" />En erreur</span>
                  <strong><span [wlCountUp]="e.errors | num"></span> <span class="sub">({{ pct(e.errorRate) }})</span></strong>
                </div>
                <div class="fact"><span class="f-label"><wl-nav-icon name="timer" [size]="12" />p95</span><strong [wlCountUp]="e.p95Ms | dur"></strong></div>
              </div>
              <div class="links">
                @if (isService(e.target)) {
                  <a class="btn small" routerLink="/requests" [queryParams]="{ service: e.target }"><wl-nav-icon name="requests" [size]="13" />Requêtes reçues par {{ e.target }}</a>
                  <a class="btn small" routerLink="/traces" [queryParams]="{ service: e.source, errors: e.errors ? 'true' : null }"><wl-nav-icon name="traces" [size]="13" />Traces{{ e.errors ? ' en erreur' : '' }}</a>
                } @else {
                  <a class="btn small" routerLink="/requests" [queryParams]="{ service: e.source, direction: 'out', q: nameOf(e.target) }"><wl-nav-icon name="requests" [size]="13" />Appels sortants de {{ e.source }}</a>
                  <a class="btn small" routerLink="/traces" [queryParams]="{ service: e.source, q: nameOf(e.target) }"><wl-nav-icon name="traces" [size]="13" />Traces</a>
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
    /* Téléphone : la carte garde sa taille réelle (textes lisibles) et défile dans son panneau. */
    @media (max-width: 760px) { .canvas { overflow-x: auto; overscroll-behavior-x: contain; } svg { width: var(--w); } }
    /* Légende : petits échantillons dessinés comme sur la carte. */
    .legend { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--text-3); }
    .lg { display: inline-flex; align-items: center; gap: 6px; }
    .lg i { display: inline-block; flex: none; }
    .lg-svc { width: 12px; height: 12px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .lg-ext { width: 13px; height: 11px; border-radius: 4px; border: 1px dashed var(--text-3); }
    .lg-line { width: 18px; height: 3px; border-radius: 2px; background: var(--text-3); }
    .lg-bad { width: 18px; height: 2px; border-radius: 2px; background: var(--danger); }
    /* Nœuds : apparition colonne par colonne, léger zoom au survol (sur un groupe intérieur : la position reste un attribut). */
    .node { cursor: pointer; outline: none; transition: opacity .3s var(--ease); }
    .node .body { transform-box: fill-box; transform-origin: center; transition: transform .35s var(--spring);
      animation: node-in .55s var(--spring) backwards; animation-delay: calc(var(--i) * 90ms + 60ms); }
    @keyframes node-in { from { opacity: 0; transform: scale(.82); } }
    .node:hover .body, .node:focus-visible .body { transform: scale(1.04); }
    .node .card { fill: var(--surface-2); stroke: var(--border); stroke-width: 1; transition: stroke .2s, fill .2s; }
    .node.ext .card { fill: var(--surface); stroke-dasharray: 4 3; }
    .node.bad .card { stroke: color-mix(in srgb, var(--danger) 70%, transparent); }
    .node:hover .card, .node:focus-visible .card { stroke: var(--accent); }
    .node.sel .card { stroke: var(--accent); stroke-width: 2; fill: var(--accent-soft); }
    .avatar { fill: hsl(var(--hue) 68% 52%); }
    .initials { fill: #fff; font: 700 10px var(--sans); letter-spacing: .02em; pointer-events: none; }
    .kind-tile { fill: var(--surface-3); }
    .kind-icon { color: var(--text-2); }
    .node.sel .kind-icon, .node:hover .kind-icon { color: var(--accent); }
    .name { fill: var(--text-1); font: 600 12.5px var(--sans); }
    .meta { fill: var(--text-3); font: 11px var(--sans); }
    .alarm { color: var(--danger); }
    /* Liens et étiquettes : fondu après les nœuds, couleur d'accent quand ils sont mis en avant. */
    .edge { cursor: pointer; transition: opacity .3s var(--ease); animation: fade-in .6s var(--ease) .3s backwards; }
    @keyframes fade-in { from { opacity: 0; } }
    .edge .line { fill: none; stroke: var(--text-3); opacity: .5; transition: stroke .2s, opacity .2s; }
    .edge .hit { fill: none; stroke: transparent; stroke-width: 12; }
    .edge.bad .line { stroke: var(--danger); opacity: .8; }
    .edge.lit .line, .edge.sel .line { stroke: var(--accent); opacity: 1; }
    .edge.bad.lit .line, .edge.bad.sel .line { stroke: var(--danger); opacity: 1; }
    .elabel { cursor: pointer; transition: opacity .3s var(--ease); animation: fade-in .2s var(--ease) backwards; }
    .elabel.placed { animation-duration: .6s; animation-delay: .45s; }
    .elabel rect { fill: var(--surface-solid); stroke: var(--border-soft); stroke-width: 1; transition: stroke .2s; }
    .elabel text { fill: var(--text-3); font: 500 11px var(--sans); transition: fill .2s; }
    .elabel.bad text { fill: var(--danger); }
    .elabel.on rect { stroke: var(--accent); }
    .elabel.on text { fill: var(--text-1); }
    .dim { opacity: .18; }
    .arrow { fill: var(--text-3); }
    .arrow.on { fill: var(--accent); }
    .arrow.bad { fill: var(--danger); }
    .map-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 10px 6px 2px; border-top: 1px solid var(--border-soft); margin-top: 8px; }
    .map-foot span { display: inline-flex; align-items: center; gap: 5px; }
    /* Chargement : colonnes de nœuds fantômes. */
    .ghost-map { display: flex; justify-content: center; align-items: center; gap: 120px; min-height: 300px; padding: 20px; }
    .ghost-col { display: grid; gap: 30px; animation: ghost-in .5s var(--ease) backwards; animation-delay: calc(var(--i) * 90ms); }
    @keyframes ghost-in { from { opacity: 0; transform: scale(.94); } }
    .ghost-node { width: 200px; height: 52px; border-radius: 12px; }
    .empty p { margin: 0 auto 8px; max-width: 520px; }
    .empty .btn { margin-top: 6px; }
    /* Panneau de détail : glisse depuis la droite. */
    .side { position: sticky; top: 60px; }
    .side-in { animation: side-in .45s var(--spring); }
    @keyframes side-in { from { opacity: 0; transform: translateX(18px) scale(.98); } }
    .side .panel-head { gap: 10px; }
    .side-title { display: grid; min-width: 0; }
    .badge { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 50%; animation: badge-pop .5s var(--spring) .1s backwards; }
    @keyframes badge-pop { from { opacity: 0; transform: scale(.4) rotate(-20deg); } }
    .avatar-badge { color: #fff; font: 700 11px/1 var(--sans); letter-spacing: .02em;
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%));
      box-shadow: 0 4px 10px -4px hsl(var(--hue) 70% 45% / .9), inset 0 1px 0 rgb(255 255 255 / .35); }
    .kind-badge { border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
    .pair { display: inline-flex; align-items: center; gap: 4px; flex: none; }
    .pair-arrow { color: var(--text-3); }
    .btn.square { width: 32px; padding: 0; justify-content: center; }
    .btn.square wl-nav-icon { transition: transform .4s var(--spring); }
    .btn.square:hover wl-nav-icon { transform: rotate(90deg); }
    .detail { display: grid; gap: 10px; }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .fact { display: grid; gap: 3px; padding: 9px 11px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft); background: var(--surface-2);
      animation: fact-in .4s var(--ease) backwards; }
    .fact:nth-child(2) { animation-delay: 40ms; } .fact:nth-child(3) { animation-delay: 80ms; } .fact:nth-child(4) { animation-delay: 120ms; }
    @keyframes fact-in { from { opacity: 0; transform: translateY(6px); } }
    .f-label { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-3); }
    .f-label wl-nav-icon { color: var(--accent); }
    .fact strong { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; }
    .fact.bad strong, .fact.bad .f-label wl-nav-icon { color: var(--danger); }
    .fact .sub { font-size: 12px; font-weight: 500; opacity: .8; }
    h3 { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    .h-count { padding: 0 6px; border-radius: 999px; font: 650 10px/16px var(--mono); color: var(--accent); background: var(--accent-soft); letter-spacing: 0; }
    .rels { display: grid; gap: 1px; }
    .rel { display: flex; align-items: center; gap: 9px; width: 100%; padding: 6px 8px; border: 0; border-radius: 9px; background: none;
      color: var(--text-1); font: 13px var(--sans); text-align: left; cursor: pointer; transition: background-color .15s, transform .3s var(--spring); }
    .rel:hover { background: var(--row-hover); transform: translateX(3px); }
    .rel-name { flex: 1; min-width: 0; }
    .mini { width: 22px; height: 22px; font-size: 8.5px; animation: none; box-shadow: none; }
    .mini.kind-badge { border-radius: 7px; }
    .rel .go { color: var(--accent); opacity: 0; transform: translateX(-4px); transition: opacity .2s, transform .3s var(--spring); }
    .rel:hover .go { opacity: 1; transform: none; }
    .links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .btn.small { height: 28px; padding: 0 10px; font-size: 12px; gap: 5px; }
    @media (max-width: 1100px) { .split.with-side { grid-template-columns: minmax(0, 1fr); } .side { position: static; } }
    @media (max-width: 700px) { .ghost-map { gap: 24px; } .ghost-node { width: 90px; } }
  `,
  host: { '(document:keydown.escape)': 'clear()' },
})
export class ServiceMapPage {
  private readonly api = inject(Api);
  protected readonly state = inject(AppState);
  protected readonly data = signal<ServiceMap | null>(null);
  protected readonly loading = signal(false);
  protected readonly selectedNode = signal<PlacedNode | null>(null);
  protected readonly selectedEdge = signal<PlacedEdge | null>(null);
  protected readonly hovered = signal<PlacedEdge | null>(null);
  /** Nœud survolé (ou atteint au clavier) : ses voisins sont mis en avant tant que rien n'est sélectionné. */
  protected readonly hoverNode = signal<string | null>(null);
  protected readonly w = W;
  protected readonly h = H;
  protected readonly textX = TEXT_X;
  /** Colonnes de nœuds fantômes pendant le chargement. */
  protected readonly ghostCols = [[1, 2], [1, 2, 3], [1, 2]];
  private readonly defs = viewChild<ElementRef<SVGDefsElement>>('defs');

  constructor() {
    effect(() => {
      this.state.range();
      this.state.tick();
      this.state.env();
      untracked(() => this.load());
    });
    // Icônes des dépendances (base, file, API) : symboles ajoutés une fois au <defs> de la carte.
    effect(() => {
      const defs = this.defs()?.nativeElement;
      if (defs && !defs.querySelector('symbol')) for (const name of new Set([...Object.values(KIND_ICON), 'warning'])) defs.append(iconSymbol(name));
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
        const hv = this.hovered();
        if (hv) this.hovered.set(this.layout()?.edges.find((x) => x.source === hv.source && x.target === hv.target) ?? null);
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
      list.forEach((n, i) => {
        const rate = n.requests / seconds;
        const errorRate = n.requests ? (100 * n.errors) / n.requests : 0;
        const meta = n.kind === 'service'
          ? (n.requests ? `${rateLabel(rate)} · ${pct(errorRate)} err.${n.p95Ms !== null ? ' · p95 ' + dur(n.p95Ms) : ''}` : 'aucune requête reçue')
          : `${KIND_LABEL[n.kind] ?? n.kind}${n.detail && n.detail !== n.name ? ' · ' + n.detail : ''}`;
        placed.set(n.id, {
          ...n, x: PAD + col * COL, y: offset + i * ROW, col, rate, errorRate,
          title: fit(n.name, W - TEXT_X - 12, NAME_CH), meta: fit(meta, W - TEXT_X - 12, META_CH),
          hue: hue(n.name), initials: initials(n.name),
        });
      });
    }
    function avgParentY(n: MapNode) {
      const ys = (incoming.get(n.id) ?? []).map((p) => placed.get(p)?.y).filter((y): y is number => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    }
    const maxCalls = Math.max(1, ...edges.map((e) => e.calls));
    const nodeBoxes: Box[] = [...placed.values()].map((n) => ({ x1: n.x - 4, y1: n.y - 4, x2: n.x + W + 4, y2: n.y + H + 4 }));
    const labelBoxes: Box[] = [];
    // Les liens les plus chargés choisissent leur place d'étiquette en premier.
    // 1. Tracé de chaque lien.
    const geo = [...edges].sort((a, b) => b.calls - a.calls).map((e) => {
      const a = placed.get(e.source)!;
      const b = placed.get(e.target)!;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
      const back = x2 <= x1; // appel vers une colonne précédente (cycle) : arc par-dessus
      const c = back ? 80 : Math.max(40, (x2 - x1) / 2);
      const [c1y, c2y] = back ? [y1 - 70, y2 - 70] : [y1, y2];
      const at = (t: number) => {
        const k = (p0: number, p1: number, p2: number, p3: number) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3;
        return { x: k(x1, x1 + c, x2 - c, x2), y: k(y1, c1y, c2y, y2) };
      };
      const samples = Array.from({ length: 101 }, (_, i) => at(i / 100));
      const preferred = back ? 0.5 : Math.min(0.5, (COL - W) / 2 / Math.max(1, x2 - x1));
      return { e, at, samples, preferred, path: `M${x1},${y1} C${x1 + c},${c1y} ${x2 - c},${c2y} ${x2},${y2}` };
    });

    // 2. Étiquettes : jamais sur un nœud ni sur une autre étiquette ; si possible pas sur un autre lien.
    // Les liens les plus chargés choisissent en premier ; sans place libre, l'étiquette ne s'affiche qu'au survol.
    const placedEdges: PlacedEdge[] = geo.map((g) => {
      const e = g.e;
      const rate = e.calls / seconds;
      const errorRate = e.calls ? (100 * e.errors) / e.calls : 0;
      const text = rateLabel(rate) + (e.errors ? ' · ' + pct(errorRate) : '');
      const half = (text.length * LABEL_CH) / 2 + 5;
      const box = (p: { x: number; y: number }): Box => ({ x1: p.x - half, y1: p.y - LABEL_H / 2, x2: p.x + half, y2: p.y + LABEL_H / 2 });
      const crossesOther = (bx: Box) => geo.some((o) => o !== g && o.samples.some((q) => q.x > bx.x1 && q.x < bx.x2 && q.y > bx.y1 - 1 && q.y < bx.y2 + 1));
      const candidates: { x: number; y: number; d: number }[] = [];
      for (let t = 0.04; t <= 0.96; t += 0.02) {
        const p = g.at(t);
        // Sur le lien, ou juste au-dessus / au-dessous (moins prioritaire).
        for (const dy of [0, -10, 10]) candidates.push({ x: p.x, y: p.y + dy, d: Math.abs(t - g.preferred) + (dy ? 0.15 : 0) });
      }
      candidates.sort((p, q) => p.d - q.d);
      const free = (bx: Box) => !nodeBoxes.some((n) => overlaps(n, bx)) && !labelBoxes.some((l) => overlaps(l, bx));
      const pick = candidates.find((c) => free(box(c)) && !crossesOther(box(c))) ?? candidates.find((c) => c.d < 0.3 + 0.15 && free(box(c)));
      const label = pick ? { x: pick.x, y: pick.y } : null;
      if (pick) labelBoxes.push(box(pick));
      const home = g.at(g.preferred);
      return {
        ...e, path: g.path, label, hx: home.x, hy: home.y, text, labelWidth: half * 2, rate, errorRate,
        width: 1 + 3 * Math.sqrt(e.calls / maxCalls),
      };
    });
    const width = PAD * 2 + (Math.max(0, ...[...placed.values()].map((n) => n.x)) - PAD) + W;
    return { nodes: [...placed.values()], edges: placedEdges, width: Math.max(width, 400), height };
  });

  /** Nœuds placés, par identifiant. */
  private readonly nodeMap = computed(() => new Map((this.layout()?.nodes ?? []).map((n) => [n.id, n])));

  /** Compteurs affichés sous la carte. */
  protected readonly counts = computed(() => {
    const nodes = this.layout()?.nodes ?? [];
    const services = nodes.filter((n) => n.kind === 'service').length;
    return { services, dependencies: nodes.length - services };
  });

  protected readonly callers = computed(() => {
    const n = this.selectedNode();
    return n ? (this.layout()?.edges ?? []).filter((e) => e.target === n.id) : [];
  });
  protected readonly callees = computed(() => {
    const n = this.selectedNode();
    return n ? (this.layout()?.edges ?? []).filter((e) => e.source === n.id) : [];
  });

  /** Mise en avant : nœud sélectionné (sinon survolé) et ses voisins, ou les deux bouts du lien sélectionné. */
  private readonly focus = computed<Focus | null>(() => {
    const edge = this.selectedEdge();
    const id = this.selectedNode()?.id ?? (edge ? null : this.hoverNode());
    if (!id) return edge ? { node: null, edge, nodes: new Set([edge.source, edge.target]) } : null;
    const nodes = new Set([id]);
    for (const e of this.layout()?.edges ?? []) {
      if (e.source === id) nodes.add(e.target);
      if (e.target === id) nodes.add(e.source);
    }
    return { node: id, edge: null, nodes };
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

  /** Clic dans le vide de la carte : désélectionne. */
  protected onCanvasClick(event: Event) {
    if (event.target === event.currentTarget) this.clear();
  }

  /** Lien estompé : hors de la mise en avant. */
  protected dimmed(e: PlacedEdge) {
    const f = this.focus();
    if (!f) return false;
    return f.edge ? f.edge !== e : e.source !== f.node && e.target !== f.node;
  }

  protected dimmedNode(node: PlacedNode) {
    const f = this.focus();
    return !!f && !f.nodes.has(node.id);
  }

  /** Lien en couleur d'accent : survolé, sélectionné, ou relié au nœud mis en avant. */
  protected lit(e: PlacedEdge) {
    if (this.hovered() === e || this.selectedEdge() === e) return true;
    const f = this.focus();
    return !!f?.node && (e.source === f.node || e.target === f.node);
  }

  /** Pointe de flèche assortie à la couleur du lien. */
  protected marker(e: PlacedEdge) {
    if (e.errorRate > 5) return 'url(#wl-arrow-bad)';
    return this.lit(e) ? 'url(#wl-arrow-on)' : 'url(#wl-arrow)';
  }

  protected nodeOf(id: string) {
    return this.nodeMap().get(id) ?? null;
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

  protected kindIcon(k: string) {
    return KIND_ICON[k] ?? 'globe';
  }

  protected hueOf(id: string) {
    return hue(this.nameOf(id));
  }

  protected initialsOf(name: string) {
    return initials(name);
  }

  protected rateLabel(perSecond: number) {
    return rateLabel(perSecond);
  }

  protected pct(v: number) {
    return pct(v);
  }
}
