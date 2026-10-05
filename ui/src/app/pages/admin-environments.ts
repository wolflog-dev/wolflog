import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api } from '../core/api';
import { environmentsChanged } from '../core/environments';
import { formatNumber, timeAgo } from '../core/format';
import { AppEnvironments, EnvironmentAdmin, EnvironmentDefinition, EnvironmentKind, EnvironmentSettings, EnvironmentUsage } from '../core/models';
import { AgoPipe } from '../core/pipes/ago-pipe';
import { Toasts } from '../core/toasts';
import { NavIcon } from '../shared/nav-icon';
import { RichOption, guessEnvTone, hue, initials } from '../shared/rich-option';
import { Skeleton } from '../shared/skeleton';

/** Types proposés : chacun donne sa couleur (une couleur personnalisée peut la remplacer). */
const KINDS: { value: EnvironmentKind; label: string; hint: string; tone: string }[] = [
  { value: 'production', label: 'Production', hint: 'Production : rouge', tone: 'danger' },
  { value: 'recette', label: 'Recette, préprod', hint: 'Recette, préproduction, test : ambre', tone: 'warn' },
  { value: 'developpement', label: 'Développement', hint: 'Développement, local : vert', tone: 'ok' },
  { value: 'autre', label: 'Autre', hint: "Autre : couleur d'accent", tone: 'accent' },
];
const TONE: Record<EnvironmentKind, string> = { production: 'danger', recette: 'warn', developpement: 'ok', autre: 'accent' };
const KIND_TEXT: Record<string, string> = { danger: 'production', warn: 'recette, préproduction', ok: 'développement', accent: 'environnement' };
/** Même règle que le serveur : lettres minuscules sans accent, chiffres, - _ . (40 caractères au plus). */
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Environnement en cours de saisie. */
interface DraftEnv extends EnvironmentDefinition {
  /** Clé stable de la carte (le nom d'un nouvel environnement change pendant la saisie). */
  key: number;
  /** Jamais enregistré : son nom peut encore changer. */
  isNew: boolean;
  /** Nom saisi à la main ; sinon tiré du libellé. */
  named: boolean;
  /** Libellé ou nom quitté au moins une fois : un nom manquant est alors signalé (pas dès l'ajout de la carte). */
  touched?: boolean;
}

/** Entrée du sélecteur de la barre du haut, calculée avec les réglages en cours de saisie. */
interface SelectorItem {
  name: string;
  label: string;
  color: string;
  configured: boolean;
  raw: string[];
  apps: string[];
  logs: number;
  /** Masqué pour l'application choisie. */
  hidden: boolean;
  desc: string;
}

/** Valeur reçue d'une application et son rattachement. */
interface ValueRow {
  env: string;
  detail: string;
  /** '*' : règle commune ; nom d'environnement ; '' : gardée telle quelle. */
  choice: string;
  general: string;
  /** Égale au nom d'un environnement : elle s'y rattache forcément (pas de « telle quelle »). */
  isName: boolean;
}

/** Nom tiré du libellé : « Préproduction (UE) » → preproduction-ue. */
function slug(label: string): string {
  return label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/-+$/, '').slice(0, 40);
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Environnements : regrouper les valeurs envoyées par les applications (prod, Production, prd → Production), leur donner
 * un libellé, une couleur et un ordre, avec des règles propres à certaines applications et les environnements masqués de
 * leur sélecteur. L'aperçu montre la barre du haut telle qu'elle sera ; rien ne change avant l'enregistrement.
 */
@Component({
  selector: 'wl-admin-environments',
  imports: [FormsModule, AgoPipe, NavIcon, RichOption, Skeleton],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <h1>Environnements</h1>
        <span class="muted small sub">Regrouper les noms envoyés par les applications</span>
        <span class="spacer"></span>
        @if (dirty()) {
          <span class="unsaved small" animate.enter="pop" animate.leave="fade-out"><wl-nav-icon name="edit" [size]="13" />Non enregistré</span>
        }
        <button class="btn" (click)="suggest()" [disabled]="!saved() || suggesting() || busy()" title="Proposer des regroupements d'après les valeurs reçues sur 30 jours">
          <wl-nav-icon [name]="suggesting() ? 'refresh' : 'sparkles'" [class.spin]="suggesting()" [size]="14" />Regrouper automatiquement
        </button>
        <button class="btn" (click)="reset()" [disabled]="!dirty() || busy()">Annuler</button>
        <button class="btn primary" (click)="save()" [disabled]="!canSave()">
          <wl-nav-icon [name]="busy() ? 'refresh' : 'check'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Enregistrement…' : 'Enregistrer' }}
        </button>
      </div>

      @if (saved()) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step" [class.done]="envs().length > 0">
              <div class="step-head"><span class="num">1</span><h2>Environnements</h2><span class="hint">communs à toutes les applications, dans l'ordre du sélecteur</span></div>
              <div class="step-body">
                @if (!envs().length) {
                  <div class="intro">
                    <span class="intro-icon"><wl-nav-icon name="layers" [size]="18" /></span>
                    <div class="intro-text">
                      <strong>Aucun regroupement : chaque valeur reçue est un environnement.</strong>
                      <span class="muted small">{{ introText() }}</span>
                      <div class="intro-actions">
                        <button type="button" class="btn primary small" (click)="suggest()" [disabled]="suggesting()"><wl-nav-icon name="sparkles" [size]="13" />Regrouper automatiquement</button>
                        <button type="button" class="btn small" (click)="addEnv()"><wl-nav-icon name="plus" [size]="13" />Ajouter un environnement</button>
                      </div>
                    </div>
                  </div>
                }
                @for (e of envs(); track e.key; let i = $index, first = $first, last = $last) {
                  <article class="env" [attr.data-env]="e.key" [class.off]="e.hidden" [class.moved]="moved() === e.key" [style.--c]="colorOf(e)"
                           animate.enter="env-in" animate.leave="env-out">
                    <div class="env-head">
                      <div class="order" role="group" [attr.aria-label]="'Position de ' + title(e)">
                        <button type="button" class="btn ghost small icon" (click)="move(i, -1)" [disabled]="first" title="Monter"
                                [attr.aria-label]="'Monter ' + title(e)"><wl-nav-icon name="arrow-up" [size]="13" /></button>
                        <button type="button" class="btn ghost small icon" (click)="move(i, 1)" [disabled]="last" title="Descendre"
                                [attr.aria-label]="'Descendre ' + title(e)"><wl-nav-icon name="arrow-down" [size]="13" /></button>
                      </div>
                      <label class="field label-field">Libellé
                        <input [ngModel]="e.label" (ngModelChange)="setLabel(i, $event)" (blur)="touch(i)" maxlength="40" placeholder="ex. Production" autocomplete="off" /></label>
                      <label class="field name-field">Nom (liens, alertes)
                        @if (e.isNew) {
                          <input class="mono" [class.bad]="!!shownIssue(e)" [ngModel]="e.name" (ngModelChange)="setName(i, $event)" (blur)="touch(i)" maxlength="40"
                                 placeholder="production" spellcheck="false" autocomplete="off" />
                        } @else {
                          <span class="locked mono" title="Fixé à l'enregistrement : liens, alertes et tableaux l'utilisent."><wl-nav-icon name="lock" [size]="12" /><span class="ellipsis">{{ e.name }}</span></span>
                        }
                      </label>
                      <label class="check shown" title="Proposé dans le sélecteur de la barre du haut ; masqué, ses données restent accessibles (liens, alertes).">
                        <input type="checkbox" class="switch" [checked]="!e.hidden" (change)="patch(i, { hidden: !$any($event.target).checked })" />Sélecteur</label>
                      <button type="button" class="btn ghost small icon del" (click)="remove(i)" [title]="'Supprimer « ' + title(e) + ' »'"
                              [attr.aria-label]="'Supprimer ' + title(e)"><wl-nav-icon name="trash" [size]="13" /></button>
                    </div>
                    <div class="tones" role="radiogroup" [attr.aria-label]="'Couleur de ' + title(e)">
                      @for (k of kinds; track k.value) {
                        <button type="button" class="tone" [class.on]="!e.color && e.kind === k.value" [style.--t]="'var(--' + k.tone + ')'" role="radio"
                                [attr.aria-checked]="!e.color && e.kind === k.value" [title]="k.hint" (click)="setKind(i, k.value)"><span class="sw"></span><span class="ellipsis">{{ k.label }}</span></button>
                      }
                      <label class="tone custom" [class.on]="!!e.color" [style.--t]="e.color ?? 'var(--accent)'" title="Couleur au choix (le type reste celui choisi)">
                        <span class="sw"></span><span class="ellipsis">{{ e.color ? e.color.toUpperCase() : 'Personnalisée' }}</span>
                        <input type="color" [value]="e.color ?? '#0ea5e9'" (input)="setColor(i, $any($event.target).value)" aria-label="Couleur personnalisée" />
                      </label>
                    </div>
                    <div class="values" role="group" [attr.aria-label]="'Valeurs regroupées dans ' + title(e)">
                      @if (e.name) {
                        <span class="chip name-chip" title="Le nom de l'environnement en fait toujours partie"><wl-nav-icon name="lock" [size]="10" /><span class="chip-text">{{ e.name }}</span></span>
                      }
                      @for (a of e.aliases; track a) {
                        <span class="chip" animate.enter="chip-in" animate.leave="chip-out"><span class="chip-text" [title]="a">{{ a }}</span>
                          <button type="button" (click)="removeAlias(i, a)" [attr.aria-label]="'Retirer ' + a"><wl-nav-icon name="close" [size]="11" /></button></span>
                      }
                      <input #aliasBox list="wl-env-unmapped" (keydown)="aliasKey($event, i, aliasBox)" (blur)="addAlias(i, aliasBox)" spellcheck="false" autocomplete="off"
                             [placeholder]="e.aliases.length ? 'Ajouter…' : 'Valeurs reçues : prod, prd…'" [attr.aria-label]="'Valeur à regrouper dans ' + title(e)" />
                    </div>
                    <!-- Ligne d'état : résumé, ou le problème de la carte à sa place (la carte ne change pas de hauteur). -->
                    @if (cardIssue(e); as issue) {
                      <p class="env-foot small bad-text" role="alert"><wl-nav-icon name="warning" [size]="13" /><span>{{ issue }}</span></p>
                    } @else {
                      <p class="env-foot small" [title]="envApps(e)">{{ envSummary(e) }}</p>
                    }
                  </article>
                }
                <datalist id="wl-env-unmapped">
                  @for (v of unmapped(); track v) { <option [value]="v"></option> }
                </datalist>
                @if (envs().length && unmapped().length) {
                  <p class="loose small"><wl-nav-icon name="info" [size]="13" />
                    <span>Non regroupées, filtrées telles quelles : @for (v of unmapped(); track v) { <code>{{ v }}</code> }</span></p>
                }
                <div><button type="button" class="btn" (click)="addEnv()"><wl-nav-icon name="plus" [size]="14" />Ajouter un environnement</button></div>
              </div>
            </section>

            <section class="panel step" [class.done]="ownApps() > 0">
              <div class="step-head"><span class="num">2</span><h2>Par application</h2><span class="hint">valeurs reçues sur 30 jours et leur environnement</span></div>
              <div class="step-body">
                <p class="muted small">Chaque valeur suit la règle commune de l'étape 1. Une application peut nommer autrement ses environnements :
                  son « prod » peut être votre préproduction. Ce choix ne vaut que pour elle.</p>
                @for (app of appViews(); track app.service) {
                  <article class="app" [class.own]="app.own">
                    <div class="app-head">
                      <span class="avatar" [style.--hue]="hue(app.service)" aria-hidden="true">{{ initials(app.service) }}</span>
                      <strong class="ellipsis" [title]="app.service">{{ app.service }}</strong>
                      @if (app.own) { <span class="own-badge">Réglages propres</span> }
                    </div>
                    <div class="rows">
                      @for (v of app.values; track v.env) {
                        <div class="row">
                          <div class="raw"><code class="ellipsis" [title]="v.env">{{ v.env }}</code><span class="muted small ellipsis">{{ v.detail }}</span></div>
                          <select (change)="setMapping(app.service, v.env, $any($event.target).value)" [attr.aria-label]="'Environnement de « ' + v.env + ' » pour ' + app.service">
                            <option value="*" [selected]="v.choice === '*'" wlOpt="Règle commune" icon="layers" [desc]="v.general"></option>
                            @for (e of envs(); track e.key) {
                              @if (e.name) {
                                <option [value]="e.name" [selected]="v.choice === e.name" [wlOpt]="title(e)" dot [tone]="colorOf(e)" [desc]="e.name"></option>
                              }
                            }
                            <option value="" [selected]="v.choice === ''" [disabled]="v.isName" wlOpt="Ne pas regrouper" icon="close"
                                    [desc]="v.isName ? 'Impossible : c’est le nom d’un environnement' : 'Garder la valeur telle quelle'"></option>
                          </select>
                        </div>
                      }
                    </div>
                    @if (app.items.length) {
                      <div class="app-selector">
                        <span class="small muted">Sélecteur quand {{ app.service }} est choisie :</span>
                        <div class="chips">
                          @for (item of app.items; track item.name) {
                            <button type="button" class="chip toggle" [class.off]="item.hidden" [style.--c]="item.color" (click)="toggleHidden(app.service, item.name)"
                                    [attr.aria-pressed]="!item.hidden" [title]="item.hidden ? 'Masqué pour ' + app.service + ' : cliquer pour le proposer' : 'Proposé : cliquer pour le masquer pour ' + app.service">
                              <i class="dot"></i><span class="chip-text">{{ item.label }}</span><wl-nav-icon [name]="item.hidden ? 'close' : 'check'" [size]="11" /></button>
                          }
                        </div>
                      </div>
                    }
                  </article>
                } @empty {
                  <p class="muted small">Aucune application n'a envoyé de données ces 30 derniers jours.</p>
                }
              </div>
            </section>
          </div>

          <aside class="panel summary">
            <div class="block">
              <h3>Aperçu de la barre du haut</h3>
              <select class="preview-app" (change)="previewService.set($any($event.target).value)" aria-label="Application de l'aperçu">
                <option value="" [selected]="!previewService()" wlOpt="Tous les services" icon="layers"></option>
                @for (s of services(); track s) { <option [value]="s" [selected]="s === previewService()" [wlOpt]="s" avatar></option> }
              </select>
              <div class="preview">
                @if (preview().length && preview().length <= 4) {
                  <div class="seg env-seg" role="group" aria-label="Aperçu du sélecteur d'environnement" [style.--pill]="previewColor()">
                    <button type="button" [class.on]="!previewSelected()" (click)="previewEnv.set('')"><wl-nav-icon name="globe" [size]="13" />Tous</button>
                    @for (p of preview(); track p.name) {
                      <button type="button" [class.on]="p.name === previewSelected()" (click)="previewEnv.set(p.name)" [title]="p.desc">{{ p.label }}</button>
                    }
                  </div>
                } @else if (preview().length) {
                  <select (change)="previewEnv.set($any($event.target).value)" [class.active]="previewSelected()" aria-label="Aperçu du sélecteur d'environnement">
                    <option value="" [selected]="!previewSelected()" wlOpt="Tous les environnements" icon="globe" desc="Aucun filtre"></option>
                    @for (p of preview(); track p.name) {
                      <option [value]="p.name" [selected]="p.name === previewSelected()" [wlOpt]="p.label" icon="server" [tone]="p.color" [desc]="p.desc"></option>
                    }
                  </select>
                } @else {
                  <p class="muted small">Aucun environnement à proposer : le sélecteur n'apparaît pas.</p>
                }
              </div>
              @if (previewItem(); as p) {
                <p class="small detail"><i class="dot" [style.background]="p.color"></i>
                  <span><strong>{{ p.label }}</strong> <code>{{ p.name }}</code> · {{ p.configured ? 'regroupe ' + p.raw.join(', ') : 'valeur non regroupée' }} · {{ p.apps.join(', ') }}</span></p>
              }
              <p class="muted small">D'après les valeurs reçues sur 30 jours (la barre du haut regarde 7 jours). Jusqu'à 4 environnements : boutons ; au-delà : liste.</p>
            </div>
            <div class="block">
              <h3>En bref</h3>
              <ul class="facts small">
                <li><b class="num">{{ envs().length }}</b> environnement{{ envs().length > 1 ? 's' : '' }} configuré{{ envs().length > 1 ? 's' : '' }}</li>
                <li><b class="num">{{ counts().grouped }}</b> valeur{{ counts().grouped > 1 ? 's' : '' }} reçue{{ counts().grouped > 1 ? 's' : '' }} regroupée{{ counts().grouped > 1 ? 's' : '' }},
                  <b class="num">{{ counts().loose }}</b> telle{{ counts().loose > 1 ? 's' : '' }} quelle{{ counts().loose > 1 ? 's' : '' }}</li>
                <li><b class="num">{{ ownApps() }}</b> application{{ ownApps() > 1 ? 's' : '' }} avec des réglages propres</li>
              </ul>
            </div>
            <div class="block how small">
              <p>Un environnement regroupe son nom et ses valeurs, sans tenir compte des majuscules. Liens, alertes et tableaux utilisent son nom.</p>
              <p>Une valeur non regroupée, ou un ancien lien vers elle, se filtre telle quelle, comme avant.</p>
            </div>
            @if (saved()?.updatedAt; as at) {
              <div class="block muted small">Modifiés {{ at | ago }}@if (saved()?.updatedBy; as by) { par {{ by }}}.</div>
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
        <div class="panel empty">Impossible de lire les environnements.<div><button class="btn" (click)="load()"><wl-nav-icon name="refresh" [size]="14" />Réessayer</button></div></div>
      } @else {
        <section class="panel"><wl-skeleton [rows]="6" /></section>
      }
    </div>
  `,
  styles: `
    .step-head { flex-wrap: wrap; row-gap: 2px; }
    .unsaved { display: inline-flex; align-items: center; gap: 6px; color: var(--warn); font-weight: 550; }
    p { margin: 0; }
    code { font-size: 11.5px; }

    .intro { display: flex; align-items: flex-start; gap: 12px; padding: 14px; border-radius: var(--radius-sm);
      background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 12%, transparent), transparent 80%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent); }
    .intro-icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; color: var(--on-accent);
      background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 8px 18px -10px var(--accent); }
    .intro-text { display: grid; gap: 4px; min-width: 0; }
    .intro-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }

    /* Environnement : carte avec un liseré de sa couleur ; survol : bordure seulement (rien ne bouge). */
    .env { display: grid; gap: 10px; min-width: 0; padding: 12px 14px 12px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft);
      background: var(--surface-2); box-shadow: inset 3px 0 0 var(--c); transition: border-color .2s, box-shadow .3s; }
    .env:hover { border-color: color-mix(in srgb, var(--c) 40%, var(--border)); }
    .env.off { border-style: dashed; }
    .env.moved { animation: moved .45s var(--spring); }
    @keyframes moved { from { transform: scale(.98); } }
    .env-in { animation: env-in .4s var(--ease); }
    .env-out { animation: env-out .22s ease-in forwards; }
    @keyframes env-in { from { opacity: 0; transform: translateY(-6px); } }
    @keyframes env-out { to { opacity: 0; transform: scale(.97); } }
    .env-head { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 10px; min-width: 0; }
    .order { display: flex; flex-direction: column; gap: 2px; }
    .label-field { flex: 1 1 170px; min-width: 0; }
    .name-field { flex: 1 1 150px; min-width: 0; }
    /* Champs texte seulement : l'interrupteur « Sélecteur » garde sa taille (étiré, il passait sous la corbeille). */
    .env-head .field input { width: 100%; }
    input.bad { border-color: var(--danger); }
    .locked { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; min-width: 0; border-radius: var(--radius-sm);
      border: 1px dashed var(--border); color: var(--text-2); font-size: 12px; }
    .locked wl-nav-icon { color: var(--text-3); }
    .shown { height: 32px; font-size: 12px; }
    .del:hover { color: var(--danger); }
    .bad-text { display: flex; align-items: center; gap: 6px; color: var(--danger); }
    .bad-text wl-nav-icon { flex: none; }

    /* Couleur : un type par carte de choix, ou une couleur au choix (nuancier sous la carte). */
    .tones { display: flex; flex-wrap: wrap; gap: 6px; }
    .tone { position: relative; flex: 1 1 auto; display: flex; align-items: center; gap: 8px; height: 32px; min-width: 0; max-width: 100%; padding: 0 10px; border: 1px solid var(--border);
      border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text-2); font: 550 12px var(--sans); text-align: left; cursor: pointer;
      transition: border-color .2s, background-color .2s, color .2s, transform .3s var(--spring); }
    .tone:hover { transform: translateY(-1px); color: var(--text-1); border-color: color-mix(in srgb, var(--t) 55%, var(--border)); }
    .tone:active { transform: scale(.97); }
    .tone.on { color: var(--text-1); border-color: var(--t); box-shadow: inset 0 0 0 1px var(--t); background: color-mix(in srgb, var(--t) 14%, transparent); }
    .sw { flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--t); box-shadow: 0 0 0 3px color-mix(in srgb, var(--t) 22%, transparent); }
    .custom:not(.on) .sw { background: conic-gradient(from 200deg, #ef4444, #f59e0b, #22c55e, #06b6d4, #3b82f6, #ef4444); box-shadow: none; }
    .custom input { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; opacity: 0; cursor: pointer; }
    .custom input:focus { transform: none; box-shadow: none; }
    .custom:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }

    /* Valeurs regroupées : pastilles locales (aucun style global), saisie à la suite. */
    .values { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 36px; min-width: 0; padding: 4px 6px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--surface-2); transition: border-color .25s, box-shadow .35s var(--ease); }
    .values:focus-within { border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
    .values input { flex: 1; min-width: 120px; height: 26px; padding: 0 6px; border: 0; background: none; box-shadow: none; }
    .values input:focus { transform: none; box-shadow: none; background: none; }
    .chip { display: inline-flex; align-items: center; gap: 4px; min-width: 0; max-width: 100%; height: 24px; padding: 0 4px 0 10px; border-radius: 999px;
      font: 550 12px var(--mono); white-space: nowrap; color: var(--text-1);
      background: color-mix(in srgb, var(--c, var(--accent)) 14%, transparent); border: 1px solid color-mix(in srgb, var(--c, var(--accent)) 32%, transparent); }
    .chip-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .chip wl-nav-icon, .chip button { flex: none; }
    .chip button { display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 50%; background: none;
      color: var(--text-3); cursor: pointer; transition: color .2s, background-color .2s, transform .25s var(--spring); }
    .chip button:hover { color: var(--danger); background-color: color-mix(in srgb, var(--danger) 14%, transparent); transform: scale(1.1); }
    .name-chip { gap: 5px; padding: 0 10px 0 8px; color: var(--text-2); background: var(--surface-3); border-color: var(--border-soft); }
    .name-chip wl-nav-icon { color: var(--text-3); }
    .chip-in { animation: chip-in .35s var(--spring); }
    .chip-out { animation: chip-out .18s ease-in forwards; }
    @keyframes chip-in { from { opacity: 0; transform: scale(.7); } }
    @keyframes chip-out { to { opacity: 0; transform: scale(.7); } }
    .env-foot { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); }
    .env-foot.bad-text { align-items: flex-start; white-space: normal; color: var(--danger); }
    .env-foot.bad-text wl-nav-icon { margin-top: 1px; }
    .loose { display: flex; align-items: flex-start; gap: 8px; color: var(--text-2); }
    .loose wl-nav-icon { flex: none; margin-top: 2px; color: var(--accent); }
    .loose code { margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: var(--surface-3); }

    /* Applications : ce qu'elles envoient, et où cela va. */
    .app { display: grid; gap: 10px; min-width: 0; padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-soft);
      background: var(--surface-2); transition: border-color .2s; }
    .app:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--border)); }
    .app.own { border-color: color-mix(in srgb, var(--accent) 40%, var(--border-soft)); }
    .app-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .avatar { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; color: #fff; font: 700 10px/1 var(--sans);
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%)); box-shadow: inset 0 1px 0 rgb(255 255 255 / .35); }
    .own-badge { flex: none; margin-left: auto; padding: 1px 8px; border-radius: 999px; font: 600 11px/16px var(--sans); white-space: nowrap;
      color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent); }
    .rows { container-type: inline-size; display: grid; gap: 8px; }
    .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 240px); align-items: center; gap: 6px 12px; }
    .raw { display: grid; gap: 1px; min-width: 0; }
    .raw code { color: var(--text-1); }
    .row select { width: 100%; }
    @container (max-width: 440px) { .row { grid-template-columns: minmax(0, 1fr); } }
    .app-selector { display: grid; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-soft); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip.toggle { gap: 6px; padding: 0 9px 0 8px; font-family: var(--sans); cursor: pointer;
      transition: background-color .2s, border-color .2s, color .2s, transform .25s var(--spring); }
    .chip.toggle:hover { border-color: var(--c); }
    .chip.toggle:active { transform: scale(.95); }
    .chip.toggle wl-nav-icon { color: var(--text-3); }
    .chip.toggle.off { color: var(--text-3); background: none; border-style: dashed; text-decoration: line-through; }
    .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }

    /* Aperçu : sélecteur de la barre du haut (boutons, ou liste au-delà de 4) ; la pastille prend la couleur choisie. */
    .preview-app { width: 100%; }
    .preview { display: flex; align-items: center; min-width: 0; min-height: 36px; margin-top: 4px; }
    .preview select { width: 100%; border-radius: 999px; }
    .env-seg { flex-wrap: wrap; max-width: 100%; border-radius: 18px; }
    .env-seg button { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; }
    .env-seg::before { border-radius: 999px;
      background: color-mix(in srgb, var(--pill, var(--accent)) 30%, transparent);
      box-shadow: 0 4px 14px -6px var(--pill, var(--accent)), inset 0 0 0 1px color-mix(in srgb, var(--pill, var(--accent)) 50%, transparent), inset 0 1px 0 rgb(255 255 255 / .2);
      transition: left .45s var(--spring), width .45s var(--spring), top .3s var(--ease), height .3s var(--ease), background-color .35s, box-shadow .35s; }
    .detail { display: flex; align-items: baseline; gap: 8px; min-width: 0; color: var(--text-2); overflow-wrap: anywhere; }
    .detail .dot { position: relative; top: 1px; }
    .facts { margin: 0; padding-left: 18px; display: grid; gap: 3px; color: var(--text-2); }
    .facts b { color: var(--text-1); }
    .how { color: var(--text-2); line-height: 1.5; }
    .error { display: inline-flex; align-items: flex-start; gap: 6px; color: var(--danger); }
    .error wl-nav-icon { flex: none; margin-top: 2px; }
    .empty > div { margin-top: 12px; }
    .spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pop { animation: pop .4s var(--spring); }
    @keyframes pop { from { opacity: 0; transform: translateY(-4px) scale(.96); } }
    .fade-out { animation: fade-out .2s ease-in forwards; }
    @keyframes fade-out { to { opacity: 0; } }
    @media (max-width: 640px) {
      .sub { display: none; }
      .form-page .step > .step-body { padding: 12px 14px 16px; }
      .form-page .step > .step-head { padding: 14px 14px 0; }
      .env { padding: 10px 10px 10px 13px; }
    }
  `,
})
export class AdminEnvironmentsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly kinds = KINDS;
  protected readonly hue = hue;
  protected readonly initials = initials;

  /** Réglages enregistrés et valeurs reçues (null : chargement). */
  protected readonly saved = signal<EnvironmentAdmin | null>(null);
  protected readonly loadError = signal(false);
  protected readonly envs = signal<DraftEnv[]>([]);
  protected readonly apps = signal<AppEnvironments[]>([]);
  protected readonly busy = signal(false);
  protected readonly suggesting = signal(false);
  protected readonly error = signal('');
  /** Valeur refusée sous une carte (déjà regroupée ailleurs…). */
  protected readonly aliasError = signal<{ key: number; text: string } | null>(null);
  /** Carte qui vient de changer de place (petit rebond). */
  protected readonly moved = signal<number | null>(null);
  protected readonly previewService = signal('');
  protected readonly previewEnv = signal('');
  private nextKey = 1;
  private movedTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly seen = computed<EnvironmentUsage[]>(() => this.saved()?.seen ?? []);

  /** Règles en cours de saisie, comme le serveur : alias de l'application d'abord, puis noms, puis alias communs (sans casse). */
  private readonly rules = computed(() => {
    const everywhere = new Map<string, string>();
    for (const e of this.envs()) if (e.name && !everywhere.has(e.name.toLowerCase())) everywhere.set(e.name.toLowerCase(), e.name);
    for (const e of this.envs()) for (const a of e.aliases) if (e.name && !everywhere.has(a.toLowerCase())) everywhere.set(a.toLowerCase(), e.name);
    const apps = new Map<string, Map<string, string | null>>();
    for (const app of this.apps()) apps.set(app.service, new Map(Object.entries(app.aliases).map(([raw, target]) => [raw.toLowerCase(), target || null])));
    return { everywhere, apps };
  });

  /** Applications : celles qui ont envoyé des données sur 30 jours, et celles qui ont des réglages. */
  protected readonly services = computed(() =>
    [...new Set([...this.seen().map((u) => u.service), ...this.apps().map((a) => a.service)])].sort((a, b) => a.localeCompare(b)),
  );

  /** Valeurs reçues rattachées à aucun environnement par la règle commune (proposées à la saisie). */
  protected readonly unmapped = computed(() => {
    const { everywhere } = this.rules();
    const out = new Map<string, string>();
    for (const u of this.seen()) {
      const key = u.env.toLowerCase();
      if (!everywhere.has(key) && !out.has(key)) out.set(key, u.env);
    }
    return [...out.values()].sort((a, b) => a.localeCompare(b));
  });

  /** Valeurs reçues regroupées (pour au moins une application), et celles qui restent telles quelles partout. */
  protected readonly counts = computed(() => {
    const all = new Set<string>();
    const grouped = new Set<string>();
    for (const u of this.seen()) {
      all.add(u.env.toLowerCase());
      if (this.resolve(u.service, u.env)) grouped.add(u.env.toLowerCase());
    }
    return { grouped: grouped.size, loose: all.size - grouped.size };
  });

  protected readonly ownApps = computed(() => this.apps().filter((a) => Object.keys(a.aliases).length || a.hidden.length).length);

  /** Activité sur 30 jours de chaque environnement configuré (pied des cartes). */
  private readonly envStats = computed(() => {
    const map = new Map<string, { logs: number; apps: Set<string> }>();
    for (const u of this.seen()) {
      const name = this.resolve(u.service, u.env);
      if (!name) continue;
      const s = map.get(name) ?? { logs: 0, apps: new Set<string>() };
      s.logs += u.logs;
      s.apps.add(u.service);
      map.set(name, s);
    }
    return map;
  });

  protected readonly appViews = computed(() =>
    this.services().map((service) => {
      const own = this.apps().find((a) => a.service === service);
      const received = this.seen().filter((u) => u.service === service);
      const values: ValueRow[] = received.map((u) => this.row(u.env, u, own));
      // Réglage d'une valeur qui n'arrive plus : affiché, pour pouvoir le retirer.
      for (const raw of Object.keys(own?.aliases ?? {})) if (!received.some((u) => same(u.env, raw))) values.push(this.row(raw, null, own));
      const hidden = new Set((own?.hidden ?? []).map((h) => h.toLowerCase()));
      const items = this.items(service).map((item) => ({ ...item, hidden: hidden.has(item.name.toLowerCase()) }));
      // Masqué alors que l'application n'y envoie plus rien : affiché, pour pouvoir le retirer.
      for (const h of own?.hidden ?? []) {
        if (items.some((item) => same(item.name, h))) continue;
        const env = this.envs().find((e) => same(e.name, h));
        items.push({ name: h, label: env ? this.title(env) : h, color: env ? this.colorOf(env) : `var(--${guessEnvTone(h)})`, configured: !!env,
          raw: [], apps: [], logs: 0, hidden: true, desc: '' });
      }
      return { service, own: !!own && (Object.keys(own.aliases).length > 0 || own.hidden.length > 0), values, items };
    }),
  );

  /** Sélecteur de la barre du haut pour l'application de l'aperçu (sans ce qu'elle masque). */
  protected readonly preview = computed(() => {
    const service = this.previewService();
    const hidden = new Set((this.apps().find((a) => a.service === service)?.hidden ?? []).map((h) => h.toLowerCase()));
    return this.items(service).filter((item) => !hidden.has(item.name.toLowerCase()));
  });
  protected readonly previewSelected = computed(() => (this.preview().some((p) => p.name === this.previewEnv()) ? this.previewEnv() : ''));
  protected readonly previewItem = computed(() => this.preview().find((p) => p.name === this.previewSelected()) ?? null);
  protected readonly previewColor = computed(() => this.previewItem()?.color ?? 'var(--accent)');

  protected readonly introText = computed(() => {
    const values = [...new Map(this.seen().map((u) => [u.env.toLowerCase(), u.env])).values()].sort((a, b) => a.localeCompare(b));
    if (!values.length) return "Aucune valeur reçue ces 30 derniers jours : ajoutez les environnements à la main, ils s'appliqueront dès l'arrivée des données.";
    const shown = values.slice(0, 8).join(', ') + (values.length > 8 ? ` (+${values.length - 8})` : '');
    return `Reçues ces 30 jours : ${shown}. Regroupez celles qui désignent le même environnement.`;
  });

  protected readonly dirty = computed(() => {
    const s = this.saved();
    return !!s && this.snapshot(this.envs(), this.apps()) !== this.snapshot(s.environments, s.apps);
  });
  protected readonly blocked = computed(() => this.envs().some((e) => !!this.nameIssue(e)));
  protected readonly canSave = computed(() => this.dirty() && !this.busy() && !this.blocked());

  constructor() {
    this.load();
  }

  protected load() {
    this.loadError.set(false);
    this.api.environmentSettings().subscribe({
      next: (s) => {
        this.saved.set(s);
        this.reset();
      },
      error: () => this.loadError.set(true),
    });
  }

  /** Saisie ramenée aux réglages enregistrés ; les cartes déjà affichées restent en place (pas de nouvelle animation d'entrée). */
  protected reset() {
    const s = this.saved();
    if (!s) return;
    const keys = new Map(this.envs().filter((e) => e.name).map((e) => [e.name, e.key]));
    this.envs.set(s.environments.map((e) => ({ ...e, aliases: [...e.aliases], key: keys.get(e.name) ?? this.nextKey++, isNew: false, named: true })));
    this.apps.set(s.apps.map((a) => ({ service: a.service, aliases: { ...a.aliases }, hidden: [...a.hidden] })));
    this.error.set('');
    this.aliasError.set(null);
  }

  protected title(e: EnvironmentDefinition) {
    return e.label.trim() || e.name || 'Nouvel environnement';
  }

  protected colorOf(e: EnvironmentDefinition) {
    return e.color ?? `var(--${TONE[e.kind] ?? 'accent'})`;
  }

  /** Problème montré sur la carte : un nom manquant attend que le champ ait été quitté (pas de rouge dès l'ajout). */
  protected shownIssue(e: DraftEnv): string | null {
    const issue = this.nameIssue(e);
    return !e.name && !e.touched ? null : issue;
  }

  /** Ligne d'état de la carte : la valeur refusée à l'instant, sinon le problème du nom. */
  protected cardIssue(e: DraftEnv): string | null {
    const alias = this.aliasError();
    return alias?.key === e.key ? alias.text : this.shownIssue(e);
  }

  protected touch(i: number) {
    if (this.envs()[i] && !this.envs()[i].touched) this.patch(i, { touched: true });
  }

  protected nameIssue(e: DraftEnv): string | null {
    if (!e.isNew) return null;
    if (!e.name) return 'Donnez-lui un nom : il sert dans les liens et les alertes.';
    if (!NAME.test(e.name)) return 'Nom : lettres minuscules sans accent, chiffres, « - », « _ » ou « . ».';
    if (this.envs().some((o) => o.key !== e.key && same(o.name, e.name))) return 'Un autre environnement porte déjà ce nom.';
    const owner = this.envs().find((o) => o.key !== e.key && o.aliases.some((a) => same(a, e.name)));
    return owner ? `« ${e.name} » est déjà regroupé dans « ${this.title(owner)} ».` : null;
  }

  protected envSummary(e: DraftEnv) {
    const s = this.envStats().get(e.name);
    if (!e.name || !s) return 'Aucune donnée reçue sur 30 jours.';
    return `${formatNumber(s.logs)} logs sur 30 jours · ${s.apps.size} application${s.apps.size > 1 ? 's' : ''}`;
  }

  protected envApps(e: DraftEnv) {
    return [...(this.envStats().get(e.name)?.apps ?? [])].join(', ');
  }

  protected patch(i: number, change: Partial<DraftEnv>) {
    this.envs.update((list) => list.map((e, j) => (j === i ? { ...e, ...change } : e)));
  }

  protected addEnv() {
    const key = this.nextKey++;
    this.envs.update((list) => [...list, { key, isNew: true, named: false, name: '', label: '', kind: 'autre', color: null, order: list.length, hidden: false, aliases: [] }]);
    setTimeout(() => document.querySelector<HTMLInputElement>(`[data-env="${key}"] .label-field input`)?.focus(), 50);
  }

  /** Libellé ; tant qu'il n'est pas enregistré ni nommé à la main, le nom suit (« Préproduction » → preproduction). */
  protected setLabel(i: number, label: string) {
    const e = this.envs()[i];
    this.patch(i, { label });
    if (e.isNew && !e.named) this.rename(i, slug(label), false);
  }

  protected setName(i: number, value: string) {
    this.rename(i, value.trim().toLowerCase(), true);
  }

  private rename(i: number, name: string, manual: boolean) {
    const e = this.envs()[i];
    this.patch(i, { name, named: e.named || manual });
    if (e.name && e.name !== name && !this.shared(e)) this.retarget(e.name, name);
  }

  /** Un autre environnement porte le même nom (saisie en cours) : les réglages des applications ne le suivent pas. */
  private shared(e: DraftEnv) {
    return this.envs().some((o) => o.key !== e.key && o.name === e.name);
  }

  /** Réglages des applications qui suivent un environnement renommé (avant son premier enregistrement), ou supprimé (null). */
  private retarget(from: string, to: string | null) {
    this.apps.update((list) =>
      list
        .map((a) => ({
          service: a.service,
          aliases: Object.fromEntries(
            Object.entries(a.aliases).flatMap(([raw, target]) => (target !== from ? [[raw, target]] : to ? [[raw, to]] : [])),
          ),
          hidden: a.hidden.flatMap((h) => (h !== from ? [h] : to ? [to] : [])),
        }))
        .filter((a) => Object.keys(a.aliases).length || a.hidden.length),
    );
  }

  protected setKind(i: number, kind: EnvironmentKind) {
    this.patch(i, { kind, color: null });
  }

  protected setColor(i: number, color: string) {
    this.patch(i, { color: color.toLowerCase() });
  }

  /** Change de place (boutons ; le glisser-déposer serait fragile au clavier et au doigt). Le focus reste sur le bouton. */
  protected move(i: number, delta: number) {
    const j = i + delta;
    const list = this.envs();
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    this.envs.set(next);
    this.moved.set(list[i].key);
    clearTimeout(this.movedTimer);
    this.movedTimer = setTimeout(() => this.moved.set(null), 500);
  }

  protected remove(i: number) {
    const e = this.envs()[i];
    const shared = this.shared(e);
    this.envs.update((list) => list.filter((_, j) => j !== i));
    if (e.name && !shared) this.retarget(e.name, null);
    if (this.aliasError()?.key === e.key) this.aliasError.set(null);
  }

  protected aliasKey(event: KeyboardEvent, i: number, box: HTMLInputElement) {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      this.addAlias(i, box);
    } else if (event.key === 'Backspace' && !box.value) {
      const aliases = this.envs()[i]?.aliases ?? [];
      if (aliases.length) this.removeAlias(i, aliases[aliases.length - 1]);
    }
  }

  /** Valeurs saisies (séparées par des virgules) ; une valeur déjà regroupée ailleurs est refusée avec la raison. */
  protected addAlias(i: number, box: HTMLInputElement) {
    const values = box.value.split(/[,;]+/).map((v) => v.trim()).filter(Boolean);
    box.value = '';
    const env = this.envs()[i];
    if (!values.length || !env) return;
    const added: string[] = [];
    let refused = '';
    for (const value of values) {
      if (same(value, env.name) || env.aliases.some((a) => same(a, value)) || added.some((a) => same(a, value))) continue;
      const owner = this.envs().find((o) => o.key !== env.key && (same(o.name, value) || o.aliases.some((a) => same(a, value))));
      if (owner) refused = `« ${value} » est déjà regroupé dans « ${this.title(owner)} » : retirez-le d'abord de cet environnement.`;
      else if (value.length > 100) refused = 'Valeur trop longue : 100 caractères au plus.';
      else added.push(value);
    }
    this.aliasError.set(refused ? { key: env.key, text: refused } : null);
    if (added.length) this.patch(i, { aliases: [...env.aliases, ...added] });
  }

  protected removeAlias(i: number, alias: string) {
    this.patch(i, { aliases: this.envs()[i].aliases.filter((a) => a !== alias) });
  }

  // ------------------------------------------------------------------ applications

  /** Rattachement d'une valeur reçue d'une application avec les réglages en cours de saisie ; null : non regroupée. */
  private resolve(service: string, raw: string): string | null {
    const { everywhere, apps } = this.rules();
    const key = raw.toLowerCase();
    const own = apps.get(service);
    if (own?.has(key)) return own.get(key) ?? null;
    return everywhere.get(key) ?? null;
  }

  private row(raw: string, usage: EnvironmentUsage | null, own: AppEnvironments | undefined): ValueRow {
    const entry = Object.entries(own?.aliases ?? {}).find(([k]) => same(k, raw));
    const general = this.rules().everywhere.get(raw.toLowerCase());
    const target = this.envs().find((e) => e.name === general);
    return {
      env: raw,
      detail: usage
        ? `${formatNumber(usage.logs)} logs · ${formatNumber(usage.spans)} spans · ${timeAgo(usage.lastSeen)}`
        : 'rien reçu depuis 30 jours',
      choice: entry ? entry[1] : '*',
      general: target ? `→ ${this.title(target)}` : '→ telle quelle (non regroupée)',
      isName: this.envs().some((e) => same(e.name, raw)),
    };
  }

  /** '*' : règle commune ; nom : cet environnement pour cette application seulement ; '' : valeur gardée telle quelle. */
  protected setMapping(service: string, raw: string, value: string) {
    this.updateApp(service, (app) => {
      for (const k of Object.keys(app.aliases)) if (same(k, raw)) delete app.aliases[k];
      if (value !== '*') app.aliases[raw] = value;
    });
  }

  protected toggleHidden(service: string, name: string) {
    this.updateApp(service, (app) => {
      const i = app.hidden.findIndex((h) => same(h, name));
      if (i >= 0) app.hidden.splice(i, 1);
      else app.hidden.push(name);
    });
  }

  private updateApp(service: string, change: (app: AppEnvironments) => void) {
    this.apps.update((list) => {
      const next = list.map((a) => ({ service: a.service, aliases: { ...a.aliases }, hidden: [...a.hidden] }));
      let app = next.find((a) => a.service === service);
      if (!app) next.push((app = { service, aliases: {}, hidden: [] }));
      change(app);
      return next.filter((a) => Object.keys(a.aliases).length || a.hidden.length);
    });
  }

  /**
   * Sélecteur d'une application ('' : toutes), comme le calcule le serveur : environnements configurés dans leur ordre,
   * puis valeurs non regroupées par ordre alphabétique, sans les environnements masqués partout.
   */
  private items(service: string): SelectorItem[] {
    const envs = this.envs();
    const groups = new Map<string, { name: string; env: DraftEnv | null; raw: Set<string>; apps: Set<string>; logs: number }>();
    for (const u of this.seen()) {
      if (service && u.service !== service) continue;
      const resolved = this.resolve(u.service, u.env);
      const name = resolved ?? u.env;
      const key = name.toLowerCase();
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { name, env: resolved ? (envs.find((e) => e.name === resolved) ?? null) : null, raw: new Set(), apps: new Set(), logs: 0 }));
      group.raw.add(u.env);
      group.apps.add(u.service);
      group.logs += u.logs;
    }
    const position = (env: DraftEnv | null) => (env ? envs.indexOf(env) : envs.length);
    return [...groups.values()]
      .filter((g) => !g.env?.hidden)
      .sort((a, b) => position(a.env) - position(b.env) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      .map((g) => {
        const tone = g.env ? (TONE[g.env.kind] ?? 'accent') : guessEnvTone(g.name);
        return {
          name: g.name,
          label: g.env ? this.title(g.env) : g.name,
          color: g.env ? this.colorOf(g.env) : `var(--${tone})`,
          configured: !!g.env,
          raw: [...g.raw].sort((a, b) => a.localeCompare(b)),
          apps: [...g.apps].sort((a, b) => a.localeCompare(b)),
          logs: g.logs,
          hidden: false,
          desc: `${KIND_TEXT[tone] ?? ''} · ${formatNumber(g.logs)} logs · ${g.apps.size} service${g.apps.size > 1 ? 's' : ''}`,
        };
      });
  }

  // ------------------------------------------------------------------ enregistrement

  private input(): EnvironmentSettings {
    return {
      environments: this.envs().map((e, i) => ({
        name: e.name, label: e.label.trim() || e.name, kind: e.kind, color: e.color, order: i, hidden: e.hidden, aliases: e.aliases,
      })),
      apps: this.apps(),
    };
  }

  /** Forme comparable des réglages (ordre des clés et des applications fixé). */
  private snapshot(envs: EnvironmentDefinition[], apps: AppEnvironments[]) {
    const sorted = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify({
      environments: envs.map((e, i) => ({ name: e.name, label: e.label.trim() || e.name, kind: e.kind, color: e.color ?? null, hidden: !!e.hidden, aliases: e.aliases, i })),
      apps: apps
        .filter((a) => Object.keys(a.aliases).length || a.hidden.length)
        .map((a) => ({ service: a.service, aliases: sorted(a.aliases), hidden: a.hidden }))
        .sort((a, b) => a.service.localeCompare(b.service)),
    });
  }

  protected save() {
    if (!this.canSave()) return;
    this.busy.set(true);
    this.error.set('');
    this.api.saveEnvironmentSettings(this.input()).subscribe({
      next: (settings) => {
        this.busy.set(false);
        this.saved.update((s) => (s ? { ...s, ...settings } : s));
        this.reset();
        this.toasts.ok('Environnements enregistrés', 'layers');
        // Barre du haut, couleurs et libellés de toute l'interface : aussitôt.
        environmentsChanged();
        this.api.environmentStats().subscribe({ error: () => {} });
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Enregistrement impossible.');
        this.toasts.error(this.error());
      },
    });
  }

  /** « Regrouper automatiquement » : la saisie est complétée (rien n'est enregistré avant « Enregistrer »). */
  protected suggest() {
    if (!this.saved() || this.suggesting()) return;
    this.suggesting.set(true);
    this.api.suggestEnvironments(this.input()).subscribe({
      next: (p) => {
        this.suggesting.set(false);
        if (!p.grouped) {
          this.toasts.info('Rien à regrouper : les valeurs reçues sont déjà rattachées, ou ne ressemblent à aucun environnement usuel.', 'sparkles');
          return;
        }
        const drafts = new Map(this.envs().map((e) => [e.name, e]));
        const unnamed = this.envs().filter((e) => !e.name);
        this.envs.set([
          ...p.environments.map((e) => {
            const draft = drafts.get(e.name);
            return { ...e, aliases: [...e.aliases], key: draft?.key ?? this.nextKey++, isNew: draft?.isNew ?? true, named: draft?.named ?? true };
          }),
          ...unnamed,
        ]);
        const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
        this.toasts.ok(`${plural(p.grouped, 'valeur')} regroupée${p.grouped > 1 ? 's' : ''}${p.created ? `, ${plural(p.created, 'environnement')} proposé${p.created > 1 ? 's' : ''}` : ''} : vérifiez, puis enregistrez.`, 'sparkles');
      },
      error: (e) => {
        this.suggesting.set(false);
        this.toasts.error(e?.error?.error ?? 'Proposition impossible.');
      },
    });
  }
}
