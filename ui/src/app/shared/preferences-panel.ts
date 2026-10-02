import { Component, booleanAttribute, inject, input } from '@angular/core';
import { BRAND_PALETTE } from '../core/brand-palette';
import { Branding } from '../core/branding';
import { NavChoice, PALETTES, Preferences, ThemeChoice } from '../core/preferences';
import { NavIcon } from './nav-icon';

/** Réglages d'affichage de l'utilisateur (menu du compte et page « Mon compte ») : thème, couleurs, animations, pointeur, menu. */
@Component({
  selector: 'wl-preferences-panel',
  imports: [NavIcon],
  template: `
    <div class="prefs" [class.compact]="compact()">
      <div class="row">
        <span class="lbl"><wl-nav-icon name="theme" [size]="14" /><span>Thème</span></span>
        <div class="seg" role="radiogroup" aria-label="Thème">
          @for (t of themes; track t.value) {
            <button type="button" role="radio" [class.on]="prefs.theme() === t.value" [attr.aria-checked]="prefs.theme() === t.value"
                    (click)="prefs.setTheme(t.value, { x: $event.clientX, y: $event.clientY })" [title]="t.hint">
              <wl-nav-icon [name]="t.icon" [size]="13" />{{ t.label }}
            </button>
          }
        </div>
      </div>
      <div class="row">
        <span class="lbl"><wl-nav-icon name="sparkles" [size]="14" /><span>Couleurs</span></span>
        <div class="swatches" role="radiogroup" aria-label="Couleurs de l'interface">
          @if (branding.swatch(); as preview) {
            <button type="button" role="radio" class="swatch" [class.on]="prefs.palette() === brand" [attr.aria-checked]="prefs.palette() === brand"
                    [style.background]="preview" [title]="'Entreprise' + (branding.name() ? '  ' + branding.name() : '')" aria-label="Couleurs de l'entreprise" (click)="prefs.setPalette(brand)"></button>
          }
          @if (!branding.forcePalette()) {
            @for (p of palettes; track p.id) {
              <button type="button" role="radio" class="swatch" [class.on]="prefs.palette() === p.id" [attr.aria-checked]="prefs.palette() === p.id"
                      [style.background]="p.preview" [title]="p.label" [attr.aria-label]="'Couleurs ' + p.label" (click)="prefs.setPalette(p.id)"></button>
            }
          } @else {
            <span class="forced">couleurs de l'entreprise</span>
          }
        </div>
      </div>
      <label class="row toggle">
        <span class="lbl"><wl-nav-icon name="play" [size]="14" /><span>Animations<small>Transitions et effets de l'interface</small></span></span>
        <input type="checkbox" class="switch" [checked]="prefs.motion()" (change)="prefs.setMotion($any($event.target).checked)" />
      </label>
      <label class="row toggle">
        <span class="lbl"><wl-nav-icon name="cursor" [size]="14" /><span>Lueur du pointeur<small>Halo discret qui suit la souris</small></span></span>
        <input type="checkbox" class="switch" [checked]="prefs.glow()" (change)="prefs.setGlow($any($event.target).checked)" />
      </label>
      <div class="row">
        <span class="lbl"><wl-nav-icon name="sidebar" [size]="14" /><span>Menu</span></span>
        <div class="seg" role="radiogroup" aria-label="Menu de navigation">
          @for (n of navs; track n.value) {
            <button type="button" role="radio" [class.on]="prefs.nav() === n.value" [attr.aria-checked]="prefs.nav() === n.value"
                    (click)="prefs.setNav(n.value)" [title]="n.hint">{{ n.label }}</button>
          }
        </div>
      </div>
      @if (!compact()) {
        <p class="note"><wl-nav-icon name="info" [size]="13" />Ces réglages sont propres à ce navigateur.</p>
      }
    </div>
  `,
  styles: `
    .prefs { display: grid; gap: 4px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; min-height: 40px; padding: 4px 0; }
    .row + .row { border-top: 1px solid var(--border-soft); }
    .lbl { display: inline-flex; align-items: center; gap: 9px; min-width: 0; font-size: 13px; color: var(--text-1); }
    .lbl > wl-nav-icon { flex: none; color: var(--accent); }
    .lbl small { display: block; font-size: 11.5px; color: var(--text-3); }
    .toggle { cursor: pointer; }
    .toggle .switch { flex: none; }
    .seg button { display: inline-flex; align-items: center; gap: 5px; }
    .compact .seg button { padding: 0 9px; }
    .swatches { display: flex; align-items: center; gap: 8px; }
    .forced { font-size: 11.5px; color: var(--text-3); }
    .swatch { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      box-shadow: 0 0 0 1px var(--border), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .3s var(--spring), box-shadow .2s; }
    .swatch:hover { transform: scale(1.12); }
    .swatch.on { box-shadow: 0 0 0 2px var(--surface-solid), 0 0 0 4px var(--accent); }
    .note { display: flex; align-items: center; gap: 7px; margin: 6px 0 0; font-size: 12px; color: var(--text-3); }
  `,
})
export class PreferencesPanel {
  protected readonly prefs = inject(Preferences);
  protected readonly branding = inject(Branding);
  protected readonly brand = BRAND_PALETTE;
  /** Version resserrée (menu du compte) : sans la note de bas de panneau. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly palettes = PALETTES;
  protected readonly themes: { value: ThemeChoice; label: string; icon: string; hint: string }[] = [
    { value: 'light', label: 'Clair', icon: 'sun', hint: 'Thème clair' },
    { value: 'dark', label: 'Sombre', icon: 'theme', hint: 'Thème sombre' },
    { value: 'system', label: 'Système', icon: 'system', hint: 'Suit le réglage clair / sombre du système' },
  ];
  protected readonly navs: { value: NavChoice; label: string; hint: string }[] = [
    { value: 'auto', label: 'Auto', hint: 'Réduit aux icônes sur les écrans moyens' },
    { value: 'on', label: 'Réduit', hint: 'Toujours réduit aux icônes' },
    { value: 'off', label: 'Complet', hint: 'Toujours avec les libellés' },
  ];
}
