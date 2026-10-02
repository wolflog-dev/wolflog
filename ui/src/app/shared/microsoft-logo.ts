import { Component, input } from '@angular/core';

/** Logo Microsoft officiel (quatre carrés), sur les boutons « Se connecter avec Microsoft ». Couleurs de la marque, fixes. */
@Component({
  selector: 'wl-microsoft-logo',
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  `,
  styles: `
    :host { display: inline-flex; flex: none; }
    svg { display: block; }
  `,
})
export class MicrosoftLogo {
  readonly size = input(18);
}
