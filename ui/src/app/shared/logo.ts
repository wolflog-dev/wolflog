import { Component, input } from '@angular/core';

/** Tête de loup à facettes : moitié gauche en couleur d'accent, moitié droite plus sombre ; yeux et truffe évidés. */
@Component({
  selector: 'wl-logo',
  template: `
    <svg viewBox="0 0 64 64" [attr.width]="size()" [attr.height]="size()" aria-hidden="true">
      <path class="l" fill-rule="evenodd" d="M12 5 25 19H32V59L18 42 4 34 10 26ZM18 30 28 33.5 20 36ZM28 46H32V51Z" />
      <path class="r" fill-rule="evenodd" d="M52 5 39 19H32V59L46 42 60 34 54 26ZM46 30 36 33.5 44 36ZM36 46H32V51Z" />
    </svg>
  `,
  styles: `
    :host { display: inline-flex; }
    .l { fill: var(--accent); }
    .r { fill: var(--accent); opacity: .72; }
  `,
})
export class Logo {
  readonly size = input(20);
}
