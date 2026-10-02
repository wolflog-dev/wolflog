import { Component, ElementRef, afterNextRender, computed, effect, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageVariable } from '../core/models';
import { htmlToMarkup, markupToHtml, mentionChip, singleLine, variableChip } from '../core/message-markup';
import { NavIcon } from './nav-icon';

/**
 * Éditeur visuel d'un modèle de message : mise en forme (gras, italique, lien, liste), variables insérées
 * comme des étiquettes (menu ou « {{ »), mentions @personne. Produit le texte enregistré (voir core/message-markup).
 */
@Component({
  selector: 'wl-message-editor',
  imports: [FormsModule, NavIcon],
  template: `
    <div class="editor" [class.single]="singleLine()" [class.focus]="focused()">
      <div class="tools">
        @if (!singleLine()) {
          <button type="button" title="Gras (Ctrl+B)" aria-label="Gras" [class.on]="active().bold" [attr.aria-pressed]="active().bold" (mousedown)="$event.preventDefault(); format('bold')"><b>G</b></button>
          <button type="button" title="Italique (Ctrl+I)" aria-label="Italique" [class.on]="active().italic" [attr.aria-pressed]="active().italic" (mousedown)="$event.preventDefault(); format('italic')"><i>I</i></button>
          <button type="button" title="Liste à puces" [class.on]="active().list" [attr.aria-pressed]="active().list" (mousedown)="$event.preventDefault(); format('insertUnorderedList')"><wl-nav-icon name="list" [size]="14" />Liste</button>
          <button type="button" title="Lien" [class.on]="panel() === 'link'" (mousedown)="$event.preventDefault(); openPanel('link')"><wl-nav-icon name="link" [size]="14" />Lien</button>
          <button type="button" title="Mentionner une personne (Teams, Slack)" [class.on]="panel() === 'mention'" (mousedown)="$event.preventDefault(); openPanel('mention')">&#64;&nbsp;Mention</button>
          <span class="sep"></span>
        }
        <button type="button" class="insert" [class.on]="panel() === 'vars'" title="Insérer une information (ou tapez {{ '{{' }})" (mousedown)="$event.preventDefault(); openPanel('vars')">
          <wl-nav-icon name="plus" [size]="14" />Information
        </button>
      </div>

      <div #area class="area" contenteditable="true" spellcheck="true" role="textbox" [attr.aria-multiline]="!singleLine()"
           [attr.aria-label]="label()" [attr.data-placeholder]="placeholder()"
           (input)="changed()" (keydown)="keydown($event)" (mousedown)="mousedown($event)" (paste)="paste($event)"
           (focus)="focused.set(true); focusChange.emit(true)" (blur)="focused.set(false); focusChange.emit(false); remember(); resync()"
           (keyup)="remember(); updateActive()" (mouseup)="remember(); updateActive()"></div>

      @switch (panel()) {
        @case ('vars') {
          <div class="panel-pop" animate.leave="pop-out" (keydown.escape)="close()">
            <span class="search-wrap">
              <wl-nav-icon name="search" [size]="14" />
              <input #search class="search" [ngModel]="query()" (ngModelChange)="query.set($event); activeIndex.set(0)" placeholder="Rechercher une information…"
                     (keydown)="searchKey($event)" aria-label="Rechercher une information" />
            </span>
            <div class="vars" #list role="listbox" aria-label="Informations">
              @for (v of filtered(); track v.name; let i = $index) {
                <button type="button" class="var-row" role="option" [class.active]="i === activeIndex()" [attr.aria-selected]="i === activeIndex()" [style.--i]="i"
                        (mouseenter)="activeIndex.set(i)" (mousedown)="$event.preventDefault(); insertVariable(v)">
                  <span class="chip">{{ v.label }}</span>
                  <span class="desc" [title]="v.description">{{ v.description }}</span>
                  <span class="val" [title]="v.value ?? ''">{{ v.value || '' }}</span>
                </button>
              } @empty {
                <div class="none"><wl-nav-icon name="search" [size]="14" />Aucune information{{ query().trim() ? ' pour « ' + query().trim() + ' »' : '' }}</div>
              }
            </div>
            <div class="keys"><kbd>↑</kbd><kbd>↓</kbd> choisir · <kbd>Entrée</kbd> insérer · <kbd>Échap</kbd> fermer</div>
          </div>
        }
        @case ('link') {
          <form class="panel-pop form" animate.leave="pop-out" (ngSubmit)="insertLink()" (keydown.escape)="close()">
            <div class="pop-title"><wl-nav-icon name="link" [size]="14" />Insérer un lien</div>
            <label>Texte <input #linkTextInput name="text" [(ngModel)]="linkText" placeholder="Voir la procédure" /></label>
            <label>Adresse
              <span class="with">
                <input #linkUrlInput name="url" [(ngModel)]="linkUrl" placeholder="https://…" />
                <button type="button" class="btn ghost small" (click)="useWolflogLink()" title="Lien vers la page dans Wolflog"><wl-nav-icon name="external" [size]="13" />Page Wolflog</button>
              </span></label>
            <div class="row">
              <button class="btn primary small" type="submit" [disabled]="!linkUrl.trim()"><wl-nav-icon name="check" [size]="13" />Insérer</button>
              <button class="btn ghost small" type="button" (click)="close()">Annuler</button>
            </div>
          </form>
        }
        @case ('mention') {
          <form class="panel-pop form" animate.leave="pop-out" (ngSubmit)="insertMention()" (keydown.escape)="close()">
            <div class="pop-title"><span class="at">&#64;</span>Mentionner une personne</div>
            <label>Nom affiché <input #mentionNameInput name="name" [(ngModel)]="mentionName" placeholder="Astreinte" /></label>
            <label>Identifiant <input name="id" [(ngModel)]="mentionId" placeholder="astreinte@mondomaine.fr" /></label>
            <span class="hint"><wl-nav-icon name="info" [size]="13" /><span>Teams : adresse e-mail (UPN) de la personne. Slack : identifiant membre (U0123…) ou « here ».
              E-mail : le nom est affiché en gras.</span></span>
            <div class="row">
              <button class="btn primary small" type="submit" [disabled]="!mentionName.trim() || !mentionId.trim()"><wl-nav-icon name="check" [size]="13" />Insérer</button>
              <button class="btn ghost small" type="button" (click)="close()">Annuler</button>
            </div>
          </form>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; position: relative; }
    .editor { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); transition: border-color .2s, box-shadow .3s var(--ease); }
    .editor:hover:not(.focus) { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .editor.focus { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--border-soft, var(--border)); }
    .single .tools { position: absolute; right: 4px; top: 4px; border: 0; padding: 0; }
    .tools button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; min-width: 28px; padding: 0 8px; border: 0;
      border-radius: 7px; background: none; color: var(--text-2); font: 12.5px var(--sans); cursor: pointer;
      transition: background-color .15s, color .15s, transform .25s var(--spring); }
    .tools button:hover { background: var(--surface-3); color: var(--text-1); }
    .tools button:active { transform: scale(.9); }
    .tools button.on { background: var(--accent-soft); color: var(--accent); }
    .tools .insert { color: var(--accent); font-weight: 600; }
    .tools .insert wl-nav-icon { transition: transform .4s var(--spring); }
    .tools .insert:hover wl-nav-icon, .tools .insert.on wl-nav-icon { transform: rotate(90deg); }
    .tools .sep { flex: 1; }
    .area { min-height: 96px; max-height: 320px; overflow: auto; padding: 10px 12px; outline: none; font: 13.5px/1.6 var(--sans); color: var(--text-1); }
    .single .area { min-height: 0; padding: 7px 110px 7px 10px; white-space: nowrap; overflow-x: auto; }
    .area:empty::before { content: attr(data-placeholder); color: var(--text-3); pointer-events: none; }
    .area :is(ul) { margin: 2px 0; padding-left: 20px; }
    .area a { color: var(--accent); }
    :host ::ng-deep .area .var, :host ::ng-deep .area .mention {
      display: inline-block; padding: 0 7px; margin: 0 1px; border-radius: 10px; line-height: 20px; font-size: 12px; font-weight: 600;
      background: var(--accent-soft); color: var(--accent); cursor: pointer; animation: chip-in .2s ease-out; transition: box-shadow .12s; }
    /* × de suppression : sa place est toujours réservée (rien ne bouge au survol), il apparaît seulement. */
    :host ::ng-deep .area :is(.var, .mention)::after { content: '×'; display: inline-block; width: 10px; margin-left: 4px; overflow: hidden; opacity: 0;
      font-weight: 700; vertical-align: top; transition: opacity .12s; }
    :host ::ng-deep .area :is(.var, .mention):hover::after, :host ::ng-deep .area :is(.var, .mention).sel::after { opacity: .75; }
    :host ::ng-deep .area :is(.var, .mention).sel { box-shadow: 0 0 0 2px var(--accent); }
    :host ::ng-deep .area .mention { background: color-mix(in srgb, var(--accent-3) 16%, transparent); color: var(--accent-3); }
    @keyframes chip-in { from { transform: scale(.85); opacity: 0; } }
    .panel-pop { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-width: 560px; padding: 8px; border: 1px solid var(--border);
      border-radius: var(--radius); background: var(--surface-solid); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); box-shadow: var(--shadow-pop); transform-origin: top left; animation: pop-in .4s var(--spring); }
    @keyframes pop-in { from { opacity: 0; transform: translateY(-8px) scale(.95); } }
    .pop-out { animation: pop-out .18s ease-in forwards; }
    @keyframes pop-out { to { opacity: 0; transform: translateY(-6px) scale(.97); } }
    /* Menu des informations : recherche, navigation au clavier, lignes en cascade. */
    .search-wrap { position: relative; display: block; margin-bottom: 6px; }
    .search-wrap wl-nav-icon { position: absolute; left: 10px; top: 50%; z-index: 1; color: var(--text-3); pointer-events: none; transform: translateY(-50%); }
    .search { width: 100%; padding-left: 32px; }
    .vars { max-height: 280px; overflow: auto; display: grid; gap: 1px; }
    .var-row { display: grid; grid-template-columns: 130px minmax(0, 1fr) minmax(0, 150px); gap: 10px; align-items: center; width: 100%;
      padding: 6px; border: 0; border-radius: 8px; background: none; color: var(--text-1); font: 12.5px var(--sans); text-align: left; cursor: pointer;
      animation: row-in .3s var(--ease) backwards; animation-delay: calc(min(var(--i), 12) * 14ms); transition: background-color .15s; }
    .var-row.active { background: var(--surface-3); }
    .var-row .chip { transition: transform .3s var(--spring); }
    .var-row.active .chip { transform: translateX(3px); }
    @keyframes row-in { from { opacity: 0; transform: translateY(-4px); } }
    .chip { justify-self: start; padding: 0 7px; border-radius: 10px; line-height: 20px; font-size: 12px; font-weight: 600; background: var(--accent-soft); color: var(--accent); }
    .desc { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .val { color: var(--text-3); font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    .none { display: flex; align-items: center; gap: 8px; padding: 10px 8px; color: var(--text-3); font-size: 12px; }
    .keys { display: flex; align-items: center; gap: 4px; margin-top: 6px; padding: 6px 4px 0; border-top: 1px solid var(--border-soft); font-size: 11px; color: var(--text-3); }
    .keys kbd { font-size: 10px; padding: 0 5px; }

    /* Formulaires lien et mention. */
    .form { display: grid; gap: 8px; }
    .pop-title { display: flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650; color: var(--text-1); }
    .pop-title wl-nav-icon, .pop-title .at { color: var(--accent); }
    .pop-title .at { font-weight: 700; }
    .form label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .form .with { display: flex; gap: 6px; }
    .form .with input { flex: 1; }
    .form .hint { display: flex; align-items: flex-start; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .form .hint wl-nav-icon { flex: none; margin-top: 1px; }
    .form .row { display: flex; gap: 6px; }
  `,
})
export class MessageEditor {
  readonly value = input<string | null>('');
  readonly variables = input<MessageVariable[]>([]);
  readonly singleLine = input(false);
  readonly placeholder = input('');
  readonly label = input('Message');
  readonly valueChange = output<string>();
  /** Prise ou perte du focus (le composeur sait ainsi où insérer une information choisie dans sa palette). */
  readonly focusChange = output<boolean>();

  private readonly area = viewChild.required<ElementRef<HTMLDivElement>>('area');
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly varsList = viewChild<ElementRef<HTMLDivElement>>('list');
  private readonly linkTextInput = viewChild<ElementRef<HTMLInputElement>>('linkTextInput');
  private readonly linkUrlInput = viewChild<ElementRef<HTMLInputElement>>('linkUrlInput');
  private readonly mentionNameInput = viewChild<ElementRef<HTMLInputElement>>('mentionNameInput');
  protected readonly focused = signal(false);
  /** Mise en forme sous le curseur : boutons Gras, Italique, Liste allumés. */
  protected readonly active = signal({ bold: false, italic: false, list: false });
  protected readonly panel = signal<'vars' | 'link' | 'mention' | null>(null);
  protected readonly query = signal('');
  /** Ligne du menu des informations choisie au clavier (flèches), insérée par Entrée. */
  protected readonly activeIndex = signal(0);
  protected linkText = '';
  protected linkUrl = '';
  protected mentionName = '';
  protected mentionId = '';

  /** Dernière valeur émise : évite de réécrire le contenu (et de perdre le curseur) pendant la saisie. */
  private emitted: string | null = null;
  private range: Range | null = null;
  /** Texte sélectionné à l'ouverture d'un panneau (remplacé par le lien). */
  private selection: Range | null = null;
  private marker: HTMLSpanElement | null = null;
  private selectedChip: HTMLElement | null = null;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.variables().filter((v) => !q || v.label.toLowerCase().includes(q) || v.name.includes(q) || v.description.toLowerCase().includes(q));
  });

  private readonly labels = computed(() => Object.fromEntries(this.variables().map((v) => [v.name, v.label])));

  constructor() {
    afterNextRender(() => this.load());
    effect(() => {
      const v = this.value() ?? '';
      // Jamais pendant la saisie : réécrire le contenu ferait perdre le texte tapé et le curseur.
      if (v !== this.emitted && !untracked(() => this.typing())) untracked(() => this.load());
    });
    // Libellés arrivés après l'affichage (aperçu du serveur) : mis à jour sur place, sans toucher au curseur.
    effect(() => {
      const labels = this.labels();
      for (const chip of Array.from(this.area()?.nativeElement.querySelectorAll<HTMLElement>('.var') ?? [])) {
        const label = labels[chip.dataset['var'] ?? ''];
        if (label && chip.textContent !== label) chip.textContent = label;
      }
    });
    // Panneau ouvert : le premier champ utile prend le focus (l'adresse si le texte du lien vient de la sélection).
    effect(() => {
      const panel = this.panel();
      if (panel === 'vars') setTimeout(() => this.search()?.nativeElement.focus());
      else if (panel === 'link') setTimeout(() => (this.linkText ? this.linkUrlInput() : this.linkTextInput())?.nativeElement.focus());
      else if (panel === 'mention') setTimeout(() => this.mentionNameInput()?.nativeElement.focus());
    });
  }

  /** Recherche d'une information : flèches pour choisir, Entrée pour insérer. */
  protected searchKey(e: KeyboardEvent) {
    const list = this.filtered();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      const next = (this.activeIndex() + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      this.activeIndex.set(next);
      this.varsList()?.nativeElement.children[next]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const v = list[Math.min(this.activeIndex(), list.length - 1)];
      if (v) this.insertVariable(v);
    }
  }

  private typing() {
    return document.activeElement === this.area()?.nativeElement;
  }

  /** En quittant l'éditeur : reprend une valeur changée de l'extérieur pendant la saisie. */
  protected resync() {
    if ((this.value() ?? '') !== this.emitted && !this.panel()) this.load();
  }

  private load() {
    const el = this.area()?.nativeElement;
    if (!el) return;
    const v = this.value() ?? '';
    this.emitted = v;
    el.innerHTML = v ? markupToHtml(this.singleLine() ? singleLine(v) : v, this.labels()) : '';
  }

  protected changed() {
    const el = this.area().nativeElement;
    // « {{ » tapé au clavier : ouvre le menu des informations à cet endroit.
    const sel = document.getSelection();
    if (sel?.rangeCount && sel.anchorNode?.nodeType === Node.TEXT_NODE) {
      const node = sel.anchorNode as Text;
      const before = node.data.slice(0, sel.anchorOffset);
      if (before.endsWith('{{')) {
        node.deleteData(sel.anchorOffset - 2, 2);
        this.remember();
        this.placeMarker();
        this.query.set('');
        this.activeIndex.set(0);
        this.panel.set('vars');
      }
    }
    if (!el.textContent?.trim() && !el.querySelector('.var, .mention')) el.innerHTML = '';
    let markup = htmlToMarkup(el);
    if (this.singleLine()) markup = singleLine(markup);
    this.emitted = markup;
    this.valueChange.emit(markup);
  }

  protected keydown(e: KeyboardEvent) {
    if (this.singleLine() && e.key === 'Enter') e.preventDefault();
    if (e.key === 'Escape') this.close();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      // Étiquette sélectionnée, ou juste avant / après le curseur : supprimée par l'éditeur
      // (les navigateurs gèrent mal les éléments non modifiables).
      const chip = this.selectedChip ?? this.chipNextTo(e.key === 'Backspace' ? 'before' : 'after');
      if (chip) {
        e.preventDefault();
        this.removeChip(chip);
        return;
      }
    }
    if (this.selectedChip && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) this.selectChip(null);
  }

  /** Clic sur une étiquette : la sélectionne ; clic sur sa croix : la supprime. */
  protected mousedown(e: MouseEvent) {
    if (this.panel()) this.close();
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.var, .mention');
    if (!chip || !this.area().nativeElement.contains(chip)) {
      this.selectChip(null);
      return;
    }
    e.preventDefault();
    if (e.clientX > chip.getBoundingClientRect().right - 16) this.removeChip(chip);
    else this.selectChip(chip);
  }

  private selectChip(chip: HTMLElement | null) {
    this.selectedChip?.classList.remove('sel');
    this.selectedChip = chip;
    if (!chip) return;
    chip.classList.add('sel');
    this.area().nativeElement.focus();
    const r = document.createRange();
    r.setStartAfter(chip);
    r.collapse(true);
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    this.remember();
  }

  private removeChip(chip: HTMLElement) {
    this.area().nativeElement.focus();
    const r = document.createRange();
    r.setStartBefore(chip);
    r.collapse(true);
    // L'espace insécable ajoutée avec l'étiquette part avec elle.
    const next = chip.nextSibling;
    if (next instanceof Text && next.data.startsWith(' ')) next.deleteData(0, 1);
    const line = chip.parentElement;
    chip.remove();
    if (this.selectedChip === chip) this.selectedChip = null;
    // Ligne vidée : un <br> lui garde sa hauteur, pour pouvoir y écrire.
    if (line && line !== this.area().nativeElement && !line.textContent && !line.querySelector('br, .var, .mention')) {
      line.appendChild(document.createElement('br'));
      r.setStart(line, 0);
      r.collapse(true);
    }
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    this.remember();
    this.changed();
  }

  /** Étiquette immédiatement avant ou après le curseur (en ignorant les textes vides). */
  private chipNextTo(side: 'before' | 'after'): HTMLElement | null {
    const sel = document.getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const { startContainer: node, startOffset: offset } = sel.getRangeAt(0);
    let candidate: Node | null;
    if (node instanceof Text) {
      if (side === 'before' ? offset > 0 : offset < node.data.length) return null;
      candidate = side === 'before' ? node.previousSibling : node.nextSibling;
    } else {
      candidate = (side === 'before' ? node.childNodes[offset - 1] : node.childNodes[offset]) ?? null;
    }
    while (candidate instanceof Text && !candidate.data.length) candidate = side === 'before' ? candidate.previousSibling : candidate.nextSibling;
    return candidate instanceof HTMLElement && candidate.matches('.var, .mention') && this.area().nativeElement.contains(candidate) ? candidate : null;
  }

  /** Collage en texte brut : pas de styles étrangers dans le modèle. */
  protected paste(e: ClipboardEvent) {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    document.execCommand('insertText', false, this.singleLine() ? text.replace(/\s*\n\s*/g, ' ') : text);
  }

  protected remember() {
    const sel = document.getSelection();
    if (sel?.rangeCount && this.area().nativeElement.contains(sel.anchorNode)) this.range = sel.getRangeAt(0).cloneRange();
  }

  /**
   * Repère invisible à l'emplacement du curseur : le champ de recherche ou les formulaires prennent le focus,
   * l'insertion se fait ensuite exactement à cet endroit.
   */
  private placeMarker() {
    this.removeMarker();
    const el = this.area().nativeElement;
    const r = this.range && el.contains(this.range.startContainer) ? this.range.cloneRange() : null;
    const at = r ?? document.createRange();
    if (!r) at.selectNodeContents(el);
    at.collapse(false);
    this.marker = document.createElement('span');
    this.marker.className = 'caret';
    at.insertNode(this.marker);
  }

  private removeMarker() {
    this.marker?.remove();
    this.marker = null;
  }

  private restore() {
    const el = this.area().nativeElement;
    el.focus();
    const sel = document.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (this.marker && el.contains(this.marker)) {
      const r = document.createRange();
      r.setStartBefore(this.marker);
      r.collapse(true);
      this.removeMarker();
      sel.addRange(r);
    } else if (this.range && el.contains(this.range.startContainer)) sel.addRange(this.range);
    else {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.addRange(r);
    }
  }

  protected format(command: 'bold' | 'italic' | 'insertUnorderedList') {
    // Sélection toujours dans l'éditeur (le bouton ne prend pas le focus) : on l'utilise telle quelle.
    const sel = document.getSelection();
    if (!sel?.rangeCount || !this.area().nativeElement.contains(sel.anchorNode)) this.restore();
    document.execCommand(command);
    this.changed();
    this.updateActive();
  }

  /** État des boutons de mise en forme à la position du curseur. */
  protected updateActive() {
    if (this.singleLine()) return;
    const state = (c: string) => { try { return document.queryCommandState(c); } catch { return false; } };
    const next = { bold: state('bold'), italic: state('italic'), list: state('insertUnorderedList') };
    const cur = this.active();
    if (next.bold !== cur.bold || next.italic !== cur.italic || next.list !== cur.list) this.active.set(next);
  }

  /**
   * Insère une information à la dernière position du curseur (ou à la fin), depuis l'extérieur de l'éditeur
   * (palette des informations du composeur).
   */
  insert(v: MessageVariable) {
    this.insertVariable(v);
  }

  protected openPanel(kind: 'vars' | 'link' | 'mention') {
    if (this.panel() === kind) {
      this.close();
      return;
    }
    this.remember();
    this.selection = this.range && !this.range.collapsed ? this.range.cloneRange() : null;
    if (kind === 'link') {
      this.linkText = this.selection?.toString() ?? '';
      this.linkUrl = '';
    }
    this.placeMarker();
    if (kind === 'mention') this.mentionName = this.mentionId = '';
    this.query.set('');
    this.activeIndex.set(0);
    this.panel.set(kind);
  }

  protected close() {
    this.panel.set(null);
    this.removeMarker();
  }

  protected insertVariable(v: MessageVariable) {
    this.insertHtml(variableChip(v.name, v.label) + '&nbsp;');
  }

  protected useWolflogLink() {
    this.linkUrl = '{{lien}}';
    if (!this.linkText) this.linkText = 'Voir dans Wolflog';
  }

  protected insertLink() {
    const url = this.linkUrl.trim();
    if (!url) return;
    const text = this.linkText.trim() || url;
    const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    // Le texte sélectionné devient le lien.
    if (this.selection && this.area().nativeElement.contains(this.selection.startContainer)) this.selection.deleteContents();
    this.insertHtml(`<a href="${escape(url)}">${escape(text)}</a>&nbsp;`);
  }

  protected insertMention() {
    if (!this.mentionName.trim() || !this.mentionId.trim()) return;
    this.insertHtml(mentionChip(this.mentionName.trim(), this.mentionId.trim()) + '&nbsp;');
  }

  private insertHtml(html: string) {
    this.panel.set(null);
    this.restore();
    // Insertion par Range : execCommand('insertHTML') de Chrome sort les éléments non modifiables de leur ligne.
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const template = document.createElement('template');
    template.innerHTML = html;
    const last = template.content.lastChild;
    range.insertNode(template.content);
    if (last) {
      range.setStartAfter(last);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    this.remember();
    this.changed();
  }
}
