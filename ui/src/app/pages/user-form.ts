import { Component, OnDestroy, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { EVERYTHING, PROFILE_ICONS, SECTIONS, profileSummary, profileTone, servicesLabel } from '../core/access';
import { AccessProfile, Role } from '../core/models';
import { Session } from '../core/session';
import { Toasts } from '../core/toasts';
import { CopyText, copyToClipboard } from '../shared/copy-text';
import { NavIcon } from '../shared/nav-icon';
import { RichOption } from '../shared/rich-option';
import { ServicePicker } from '../shared/service-picker';
import { ROLE_LABELS, nameHue, nameInitials } from './admin-users';

/**
 * Ajout d'un utilisateur : identité, rôle (ce qu'il peut faire), profil d'accès et services visibles (ce qu'il voit),
 * puis le mot de passe provisoire.
 */
@Component({
  selector: 'wl-user-form',
  imports: [FormsModule, RouterLink, CopyText, NavIcon, RichOption, ServicePicker],
  template: `
    <div class="page form-page">
      <div class="page-head">
        <a routerLink="/admin/users" class="small crumb"><wl-nav-icon name="users" [size]="14" />Utilisateurs</a>
        <span class="muted">/</span>
        <h1>Ajouter un utilisateur</h1>
        <span class="spacer"></span>
        @if (!created()) {
          <a class="btn" routerLink="/admin/users">Annuler</a>
          <button class="btn primary" (click)="create()" [disabled]="busy() || !username.trim()">
            <wl-nav-icon [name]="busy() ? 'refresh' : 'plus'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Création…' : 'Créer le compte' }}
          </button>
        } @else {
          <a class="btn primary" routerLink="/admin/users"><wl-nav-icon name="check" [size]="14" />Terminé</a>
        }
      </div>

      @if (created(); as c) {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step done created">
              <div class="step-head"><span class="num">4</span><h2>Compte « {{ c.username }} » créé</h2></div>
              <div class="step-body">
                <div class="success">
                  <span class="done-badge"><wl-nav-icon name="check" [size]="22" /></span>
                  <div class="secret-box">
                    <span class="muted small">Mot de passe provisoire</span>
                    <div class="secret-value"><code class="secret">{{ c.password }}</code><wl-copy [text]="c.password" /></div>
                  </div>
                </div>
                <p class="muted small">Transmettez-le à la personne avec l'adresse de Wolflog ({{ origin }}). Il ne sera plus affiché ;
                  elle devra choisir son propre mot de passe à la première connexion.</p>
                <div>
                  <button class="btn" [class.copied]="invited()" (click)="copyInvitation(c.username, c.password)">
                    <wl-nav-icon [name]="invited() ? 'check' : 'mail'" [size]="14" />{{ invited() ? 'Invitation copiée' : 'Copier le message d’invitation' }}
                  </button>
                </div>
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Ensuite</h3>
              <p class="small">La personne se connecte avec ce mot de passe provisoire, puis choisit le sien. Son rôle et son profil d'accès restent
                modifiables dans la liste des utilisateurs.</p>
            </div>
            <div class="actions"><a class="btn primary" routerLink="/admin/users"><wl-nav-icon name="check" [size]="14" />Terminé</a>
              <a class="btn" routerLink="/admin/users/new" (click)="reset()"><wl-nav-icon name="plus" [size]="14" />Ajouter un autre</a></div>
          </aside>
        </div>
      } @else {
        <div class="form-grid">
          <div class="steps">
            <section class="panel step" [class.done]="!!username.trim()">
              <div class="step-head"><span class="num">1</span><h2>Qui ?</h2><span class="hint">seul le nom d'utilisateur est obligatoire</span></div>
              <div class="step-body">
                <div class="options">
                  <label class="field">Nom d'utilisateur
                    <span class="control"><wl-nav-icon name="account" [size]="14" /><input [(ngModel)]="username" autocomplete="off" placeholder="ex. jdupont" spellcheck="false" /></span></label>
                  <label class="field">Nom affiché
                    <span class="control"><wl-nav-icon name="text" [size]="14" /><input [(ngModel)]="displayName" autocomplete="off" placeholder="ex. Jeanne Dupont" /></span></label>
                  <label class="field">E-mail
                    <span class="control"><wl-nav-icon name="mail" [size]="14" /><input type="email" [(ngModel)]="email" autocomplete="off" placeholder="facultatif" /></span></label>
                </div>
                @if (session.me()?.sso; as sso) {
                  <p class="note muted small"><wl-nav-icon name="shield" [size]="14" />Les personnes qui se connectent avec {{ sso.name }} sont ajoutées automatiquement : inutile de créer leur compte.</p>
                }
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">2</span><h2>Que peut-il faire ?</h2><span class="hint">son rôle</span></div>
              <div class="step-body">
                <div class="choices">
                  @for (r of roles; track r) {
                    <button type="button" class="choice" [class.on]="role() === r" (click)="role.set(r)" [style.--tone]="labels[r].tone">
                      <span class="choice-icon"><wl-nav-icon [name]="labels[r].icon" [size]="17" /></span>
                      <strong>{{ labels[r].label }}</strong><span>{{ labels[r].hint }}</span>
                    </button>
                  }
                </div>
              </div>
            </section>
            <section class="panel step done">
              <div class="step-head"><span class="num">3</span><h2>Que voit-il ?</h2><span class="hint">son profil d'accès : les parties de sa navigation</span></div>
              <div class="step-body">
                @if (role() === 'admin') {
                  <div class="all-access">
                    <span class="p-badge" [style.--tone]="labels.admin.tone"><wl-nav-icon name="crown" [size]="12" />Administrateur : tout</span>
                    <span class="muted small">Les administrateurs voient toutes les parties de Wolflog, quel que soit leur profil.</span>
                  </div>
                } @else {
                  <div class="profile-row">
                    @if (profiles().length) {
                      <select class="profile-select" [style.--tone]="tone(profileId())" (change)="profileId.set($any($event.target).value)" aria-label="Profil d'accès">
                        @for (p of profiles(); track p.id) {
                          <option [value]="p.id" [selected]="p.id === profileId()" [wlOpt]="p.name" [icon]="p.icon || defaultIcon" [tone]="tone(p.id)" [desc]="summary(p)"></option>
                        }
                      </select>
                    } @else {
                      <i class="skeleton select-ghost" aria-busy="true"></i>
                    }
                    <a class="small manage" routerLink="/admin/access"><wl-nav-icon name="id-card" [size]="13" />Gérer les profils</a>
                  </div>
                  @if (profile(); as p) {
                    <div class="sec-chips" [style.--tone]="tone(p.id)">
                      @if (p.id === everything) {
                        <span class="sec-chip home"><wl-nav-icon name="sparkles" [size]="12" />Toutes les parties, y compris les prochaines</span>
                      } @else {
                        @for (s of sectionsOf(p); track s.id) {
                          <span class="sec-chip" [class.home]="s.id === p.home" [title]="s.id === p.home ? 'Page d’accueil' : s.desc" animate.enter="chip-in">
                            <wl-nav-icon [name]="s.id === p.home ? 'home' : s.icon" [size]="12" />{{ s.label }}</span>
                        }
                      }
                    </div>
                  }
                  <div class="field">Services visibles
                    <div class="seg" role="radiogroup" aria-label="Services visibles">
                      <button type="button" role="radio" [class.on]="scopeMode() === 'profile'" [attr.aria-checked]="scopeMode() === 'profile'" (click)="scopeMode.set('profile')">Comme le profil</button>
                      <button type="button" role="radio" [class.on]="scopeMode() === 'all'" [attr.aria-checked]="scopeMode() === 'all'" (click)="scopeMode.set('all')">Tous</button>
                      <button type="button" role="radio" [class.on]="scopeMode() === 'custom'" [attr.aria-checked]="scopeMode() === 'custom'" (click)="scopeMode.set('custom')">Choisir…</button>
                    </div>
                  </div>
                  @switch (scopeMode()) {
                    @case ('profile') { <p class="muted small">{{ profileScope() }}</p> }
                    @case ('all') { <p class="muted small">Tous les services, quel que soit son profil.</p> }
                    @default { <wl-service-picker [(value)]="services" /> }
                  }
                }
              </div>
            </section>
          </div>
          <aside class="panel summary">
            <div class="block">
              <h3>Aperçu</h3>
              <div class="preview">
                <span class="avatar" [style.--hue]="hue()">{{ initials() }}</span>
                <div class="who">
                  <strong class="ellipsis">{{ displayName.trim() || username.trim() || 'Nouvel utilisateur' }}</strong>
                  <span class="mono muted small ellipsis">{{ username.trim() || 'identifiant' }}{{ email.trim() ? ' · ' + email.trim() : '' }}</span>
                </div>
              </div>
              <div class="p-badges">
                <span class="p-badge" [style.--tone]="labels[role()].tone"><wl-nav-icon [name]="labels[role()].icon" [size]="12" />{{ labels[role()].label }}</span>
                @if (role() === 'admin') {
                  <span class="p-badge" [style.--tone]="labels.admin.tone"><wl-nav-icon name="eye" [size]="12" />Administrateur : tout</span>
                } @else if (profile(); as p) {
                  <span class="p-badge" [style.--tone]="tone(p.id)" [title]="summary(p)"><wl-nav-icon [name]="p.icon || defaultIcon" [size]="12" />{{ p.name }}</span>
                }
                @if (role() !== 'admin' && effectiveServices().length) {
                  <span class="p-badge" style="--tone: var(--accent-3)" [title]="'Services visibles : ' + effectiveServices().join(', ')">
                    <wl-nav-icon name="filter" [size]="12" />{{ servicesText(effectiveServices()) }}</span>
                }
              </div>
            </div>
            <div class="block">
              <h3>Résumé</h3>
              <p class="phrase">{{ summaryText() }}</p>
              <p class="muted small">Un mot de passe provisoire sera généré et affiché une seule fois.</p>
            </div>
            @if (error()) { <div class="block"><span class="error small" role="alert" animate.enter="hint-in"><wl-nav-icon name="warning" [size]="14" />{{ error() }}</span></div> }
            <div class="actions">
              <button class="btn primary" (click)="create()" [disabled]="busy() || !username.trim()">
                <wl-nav-icon [name]="busy() ? 'refresh' : 'plus'" [class.spin]="busy()" [size]="14" />{{ busy() ? 'Création…' : 'Créer le compte' }}
              </button>
              <a class="btn" routerLink="/admin/users">Annuler</a>
            </div>
          </aside>
        </div>
      }
    </div>
  `,
  styles: `
    .crumb { display: inline-flex; align-items: center; gap: 6px; }
    .options { display: flex; flex-wrap: wrap; gap: 12px 20px; }
    .options .field { min-width: min(220px, 100%); flex: 1; }
    div.field { display: grid; justify-items: start; gap: 6px; font-size: 12px; color: var(--text-2); }
    .control { position: relative; display: block; }
    .control input { width: 100%; padding-left: 32px; }
    .control wl-nav-icon { position: absolute; left: 11px; top: 0; bottom: 0; margin: auto 0; height: 14px; color: var(--text-3); pointer-events: none;
      transition: color .25s, transform .4s var(--spring); }
    .control:focus-within wl-nav-icon { color: var(--accent); transform: translateY(-1px) scale(1.12); }
    .note { display: flex; align-items: center; gap: 7px; }
    .note wl-nav-icon { flex: none; color: var(--accent-3); }

    .choice-icon { display: grid; place-items: center; width: 34px; height: 34px; margin-bottom: 6px; border-radius: 10px;
      transition: transform .45s var(--spring), background-color .25s, color .25s; }
    .choice .choice-icon { color: var(--tone); background: color-mix(in srgb, var(--tone) 15%, transparent); }
    .choice:hover .choice-icon { transform: scale(1.08) rotate(-6deg); }
    .choice.on .choice-icon { color: var(--on-accent); background: linear-gradient(135deg, var(--tone), color-mix(in srgb, var(--tone) 55%, var(--accent-2)));
      box-shadow: 0 8px 18px -8px var(--tone); animation: chosen .5s var(--spring); }
    @keyframes chosen { 40% { transform: scale(1.18) rotate(-8deg); } }

    /* Profil d'accès : liste riche teintée, puis les parties visibles en pastilles. */
    .profile-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
    .profile-select, .select-ghost { width: min(340px, 100%); height: 38px; }
    .profile-select { border-color: color-mix(in srgb, var(--tone) 42%, var(--border)); background-color: color-mix(in srgb, var(--tone) 9%, var(--surface-2)); }
    .select-ghost { display: block; border-radius: var(--radius-sm); }
    .manage { display: inline-flex; align-items: center; gap: 6px; }
    .sec-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .sec-chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px 0 7px; border-radius: 999px; font: 550 11.5px/1 var(--sans);
      white-space: nowrap; color: var(--text-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border-soft); }
    .sec-chip wl-nav-icon { color: var(--tone); }
    .sec-chip.home { color: var(--text-1); background: color-mix(in srgb, var(--tone) 16%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 42%, transparent); }
    .chip-in { animation: chip-in .35s var(--spring); }
    @keyframes chip-in { from { opacity: 0; transform: scale(.85); } }
    .all-access { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }

    .preview { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .avatar { flex: none; display: grid; place-items: center; width: 38px; height: 38px; border-radius: 50%; color: #fff; font: 700 13px/1 var(--sans);
      background: linear-gradient(135deg, hsl(var(--hue) 72% 58%), hsl(calc(var(--hue) + 40) 76% 42%));
      box-shadow: 0 6px 14px -6px hsl(var(--hue) 70% 45%), inset 0 1px 0 rgb(255 255 255 / .35); }
    .who { flex: 1; display: grid; min-width: 0; }
    .p-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .p-badge { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px 0 7px; border-radius: 999px; max-width: 100%;
      font: 600 11.5px var(--sans); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--tone);
      background: color-mix(in srgb, var(--tone) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 28%, transparent); }

    .success { display: flex; align-items: center; gap: 16px; }
    .done-badge { flex: none; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%; color: var(--on-accent);
      background: linear-gradient(135deg, var(--ok), color-mix(in srgb, var(--ok) 60%, var(--accent-2)));
      box-shadow: 0 10px 24px -10px var(--ok); animation: badge-in .7s var(--spring) .1s backwards; }
    @keyframes badge-in { from { opacity: 0; transform: scale(.3) rotate(-30deg); } }
    .secret-box { display: grid; gap: 4px; min-width: 0; }
    .secret-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .secret { font-size: 15px; padding: 6px 12px; background: var(--code-bg); border: 1px solid var(--border); border-radius: var(--radius-sm); user-select: all;
      letter-spacing: .03em; overflow-wrap: anywhere; }
    .btn.copied { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
    .error { display: inline-flex; align-items: center; gap: 7px; color: var(--danger); }
    .btn wl-nav-icon.spin { animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .hint-in { animation: hint-in .35s var(--spring); }
    @keyframes hint-in { from { opacity: 0; transform: translateY(-4px); } }
    .phrase { font-size: 13.5px; line-height: 1.5; }
    p { margin: 0; }

    @media (max-width: 600px) {
      .page { padding: 14px 12px 24px; gap: 14px; }
      .form-page .step > .step-body { padding: 12px 14px 16px; }
      .form-page .step > .step-head { padding: 14px 14px 0; flex-wrap: wrap; }
      .form-page .choices { grid-template-columns: minmax(0, 1fr); }
    }
  `,
})
export class UserFormPage implements OnDestroy {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly session = inject(Session);
  /** Profil proposé d'emblée (?profile=<id>, depuis la liste filtrée par profil). */
  readonly preset = input<string>(undefined, { alias: 'profile' });
  protected readonly roles: Role[] = ['viewer', 'editor', 'admin'];
  protected readonly labels = ROLE_LABELS;
  protected readonly role = signal<Role>('viewer');
  protected readonly profiles = signal<AccessProfile[]>([]);
  /** Profil d'accès choisi (« Tout voir » par défaut). */
  protected readonly profileId = linkedSignal(() => this.preset() || EVERYTHING);
  protected readonly profile = computed(() => this.profiles().find((p) => p.id === this.profileId()) ?? null);
  /** Services visibles : ceux du profil (par défaut), tous, ou une liste propre au compte. */
  protected readonly scopeMode = signal<'profile' | 'all' | 'custom'>('profile');
  protected readonly services = signal<string[]>([]);
  /** Services que verra le compte (vide : tous). */
  protected readonly effectiveServices = computed(() =>
    this.scopeMode() === 'profile' ? (this.profile()?.services ?? []) : this.scopeMode() === 'all' ? [] : this.services());
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly created = signal<{ username: string; password: string } | null>(null);
  /** Message d'invitation copié (coche pendant quelques secondes). */
  protected readonly invited = signal(false);
  protected readonly origin = location.origin;
  protected readonly tone = profileTone;
  protected readonly summary = profileSummary;
  protected readonly everything = EVERYTHING;
  protected readonly defaultIcon = PROFILE_ICONS[0];
  protected username = '';
  protected displayName = '';
  protected email = '';
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly summaryText = computed(() => {
    const role = this.labels[this.role()];
    const rights = `Compte ${role.label.toLowerCase()} : ${role.hint.toLowerCase()}.`;
    if (this.role() === 'admin') return `${rights} Voit toutes les parties de Wolflog.`;
    const p = this.profile();
    const services = this.effectiveServices().length ? ` Services : ${servicesLabel(this.effectiveServices(), 4)}.` : '';
    return (p ? `${rights} Profil « ${p.name} » : ${profileSummary(p)}.` : rights) + services;
  });

  protected servicesText(patterns: readonly string[]) {
    return servicesLabel(patterns, 2);
  }

  /** Services du profil choisi, en clair. */
  protected profileScope() {
    const p = this.profile();
    const list = p?.services?.length ? servicesLabel(p.services, 6) : 'tous les services';
    return p ? `Profil « ${p.name} » : ${list}.` : 'Services du profil choisi.';
  }

  constructor() {
    this.api.accessProfiles().subscribe({
      next: (list) => {
        this.profiles.set(list);
        // Profil demandé inconnu : « Tout voir ».
        if (!list.some((p) => p.id === this.profileId())) this.profileId.set(EVERYTHING);
      },
      error: () => this.toasts.error('Impossible de lire les profils d’accès.'),
    });
  }

  /** Aperçu : relus à chaque saisie (champs liés par ngModel). */
  protected initials() {
    return nameInitials(this.displayName.trim() || this.username.trim() || '?');
  }

  protected hue() {
    return nameHue(this.username.trim());
  }

  protected sectionsOf(p: AccessProfile) {
    return SECTIONS.filter((s) => p.sections.includes(s.id));
  }

  protected create() {
    this.error.set('');
    this.busy.set(true);
    const profileId = this.role() === 'admin' ? null : this.profileId();
    // Liste propre au compte seulement si elle diffère de « comme le profil » ([] : tous).
    const mode = this.scopeMode();
    const services = this.role() === 'admin' || mode === 'profile' ? null : mode === 'all' ? [] : this.services();
    this.api.createUser({ username: this.username.trim(), displayName: this.displayName.trim(), email: this.email.trim(), role: this.role(), profileId, services }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.created.set({ username: r.user.username, password: r.temporaryPassword });
        this.toasts.ok(`Compte « ${r.user.username} » créé`, 'users');
      },
      error: (e) => {
        this.busy.set(false);
        this.error.set(e?.error?.error ?? 'Création impossible.');
        this.toasts.error(this.error());
      },
    });
  }

  /** Message prêt à envoyer : adresse, identifiant et mot de passe provisoire. */
  protected copyInvitation(username: string, password: string) {
    const text = `Bonjour,\n\nVoici votre accès à Wolflog : ${this.origin}\nUtilisateur : ${username}\nMot de passe provisoire : ${password}\n\n`
      + 'Vous choisirez votre propre mot de passe à la première connexion.';
    copyToClipboard(text).then(
      () => {
        this.invited.set(true);
        this.toasts.info('Invitation copiée dans le presse-papiers', 'mail');
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.invited.set(false), 2500);
      },
      () => this.toasts.error('Copie impossible : le navigateur refuse l’accès au presse-papiers.'),
    );
  }

  protected reset() {
    this.created.set(null);
    this.invited.set(false);
    this.username = this.displayName = this.email = '';
    this.role.set('viewer');
    this.profileId.set(EVERYTHING);
    this.scopeMode.set('profile');
    this.services.set([]);
  }

  ngOnDestroy() {
    clearTimeout(this.timer);
  }
}
