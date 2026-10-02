import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  text: string;
  kind: 'ok' | 'error' | 'info';
  icon: string;
  /** Durée d'affichage (ms), reprise par la barre de progression. */
  duration: number;
}

/**
 * Notifications brèves en bas à droite (« Enregistré », « Copié », erreurs…), affichées par <wl-toaster>.
 *   inject(Toasts).ok('Alerte enregistrée') ; .error(message) ; .info(texte, 'bell')
 */
@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly items = signal<Toast[]>([]);
  private next = 1;

  ok(text: string, icon = 'ok') { this.show(text, 'ok', icon); }
  error(text: string, icon = 'warning') { this.show(text, 'error', icon, 6000); }
  info(text: string, icon = 'info') { this.show(text, 'info', icon); }

  show(text: string, kind: Toast['kind'], icon: string, duration = 3200) {
    const toast: Toast = { id: this.next++, text, kind, icon, duration };
    this.items.update((list) => [...list.slice(-3), toast]);
    setTimeout(() => this.dismiss(toast.id), duration);
  }

  dismiss(id: number) {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }
}
