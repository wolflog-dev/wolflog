import { Component, ElementRef, effect, inject, input } from '@angular/core';
import { createIcon } from '../core/icons';

/** Icône au trait (voir core/icons.ts), couleur du texte. Usage : <wl-nav-icon name="logs" />, taille par défaut 16 px. */
@Component({
  selector: 'wl-nav-icon',
  template: '',
  styles: `
    :host { display: inline-flex; flex: none; }
    :host ::ng-deep svg { display: block; }
  `,
})
export class NavIcon {
  readonly name = input.required<string>();
  readonly size = input(16);

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  constructor() {
    effect(() => this.el.replaceChildren(createIcon(this.name(), this.size())));
  }
}
