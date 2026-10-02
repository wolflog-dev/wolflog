import { Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { Api } from '../core/api';
import { Dashboard, DashboardVariable, DataSource, FieldValue, Panel } from '../core/models';
import { isUsed, resolvePanel } from '../shared/dashboard-variables';
import { AppState } from '../core/app-state';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { NumPipe } from '../core/pipes/num-pipe';
import { DashboardPanel, panelAlertLink, panelDataLink, panelIcon, panelSections } from '../shared/dashboard-panel';
import { PanelEditor, newPanel } from '../shared/panel-editor';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { VisibilityPicker } from '../shared/visibility-picker';

@Component({
  selector: 'wl-dashboard',
  imports: [RouterLink, FormsModule, CdkDropList, CdkDrag, CdkDragHandle, DashboardPanel, PanelEditor, NavIcon, RichOption, NumPipe, VisibilityPicker],
  template: `
    <div class="page">
      <div class="page-head">
        <nav class="crumbs" aria-label="Fil d'Ariane">
          <a routerLink="/dashboards" class="crumb"><wl-nav-icon name="dashboards" [size]="14" />Tableaux de bord</a>
          <wl-nav-icon name="chevron-right" [size]="13" class="sep" />
        </nav>
        @if (dashboard(); as d) {
          @if (editing()) {
            <input class="name edit-in" [(ngModel)]="d.name" aria-label="Nom du tableau" />
            <input class="desc edit-in" [(ngModel)]="d.description" placeholder="Description (facultative)" aria-label="Description du tableau" />
            <span class="tag editing-tag"><wl-nav-icon name="pencil" [size]="12" />Édition</span>
            <span class="spacer"></span>
            <button class="btn edit-in" (click)="add()"><wl-nav-icon name="plus" [size]="14" />Ajouter un panneau</button>
            <button class="btn danger-text edit-in" (click)="remove()"><wl-nav-icon name="trash" [size]="14" />Supprimer le tableau</button>
            <button class="btn edit-in" (click)="cancelEdit()"><wl-nav-icon name="close" [size]="14" />Annuler</button>
            <button class="btn primary edit-in" (click)="save()" [disabled]="saving()">
              <wl-nav-icon [name]="saving() ? 'refresh' : 'check'" [size]="14" [class.spin]="saving()" />{{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
          } @else {
            <h1 class="ellipsis title" [title]="d.name">{{ d.name }}</h1>
            @if (d.description) { <span class="muted small ellipsis desc-text" [title]="d.description">{{ d.description }}</span> }
            <span class="spacer"></span>
            @if (saving()) { <span class="muted small saving"><wl-nav-icon name="refresh" [size]="13" class="spin" />Enregistrement…</span> }
            @if (session.canEdit()) {
              <button class="btn edit-in" (click)="add()"><wl-nav-icon name="plus" [size]="14" />Ajouter un panneau</button>
              <button class="btn edit-in" (click)="duplicateDashboard()" [disabled]="duplicating()">
                <wl-nav-icon [name]="duplicating() ? 'refresh' : 'copy'" [size]="14" [class.spin]="duplicating()" />Dupliquer
              </button>
              <button class="btn edit-in" (click)="startEdit()" title="Réordonner les panneaux, gérer les variables et « Visible pour », renommer"><wl-nav-icon name="edit" [size]="14" />Réorganiser</button>
            }
          }
        } @else if (!notFound()) {
          <i class="skeleton" style="width: 220px; height: 22px" aria-busy="true"></i>
        }
      </div>

      @if (editing()) {
        <p class="muted small hint"><wl-nav-icon name="info" [size]="14" />Glissez les panneaux par leur poignée pour les réordonner. Les changements sont appliqués à l'enregistrement.</p>
        <section class="panel vis-editor">
          <div class="panel-head">
            <h2><wl-nav-icon name="eye" [size]="15" />Visible pour</h2>
            <span class="muted small">qui trouve ce tableau dans la liste et la recherche ; les administrateurs voient tout</span>
          </div>
          <div class="vis-body">
            <wl-visibility-picker [value]="dashboard()?.visibleTo ?? []" (valueChange)="setVisibility($event)" />
          </div>
        </section>
        <section class="panel vars-editor">
          <div class="panel-head">
            <h2><wl-nav-icon name="filter" [size]="15" />Variables</h2>
            <span class="muted small">une liste de choix dans l'en-tête ; dans un panneau, écrire <code>$nom</code> (filtre, service, regroupement, titre), ex. <code>http.route:$route</code></span>
            <span class="spacer"></span>
            <button class="btn small" (click)="addVariable()"><wl-nav-icon name="plus" [size]="13" />Ajouter une variable</button>
          </div>
          @for (v of dashboard()?.variables ?? []; track $index; let i = $index) {
            <div class="var-row" animate.enter="row-in">
              <label>Nom <input [ngModel]="v.name" (ngModelChange)="patchVariable(i, { name: $event })" placeholder="route" class="mono" /></label>
              <label>Libellé <input [ngModel]="v.label ?? ''" (ngModelChange)="patchVariable(i, { label: $event })" [placeholder]="v.name" /></label>
              <label>Valeurs de
                <select [ngModel]="v.source" (ngModelChange)="patchVariable(i, { source: $event })">
                  <option value="spans" wlOpt="traces" icon="traces"></option>
                  <option value="logs" wlOpt="logs" icon="logs"></option>
                  <option value="metrics" wlOpt="métriques" icon="metrics"></option>
                </select>
              </label>
              <label>Champ <input [ngModel]="v.field" (ngModelChange)="patchVariable(i, { field: $event })" placeholder="http.route" class="mono" [attr.list]="'fields-' + v.source" /></label>
              <span class="usage" [class.on]="used(v)" [title]="used(v) ? 'Au moins un panneau utilise $' + v.name : 'Écrire $' + v.name + ' dans un panneau pour l’utiliser'"><i></i>{{ used(v) ? 'utilisée' : 'pas encore utilisée' }}</span>
              <span class="spacer"></span>
              <button class="btn ghost small danger-text" (click)="removeVariable(i)"><wl-nav-icon name="trash" [size]="13" />Retirer</button>
            </div>
          } @empty {
            <p class="muted small empty-vars">Aucune variable. Exemple : « route » sur le champ http.route des traces, pour afficher les panneaux d'une seule route.</p>
          }
          @for (src of sources; track src) {
            <datalist [id]="'fields-' + src">@for (f of fieldList()[src] ?? []; track f) { <option [value]="f"></option> }</datalist>
          }
        </section>
      } @else if (dashboard()?.variables?.length) {
        <div class="vars">
          <span class="vars-icon" title="Variables du tableau : filtrent tous les panneaux qui les utilisent"><wl-nav-icon name="filter" [size]="14" /></span>
          @for (v of dashboard()!.variables!; track v.name) {
            <label [class.set]="!!values()[v.name]">{{ v.label || v.name }}
              <select [ngModel]="values()[v.name] ?? ''" (ngModelChange)="setValue(v.name, $event)">
                <option value="" wlOpt="Tous" icon="layers" tone="muted"></option>
                @for (o of options()[v.name] ?? []; track o.value) {
                  <option [value]="o.value" [wlOpt]="o.value" [avatar]="isServiceField(v.field)" [meta]="o.count | num" metaTone="muted"></option>
                }
                @if (missing(v.name); as m) { <option [value]="m" [wlOpt]="m" icon="link" desc="Valeur du lien partagé"></option> }
              </select>
            </label>
          }
          @if (customized()) {
            <button class="btn ghost small reset" (click)="resetValues()" title="Revenir aux valeurs par défaut"><wl-nav-icon name="refresh" [size]="13" />Réinitialiser</button>
          }
        </div>
      }

      @if (dashboard()?.hiddenPanels; as n) {
        <p class="muted small hidden-note"><wl-nav-icon name="lock" [size]="13" />{{ hiddenText(n) }}</p>
      }

      @if (dashboard(); as d) {
        <div class="grid" cdkDropList cdkDropListOrientation="mixed" [cdkDropListDisabled]="!editing()" (cdkDropListDropped)="drop($event)">
          @for (p of d.panels; track p.id; let i = $index) {
            <section #cell class="panel cell" cdkDrag animate.enter="cell-in" animate.leave="cell-out" [attr.data-panel]="p.id" [style.--i]="i"
                     [style.grid-column]="'span ' + (expanded() === p.id ? 12 : p.width)" [class.editing]="editing()" [class.expanded]="expanded() === p.id">
              <div class="panel-head">
                @if (editing()) { <span class="grip" cdkDragHandle title="Déplacer" aria-label="Déplacer le panneau">⠿</span> }
                <span class="p-icon"><wl-nav-icon [name]="iconOf(p)" [size]="14" /></span>
                <h2 class="ellipsis" [title]="p.title">{{ (resolved().get(p.id) ?? p).title }}</h2>
                <span class="spacer"></span>
                <div class="tools" [class.always]="editing()">
                  @if (editing()) {
                    <button class="tool" type="button" (click)="edit(p)" title="Configurer" aria-label="Configurer le panneau"><wl-nav-icon name="edit" [size]="14" /></button>
                    <button class="tool" type="button" (click)="duplicate(p)" title="Dupliquer" aria-label="Dupliquer le panneau"><wl-nav-icon name="copy" [size]="14" /></button>
                    <button class="tool danger" type="button" (click)="removePanel(p)" title="Retirer" aria-label="Retirer le panneau"><wl-nav-icon name="trash" [size]="14" /></button>
                  } @else {
                    <!-- Panneau large : actions directes. Panneau étroit : un seul bouton « ⋯ » (le titre garde sa place). -->
                    @if (session.canEdit()) {
                      <button class="tool wide" type="button" (click)="edit(p)" title="Modifier" aria-label="Modifier le panneau"><wl-nav-icon name="edit" [size]="14" /></button>
                    }
                    <button class="tool wide" type="button" (click)="toggleExpand(p, cell)" [title]="expanded() === p.id ? 'Réduire (Échap)' : 'Agrandir'"
                            [attr.aria-label]="expanded() === p.id ? 'Réduire le panneau' : 'Agrandir le panneau'" [attr.aria-pressed]="expanded() === p.id">
                      <wl-nav-icon [name]="expanded() === p.id ? 'close' : 'external'" [size]="14" />
                    </button>
                    @if (canSee(p)) { <a class="tool wide" [routerLink]="link(p).path" [queryParams]="link(p).query" title="Voir les données" aria-label="Voir les données"><wl-nav-icon name="table" [size]="14" /></a> }
                    @if (canAlert(p)) {
                      <a class="tool wide" routerLink="/alerts/new" [queryParams]="alertLink(p)" title="Créer une alerte à partir de ce panneau" aria-label="Créer une alerte"><wl-nav-icon name="bell" [size]="14" /></a>
                    }
                    <button class="tool more" type="button" (click)="menuFor.set(menuFor() === p.id ? null : p.id)" title="Actions du panneau"
                            aria-label="Actions du panneau" aria-haspopup="menu" [attr.aria-expanded]="menuFor() === p.id"><wl-nav-icon name="more" [size]="14" /></button>
                  }
                </div>
                @if (menuFor() === p.id && !editing()) {
                  <div class="p-menu" role="menu" animate.enter="p-menu-in" animate.leave="p-menu-out">
                    @if (session.canEdit()) {
                      <button type="button" role="menuitem" (click)="menuFor.set(null); edit(p)"><wl-nav-icon name="edit" [size]="14" />Modifier</button>
                    }
                    <button type="button" role="menuitem" (click)="menuFor.set(null); toggleExpand(p, cell)">
                      <wl-nav-icon [name]="expanded() === p.id ? 'close' : 'external'" [size]="14" />{{ expanded() === p.id ? 'Réduire' : 'Agrandir' }}</button>
                    @if (canSee(p)) {
                      <a role="menuitem" [routerLink]="link(p).path" [queryParams]="link(p).query" (click)="menuFor.set(null)"><wl-nav-icon name="table" [size]="14" />Voir les données</a>
                    }
                    @if (canAlert(p)) {
                      <a role="menuitem" routerLink="/alerts/new" [queryParams]="alertLink(p)" (click)="menuFor.set(null)"><wl-nav-icon name="bell" [size]="14" />Créer une alerte</a>
                    }
                  </div>
                }
              </div>
              <div class="panel-body">
                <wl-dashboard-panel [panel]="resolved().get(p.id) ?? p" [heightOverride]="expanded() === p.id ? 460 : null" />
              </div>
            </section>
          } @empty {
            <div class="panel empty whole">
              <p class="lead">Ce tableau est vide.</p>
              <p class="small">Ajoutez des courbes, des chiffres clés, des classements ou les derniers logs : chaque panneau suit la période et le service choisis en haut.</p>
              @if (session.canEdit()) { <button class="btn primary" (click)="add()"><wl-nav-icon name="plus" [size]="14" />Ajouter un premier panneau</button> }
            </div>
          }
        </div>
      } @else if (notFound()) {
        <div class="panel empty">
          @if (refusal(); as why) {
            <p class="lead">Tableau de bord hors de votre profil d'accès.</p>
            <p class="small">{{ why }}</p>
          } @else {
            <p class="lead">Tableau de bord introuvable.</p>
            <p class="small">Il a peut-être été supprimé, ou le lien est incomplet.</p>
          }
          <a class="btn" routerLink="/dashboards"><wl-nav-icon name="dashboards" [size]="14" />Retour à la liste</a>
        </div>
      } @else {
        <div class="grid" aria-busy="true">
          @for (w of ghosts; track $index; let i = $index) {
            <div class="panel ghost-cell" [style.grid-column]="'span ' + w" [style.--i]="i">
              <div class="panel-head"><i class="skeleton" style="width: 22px; height: 22px; border-radius: 8px"></i><i class="skeleton" style="width: 38%; height: 11px"></i></div>
              <div class="panel-body"><i class="skeleton" style="height: 196px"></i></div>
            </div>
          }
        </div>
      }
    </div>

    @if (editingPanel(); as p) {
      <wl-panel-editor animate.leave="editor-out" [panel]="p" [isNew]="isNewPanel()" (save)="applyPanel($event)" (cancel)="editingPanel.set(null)" />
    }
  `,
  styles: `
    .crumbs { display: inline-flex; align-items: center; gap: 4px; }
    .crumb { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px 4px 7px; border-radius: 999px; font-size: 12px; color: var(--text-3);
      transition: background-color .2s, color .2s; }
    .crumb:hover { color: var(--text-1); background: var(--surface-3); text-decoration: none; }
    .crumb wl-nav-icon { transition: transform .4s var(--spring); }
    .crumb:hover wl-nav-icon { transform: rotate(-8deg) scale(1.12); }
    .sep { color: var(--text-3); opacity: .55; }
    .title { min-width: 0; max-width: 42vw; }
    .desc-text { min-width: 0; max-width: 28vw; }
    .name { width: 240px; font-weight: 600; }
    .desc { width: 300px; }
    .edit-in { animation: edit-in .4s var(--ease) backwards; }
    @keyframes edit-in { from { opacity: 0; transform: translateY(-4px); } }
    .editing-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; border-color: transparent; color: var(--accent); background: var(--accent-soft);
      font-family: var(--sans); animation: tag-pop .5s var(--spring) backwards; }
    @keyframes tag-pop { from { opacity: 0; transform: scale(.5); } }
    .danger-text { color: var(--danger); }
    .btn.danger-text:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
    .saving { display: inline-flex; align-items: center; gap: 6px; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint { margin: -6px 0 0; display: flex; align-items: center; gap: 8px; }
    .hint wl-nav-icon { color: var(--accent); }
    /* Variables : barre de filtres au-dessus des panneaux. */
    .vars { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: -4px; }
    .vars-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: var(--accent); background: var(--accent-soft); }
    .vars label, .var-row label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
    .vars select { min-width: 180px; }
    .vars label.set { color: var(--text-1); }
    .vars label.set select { border-color: var(--accent); background-color: var(--accent-soft); }
    .reset wl-nav-icon { transition: transform .5s var(--spring); }
    .reset:hover wl-nav-icon { transform: rotate(-180deg); }
    .vars-editor .panel-head, .vis-editor .panel-head { flex-wrap: wrap; }
    .vars-editor h2, .vis-editor h2 { display: inline-flex; align-items: center; gap: 8px; }
    .vars-editor h2 wl-nav-icon, .vis-editor h2 wl-nav-icon { color: var(--accent); }
    /* « Visible pour » (mode édition) et panneaux masqués (hors du profil d'accès). */
    .vis-body { padding: 10px 12px 12px; }
    .hidden-note { margin: -6px 0 0; display: flex; align-items: center; gap: 7px; }
    .hidden-note wl-nav-icon { color: var(--text-3); }
    .var-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border-soft); }
    .var-row:last-of-type { border-bottom: 0; }
    .var-row input { width: 150px; }
    .row-in { animation: row-in .4s var(--ease); }
    @keyframes row-in { from { opacity: 0; transform: translateY(-6px); } }
    .usage { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-3); }
    .usage i { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); opacity: .55; transition: background-color .3s, opacity .3s, transform .4s var(--spring); }
    .usage.on { color: var(--ok); }
    .usage.on i { background: var(--ok); opacity: 1; transform: scale(1.2); }
    .empty-vars { margin: 0; padding: 10px 12px; }
    /* Grille des panneaux : entrée en cascade, sortie en fondu, mise en avant du panneau agrandi. */
    .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 14px; }
    .cell { min-width: 0; }
    .cell-in { animation: cell-in .5s var(--ease) backwards; animation-delay: min(calc(var(--i) * 45ms), 360ms); }
    @keyframes cell-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
    .cell-out { animation: cell-out .25s ease-in forwards; }
    @keyframes cell-out { to { opacity: 0; transform: scale(.94); } }
    .cell.expanded { animation: cell-grow .5s var(--spring) backwards;
      box-shadow: var(--shadow-pop), inset 0 1px 0 var(--highlight), 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
    @keyframes cell-grow { from { opacity: .4; transform: scale(.97); } }
    .cell.editing { outline: 1px dashed color-mix(in srgb, var(--accent) 35%, var(--border)); outline-offset: 3px; }
    .grip { display: grid; place-items: center; width: 22px; height: 24px; margin-left: -6px; border-radius: 7px; cursor: grab; color: var(--text-3);
      user-select: none; transition: background-color .15s, color .15s; }
    .grip:hover { color: var(--accent); background: var(--accent-soft); }
    .grip:active { cursor: grabbing; }
    .cell .panel-head { position: relative; gap: 8px; }
    .p-icon { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 8px; color: var(--accent);
      background: color-mix(in srgb, var(--accent) 12%, transparent); transition: transform .4s var(--spring); }
    .cell:hover .p-icon { transform: rotate(-8deg) scale(1.08); }
    /*
     * Outils : toujours à leur place, à droite du titre (invisibles hors survol). Ils ne recouvrent jamais le titre
     * (coupé avant eux par « … ») et rien ne bouge ni ne grandit au survol.
     */
    .cell .panel-head h2 { min-width: 0; }
    .cell { container-type: inline-size; }
    .tool.more { display: none; }
    @container (max-width: 400px) {
      .tool.wide { display: none; }
      .tool.more { display: grid; }
    }
    .p-menu { position: absolute; z-index: 5; top: calc(100% - 6px); right: 10px; display: grid; min-width: 190px; padding: 5px;
      border: 1px solid var(--border); border-radius: 12px; background: var(--surface-solid); box-shadow: var(--shadow-pop);
      backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); transform-origin: top right; }
    .p-menu > * { display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: none;
      color: var(--text-1); font: 500 13px var(--sans); text-align: left; cursor: pointer; }
    .p-menu > :hover { background: var(--surface-3); text-decoration: none; }
    .p-menu wl-nav-icon { color: var(--text-3); }
    .p-menu-in { animation: p-menu-in .22s var(--ease); }
    .p-menu-out { animation: p-menu-out .15s ease-in forwards; }
    @keyframes p-menu-in { from { opacity: 0; transform: translateY(-4px) scale(.96); } }
    @keyframes p-menu-out { to { opacity: 0; transform: translateY(-4px) scale(.97); } }
    .tools { flex: none; display: flex; gap: 2px; padding: 2px; border: 1px solid transparent; border-radius: 999px;
      opacity: 0; pointer-events: none; transition: opacity .2s var(--ease), background-color .2s, border-color .2s; }
    .cell:hover .tools, .cell:focus-within .tools, .tools.always { opacity: 1; pointer-events: auto; border-color: var(--border); background: var(--surface-2); }
    .tool { display: grid; place-items: center; width: 24px; height: 24px; border: 0; border-radius: 50%; background: none; color: var(--text-2);
      cursor: pointer; transition: background-color .15s, color .15s, transform .3s var(--spring); }
    .tool:hover { background: var(--surface-3); color: var(--text-1); transform: scale(1.1); text-decoration: none; }
    .tool:active { transform: scale(.9); }
    .tool.danger:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .cell:hover .tools:not(.always) .tool { animation: tool-in .35s var(--spring) backwards; }
    .cell:hover .tools:not(.always) .tool:nth-child(2) { animation-delay: 30ms; }
    .cell:hover .tools:not(.always) .tool:nth-child(3) { animation-delay: 60ms; }
    .cell:hover .tools:not(.always) .tool:nth-child(4) { animation-delay: 90ms; }
    @keyframes tool-in { from { opacity: 0; transform: scale(.5); } }
    .panel-body { padding: 8px 10px; }
    .btn.small { height: 26px; font-size: 12px; padding: 0 9px; gap: 5px; }
    .whole { grid-column: span 12; display: grid; justify-items: center; gap: 10px; }
    .empty p { margin: 0; }
    .empty .lead { font-size: 14px; font-weight: 600; color: var(--text-1); }
    .empty .small { max-width: 460px; margin: 0 auto; }
    .empty .btn { margin-top: 6px; }
    /* Glisser-déposer : l'aperçu se soulève, l'emplacement d'arrivée est marqué. */
    .cell.cdk-drag-preview { scale: 1.02; rotate: .6deg; opacity: .95; cursor: grabbing;
      box-shadow: var(--shadow-pop), 0 0 0 1px color-mix(in srgb, var(--accent) 60%, transparent); }
    .cell.cdk-drag-placeholder { outline: 2px dashed var(--accent); outline-offset: 3px; background: var(--accent-soft); box-shadow: none; }
    .cell.cdk-drag-placeholder > * { opacity: .3; }
    .cell.cdk-drag-animating { transition: transform .3s var(--ease); }
    .grid.cdk-drop-list-dragging { cursor: grabbing; }
    /* Chargement : panneaux fantômes. */
    .ghost-cell { min-width: 0; animation: ghost-in .45s var(--ease) backwards; animation-delay: calc(var(--i) * 60ms); }
    .ghost-cell .panel-head { gap: 10px; }
    @keyframes ghost-in { from { opacity: 0; transform: translateY(10px); } }
    @media (hover: none) {
      .tools { opacity: 1; pointer-events: auto; }
    }
    @media (max-width: 900px) { .cell, .ghost-cell { grid-column: span 12 !important; } .title, .desc-text { max-width: none; } }
  `,
  host: { '(document:keydown.escape)': 'expanded.set(null); menuFor.set(null)', '(document:pointerdown)': 'closeMenu($event)' },
})
export class DashboardPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly session = inject(Session);
  readonly id = input.required<string>();
  /** ?edit=1 : ouvre directement en édition (nouveau tableau). */
  readonly edit$ = input<string | null>(null, { alias: 'edit' });

  protected readonly dashboard = signal<Dashboard | null>(null);
  protected readonly editing = signal(false);
  protected readonly editingPanel = signal<Panel | null>(null);
  protected readonly isNewPanel = signal(false);
  protected readonly expanded = signal<string | null>(null);
  /** Panneau dont le menu « ⋯ » est ouvert (panneaux étroits). */
  protected readonly menuFor = signal<string | null>(null);

  /** Un clic hors du menu « ⋯ » le ferme. */
  protected closeMenu(e: PointerEvent) {
    if (this.menuFor() && !(e.target as Element | null)?.closest?.('.p-menu, .tool.more')) this.menuFor.set(null);
  }

  /** Une alerte peut être créée depuis les panneaux à valeur (pas depuis la liste de logs ni une métrique brute). */
  protected canAlert(p: Panel) {
    return this.session.canEdit() && this.session.can('alerts') && p.type !== 'logs-table' && p.type !== 'metric';
  }

  /** Page des données du panneau ouverte par le profil d'accès (sinon le lien mènerait à un refus). */
  protected canSee(p: Panel) {
    return this.session.can(panelSections(p));
  }
  protected readonly saving = signal(false);
  protected readonly duplicating = signal(false);
  protected readonly notFound = signal(false);
  /** Refus du serveur (tableau hors du profil d'accès), affiché à la place de « introuvable ». */
  protected readonly refusal = signal<string | null>(null);
  protected readonly link = panelDataLink;
  protected readonly alertLink = panelAlertLink;
  protected readonly iconOf = panelIcon;
  /** Largeurs des panneaux fantômes pendant le chargement. */
  protected readonly ghosts = [6, 6, 4, 8];
  private backup: Dashboard | null = null;
  private readonly state = inject(AppState);
  protected readonly sources: DataSource[] = ['spans', 'logs', 'metrics'];

  /** Valeurs choisies pour les variables (aussi dans l'adresse : var-nom=valeur, lien partageable). */
  protected readonly values = signal<Record<string, string>>({});
  protected readonly options = signal<Record<string, FieldValue[]>>({});
  protected readonly fieldList = signal<Record<string, string[]>>({});
  /** Panneaux avec les variables remplacées (même objet tant que rien ne change : pas de rechargement inutile). */
  protected readonly resolved = computed(() => {
    const d = this.dashboard();
    const map = new Map<string, Panel>();
    if (!d) return map;
    for (const p of d.panels) map.set(p.id, resolvePanel(p, d.variables ?? [], this.values()));
    return map;
  });
  /** Au moins une variable s'écarte de sa valeur par défaut (bouton « Réinitialiser »). */
  protected readonly customized = computed(() =>
    (this.dashboard()?.variables ?? []).some((v) => (this.values()[v.name] ?? '') !== (v.default ?? '')),
  );

  constructor() {
    effect(() => {
      const id = this.id();
      untracked(() => {
        // Autre tableau (copie tout juste créée, recherche globale) : squelette, et ni édition ni panneau agrandi hérités.
        if (this.dashboard() && this.dashboard()!.id !== id) {
          this.dashboard.set(null);
          this.editing.set(false);
          this.expanded.set(null);
        }
        this.notFound.set(false);
        this.api.dashboard(id).subscribe({
          next: (d) => {
            this.dashboard.set(d);
            this.notFound.set(false);
            this.initValues(d);
            if (this.edit$() && !d.panels.length) this.add();
          },
          error: (e: { status?: number; error?: { error?: string } }) => {
            this.refusal.set(e?.status === 403 ? e.error?.error ?? 'Ce tableau de bord n’entre pas dans votre profil d’accès.' : null);
            this.notFound.set(true);
          },
        });
      });
    });
  }

  private initValues(d: Dashboard) {
    const url = new URLSearchParams(location.search);
    const values: Record<string, string> = {};
    for (const v of d.variables ?? []) values[v.name] = url.get('var-' + v.name) ?? v.default ?? '';
    this.values.set(values);
    this.loadOptions();
  }

  /** Valeurs proposées : les plus fréquentes sur la période affichée. */
  private loadOptions() {
    for (const v of this.dashboard()?.variables ?? []) {
      if (!v.name || !v.field) continue;
      this.api.fieldValues(this.state.range(), v.source, v.field).subscribe({
        next: (list) => this.options.update((o) => ({ ...o, [v.name]: list })),
        error: () => {},
      });
    }
  }

  /** Valeur choisie (lien partagé) absente des valeurs récentes : on la garde dans la liste. */
  protected missing(name: string) {
    const value = this.values()[name];
    return value && !(this.options()[name] ?? []).some((o) => o.value === value) ? value : null;
  }

  protected setValue(name: string, value: string) {
    this.values.update((v) => ({ ...v, [name]: value }));
    this.router.navigate([], { queryParams: { ['var-' + name]: value || null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Revient aux valeurs par défaut de toutes les variables (et les retire de l'adresse). */
  protected resetValues() {
    const vars = this.dashboard()?.variables ?? [];
    this.values.set(Object.fromEntries(vars.map((v) => [v.name, v.default ?? ''])));
    this.router.navigate([], { queryParams: Object.fromEntries(vars.map((v) => ['var-' + v.name, null])), queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Variable portant sur le service : valeurs affichées avec leur pastille de couleur. */
  protected isServiceField(field: string) {
    return field === 'service' || field === 'service.name';
  }

  protected used(v: DashboardVariable) {
    return isUsed(v, this.dashboard()?.panels ?? []);
  }

  protected addVariable() {
    const d = this.dashboard();
    if (!d) return;
    this.dashboard.set({ ...d, variables: [...(d.variables ?? []), { name: 'route', label: 'Route', field: 'http.route', source: 'spans' }] });
    for (const src of this.sources) {
      if (this.fieldList()[src]) continue;
      this.api.fields(this.state.range(), src).subscribe((f) => this.fieldList.update((l) => ({ ...l, [src]: f.map((x) => x.key) })));
    }
  }

  protected patchVariable(i: number, change: Partial<DashboardVariable>) {
    const d = this.dashboard();
    if (!d?.variables) return;
    this.dashboard.set({ ...d, variables: d.variables.map((v, j) => (j === i ? { ...v, ...change } : v)) });
  }

  protected removeVariable(i: number) {
    const d = this.dashboard();
    if (!d?.variables) return;
    this.dashboard.set({ ...d, variables: d.variables.filter((_, j) => j !== i) });
  }

  /** « Visible pour » changé en mode édition : enregistré avec le reste du tableau. */
  protected setVisibility(visibleTo: string[]) {
    const d = this.dashboard();
    if (d) this.dashboard.set({ ...d, visibleTo });
  }

  /** Ligne discrète sur les panneaux retirés de la vue (hors du profil d'accès). */
  protected hiddenText(n: number) {
    const text = n > 1 ? `${n} panneaux masqués : hors de votre profil d'accès` : `1 panneau masqué : hors de votre profil d'accès`;
    if (!this.editing()) return text;
    return text + (n > 1 ? ' (ils gardent leur place à l’enregistrement)' : ' (il garde sa place à l’enregistrement)');
  }

  startEdit() {
    this.backup = structuredClone(this.dashboard());
    this.expanded.set(null);
    this.editing.set(true);
  }

  cancelEdit() {
    this.dashboard.set(this.backup);
    this.editing.set(false);
  }

  save() {
    this.persist(() => {
      this.editing.set(false);
      this.toasts.ok('Tableau enregistré');
    });
  }

  remove() {
    const d = this.dashboard();
    if (!d) return;
    // Des panneaux masqués disparaîtraient avec le tableau : réservé à qui voit tout (le serveur refuse aussi).
    if (d.hiddenPanels) {
      this.toasts.error('Ce tableau contient des panneaux hors de votre profil d’accès : seul un administrateur peut le supprimer.');
      return;
    }
    if (!confirm(`Supprimer le tableau « ${d.name} » ? Cette action est définitive.`)) return;
    this.api.deleteDashboard(d.id).subscribe({
      next: () => {
        this.toasts.ok(`Tableau « ${d.name} » supprimé`, 'trash');
        this.router.navigate(['/dashboards']);
      },
      error: (e: { error?: { error?: string } }) => this.toasts.error(e?.error?.error ?? 'Suppression impossible.'),
    });
  }

  duplicateDashboard() {
    const d = this.dashboard();
    if (!d || this.duplicating()) return;
    this.duplicating.set(true);
    const copy = { ...structuredClone(d), name: `${d.name} (copie)`, panels: d.panels.map((p) => ({ ...p, id: newPanel().id })) };
    this.api.createDashboard(copy).subscribe({
      next: (created) => {
        this.duplicating.set(false);
        this.toasts.ok(`Copie créée : « ${created.name} »`, 'copy');
        this.router.navigate(['/dashboards', created.id]);
      },
      error: () => {
        this.duplicating.set(false);
        this.toasts.error('Impossible de dupliquer le tableau.');
      },
    });
  }

  drop(event: CdkDragDrop<Panel[]>) {
    this.update((panels) => moveItemInArray(panels, event.previousIndex, event.currentIndex));
  }

  add() {
    this.isNewPanel.set(true);
    this.editingPanel.set(newPanel());
  }

  edit(p: Panel) {
    this.isNewPanel.set(false);
    this.editingPanel.set(p);
  }

  /** Agrandit (pleine largeur, plus haut) ou réduit un panneau ; le panneau agrandi reste dans la vue. */
  toggleExpand(p: Panel, cell?: HTMLElement) {
    const open = this.expanded() !== p.id;
    this.expanded.set(open ? p.id : null);
    if (open && cell) afterNextRender(() => cell.scrollIntoView({ behavior: this.scrollBehavior(), block: 'nearest' }), { injector: this.injector });
  }

  duplicate(p: Panel) {
    const id = newPanel().id;
    this.update((panels) => panels.splice(panels.indexOf(p) + 1, 0, { ...structuredClone(p), id, title: p.title + ' (copie)' }));
    this.reveal(id);
  }

  removePanel(p: Panel) {
    this.update((panels) => panels.splice(panels.indexOf(p), 1));
  }

  applyPanel(p: Panel) {
    const added = !this.dashboard()?.panels.some((x) => x.id === p.id);
    this.update((panels) => {
      const i = panels.findIndex((x) => x.id === p.id);
      if (i >= 0) panels[i] = p;
      else panels.push(p);
    });
    this.editingPanel.set(null);
    if (added) this.reveal(p.id);
    // Hors mode réorganisation, chaque modification de panneau est enregistrée immédiatement.
    if (!this.editing()) this.persist(() => this.toasts.ok(added ? 'Panneau ajouté au tableau' : 'Panneau enregistré'));
  }

  private persist(done: () => void) {
    const d = this.dashboard();
    if (!d) return;
    this.saving.set(true);
    this.api.saveDashboard(d).subscribe({
      next: (saved) => {
        this.dashboard.set(saved);
        this.saving.set(false);
        this.initValues(saved);
        this.router.navigate([], { queryParams: { edit: null }, replaceUrl: true });
        done();
      },
      error: (e: { error?: { error?: string } }) => {
        this.saving.set(false);
        this.toasts.error(e?.error?.error ?? 'Échec de l’enregistrement');
      },
    });
  }

  /** Fait défiler jusqu'au panneau (nouveau ou dupliqué) une fois affiché. */
  private reveal(id: string) {
    afterNextRender(
      () => this.host.querySelector(`[data-panel="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: this.scrollBehavior(), block: 'nearest' }),
      { injector: this.injector },
    );
  }

  private scrollBehavior(): ScrollBehavior {
    return document.documentElement.dataset['motion'] === 'off' ? 'auto' : 'smooth';
  }

  /** Modifie la liste de panneaux et publie un nouvel objet (les panneaux se rechargent). */
  private update(change: (panels: Panel[]) => void) {
    const d = this.dashboard();
    if (!d) return;
    const panels = [...d.panels];
    change(panels);
    this.dashboard.set({ ...d, panels });
  }
}
