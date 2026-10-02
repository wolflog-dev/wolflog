import { Component, computed, input } from '@angular/core';
import { BrandPalette, Theme, paletteVars } from '../core/brand-palette';
import { Logo } from './logo';
import { NavIcon } from './nav-icon';

const LINKS = [
  { icon: 'overview', label: "Vue d'ensemble" },
  { icon: 'logs', label: 'Logs' },
  { icon: 'traces', label: 'Traces' },
  { icon: 'alerts', label: 'Alertes' },
];
const BARS = [0.42, 0.58, 0.46, 0.72, 0.6, 0.88, 0.66, 1, 0.78];

/**
 * Maquette aux couleurs d'une palette, indépendante de l'apparence de la page (page Personnalisation) : l'interface
 * (menu, boutons, carte), la page de connexion, ou le logo seul sur le fond du thème. Les variables des thèmes de
 * styles.scss y sont recalculées à partir de la palette donnée.
 *   <wl-brand-mock [palette]="p" theme="light" kind="login" [logo]="url" name="Acme" message="Bienvenue" />
 */
@Component({
  selector: 'wl-brand-mock',
  imports: [Logo, NavIcon],
  host: { '[class]': "kind() + ' ' + theme()", '[style]': 'vars()', 'aria-hidden': 'true' },
  template: `
    @switch (kind()) {
      @case ('logo') {
        @if (logo(); as src) { <img class="alone" [src]="src" alt="" /> }
        <span class="caption">{{ theme() === 'dark' ? 'Fond sombre' : 'Fond clair' }}</span>
      }
      @case ('login') {
        <div class="l-card glassy">
          <div class="l-brand" [class.company]="branded()">
            @if (logo(); as src) { <img class="l-img" [src]="src" alt="" /> } @else { <span class="m-logo l-tile"><wl-logo [size]="17" /></span> }
            <span class="l-titles">
              @if (branded()) {
                @if (name()) { <strong class="l-name">{{ name() }}</strong> }
                <span class="l-sub"><wl-logo [size]="9" />propulsé par Wolflog</span>
              } @else {
                <strong class="l-name mono">wolflog</strong><span class="l-sub">Logs, traces, métriques et audience</span>
              }
            </span>
          </div>
          @if (message()) { <p class="l-welcome">{{ message() }}</p> }
          <i class="l-field"></i><i class="l-field"></i>
          <span class="m-btn primary l-btn">Se connecter</span>
        </div>
      }
      @default {
        <div class="m-nav glassy">
          <div class="m-brand">
            <span class="m-logo" [class.img]="!!logo()">@if (logo(); as src) { <img [src]="src" alt="" /> } @else { <wl-logo [size]="11" /> }</span>
            <span class="m-t">{{ name() || 'wolflog' }}</span>
          </div>
          @for (l of links; track l.label; let first = $first) {
            <span class="m-link" [class.on]="first"><wl-nav-icon [name]="l.icon" [size]="10" /><span class="m-t">{{ l.label }}</span></span>
          }
        </div>
        <div class="m-main">
          <div class="m-head glassy"><span class="m-title">Vue d'ensemble</span><span class="m-btn">Filtrer</span><span class="m-btn primary">Nouveau</span></div>
          <div class="m-card glassy">
            <div class="m-row"><span class="m-label">Requêtes</span><span class="m-chip">+12 %</span></div>
            <strong class="m-value">12 480</strong>
            <div class="m-bars">@for (h of bars; track $index) { <i [style.--h]="h" [style.--i]="$index"></i> }</div>
            <div class="m-row"><span class="m-a">Voir les traces →</span><i class="m-switch"></i></div>
          </div>
        </div>
      }
    }
  `,
  styles: `
    /* Formules des thèmes de styles.scss, appliquées à la palette donnée (variables en ligne : --h1…--sa). */
    :host { position: relative; isolation: isolate; display: block; min-width: 0; overflow: hidden; border-radius: 14px; color: var(--text-1);
      background: var(--bg); box-shadow: 0 16px 34px -22px rgb(0 0 0 / .7), inset 0 0 0 1px var(--border);
      --bg: hsl(var(--h1) calc(var(--s) * .55) 5%); --aurora-1: hsl(var(--h1) var(--s) 46%); --aurora-2: hsl(var(--h2) var(--s) 42%);
      --aurora-3: hsl(var(--h3) var(--s) 36%); --aurora-4: hsl(var(--h4) var(--s) 48%); --glass-tint: hsl(var(--h1) calc(var(--s) * .4) 11% / .42);
      --sheen: rgb(255 255 255 / .09); --surface-2: rgb(255 255 255 / .06); --border: rgb(255 255 255 / .13); --highlight: rgb(255 255 255 / .15);
      --text-1: hsl(var(--h1) calc(var(--s) * .3) 96%); --text-2: hsl(var(--h1) calc(var(--s) * .2) 80%); --text-3: hsl(var(--h1) calc(var(--s) * .15) 62%);
      --accent: hsl(var(--ha) var(--sa) 66%); --accent-2: hsl(var(--ha2) var(--sa) 64%); --accent-3: hsl(var(--ha3) var(--sa) 58%);
      --accent-soft: hsl(var(--ha) var(--sa) 66% / .16); --on-accent: hsl(var(--h1) 70% 7%); }
    :host(.light) {
      --bg: hsl(var(--h1) calc(var(--s) * .7) 97%); --aurora-1: hsl(var(--h1) var(--s) 76%); --aurora-2: hsl(var(--h2) var(--s) 74%);
      --aurora-3: hsl(var(--h3) var(--s) 70%); --aurora-4: hsl(var(--h4) var(--s) 80%); --glass-tint: rgb(255 255 255 / .46);
      --sheen: rgb(255 255 255 / .5); --surface-2: rgb(255 255 255 / .55); --border: hsl(var(--h1) 40% 30% / .14); --highlight: rgb(255 255 255 / .9);
      --text-1: hsl(var(--h1) calc(var(--s) * .5) 12%); --text-2: hsl(var(--h1) calc(var(--s) * .25) 32%); --text-3: hsl(var(--h1) calc(var(--s) * .18) 50%);
      --accent: hsl(var(--ha) var(--sa) 40%); --accent-2: hsl(var(--ha2) var(--sa) 46%); --accent-3: hsl(var(--ha3) var(--sa) 36%);
      --accent-soft: hsl(var(--ha) var(--sa) 40% / .12); --on-accent: #fff; }
    /* Aurore du fond : halos fixes (sans animation). */
    :host(.app)::before, :host(.login)::before { content: ''; position: absolute; inset: 0; z-index: -1; opacity: .8;
      background: radial-gradient(60% 60% at 0 0, var(--aurora-1), transparent 70%), radial-gradient(55% 55% at 100% 0, var(--aurora-2), transparent 70%),
        radial-gradient(60% 60% at 100% 100%, var(--aurora-3), transparent 70%), radial-gradient(50% 55% at 0 100%, var(--aurora-4), transparent 70%); }
    .glassy { border: 1px solid var(--border); background: linear-gradient(135deg, var(--sheen), transparent 60%), var(--glass-tint); box-shadow: inset 0 1px 0 var(--highlight); }

    /* Logo seul : hauteur fixe, largeur tirée des proportions (un SVG sans dimensions ne s'écrase pas), jamais agrandi. */
    :host(.logo) { display: grid; place-items: center; height: 112px; padding: 14px 14px 24px; border-radius: var(--radius-sm); box-shadow: inset 0 0 0 1px var(--border); }
    .alone { height: 62px; width: auto; max-width: 100%; object-fit: scale-down; animation: pop .5s var(--spring); }
    .caption { position: absolute; left: 10px; bottom: 6px; font-size: 11px; color: var(--text-3); }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.96); } }

    /* Interface : menu, barre de titre avec boutons, carte avec graphique, lien et interrupteur. */
    :host(.app) { display: grid; grid-template-columns: 34% minmax(0, 1fr); gap: 8px; height: 200px; padding: 8px; font: 10px/1.35 var(--sans); }
    .m-nav { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px 6px; border-radius: 10px; }
    .m-brand { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 0 3px 7px; font: 700 10.5px var(--sans); }
    .m-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .m-logo { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 6px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 4px 10px -4px var(--accent); }
    .m-logo ::ng-deep path { fill: #fff; }
    .m-logo.img { width: auto; background: none; box-shadow: none; }
    .m-logo img { display: block; height: 18px; width: auto; max-width: 46px; object-fit: contain; }
    .m-link { position: relative; display: flex; align-items: center; gap: 5px; min-width: 0; padding: 4px 6px; border-radius: 6px; color: var(--text-2); }
    .m-link wl-nav-icon { flex: none; color: var(--text-3); }
    .m-link.on { color: var(--text-1); background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 26%, transparent), color-mix(in srgb, var(--accent-2) 8%, transparent)); }
    .m-link.on wl-nav-icon { color: var(--accent); }
    .m-link.on::before { content: ''; position: absolute; left: -6px; top: 4px; bottom: 4px; width: 2px; border-radius: 0 2px 2px 0;
      background: linear-gradient(var(--accent), var(--accent-3)); }
    .m-main { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 8px; min-width: 0; }
    .m-head { display: flex; align-items: center; gap: 5px; min-width: 0; padding: 5px 6px 5px 9px; border-radius: 10px; }
    .m-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 700;
      background: linear-gradient(90deg, var(--text-1) 15%, color-mix(in srgb, var(--accent) 80%, var(--text-1))); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .m-btn { flex: none; padding: 3px 7px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); font-size: 9.5px; font-weight: 600;
      box-shadow: inset 0 1px 0 var(--highlight); }
    .m-btn.primary { border-color: rgb(255 255 255 / .2); color: var(--on-accent); background: linear-gradient(120deg, var(--accent), var(--accent-2));
      box-shadow: 0 6px 14px -8px var(--accent), inset 0 1px 0 rgb(255 255 255 / .35); }
    .m-card { display: grid; align-content: start; gap: 4px; min-width: 0; padding: 8px 10px; border-radius: 10px; }
    .m-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .m-label { color: var(--text-3); font-size: 9.5px; }
    .m-chip { display: inline-block; padding: 1px 6px; border-radius: 999px; font: 700 8.5px/12px var(--mono); white-space: nowrap; color: var(--accent); background: var(--accent-soft); }
    .m-value { font-size: 17px; letter-spacing: -.02em; }
    .m-bars { display: flex; align-items: flex-end; gap: 3px; height: 34px; }
    .m-bars i { flex: 1; height: 100%; border-radius: 3px 3px 1px 1px; background: linear-gradient(var(--accent), var(--accent-2)); opacity: .9;
      transform-origin: bottom; transform: scaleY(var(--h)); animation: grow .7s var(--ease) backwards; animation-delay: calc(var(--i) * 40ms + 150ms); }
    @keyframes grow { from { transform: scaleY(0); } }
    .m-a { color: var(--accent); font-size: 9.5px; font-weight: 600; }
    .m-switch { position: relative; width: 22px; height: 12px; border-radius: 999px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .m-switch::after { content: ''; position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / .3); }

    /* Page de connexion : en-tête (logo, nom, « propulsé par Wolflog »), message d'accueil, champs et bouton. */
    :host(.login) { display: grid; place-items: center; padding: 20px 14px; }
    .l-card { display: grid; gap: 8px; width: min(240px, 100%); padding: 14px 14px 12px; border-radius: 14px; font: 10px/1.4 var(--sans); }
    .l-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .l-brand.company { flex-direction: column; gap: 5px; text-align: center; }
    .l-img { display: block; height: 32px; width: auto; max-width: 140px; object-fit: scale-down; }
    .l-tile { width: 30px; height: 30px; border-radius: 10px; }
    .l-titles { display: grid; gap: 1px; min-width: 0; justify-items: start; }
    .company .l-titles { justify-items: center; }
    .l-name { max-width: 100%; font: 700 13px/1.2 var(--sans); overflow-wrap: anywhere;
      background: linear-gradient(90deg, var(--text-1) 20%, color-mix(in srgb, var(--accent) 85%, var(--text-1))); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .l-name.mono { font-family: var(--mono); letter-spacing: -.03em; }
    .l-sub { display: inline-flex; align-items: center; gap: 4px; font-size: 8.5px; color: var(--text-3); }
    .l-welcome { margin: 0; max-height: 7.4em; overflow: hidden; padding: 6px 8px; border-radius: 8px; font-size: 9px; line-height: 1.45; color: var(--text-2);
      text-align: center; white-space: pre-line; overflow-wrap: anywhere;
      background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); }
    .l-field { display: block; height: 18px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); }
    .l-btn { padding: 5px; text-align: center; }
  `,
})
export class BrandMock {
  readonly palette = input.required<BrandPalette>();
  readonly theme = input<Theme>('dark');
  /** app : menu, boutons et carte ; login : page de connexion ; logo : le logo seul sur le fond du thème. */
  readonly kind = input<'app' | 'login' | 'logo'>('app');
  readonly logo = input<string | null>(null);
  readonly name = input('');
  readonly message = input('');
  protected readonly links = LINKS;
  protected readonly bars = BARS;
  protected readonly vars = computed(() => paletteVars(this.palette(), this.theme()));
  protected readonly branded = computed(() => !!this.name() || !!this.logo());
}
