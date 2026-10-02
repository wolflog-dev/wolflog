import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { Api } from '../core/api';
import { AlertChannel, AlertRule, MessagePreviewResult, MessageVariable } from '../core/models';
import { Toasts } from '../core/toasts';
import { channelIcon } from './alert-rules';
import { Logo } from './logo';
import { MESSAGE_PRESETS, MessagePreset } from './message-presets';
import { MessageEditor } from './message-editor';
import { NavIcon } from './nav-icon';
import { RichOption } from './rich-option';

type PreviewTab = 'teams' | 'slack' | 'email' | 'mobile';
type PreviewStatus = 'firing' | 'resolved' | 'test';

/**
 * Message d'une alerte (ou modèle par défaut de toutes les alertes) : titre et message dans l'éditeur visuel,
 * modèles prêts à l'emploi, palette des informations avec leur valeur actuelle, et aperçu fidèle calculé par le
 * serveur  Teams, Slack, e-mail, notification mobile  pour le déclenchement, la résolution ou un test,
 * en clair ou en sombre. Envoi de test vers les canaux de la règle.
 */
@Component({
  selector: 'wl-message-composer',
  imports: [MessageEditor, NavIcon, RichOption, Logo],
  template: `
    <div class="composer">
      @if (mode() === 'rule' && !custom()) {
        <div class="default-row" animate.enter="swap-in">
          <span class="d-icon"><wl-nav-icon name="sparkles" [size]="16" /></span>
          <div class="grow">
            <strong>Message par défaut</strong>
            <span class="muted small">Le même pour toutes les alertes{{ isAdminHint() }}. Personnalisez-le pour celle-ci, ou partez d'un modèle.</span>
          </div>
          <button type="button" class="btn small" (click)="customize()"><wl-nav-icon name="pencil" [size]="13" />Personnaliser</button>
        </div>
        <div class="presets" animate.enter="swap-in">
          @for (p of presets(); track p.id; let i = $index) {
            <button type="button" class="preset" [style.--i]="i" (click)="applyPreset(p)" [title]="p.desc">
              <span class="p-icon"><wl-nav-icon [name]="p.icon" [size]="14" /></span><span class="p-text"><b>{{ p.label }}</b><small>{{ p.desc }}</small></span>
            </button>
          }
        </div>
      } @else {
        <div class="fields" animate.enter="swap-in">
          <div class="edit-head">
            <span class="eh-title"><wl-nav-icon name="pencil" [size]="14" />{{ mode() === 'rule' ? 'Message de cette alerte' : 'Message par défaut' }}</span>
            <span class="spacer"></span>
            <span class="muted small">Modèles :</span>
            @for (p of presets(); track p.id) {
              <button type="button" class="mini-preset" (click)="applyPreset(p)" [title]="p.desc"><wl-nav-icon [name]="p.icon" [size]="12" />{{ p.label }}</button>
            }
          </div>
          <label class="lbl">Titre <span class="count num" [class.warn]="titleLength() > 80">{{ titleLength() }}</span></label>
          <wl-message-editor #titleEditor [value]="titleValue()" (valueChange)="setTitle($event)" [variables]="variables()" [singleLine]="true"
                             (focusChange)="$event && target.set('title')" label="Titre de la notification" placeholder="Titre de la notification" />
          <label class="lbl">Message <span class="count num">{{ bodyLength() }}</span></label>
          <wl-message-editor #bodyEditor [value]="bodyValue()" (valueChange)="setBody($event)" [variables]="variables()"
                             (focusChange)="$event && target.set('body')" label="Message de la notification"
                             placeholder="Écrivez le message ; cliquez une information ci-dessous pour l'insérer." />

          <!-- Palette : toutes les informations, avec leur valeur pour cette règle ; un clic l'insère à l'endroit du curseur. -->
          <div class="palette">
            <div class="pal-head">
              <span class="pal-title"><wl-nav-icon name="sparkles" [size]="13" />Informations</span>
              <span class="muted small">cliquez pour insérer dans le <b>{{ target() === 'title' ? 'titre' : 'message' }}</b></span>
            </div>
            <div class="chips">
              @for (v of variables(); track v.name; let i = $index) {
                <button type="button" class="v-chip" [class.empty]="!v.value" [class.used]="used().has(v.name)" [style.--i]="i"
                        (mousedown)="$event.preventDefault()" (click)="insertVariable(v)"
                        [title]="v.description + (v.value ? '\\nValeur actuelle : ' + v.value : '\\nVide pour cette règle : la ligne qui la contient sera masquée')">
                  <span class="v-label">{{ v.label }}</span>
                  <span class="v-val">{{ v.value || 'vide' }}</span>
                </button>
              }
            </div>
          </div>

          <div class="actions-row">
            <span class="muted small tip"><wl-nav-icon name="info" [size]="13" />Une ligne dont toutes les informations sont vides n'est pas envoyée.</span>
            <span class="spacer"></span>
            <button type="button" class="btn ghost small" (click)="reset()"><wl-nav-icon name="refresh" [size]="13" />{{ mode() === 'rule' ? 'Revenir au message par défaut' : 'Rétablir le modèle intégré' }}</button>
          </div>
        </div>
      }

      <section class="preview">
        <div class="preview-head">
          <span class="ph-title"><wl-nav-icon name="eye" [size]="14" />Aperçu</span>
          <div class="seg states" role="group" aria-label="Moment du message">
            @for (s of states; track s.value) {
              <button type="button" [class.on]="status() === s.value" (click)="status.set(s.value)" [title]="s.hint"><wl-nav-icon [name]="s.icon" [size]="13" />{{ s.label }}</button>
            }
          </div>
          <span class="spacer"></span>
          @if (result(); as r) {
            <span class="source" [class.sample]="r.sample"
                  [title]="r.sample ? 'Aucune donnée réelle pour cette règle : valeurs inventées pour l’aperçu' : 'Aperçu calculé avec les données actuelles de la règle'">
              <wl-nav-icon [name]="r.sample ? 'sparkles' : 'bolt'" [size]="12" />{{ r.sample ? 'Valeurs d’exemple' : 'Données réelles' }}
            </span>
          }
          <button type="button" class="btn ghost icon-btn" (click)="dark.set(!dark())" [title]="dark() ? 'Aperçu en thème clair' : 'Aperçu en thème sombre'"
                  [attr.aria-label]="dark() ? 'Aperçu en thème clair' : 'Aperçu en thème sombre'"><wl-nav-icon [name]="dark() ? 'sun' : 'theme'" [size]="14" /></button>
        </div>

        <div class="channel-tabs" role="tablist">
          @for (t of tabs; track t.value) {
            <button type="button" role="tab" [class.on]="tab() === t.value" [attr.aria-selected]="tab() === t.value" (click)="selectTab(t.value)">
              <wl-nav-icon [name]="t.icon" [size]="14" />{{ t.label }}
            </button>
          }
        </div>

        <div class="stage" [class.dark]="dark()" [style.--dir]="dir()">
          @if (error()) {
            <div class="err"><wl-nav-icon name="warning" [size]="16" />{{ error() }}</div>
          } @else if (result(); as r) {
            @switch (tab()) {
              @case ('teams') {
                <div class="frame teams" animate.enter="slide-in" [attr.data-tone]="r.preview.tone">
                  <span class="t-avatar app-logo"><wl-logo [size]="18" /></span>
                  <div class="t-main">
                    <div class="t-meta"><strong>Wolflog</strong><span class="t-via">Workflows</span><span class="t-time">{{ clock() }}</span></div>
                    <div class="t-card">
                      <div class="t-title">{{ r.preview.title }}</div>
                      <div class="rich" [innerHTML]="r.preview.html"></div>
                      @if (r.preview.link) { <div class="t-actions"><span class="t-btn">Voir dans Wolflog</span></div> }
                    </div>
                    <div class="t-reply"><wl-nav-icon name="chat" [size]="13" />Répondre</div>
                  </div>
                </div>
              }
              @case ('slack') {
                <div class="frame slack" animate.enter="slide-in">
                  <span class="s-avatar app-logo"><wl-logo [size]="20" /></span>
                  <div class="s-main">
                    <div class="s-head"><strong>Wolflog</strong><span class="s-app">APP</span><span class="s-time">{{ clock() }}</span></div>
                    <div class="s-title">{{ r.preview.title }}</div>
                    <div class="rich" [innerHTML]="r.preview.html"></div>
                    @if (r.preview.link) { <a class="s-link">Voir dans Wolflog</a> }
                  </div>
                </div>
              }
              @case ('email') {
                <div class="frame mail" animate.enter="slide-in">
                  <div class="m-subject">[Wolflog] {{ r.preview.title }}</div>
                  <div class="m-from">
                    <span class="m-avatar app-logo"><wl-logo [size]="18" /></span>
                    <div class="m-who"><strong>Wolflog</strong> <span class="muted">&lt;wolflog&#64;…&gt;</span><div class="muted">À : {{ mailTo() }}</div></div>
                    <span class="m-time">{{ clock() }}</span>
                  </div>
                  <div class="m-sheet">
                    <div class="m-title">{{ r.preview.title }}</div>
                    <div class="rich" [innerHTML]="r.preview.html"></div>
                    @if (r.preview.link) { <a class="m-link">Voir dans Wolflog</a> }
                  </div>
                </div>
              }
              @default {
                <div class="frame mobile" animate.enter="slide-in">
                  <div class="phone">
                    <div class="notch"></div>
                    <div class="lock-time">{{ clock() }}</div>
                    <div class="lock-date">{{ today() }}</div>
                    <div class="push" [attr.data-tone]="r.preview.tone">
                      <div class="push-head"><span class="push-icon app-logo"><wl-logo [size]="12" /></span><span>WOLFLOG</span><span class="push-time">maintenant</span></div>
                      <div class="push-title">{{ r.preview.title }}</div>
                      <div class="push-body">{{ r.preview.text }}</div>
                    </div>
                  </div>
                  <p class="approx">Approximation : chaque application (Teams, Slack, messagerie) coupe le texte à sa façon.</p>
                </div>
              }
            }
            <!-- Reflet qui balaie l'aperçu quand son contenu vient de changer. -->
            @for (v of [version()]; track v) { <i class="flash"></i> }
          } @else {
            <div class="sk-card" aria-label="Calcul de l’aperçu">
              <i class="skeleton" style="width: 42%; height: 16px"></i>
              <i class="skeleton" style="width: 90%"></i>
              <i class="skeleton" style="width: 74%"></i>
              <i class="skeleton" style="width: 128px; height: 26px; margin-top: 4px"></i>
            </div>
          }
        </div>

        @if (warnings().length) {
          <ul class="warnings">
            @for (w of warnings(); track w; let i = $index) { <li [style.--i]="i"><wl-nav-icon name="warning" [size]="13" />{{ w }}</li> }
          </ul>
        }

        <div class="test-row">
          @if (mode() === 'default') {
            <select [value]="testChannel()" (change)="testChannel.set($any($event.target).value)" aria-label="Canal de test">
              <option value="" wlOpt="Canal de test…" icon="bell" tone="muted"></option>
              @for (c of channels(); track c.id) { <option [value]="c.id" [wlOpt]="c.name" [icon]="channelIcon(c.type)" [desc]="c.target"></option> }
            </select>
          } @else if (recipients().length) {
            <span class="muted small">Envoi vers</span>
            @for (c of recipients(); track c.id) {
              <span class="to" [title]="c.target"><wl-nav-icon [name]="channelIcon(c.type)" [size]="12" />{{ c.name }}</span>
            }
          }
          <span class="spacer"></span>
          @if (testResult(); as t) { <span class="small result" [class.ok]="t.ok" [class.danger]="!t.ok" animate.enter="swap-in"><wl-nav-icon [name]="t.ok ? 'ok' : 'warning'" [size]="13" />{{ t.text }}</span> }
          @else if (!canTest()) { <span class="muted small">{{ mode() === 'rule' ? 'Cochez un canal pour envoyer un test.' : '' }}</span> }
          <button type="button" class="btn small" (click)="sendTest()" [disabled]="testing() || !canTest()">
            @if (testing()) { <span class="spinner"></span> } @else { <wl-nav-icon name="play" [size]="13" /> }
            {{ testing() ? 'Envoi…' : 'Envoyer un test' }}
          </button>
        </div>
      </section>
    </div>
  `,
  styles: `
    .composer { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; container-type: inline-size; }
    /* Étroit (téléphone) : moments sans icônes, onglets des canaux qui défilent, cadres sans marges superflues. */
    @container (max-width: 460px) {
      .states button wl-nav-icon, .ph-title { display: none; }
      .states button { padding: 0 9px; }
      .channel-tabs { overflow-x: auto; scrollbar-width: none; }
      .channel-tabs button { flex: none; padding: 0 10px; }
      .stage { padding: 10px; }
      .teams { padding: 10px; }
      .t-avatar, .s-avatar { display: none; }
      .phone { width: 100%; max-width: 300px; }
      .v-chip { max-width: 100%; }
    }
    .swap-in { animation: swap-in .35s var(--ease) backwards; }
    @keyframes swap-in { from { opacity: 0; transform: translateY(-4px); } }

    /* Message par défaut + modèles. */
    .default-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: var(--radius-sm);
      border: 1px dashed var(--border); background: var(--surface-2); }
    .default-row .grow { flex: 1; min-width: 220px; display: grid; gap: 2px; }
    .d-icon { display: grid; place-items: center; width: 32px; height: 32px; flex: none; border-radius: 10px; color: var(--accent); background: var(--accent-soft); }
    .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
    .preset { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);
      background: var(--surface-2); color: var(--text-1); text-align: left; cursor: pointer; animation: swap-in .4s var(--ease) backwards;
      animation-delay: calc(var(--i) * 50ms); transition: border-color .2s, transform .3s var(--spring); }
    .preset:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); transform: translateY(-2px); }
    .p-icon { display: grid; place-items: center; width: 28px; height: 28px; flex: none; border-radius: 9px; color: var(--accent); background: var(--accent-soft);
      transition: transform .4s var(--spring); }
    .preset:hover .p-icon { transform: rotate(-8deg) scale(1.1); }
    .p-text { display: grid; gap: 1px; min-width: 0; font-size: 12.5px; }
    .p-text small { color: var(--text-3); font-size: 11px; line-height: 1.3; }

    /* Édition. */
    .fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .edit-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 2px; }
    .eh-title { display: inline-flex; align-items: center; gap: 7px; font-weight: 650; font-size: 13px; }
    .eh-title wl-nav-icon { color: var(--accent); }
    .mini-preset { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border: 1px solid var(--border); border-radius: 999px;
      background: var(--surface-2); color: var(--text-2); font: 500 11.5px var(--sans); cursor: pointer; transition: color .2s, border-color .2s, transform .25s var(--spring); }
    .mini-preset:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
    .lbl { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-2); margin-top: 6px; }
    .count { padding: 0 6px; border-radius: 999px; font: 600 10px/16px var(--mono); color: var(--text-3); background: var(--surface-3); }
    .count.warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 14%, transparent); }

    .palette { margin-top: 8px; padding: 10px 12px 12px; border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--surface-2); }
    .pal-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
    .pal-title { display: inline-flex; align-items: center; gap: 6px; font: 650 11px var(--sans); color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
    .pal-title wl-nav-icon { color: var(--accent); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .v-chip { display: inline-flex; align-items: center; gap: 7px; max-width: 260px; height: 28px; padding: 0 4px 0 10px; border: 1px solid transparent;
      border-radius: 999px; background: var(--accent-soft); color: var(--accent); font: 600 12px var(--sans); cursor: pointer;
      animation: swap-in .35s var(--ease) backwards; animation-delay: calc(min(var(--i), 16) * 18ms);
      transition: transform .3s var(--spring), border-color .2s, background-color .2s; }
    .v-chip:hover { transform: translateY(-2px); border-color: var(--accent); }
    .v-chip:active { transform: scale(.94); }
    .v-chip.used { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
    .v-val { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; border-radius: 999px; line-height: 20px;
      font: 500 11px var(--mono); color: var(--text-2); background: var(--surface-solid); }
    .v-chip.empty { background: var(--surface-3); color: var(--text-3); }
    .v-chip.empty .v-val { font-style: italic; opacity: .7; }
    .actions-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .tip { display: inline-flex; align-items: center; gap: 6px; }

    /* Aperçu. */
    .preview { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-2); overflow: hidden; }
    .preview-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 8px 8px 14px; border-bottom: 1px solid var(--border-soft); }
    .ph-title { display: inline-flex; align-items: center; gap: 6px; font: 650 11px var(--sans); color: var(--text-3); text-transform: uppercase; letter-spacing: .08em; }
    .ph-title wl-nav-icon { color: var(--accent); }
    .states button { display: inline-flex; align-items: center; gap: 6px; }
    .source { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: 999px; font-size: 11.5px;
      color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }
    .source.sample { color: var(--accent); background: var(--accent-soft); }
    .icon-btn { width: 30px; padding: 0; justify-content: center; }
    .channel-tabs { display: flex; gap: 4px; padding: 8px 10px 0; }
    .channel-tabs button { position: relative; display: inline-flex; align-items: center; gap: 7px; height: 32px; padding: 0 12px; border: 0;
      border-radius: 10px 10px 0 0; background: none; color: var(--text-3); font: 550 12.5px var(--sans); cursor: pointer; transition: color .2s, background-color .2s; }
    .channel-tabs button:hover { color: var(--text-1); }
    .channel-tabs button.on { color: var(--text-1); background: var(--surface); }
    .channel-tabs button::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px;
      background: linear-gradient(90deg, var(--accent), var(--accent-3)); transform: scaleX(0); transition: transform .35s var(--spring); }
    .channel-tabs button.on::after { transform: scaleX(1); }

    .stage { position: relative; overflow: hidden; min-height: 210px; padding: 16px; background: var(--surface); }
    .slide-in { animation: slide-in .4s var(--ease) backwards; }
    @keyframes slide-in { from { opacity: 0; transform: translateX(calc(var(--dir, 1) * 26px)); } }
    .flash { position: absolute; inset: 0; pointer-events: none; transform: translateX(-100%);
      background: linear-gradient(100deg, transparent 35%, color-mix(in srgb, var(--accent) 16%, transparent) 50%, transparent 65%);
      animation: flash .9s var(--ease) forwards; }
    @keyframes flash { to { transform: translateX(100%); } }
    .err { display: flex; align-items: center; gap: 8px; color: var(--danger); font-size: 13px; }
    .sk-card { display: grid; gap: 9px; }

    .frame { border-radius: 12px; overflow: hidden; }
    .rich { font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
    .rich :is(p) { margin: 0 0 4px; }
    .rich :is(ul) { margin: 2px 0 6px; padding-left: 20px; }
    .app-logo { display: grid; place-items: center; flex: none; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .app-logo wl-logo { --accent: #fff; }

    /* Teams (clair / sombre). */
    .teams { --bg: #f5f5f5; --card: #fff; --fg: #242424; --muted: #616161; --line: #e0e0e0; --btn: #d1d1d1; --link: #5b5fc7;
      --tone-c: #c4314b; display: flex; gap: 10px; padding: 14px; background: var(--bg); color: var(--fg); font-family: 'Segoe UI', system-ui, sans-serif; }
    .stage.dark .teams { --bg: #1f1f1f; --card: #292929; --fg: #fff; --muted: #adadad; --line: #3d3d3d; --btn: #5c5c5c; --link: #9ea2ff; --tone-c: #e37d80; }
    .teams[data-tone='Warning'] { --tone-c: #8a6d00; }
    .stage.dark .teams[data-tone='Warning'] { --tone-c: #ffd335; }
    .teams[data-tone='Good'] { --tone-c: #237b4b; }
    .stage.dark .teams[data-tone='Good'] { --tone-c: #92c353; }
    .t-avatar { width: 32px; height: 32px; border-radius: 8px; }
    .t-main { flex: 1; min-width: 0; }
    .t-meta { display: flex; align-items: baseline; gap: 8px; font-size: 12px; margin-bottom: 6px; }
    .t-via { padding: 0 5px; border-radius: 4px; background: var(--line); color: var(--muted); font-size: 10.5px; }
    .t-time { color: var(--muted); }
    .t-card { max-width: 540px; padding: 14px 16px; border-radius: 6px; background: var(--card); border-left: 4px solid var(--tone-c);
      box-shadow: 0 1px 3px rgb(0 0 0 / .14); }
    .t-title { font-weight: 700; font-size: 15px; margin-bottom: 6px; color: var(--tone-c); }
    .teams .rich a { color: var(--link); }
    .t-actions { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
    .t-btn { display: inline-block; padding: 5px 14px; border: 1px solid var(--btn); border-radius: 4px; font-size: 13px; font-weight: 600; }
    .t-reply { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--muted); }

    /* Slack. */
    .slack { --bg: #fff; --fg: #1d1c1d; --muted: #616061; --link: #1264a3; --tag: #e8e8e8;
      display: flex; gap: 10px; padding: 14px 16px; background: var(--bg); color: var(--fg); font-family: 'Lato', 'Segoe UI', system-ui, sans-serif; }
    .stage.dark .slack { --bg: #1a1d21; --fg: #d1d2d3; --muted: #9a9b9d; --link: #1d9bd1; --tag: #2c2d30; }
    .s-avatar { width: 36px; height: 36px; border-radius: 8px; }
    .s-main { min-width: 0; }
    .s-head { display: flex; align-items: baseline; gap: 6px; font-size: 14px; }
    .s-app { padding: 0 4px; border-radius: 3px; background: var(--tag); color: var(--muted); font-size: 10px; font-weight: 700; }
    .s-time { color: var(--muted); font-size: 12px; }
    .s-title { font-weight: 700; margin: 2px 0; }
    .slack .rich a, .s-link { color: var(--link); }
    .s-link { font-size: 14px; }

    /* E-mail. */
    .mail { --outer: #f2f4f7; --sheet: #fff; --fg: #1d2026; --muted: #858b96; --line: #e6e6e6; --link: #2f5fd0;
      background: var(--outer); color: var(--fg); }
    .stage.dark .mail { --outer: #16171a; --sheet: #1f2125; --fg: #e8e8e8; --muted: #9aa0aa; --line: #2e3036; --link: #7aa2f7; }
    .m-subject { padding: 14px 16px 6px; font: 600 16px 'Segoe UI', Arial, sans-serif; }
    .m-from { display: flex; align-items: center; gap: 10px; padding: 6px 16px 12px; font-size: 12.5px; border-bottom: 1px solid var(--line); }
    .m-avatar { width: 34px; height: 34px; border-radius: 50%; }
    .m-who { flex: 1; min-width: 0; }
    .mail .muted { color: var(--muted); }
    .m-time { color: var(--muted); font-size: 12px; }
    .m-sheet { margin: 14px 16px 16px; padding: 16px; border-radius: 8px; background: var(--sheet); font: 14px/1.5 'Segoe UI', Arial, sans-serif; }
    .m-title { font-size: 16px; font-weight: 600; margin-bottom: 8px; }
    .mail .rich a, .m-link { color: var(--link); }
    .m-link { display: inline-block; margin-top: 10px; }

    /* Notification mobile. */
    .mobile { display: grid; justify-items: center; gap: 8px; }
    .phone { position: relative; width: 300px; height: 300px; padding: 34px 12px 0; border-radius: 34px 34px 0 0; overflow: hidden;
      background: radial-gradient(120% 90% at 20% 10%, #8fb8ff, transparent 60%), radial-gradient(90% 80% at 90% 80%, #ffb4d9, transparent 60%), #dfe7ff;
      box-shadow: inset 0 0 0 6px #111, 0 20px 40px -24px rgb(0 0 0 / .6); }
    .stage.dark .phone { background: radial-gradient(120% 90% at 20% 10%, #1e3a8a, transparent 60%), radial-gradient(90% 80% at 90% 80%, #581c87, transparent 60%), #0b1020; }
    .notch { position: absolute; top: 10px; left: 50%; width: 90px; height: 20px; margin-left: -45px; border-radius: 999px; background: #111; }
    .lock-time { text-align: center; font: 300 46px/1 system-ui, sans-serif; color: rgb(255 255 255 / .92); letter-spacing: -.02em; margin-top: 6px; }
    .lock-date { text-align: center; font-size: 12px; color: rgb(255 255 255 / .85); margin: 4px 0 16px; }
    .push { padding: 10px 12px; border-radius: 18px; background: rgb(255 255 255 / .72); color: #111; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      box-shadow: 0 6px 20px -10px rgb(0 0 0 / .45); animation: push-in .6s var(--spring) .15s backwards; }
    .stage.dark .push { background: rgb(40 40 46 / .72); color: #f5f5f7; }
    @keyframes push-in { from { opacity: 0; transform: translateY(-18px) scale(.96); } }
    .push-head { display: flex; align-items: center; gap: 6px; font-size: 10.5px; letter-spacing: .03em; opacity: .7; }
    .push-icon { width: 18px; height: 18px; border-radius: 5px; }
    .push-time { margin-left: auto; }
    .push-title { margin-top: 4px; font-weight: 650; font-size: 13px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; }
    .push-body { font-size: 12.5px; line-height: 1.35; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; white-space: pre-line; }
    .approx { margin: 0; font-size: 11px; color: var(--text-3); }

    /* Avertissements et envoi de test. */
    .warnings { display: grid; gap: 4px; margin: 0; padding: 8px 14px; list-style: none; border-top: 1px solid var(--border-soft);
      background: color-mix(in srgb, var(--warn) 7%, transparent); }
    .warnings li { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--warn); animation: swap-in .35s var(--ease) backwards;
      animation-delay: calc(var(--i) * 60ms); }
    .test-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-top: 1px solid var(--border-soft); background: var(--surface-2); }
    .to { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 999px; font-size: 11.5px;
      color: var(--text-1); background: var(--surface-3); }
    .to wl-nav-icon { color: var(--accent); }
    .result { display: inline-flex; align-items: center; gap: 6px; }
  `,
})
export class MessageComposer {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly channelIcon = channelIcon;

  /** rule : message d'une règle (vide = modèle par défaut) ; default : modèle par défaut de toutes les règles. */
  readonly mode = input<'rule' | 'default'>('rule');
  readonly rule = input<AlertRule | null>(null);
  readonly title = input<string | null>(null);
  readonly body = input<string | null>(null);
  /** Canaux connus : destinataires du test (ceux cochés dans la règle) et choix du canal de test (mode par défaut). */
  readonly channels = input<AlertChannel[]>([]);
  readonly titleChange = output<string | null>();
  readonly bodyChange = output<string | null>();

  private readonly titleEditor = viewChild<MessageEditor>('titleEditor');
  private readonly bodyEditor = viewChild<MessageEditor>('bodyEditor');

  protected readonly tabs: { value: PreviewTab; label: string; icon: string }[] = [
    { value: 'teams', label: 'Teams', icon: channelIcon('teams') },
    { value: 'slack', label: 'Slack', icon: channelIcon('slack') },
    { value: 'email', label: 'E-mail', icon: channelIcon('email') },
    { value: 'mobile', label: 'Mobile', icon: 'bell' },
  ];
  protected readonly states: { value: PreviewStatus; label: string; icon: string; hint: string }[] = [
    { value: 'firing', label: 'Déclenchement', icon: 'alerts', hint: 'Message envoyé quand l’alerte se déclenche (et à chaque rappel)' },
    { value: 'resolved', label: 'Résolution', icon: 'ok', hint: 'Message envoyé quand tout redevient normal' },
    { value: 'test', label: 'Test', icon: 'play', hint: 'Message de l’envoi de test' },
  ];
  protected readonly tab = signal<PreviewTab>('teams');
  protected readonly status = signal<PreviewStatus>('firing');
  /** Sens du glissement au changement d'onglet (1 : vers la droite, -1 : vers la gauche). */
  protected readonly dir = signal(1);
  /** Aperçu en sombre : par défaut comme l'interface. */
  protected readonly dark = signal(document.documentElement.getAttribute('data-theme') === 'dark'
    || (!document.documentElement.getAttribute('data-theme') && !matchMedia('(prefers-color-scheme: light)').matches));
  protected readonly result = signal<MessagePreviewResult | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly testChannel = signal('');
  /** Éditeur qui reçoit les informations cliquées dans la palette. */
  protected readonly target = signal<'title' | 'body'>('body');
  /** Change à chaque nouveau rendu : relance le reflet de l'aperçu. */
  protected readonly version = signal(0);

  /**
   * Valeurs affichées dans les éditeurs : le modèle saisi ; avant toute saisie, le modèle en vigueur.
   * Une fois l'édition commencée, un champ vidé reste vide (il ne se remplit plus avec le modèle par défaut).
   */
  private readonly editing = signal(false);
  protected readonly custom = computed(() => this.editing() || !!(this.title() || this.body()));
  protected readonly titleValue = computed(() => this.title() ?? (this.editing() ? '' : this.result()?.titleTemplate ?? ''));
  protected readonly bodyValue = computed(() => this.body() ?? (this.editing() ? '' : this.result()?.bodyTemplate ?? ''));
  protected readonly variables = computed(() => this.result()?.variables ?? []);
  protected readonly canTest = computed(() => (this.mode() === 'rule' ? (this.rule()?.channels.length ?? 0) > 0 : !!this.testChannel()));

  /** Modèles proposés : « Erreur applicative » seulement pour les alertes d'erreur (et le modèle par défaut). */
  protected readonly presets = computed(() => {
    const kind = this.rule()?.kind;
    return MESSAGE_PRESETS.filter((p) => p.id !== 'erreur' || kind === 'error' || this.mode() === 'default');
  });

  /** Informations utilisées par les modèles en vigueur (titre et message). */
  protected readonly used = computed(() => {
    const r = this.result();
    const text = `${r?.titleTemplate ?? ''}\n${r?.bodyTemplate ?? ''}`;
    return new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1].toLowerCase()));
  });

  protected readonly titleLength = computed(() => this.result()?.preview.title.length ?? 0);
  protected readonly bodyLength = computed(() => this.result()?.preview.text.length ?? 0);

  /** Points d'attention sur le rendu : titre long, message vide, informations vides pour cette règle. */
  protected readonly warnings = computed(() => {
    const r = this.result();
    if (!r) return [];
    const list: string[] = [];
    if (r.preview.title.length > 80) list.push(`Titre de ${r.preview.title.length} caractères : il sera coupé dans les notifications mobiles.`);
    if (!r.preview.text.trim()) list.push('Message vide : seul le titre sera envoyé.');
    const empty = r.variables.filter((v) => !v.value && this.used().has(v.name)).map((v) => v.label);
    if (empty.length && !r.sample) {
      list.push(`${empty.length > 1 ? 'Vides' : 'Vide'} pour cette règle : ${empty.join(', ')}  la ligne correspondante sera masquée.`);
    }
    return list;
  });

  /** Destinataires du test (canaux cochés dans la règle). */
  protected readonly recipients = computed(() => {
    const ids = this.rule()?.channels ?? [];
    return this.channels().filter((c) => ids.includes(c.id));
  });

  protected readonly mailTo = computed(() => {
    const mails = this.recipients().filter((c) => c.type === 'email').map((c) => c.target);
    return mails.length ? mails.join(', ') : 'vous';
  });

  protected readonly clock = signal(new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }));
  protected readonly today = signal(new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }));

  private readonly requests = new Subject<void>();

  constructor() {
    this.requests.pipe(
      debounceTime(300),
      switchMap(() => this.api.messagePreview(this.input()).pipe(catchError((e) => {
        this.error.set(e?.error?.error ?? 'Aperçu impossible.');
        return of(null);
      }))),
      takeUntilDestroyed(inject(DestroyRef)),
    ).subscribe((r) => {
      if (!r) return;
      const before = this.result();
      this.error.set(null);
      this.result.set(r);
      if (before && (before.preview.title !== r.preview.title || before.preview.html !== r.preview.html)) this.version.update((v) => v + 1);
    });
    effect(() => {
      this.rule();
      this.title();
      this.body();
      this.status();
      untracked(() => this.requests.next());
    });
  }

  protected isAdminHint() {
    return this.mode() === 'rule' ? ' (modifiable par un administrateur dans Alertes › Canaux)' : '';
  }

  private input() {
    return { rule: this.rule(), title: this.title() || null, body: this.body() || null, status: this.status() };
  }

  protected selectTab(tab: PreviewTab) {
    const order = this.tabs.map((t) => t.value);
    this.dir.set(order.indexOf(tab) >= order.indexOf(this.tab()) ? 1 : -1);
    this.tab.set(tab);
  }

  protected customize() {
    this.editing.set(true);
    const r = this.result();
    this.titleChange.emit(r?.titleTemplate ?? '{{statut}} : {{regle}}');
    this.bodyChange.emit(r?.bodyTemplate ?? '{{message}}');
  }

  protected applyPreset(p: MessagePreset) {
    this.editing.set(true);
    this.titleChange.emit(p.title);
    this.bodyChange.emit(p.body);
    this.toasts.info(`Modèle « ${p.label} » appliqué`, p.icon);
  }

  protected reset() {
    this.editing.set(false);
    this.titleChange.emit(null);
    this.bodyChange.emit(null);
  }

  protected setTitle(v: string) {
    this.editing.set(true);
    this.titleChange.emit(v.trim() ? v : null);
  }

  protected setBody(v: string) {
    this.editing.set(true);
    this.bodyChange.emit(v.trim() ? v : null);
  }

  /** Clic dans la palette : l'information va dans le dernier éditeur utilisé, à l'endroit du curseur. */
  protected insertVariable(v: MessageVariable) {
    (this.target() === 'title' ? this.titleEditor() : this.bodyEditor())?.insert(v);
  }

  protected sendTest() {
    this.testing.set(true);
    this.testResult.set(null);
    const channels = this.mode() === 'default' ? [this.testChannel()] : null;
    this.api.messageTest({ rule: this.rule(), title: this.title() || null, body: this.body() || null, channels }).subscribe({
      next: (r) => {
        this.testing.set(false);
        this.testResult.set({ ok: true, text: `Envoyé à ${r.sent.join(', ')}.` });
        this.toasts.ok(`Message de test envoyé à ${r.sent.join(', ')}`, 'play');
      },
      error: (e) => {
        this.testing.set(false);
        const text = e?.error?.error ?? 'Envoi impossible.';
        this.testResult.set({ ok: false, text });
        this.toasts.error(text);
      },
    });
  }
}
