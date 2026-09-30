import { Component, ElementRef, afterNextRender, computed, effect, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MessageVariable } from '../core/models';
import { htmlToMarkup, markupToHtml, mentionChip, singleLine, variableChip } from '../core/message-markup';

/**
 * Éditeur visuel d'un modèle de message : mise en forme (gras, italique, lien, liste), variables insérées
 * comme des étiquettes (menu ou « {{ »), mentions @personne. Produit le texte enregistré (voir core/message-markup).
 */
@Component({
  selector: 'wl-message-editor',
  imports: [FormsModule],
  template: `
    <div class="editor" [class.single]="singleLine()" [class.focus]="focused()">
      <div class="tools">
        @if (!singleLine()) {
          <button type="button" title="Gras (Ctrl+B)" (mousedown)="$event.preventDefault(); format('bold')"><b>G</b></button>
          <button type="button" title="Italique (Ctrl+I)" (mousedown)="$event.preventDefault(); format('italic')"><i>I</i></button>
          <button type="button" title="Liste" (mousedown)="$event.preventDefault(); format('insertUnorderedList')">•&nbsp;Liste</button>
          <button type="button" title="Lien" (mousedown)="$event.preventDefault(); openPanel('link')">Lien</button>
          <button type="button" title="Mentionner une personne (Teams, Slack)" (mousedown)="$event.preventDefault(); openPanel('mention')">&#64;&nbsp;Mention</button>
          <span class="sep"></span>
        }
        <button type="button" class="insert" title="Insérer une information (ou tapez {{ '{{' }})" (mousedown)="$event.preventDefault(); openPanel('vars')">
          + Information
        </button>
      </div>

      <div #area class="area" contenteditable="true" spellcheck="true" role="textbox" [attr.aria-multiline]="!singleLine()"
           [attr.aria-label]="label()" [attr.data-placeholder]="placeholder()"
           (input)="changed()" (keydown)="keydown($event)" (mousedown)="mousedown($event)" (paste)="paste($event)"
           (focus)="focused.set(true)" (blur)="focused.set(false); remember(); resync()" (keyup)="remember()" (mouseup)="remember()"></div>

      @switch (panel()) {
        @case ('vars') {
          <div class="panel-pop" (keydown.escape)="close()">
            <input #search class="search" [ngModel]="query()" (ngModelChange)="query.set($event)" placeholder="Rechercher une information…"
                   (keydown.enter)="$event.preventDefault(); filtered()[0] && insertVariable(filtered()[0])" />
            <div class="vars">
              @for (v of filtered(); track v.name) {
                <button type="button" class="var-row" (mousedown)="$event.preventDefault(); insertVariable(v)">
                  <span class="chip">{{ v.label }}</span>
                  <span class="desc">{{ v.description }}</span>
                  <span class="val" [title]="v.value ?? ''">{{ v.value || '—' }}</span>
                </button>
              } @empty {
                <div class="none">Aucune information</div>
              }
            </div>
          </div>
        }
        @case ('link') {
          <form class="panel-pop form" (ngSubmit)="insertLink()" (keydown.escape)="close()">
            <label>Texte <input name="text" [(ngModel)]="linkText" placeholder="Voir la procédure" /></label>
            <label>Adresse
              <span class="with">
                <input name="url" [(ngModel)]="linkUrl" placeholder="https://…" />
                <button type="button" class="btn ghost small" (click)="useWolflogLink()" title="Lien vers la page dans Wolflog">Page Wolflog</button>
              </span></label>
            <div class="row"><button class="btn primary small" type="submit">Insérer</button><button class="btn ghost small" type="button" (click)="close()">Annuler</button></div>
          </form>
        }
        @case ('mention') {
          <form class="panel-pop form" (ngSubmit)="insertMention()" (keydown.escape)="close()">
            <label>Nom affiché <input name="name" [(ngModel)]="mentionName" placeholder="Astreinte" /></label>
            <label>Identifiant <input name="id" [(ngModel)]="mentionId" placeholder="astreinte@mondomaine.fr" /></label>
            <span class="hint">Teams : adresse e-mail (UPN) de la personne. Slack : identifiant membre (U0123…) ou « here ».
              E-mail : le nom est affiché en gras.</span>
            <div class="row"><button class="btn primary small" type="submit">Insérer</button><button class="btn ghost small" type="button" (click)="close()">Annuler</button></div>
          </form>
        }
      }
    </div>
  `,
  styles: `
    :host { display: block; position: relative; }
    .editor { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); transition: border-color .15s, box-shadow .15s; }
    .editor.focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .tools { display: flex; align-items: center; gap: 2px; padding: 4px 6px; border-bottom: 1px solid var(--border-soft, var(--border)); }
    .single .tools { position: absolute; right: 4px; top: 4px; border: 0; padding: 0; }
    .tools button { height: 26px; min-width: 28px; padding: 0 8px; border: 0; border-radius: 5px; background: none; color: var(--text-2); font: 12.5px var(--sans); cursor: pointer; }
    .tools button:hover { background: var(--surface-3); color: var(--text-1); }
    .tools .insert { color: var(--accent); font-weight: 600; }
    .tools .sep { flex: 1; }
    .area { min-height: 96px; max-height: 320px; overflow: auto; padding: 10px 12px; outline: none; font: 13.5px/1.6 var(--sans); color: var(--text-1); }
    .single .area { min-height: 0; padding: 7px 110px 7px 10px; white-space: nowrap; overflow-x: auto; }
    .area:empty::before { content: attr(data-placeholder); color: var(--text-3); pointer-events: none; }
    .area :is(ul) { margin: 2px 0; padding-left: 20px; }
    .area a { color: var(--accent); }
    :host ::ng-deep .area .var, :host ::ng-deep .area .mention {
      display: inline-block; padding: 0 7px; margin: 0 1px; border-radius: 10px; line-height: 20px; font-size: 12px; font-weight: 600;
      background: var(--accent-soft); color: var(--accent); cursor: pointer; animation: chip-in .2s ease-out; transition: box-shadow .12s; }
    :host ::ng-deep .area :is(.var, .mention)::after { content: '×'; display: inline-block; width: 0; overflow: hidden; opacity: .75;
      font-weight: 700; vertical-align: top; transition: width .12s, margin .12s; }
    :host ::ng-deep .area :is(.var, .mention):hover::after, :host ::ng-deep .area :is(.var, .mention).sel::after { width: 10px; margin-left: 4px; }
    :host ::ng-deep .area :is(.var, .mention).sel { box-shadow: 0 0 0 2px var(--accent); }
    :host ::ng-deep .area .mention { background: color-mix(in srgb, #9b59b6 16%, transparent); color: #9b59b6; }
    @keyframes chip-in { from { transform: scale(.85); opacity: 0; } }
    .panel-pop { position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-width: 560px; padding: 8px; border: 1px solid var(--border);
      border-radius: 10px; background: var(--surface); box-shadow: 0 12px 32px rgba(0, 0, 0, .28); animation: pop-in .15s ease-out; }
    @keyframes pop-in { from { opacity: 0; transform: translateY(-4px); } }
    .search { width: 100%; margin-bottom: 6px; }
    .vars { max-height: 280px; overflow: auto; display: grid; gap: 1px; }
    .var-row { display: grid; grid-template-columns: 130px minmax(0, 1fr) minmax(0, 150px); gap: 10px; align-items: center; width: 100%;
      padding: 6px; border: 0; border-radius: 6px; background: none; color: var(--text-1); font: 12.5px var(--sans); text-align: left; cursor: pointer; }
    .var-row:hover { background: var(--surface-2); }
    .chip { justify-self: start; padding: 0 7px; border-radius: 10px; line-height: 20px; font-size: 12px; font-weight: 600; background: var(--accent-soft); color: var(--accent); }
    .desc { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .val { color: var(--text-3); font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
    .none { padding: 8px; color: var(--text-3); font-size: 12px; }
    .form { display: grid; gap: 8px; }
    .form label { display: grid; gap: 4px; font-size: 12px; color: var(--text-2); }
    .form .with { display: flex; gap: 6px; }
    .form .with input { flex: 1; }
    .form .hint { font-size: 11.5px; color: var(--text-3); }
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

  private readonly area = viewChild.required<ElementRef<HTMLDivElement>>('area');
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  protected readonly focused = signal(false);
  protected readonly panel = signal<'vars' | 'link' | 'mention' | null>(null);
  protected readonly query = signal('');
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
    effect(() => {
      if (this.panel() === 'vars') setTimeout(() => this.search()?.nativeElement.focus());
    });
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
