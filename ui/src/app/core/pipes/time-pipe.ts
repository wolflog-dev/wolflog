import { Pipe, PipeTransform } from '@angular/core';
import { formatTime } from '../format';

/** Heure à la milliseconde, avec la date si demandé. */
@Pipe({ name: 'time' })
export class TimePipe implements PipeTransform {
  transform(v: string | null | undefined, withDate = false) { return v ? formatTime(v, withDate) : '–'; }
}
