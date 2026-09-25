import { Pipe, PipeTransform } from '@angular/core';
import { formatDuration } from '../format';

/** Durée lisible : µs, ms, s, min. */
@Pipe({ name: 'dur' })
export class DurPipe implements PipeTransform {
  transform(v: number | null | undefined) { return formatDuration(v); }
}
