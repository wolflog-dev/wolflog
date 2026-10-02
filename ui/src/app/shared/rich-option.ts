import { Directive, ElementRef, afterNextRender, booleanAttribute, effect, inject, input } from '@angular/core';
import { knownEnvironment } from '../core/environments';
import { createIcon } from '../core/icons';

/** Teintes nommées (couleurs du thème) ; toute autre valeur est prise comme couleur CSS. */
const TONES: Record<string, string> = {
  accent: 'var(--accent)', info: 'var(--accent-3)', ok: 'var(--ok)', warn: 'var(--warn)', danger: 'var(--danger)', crash: 'var(--crash)', muted: 'var(--text-3)',
};
const tone = (value: string | null | undefined) => (value ? TONES[value] ?? value : null);

/**
 * Teinte d'un environnement (danger, warn, ok ou accent) : celle réglée dans Administration › Environnements, selon
 * l'application si elle est connue (une même valeur peut y désigner un autre environnement) ; sinon devinée d'après
 * le nom : production en rouge, recette en ambre, développement en vert.
 */
export function envTone(env: string | null | undefined, service?: string | null): string {
  return knownEnvironment(env, service)?.tone ?? guessEnvTone(env);
}

/** Teinte devinée d'après le nom seul (environnement non configuré), comme le fait le serveur (EnvironmentKinds.Guess). */
export function guessEnvTone(env: string | null | undefined): string {
  const e = (env ?? '').toLowerCase();
  if (/prod|live|prd/.test(e)) return 'danger';
  if (/stag|recette|rec|preprod|pre-prod|uat|qa|test/.test(e)) return 'warn';
  if (/dev|local|sandbox/.test(e)) return 'ok';
  return 'accent';
}

/** Couleur CSS d'un environnement (pastilles, options, barre du haut) : couleur personnalisée, sinon celle de sa teinte. */
export function envColor(env: string | null | undefined, service?: string | null): string {
  return knownEnvironment(env, service)?.color ?? `var(--${envTone(env, service)})`;
}

/** Libellé d'un environnement (« Production ») ; la valeur elle-même si elle n'est rattachée à aucun environnement configuré. */
export function envLabel(env: string | null | undefined, service?: string | null): string {
  return knownEnvironment(env, service)?.label ?? env ?? '';
}

/** Initiales d'un nom de service ou de personne : « Wolflog.Demo » → « WD », « api » → « AP ». */
export function initials(label: string): string {
  const parts = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] ?? '?').slice(0, 2).toUpperCase();
}

/** Teinte stable dérivée du texte (même service = même couleur partout). */
export function hue(label: string): number {
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * Option riche d'une liste déroulante : icône, avatar ou pastille, libellé, description, compteur à droite.
 *   <option [value]="s" [wlOpt]="s" avatar [meta]="n + ' logs'"></option>
 *   <option value="errorRate" wlOpt="le taux d'erreur" icon="errors" tone="danger" desc="Part des requêtes 5xx"></option>
 *   <option [value]="e" [wlOpt]="e" dot [tone]="envTone(e)"></option>
 * Listes personnalisables (Chrome, Edge) : contenu riche, et l'option choisie s'affiche dans la liste fermée
 * (icône et libellé). Autres navigateurs : l'attribut label n'affiche que le libellé.
 */
@Directive({ selector: 'option[wlOpt]' })
export class RichOption {
  readonly label = input('', { alias: 'wlOpt' });
  readonly desc = input<string | null | undefined>(null);
  readonly meta = input<string | number | null | undefined>(null);
  readonly metaTone = input<string | null | undefined>(null);
  readonly icon = input<string | null | undefined>(null);
  readonly tone = input<string | null | undefined>(null);
  readonly avatar = input(false, { transform: booleanAttribute });
  readonly dot = input(false, { transform: booleanAttribute });

  private readonly el = inject<ElementRef<HTMLOptionElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => this.render());
    afterNextRender(() => RichOption.withSelectedContent(this.el.parentElement));
  }

  private render() {
    const label = this.label() ?? '';
    const span = (cls: string, text?: string) => {
      const s = document.createElement('span');
      s.className = cls;
      if (text !== undefined) s.textContent = text;
      return s;
    };
    this.el.setAttribute('label', label);
    const color = tone(this.tone());
    if (color) this.el.style.setProperty('--tone', color);
    else this.el.style.removeProperty('--tone');

    const parts: Node[] = [];
    if (this.avatar()) {
      const a = span('o-lead o-avatar', initials(label));
      a.style.setProperty('--hue', String(hue(label)));
      parts.push(a);
    } else if (this.icon()) {
      const i = span('o-lead o-icon');
      i.append(createIcon(this.icon()!, 15));
      parts.push(i);
    } else if (this.dot()) {
      parts.push(span('o-lead o-dot'));
    }
    const text = span('o-text');
    text.append(span('o-label', label));
    if (this.desc()) text.append(span('o-desc', this.desc()!));
    parts.push(text);
    const meta = this.meta();
    if (meta !== null && meta !== undefined && meta !== '') {
      const m = span('o-meta', String(meta));
      const mt = tone(this.metaTone());
      if (mt) m.style.setProperty('--meta-tone', mt);
      parts.push(m);
    }
    this.el.replaceChildren(...parts);
  }

  /** Liste fermée : bouton qui recopie le contenu de l'option choisie (seulement si la liste est personnalisable). */
  private static withSelectedContent(select: HTMLElement | null) {
    if (!(select instanceof HTMLSelectElement) || !CSS.supports('appearance', 'base-select')) return;
    if (select.querySelector(':scope > button')) return;
    const button = document.createElement('button');
    button.append(document.createElement('selectedcontent'));
    select.prepend(button);
    select.classList.add('rich');
  }
}
