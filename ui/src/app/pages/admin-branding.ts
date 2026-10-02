import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api } from '../core/api';
import { OCEAN, Theme, accentColors, brandPalette, normalizeHex } from '../core/brand-palette';
import { Branding } from '../core/branding';
import { formatBytes } from '../core/format';
import { BrandingInput, BrandingSettings } from '../core/models';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { Toasts } from '../core/toasts';
import { BrandMock } from '../shared/brand-mock';
import { NavIcon } from '../shared/nav-icon';
import { Skeleton } from '../shared/skeleton';

/** Couleurs proposées ; toute autre se choisit au nuancier ou par son code. */
const PRESETS = [
  { label: 'Bleu', hex: '#2563eb' },
  { label: 'Bleu nuit', hex: '#1e3a8a' },
  { label: 'Cyan', hex: '#0891b2' },
  { label: 'Sarcelle', hex: '#0d9488' },
  { label: 'Vert', hex: '#16a34a' },
  { label: 'Ambre', hex: '#d97706' },
  { label: 'Orange', hex: '#ea580c' },
  { label: 'Rouge', hex: '#dc2626' },
  { label: 'Ardoise', hex: '#475569' },
];

/** Logos acceptés (le serveur vérifie aussi le contenu du fichier). */
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const LOGO_MAX = 1024 * 1024;

/** Thème affiché : attribut data-theme (bouton du menu), sinon réglage du système. */
function currentTheme(): Theme {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'light' || theme === 'dark' ? theme : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * Personnalisation : nom, logo et couleur de l'entreprise, message de la page de connexion. Les maquettes (interface,
 * page de connexion, logo sur les deux fonds) montrent la palette calculée dans les deux thèmes ; rien ne change dans
 * l'interface avant l'enregistrement.
 */
@Component({
  selector: 'wl-admin-branding',
  imports: [FormsModule, AgoPipe, BrandMock, NavIcon, Skeleton],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <h1>Personnalisation</h1>
        <span class="muted small sub">Nom, logo et couleurs de l'entreprise</span>
        <span class="spacer"></span>
        @if (dirty()) {
          <span class="unsaved small" animate.enter="pop" animate.leave="fade-out"><wl-nav-icon name="edit" [size]="13" />Non enregistré</span>
        }
        <button class="btn" (click)="reset()" [disabled]="!dirty() || busy()">Annuler</button>
        <button class="btn primary" (click)="save()" [disabled]="!canSave()">
          <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
        </button>
      </div>

      @if (saved()) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step" [class.done]="!!name().trim()">
              <div class="step-head"><span class="num">1</span><h2>Nom de l'entreprise</h2><span class="hint">à la place de « Wolflog » : menu, onglets, page de connexion</span></div>
              <div class="step-body">
                <label class="field">Nom
                  <span class="control"><wl-nav-icon name="building" [size]="14" />
                    <input [ngModel]="name()" (ngModelChange)="name.set($event)" maxlength="60" placeholder="ex. Acme Industries" autocomplete="organization" /></span>
                  <span class="muted small">Vide : Wolflog garde son nom.</span></label>
              </div>
            </section>

            <section class="panel step" [class.done]="!!logo()">
              <div class="step-head"><span class="num">2</span><h2>Logo</h2><span class="hint">PNG, JPEG, WebP ou SVG · 1 Mo au plus · fond transparent conseillé</span></div>
              <div class="step-body">
                <label class="drop" #drop [class.over]="dragging()">
                  <input type="file" [accept]="accept" (change)="pick($event)" aria-label="Choisir le logo" />
                  <span class="drop-icon"><wl-nav-icon name="upload" [size]="20" /></span>
                  <span class="drop-text">
                    <strong>{{ dragging() ? 'Déposez le fichier' : logo() ? 'Remplacer le logo' : 'Glissez votre logo ici' }}</strong>
                    <span class="muted small">ou <u>choisissez un fichier</u></span>
                  </span>
                </label>
                @if (logo(); as src) {
                  <div class="logo-view" animate.enter="pop">
                    <div class="logo-bgs">
                      @for (t of themes; track t) { <wl-brand-mock kind="logo" [theme]="t" [palette]="palette()" [logo]="src" /> }
                    </div>
                    <div class="logo-meta small">
                      <wl-nav-icon name="image" [size]="14" /><span class="ellipsis">{{ logoLabel() }}</span>
                      @if (pending()) { <span class="badge-new">à enregistrer</span> }
                      <span class="spacer"></span>
                      <button type="button" class="btn small danger" (click)="dropLogo()"><wl-nav-icon name="trash" [size]="13" />Retirer</button>
                    </div>
                  </div>
                } @else if (removing()) {
                  <p class="removed small" animate.enter="pop"><wl-nav-icon name="info" [size]="14" />Le logo sera retiré à l'enregistrement.
                    <button type="button" class="btn ghost small" (click)="removing.set(false)">Le garder</button></p>
                }
              </div>
            </section>

            <section class="panel step" [class.done]="!!color()">
              <div class="step-head"><span class="num">3</span><h2>Couleurs</h2><span class="hint">une palette « Entreprise » en est tirée, lisible en thème clair comme sombre</span></div>
              <div class="step-body">
                <div class="color-row">
                  <label class="picker" [class.empty]="!color()" [style.--c]="color()" title="Nuancier">
                    <input type="color" [value]="color() ?? '#2563eb'" (input)="setColor($any($event.target).value)" aria-label="Couleur de l'entreprise" />
                  </label>
                  <label class="field hex">Code
                    <span class="control"><wl-nav-icon name="hash" [size]="14" />
                      <input class="mono" [class.bad]="hexInvalid()" [ngModel]="hex()" (ngModelChange)="typeHex($event)" (blur)="settleHex()"
                             maxlength="7" placeholder="#0A66C2" spellcheck="false" autocomplete="off" /></span></label>
                  <div class="presets" role="group" aria-label="Couleurs proposées">
                    @for (p of presets; track p.hex) {
                      <button type="button" class="preset" [class.on]="color() === p.hex" [style.--c]="p.hex" (click)="setColor(p.hex)"
                              [title]="p.label" [attr.aria-label]="p.label" [attr.aria-pressed]="color() === p.hex"></button>
                    }
                    <button type="button" class="preset none" [class.on]="!color()" (click)="setColor(null)" title="Aucune : palettes de Wolflog"
                            aria-label="Aucune couleur d'entreprise" [attr.aria-pressed]="!color()"><wl-nav-icon name="close" [size]="11" /></button>
                  </div>
                </div>
                @if (hexError()) {
                  <p class="bad-hex small" animate.enter="pop"><wl-nav-icon name="warning" [size]="13" />Code attendu : # suivi de 3 ou 6 chiffres hexadécimaux, ex. #0A66C2.</p>
                }

                <div class="mocks">
                  @for (t of themes; track t) {
                    <figure class="mock-frame">
                      <figcaption class="small"><wl-nav-icon [name]="t === 'dark' ? 'theme' : 'sun'" [size]="13" />{{ t === 'dark' ? 'Thème sombre' : 'Thème clair' }}</figcaption>
                      <wl-brand-mock [theme]="t" [palette]="palette()" [logo]="logo()" [name]="name().trim()" />
                    </figure>
                  }
                </div>

                <label class="check force" [class.off]="!color()">
                  <input type="checkbox" class="switch" [checked]="force()" (change)="force.set($any($event.target).checked)" [disabled]="!color()" />
                  <span class="force-text"><strong>Imposer les couleurs de l'entreprise</strong><span class="muted small">{{ forceHint() }}</span></span>
                </label>
              </div>
            </section>

            <section class="panel step" [class.done]="!!message().trim()">
              <div class="step-head"><span class="num">4</span><h2>Page de connexion</h2><span class="hint">message d'accueil, sous le logo</span></div>
              <div class="step-body">
                <label class="field">Message d'accueil
                  <textarea rows="3" maxlength="500" [ngModel]="message()" (ngModelChange)="message.set($event)"
                            placeholder="ex. Bienvenue sur la supervision d'Acme. Un accès ? support@acme.fr"></textarea>
                  <span class="count small" [class.near]="message().length > 450">{{ message().length }} / 500</span></label>
              </div>
            </section>
          </div>

          <aside class="panel summary">
            <div class="block">
              <h3>Page de connexion</h3>
              <wl-brand-mock kind="login" [theme]="theme()" [palette]="palette()" [logo]="logo()" [name]="name().trim()" [message]="message().trim()" />
            </div>
            <div class="block">
              <h3>Palette</h3>
              @for (row of tones(); track row.theme) {
                <div class="tones small"><span class="muted">{{ row.label }}</span>
                  @for (c of row.colors; track $index) { <i [style.background]="c"></i> }</div>
              }
              <p class="muted small">{{ paletteNote() }}</p>
            </div>
            @if (saved()?.updatedAt; as at) {
              <div class="block muted small">Modifiée {{ at | ago }}@if (saved()?.updatedBy; as by) { par {{ by }}}.</div>
            }
            @if (error()) {
              <div class="block"><span class="error small" role="alert" animate.enter="pop"><wl-nav-icon name="warning" [size]="13" />{{ error() }}</span></div>
            }
            <div class="actions">
              <button class="btn primary" (click)="save()" [disabled]="!canSave()">
                <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
              <button class="btn" (click)="reset()" [disabled]="!dirty() || busy()">Annuler</button>
            </div>
          </aside>
        </div>
      } @else if (loadError()) {
        <div class="panel empty">Impossible de lire la personnalisation.<div><button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button></div></div>
      } @else {
        <section class="panel"><wl-skeleton [rows]="6" /></section>
      }
    </div>
  `,
  styles: `
    .step-head { flex-wrap: wrap; row-gap: 2px; }
    .unsaved { display: inline-flex; align-items: center; gap: 6px; color: var(--warn); font-weight: 550; }
    .control { position: relative; display: block; }
    .control input { width: 100%; padding-left: 32px; }
    .control wl-nav-icon { position: absolute; left: 11px; top: 0; bottom: 0; margin: auto 0; height: 14px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within wl-nav-icon { color: var(--accent); transform: translateY(-1px) scale(1.12); }
    p { margin: 0; }

    /* Dépôt du logo : tout le cadre ouvre le sélecteur de fichiers (champ transparent par-dessus). */
    .drop { position: relative; display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-radius: var(--radius-sm); cursor: pointer;
      border: 1.5px dashed color-mix(in srgb, var(--accent) 38%, var(--border)); background: color-mix(in srgb, var(--accent) 5%, transparent);
      transition: border-color .25s, background-color .25s, transform .35s var(--spring); }
    .drop input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .drop:hover { border-color: var(--accent); background-color: color-mix(in srgb, var(--accent) 9%, transparent); }
    .drop:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
    .drop.over { border-style: solid; border-color: var(--accent); background-color: var(--accent-soft); transform: scale(1.01); }
    .drop-icon { flex: none; display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 10px 22px -10px var(--accent); transition: transform .45s var(--spring); }
    .drop:hover .drop-icon { transform: translateY(-2px) rotate(-6deg); }
    .drop.over .drop-icon { transform: translateY(-3px) scale(1.08); }
    .drop-text { display: grid; gap: 1px; min-width: 0; }
    .drop-text u { color: var(--accent); text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent); text-underline-offset: 3px; }
    .logo-view { display: grid; gap: 10px; }
    .logo-bgs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .logo-meta { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--text-2); }
    .logo-meta > wl-nav-icon { flex: none; color: var(--accent); }
    .badge-new { flex: none; display: inline-block; padding: 1px 8px; border-radius: 999px; font: 600 11px/16px var(--sans); white-space: nowrap;
      color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
    .removed { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--text-2); }

    /* Couleur : nuancier (champ couleur transparent sur la pastille), code, couleurs proposées. */
    .color-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px 16px; }
    .picker { position: relative; flex: none; width: 52px; height: 52px; border-radius: 16px; cursor: pointer; background: var(--c);
      box-shadow: 0 10px 24px -12px var(--c), inset 0 0 0 1px rgb(255 255 255 / .22), inset 0 1px 0 rgb(255 255 255 / .35); transition: transform .4s var(--spring); }
    .picker.empty { background: conic-gradient(from 200deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #3b82f6, #ef4444); }
    .picker:hover { transform: scale(1.06) rotate(-4deg); }
    .picker:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 3px; }
    .picker input { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; opacity: 0; cursor: pointer; }
    .hex { width: 150px; }
    .hex input.bad { border-color: var(--danger); }
    .bad-hex { display: flex; align-items: center; gap: 6px; color: var(--danger); }
    .presets { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding-bottom: 5px; }
    .preset { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; cursor: pointer; background: var(--c);
      color: var(--text-2); box-shadow: inset 0 0 0 1px rgb(255 255 255 / .22), inset 0 1px 0 rgb(255 255 255 / .3); transition: transform .3s var(--spring), box-shadow .2s; }
    .preset:hover { transform: scale(1.18); }
    .preset:active { transform: scale(.9); }
    .preset.on { box-shadow: 0 0 0 2px var(--surface-solid), 0 0 0 4px var(--c); }
    .preset.none { --c: var(--surface-3); }
    .preset.none.on { box-shadow: 0 0 0 2px var(--surface-solid), 0 0 0 4px var(--text-3); }
    .mocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(250px, 100%), 1fr)); gap: 14px; min-width: 0; }
    .mock-frame { display: grid; gap: 6px; min-width: 0; margin: 0; }
    .mock-frame figcaption { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); }
    .force { display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft);
      background: var(--surface-2); white-space: normal; transition: border-color .2s, opacity .2s; }
    .force:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .force.off { opacity: .6; cursor: default; }
    .force input { margin-top: 1px; }
    .force-text { display: grid; gap: 2px; color: var(--text-1); }
    textarea { width: 100%; height: auto; min-height: 78px; padding: 9px 11px; line-height: 1.5; resize: vertical; }
    .count { justify-self: end; color: var(--text-3); font-variant-numeric: tabular-nums; transition: color .2s; }
    .count.near { color: var(--warn); }

    .tones { display: flex; align-items: center; gap: 6px; }
    .tones span { width: 44px; }
    .tones i { width: 20px; height: 20px; border-radius: 7px; box-shadow: inset 0 0 0 1px rgb(255 255 255 / .2); animation: pop .45s var(--spring) backwards; }
    .error { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--danger); }
    .error wl-nav-icon { flex: none; margin-top: 2px; }
    .empty > div { margin-top: 12px; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pop { animation: pop .4s var(--spring); }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.96); } }
    .fade-out { animation: fade-out .2s ease-in forwards; }
    @keyframes fade-out { to { opacity: 0; } }
    @media (max-width: 640px) { .sub { display: none; } .drop { padding: 14px; } }
  `,
})
export class AdminBrandingPage {
  private readonly api = inject(Api);
  private readonly branding = inject(Branding);
  private readonly toasts = inject(Toasts);
  protected readonly presets = PRESETS;
  protected readonly themes = ['dark', 'light'] as const;
  protected readonly accept = [...LOGO_TYPES, '.svg'].join(',');

  /** Personnalisation enregistrée (null : chargement). */
  protected readonly saved = signal<BrandingSettings | null>(null);
  protected readonly loadError = signal(false);
  protected readonly name = signal('');
  protected readonly color = signal<string | null>(null);
  /** Texte du code couleur, éventuellement en cours de saisie. */
  protected readonly hex = signal('');
  /** Code couleur invalide signalé (à la sortie du champ). */
  protected readonly hexError = signal(false);
  protected readonly message = signal('');
  protected readonly force = signal(false);
  /** Logo choisi, envoyé à l'enregistrement ; aperçu par une adresse locale. */
  protected readonly pending = signal<{ file: File; url: string } | null>(null);
  /** Retrait du logo enregistré demandé. */
  protected readonly removing = signal(false);
  protected readonly dragging = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Thème de l'interface, pour l'aperçu de la page de connexion. */
  protected readonly theme = signal<Theme>(currentTheme());
  private readonly drop = viewChild<ElementRef<HTMLElement>>('drop');

  /** Palette en cours de saisie (sans couleur : Océan, la palette par défaut). */
  protected readonly palette = computed(() => brandPalette(this.color()) ?? OCEAN);
  protected readonly tones = computed(() => [
    { theme: 'dark', label: 'Sombre', colors: accentColors(this.palette(), 'dark') },
    { theme: 'light', label: 'Clair', colors: accentColors(this.palette(), 'light') },
  ]);
  /** Logo affiché : celui choisi, sinon celui enregistré (sauf retrait demandé). */
  protected readonly logo = computed(() => this.pending()?.url ?? (this.removing() ? null : (this.saved()?.logoUrl ?? null)));
  protected readonly hexInvalid = computed(() => !!this.hex().trim() && !normalizeHex(this.hex()));

  protected readonly logoLabel = computed(() => {
    const p = this.pending();
    if (p) return `${p.file.name} · ${formatBytes(p.file.size)}`;
    const s = this.saved();
    return s?.logoFileName ? `${s.logoFileName} · ${formatBytes(s.logoSize)}` : 'Logo enregistré';
  });

  protected readonly forceHint = computed(() =>
    !this.color()
      ? "Choisissez d'abord une couleur."
      : this.force()
        ? 'Tout le monde voit ces couleurs ; le choix de palette du menu est désactivé.'
        : 'Proposées par défaut : chacun peut choisir une autre palette dans le menu.');

  /** Saturation retenue par thème, quand elle a dû être adoucie pour garder liens et boutons lisibles. */
  protected readonly paletteNote = computed(() => {
    if (!this.color()) return "Sans couleur d'entreprise : palettes de Wolflog, Océan par défaut.";
    const p = this.palette();
    const softened = [p.saDark < p.sa ? `${p.saDark} % en thème sombre` : '', p.saLight < p.sa ? `${p.saLight} % en thème clair` : ''].filter(Boolean);
    return softened.length
      ? `Saturation adoucie pour garder liens et boutons lisibles : ${softened.join(', ')} (couleur : ${p.sa} %).`
      : 'Accents lisibles dans les deux thèmes, sans retouche.';
  });

  protected readonly dirty = computed(() => {
    const s = this.saved();
    if (!s) return false;
    const f = this.formValue();
    return f.name !== s.name || f.color !== s.color || f.loginMessage !== s.loginMessage || f.forcePalette !== s.forcePalette
      || !!this.pending() || (this.removing() && s.hasLogo);
  });
  protected readonly canSave = computed(() => this.dirty() && !this.busy() && !this.hexInvalid());

  constructor() {
    this.load();
    // Thème changé (bouton du menu ou réglage du système) : l'aperçu de la connexion suit.
    const media = matchMedia('(prefers-color-scheme: light)');
    const sync = () => this.theme.set(currentTheme());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    media.addEventListener('change', sync);
    inject(DestroyRef).onDestroy(() => {
      observer.disconnect();
      media.removeEventListener('change', sync);
      this.release();
    });

    // Glisser-déposer : écouteurs DOM directs (dragover se répète sans cesse : pas de détection de changements à chaque fois).
    // Un fichier lâché à côté du cadre n'ouvre pas l'image à la place de l'application.
    effect((cleanup) => {
      const zone = this.drop()?.nativeElement;
      if (!zone) return;
      const files = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
      const over = (e: DragEvent) => {
        if (!files(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        if (!this.dragging()) this.dragging.set(true);
      };
      const leave = (e: DragEvent) => {
        if (!zone.contains(e.relatedTarget as Node | null)) this.dragging.set(false);
      };
      const dropped = (e: DragEvent) => {
        e.preventDefault();
        this.dragging.set(false);
        const file = e.dataTransfer?.files[0];
        if (file) this.stage(file);
      };
      const elsewhere = (e: DragEvent) => {
        if (!files(e) || zone.contains(e.target as Node | null)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'none';
      };
      zone.addEventListener('dragover', over);
      zone.addEventListener('dragleave', leave);
      zone.addEventListener('drop', dropped);
      window.addEventListener('dragover', elsewhere);
      window.addEventListener('drop', elsewhere);
      cleanup(() => {
        zone.removeEventListener('dragover', over);
        zone.removeEventListener('dragleave', leave);
        zone.removeEventListener('drop', dropped);
        window.removeEventListener('dragover', elsewhere);
        window.removeEventListener('drop', elsewhere);
      });
    });
  }

  protected load() {
    this.loadError.set(false);
    this.api.brandingSettings().subscribe({
      next: (s) => {
        this.saved.set(s);
        this.reset();
      },
      error: () => this.loadError.set(true),
    });
  }

  /** Saisie ramenée à la personnalisation enregistrée. */
  protected reset() {
    const s = this.saved();
    if (!s) return;
    this.name.set(s.name ?? '');
    this.setColor(s.color);
    this.force.set(s.forcePalette);
    this.message.set(s.loginMessage ?? '');
    this.release();
    this.removing.set(false);
    this.error.set('');
  }

  protected setColor(value: string | null) {
    const color = normalizeHex(value);
    this.color.set(color);
    this.hex.set(color?.toUpperCase() ?? '');
    this.hexError.set(false);
    if (!color) this.force.set(false);
  }

  /** Code saisi : l'aperçu suit dès qu'il est valide ; vide, plus de couleur d'entreprise. */
  protected typeHex(value: string) {
    this.hex.set(value);
    this.hexError.set(false);
    const color = normalizeHex(value);
    if (color) this.color.set(color);
    else if (!value.trim()) this.setColor(null);
  }

  /** Sortie du champ : code complété (#abc → #AABBCC), ou signalé s'il est invalide. */
  protected settleHex() {
    if (this.hexInvalid()) this.hexError.set(true);
    else if (this.hex().trim()) this.setColor(this.hex());
  }

  protected pick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) this.stage(file);
  }

  /** Logo choisi : type et poids vérifiés, affiché tout de suite, envoyé à l'enregistrement. */
  private stage(file: File) {
    if (!LOGO_TYPES.includes(file.type) && !/\.svg$/i.test(file.name)) {
      this.toasts.error('Format non pris en charge : PNG, JPEG, WebP ou SVG.');
      return;
    }
    if (file.size > LOGO_MAX) {
      this.toasts.error('Logo trop lourd : 1 Mo au plus.');
      return;
    }
    this.release();
    this.pending.set({ file, url: URL.createObjectURL(file) });
    this.removing.set(false);
  }

  /** Plus de logo : le fichier choisi est oublié, celui enregistré sera retiré. */
  protected dropLogo() {
    this.release();
    this.removing.set(!!this.saved()?.hasLogo);
  }

  /** Oublie le logo choisi et libère son adresse locale. */
  private release() {
    const p = this.pending();
    if (p) URL.revokeObjectURL(p.url);
    this.pending.set(null);
  }

  private formValue(): BrandingInput {
    const color = this.color();
    return { name: this.name().trim() || null, color, loginMessage: this.message().trim() || null, forcePalette: !!color && this.force() };
  }

  /** Logo d'abord (le plus susceptible d'être refusé), puis le reste ; l'interface prend ensuite la nouvelle apparence. */
  protected async save() {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set('');
    let last: BrandingSettings | null = null;
    try {
      const pending = this.pending();
      if (pending) {
        last = await firstValueFrom(this.api.uploadLogo(pending.file));
        this.release();
      } else if (this.removing()) {
        last = await firstValueFrom(this.api.deleteLogo());
        this.removing.set(false);
      }
      last = await firstValueFrom(this.api.saveBranding(this.formValue()));
      this.toasts.ok('Personnalisation enregistrée', 'palette');
    } catch (e) {
      this.error.set((e as { error?: { error?: string } }).error?.error ?? 'Enregistrement impossible.');
      this.toasts.error(this.error());
    } finally {
      this.busy.set(false);
      if (last) {
        this.saved.set(last);
        this.applyToApp(last);
      }
    }
  }

  /** Toute l'interface prend la nouvelle apparence, en fondu si les animations sont actives (View Transitions). */
  private applyToApp(b: BrandingSettings) {
    const root = document.documentElement;
    const apply = () => this.branding.apply(b);
    if (!document.startViewTransition || root.dataset['motion'] === 'off') return apply();
    document.startViewTransition(apply).ready
      .then(() => root.animate({ opacity: [0, 1] }, { duration: 450, easing: 'ease-out', pseudoElement: '::view-transition-new(root)' }))
      .catch(() => { /* transition sautée : la nouvelle apparence est déjà appliquée */ });
  }
}
