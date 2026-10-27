import { signal } from '@angular/core';
import { Observable, Subscription } from 'rxjs';

export interface WindowedListOptions<T> {
  /** Lignes par chargement. */
  pageSize: number;
  /** Lignes gardées en mémoire au plus : au-delà, celles du bord opposé sont libérées (rechargées si l'on y revient). */
  maxItems: number;
  /** Lignes plus anciennes que la dernière (curseur). */
  older: (last: T) => Observable<T[]>;
  /** Lignes plus récentes que la première (curseur), dans l'ordre de la liste. */
  newer: (first: T) => Observable<T[]>;
  /**
   * Lignes ajoutées (positif) ou retirées (négatif) en haut de la liste : le défilement doit être décalé d'autant pour
   * que les lignes affichées ne bougent pas.
   */
  shiftTop: (rows: number) => void;
  /**
   * Chargement terminé : la page vérifie de nouveau les bords (sans attendre un défilement), pour enchaîner si l'on est
   * toujours au bord.
   */
  loaded?: () => void;
}

/**
 * Liste paginée par curseur dans les deux sens, avec une fenêtre glissante : on peut parcourir des millions de lignes
 * en défilant, sans jamais en garder plus de <c>maxItems</c> en mémoire.
 */
export class WindowedList<T> {
  readonly items = signal<T[]>([]);
  /** Il reste des lignes plus anciennes (en bas). */
  readonly hasOlder = signal(false);
  /** Des lignes plus récentes ont été libérées (en haut) : elles sont rechargées en remontant. */
  readonly hasNewer = signal(false);
  readonly loadingMore = signal(false);
  private sub?: Subscription;

  constructor(private readonly o: WindowedListOptions<T>) {}

  /** Première page (la plus récente). */
  reset(first: T[]) {
    this.sub?.unsubscribe();
    this.items.set(first);
    this.hasOlder.set(first.length >= this.o.pageSize);
    this.hasNewer.set(false);
    this.loadingMore.set(false);
  }

  /** Lignes visibles : charge ce qui manque près des bords. */
  onRange(start: number, end: number) {
    if (this.loadingMore()) return;
    const n = this.items().length;
    const margin = Math.max(20, Math.floor(this.o.pageSize / 3));
    if (this.hasOlder() && end >= n - margin) this.load('older');
    else if (this.hasNewer() && start <= margin) this.load('newer');
  }

  private load(direction: 'older' | 'newer') {
    const list = this.items();
    if (!list.length) return;
    this.loadingMore.set(true);
    const request = direction === 'older' ? this.o.older(list[list.length - 1]) : this.o.newer(list[0]);
    this.sub = request.subscribe({
      next: (page) => {
        const full = page.length >= this.o.pageSize;
        let next: T[];
        if (direction === 'older') {
          next = list.concat(page);
          this.hasOlder.set(full);
          const excess = next.length - this.o.maxItems;
          if (excess > 0) {
            next = next.slice(excess);
            this.hasNewer.set(true);
            this.o.shiftTop(-excess);
          }
        } else {
          next = page.concat(list);
          this.hasNewer.set(full);
          this.o.shiftTop(page.length);
          const excess = next.length - this.o.maxItems;
          if (excess > 0) {
            next = next.slice(0, next.length - excess);
            this.hasOlder.set(true);
          }
        }
        this.items.set(next);
        this.loadingMore.set(false);
        if (page.length > 0) this.o.loaded?.();
        else if (direction === 'newer') this.hasNewer.set(false);
        else this.hasOlder.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  destroy() {
    this.sub?.unsubscribe();
  }
}
