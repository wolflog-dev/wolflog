import { Pipe, PipeTransform } from '@angular/core';
import { timeAgo } from '../format';

/** Temps écoulé : « il y a 5 min ». */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(v: string | null | undefined) { return timeAgo(v ?? null); }
}
