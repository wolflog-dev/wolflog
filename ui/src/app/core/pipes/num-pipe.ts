import { Pipe, PipeTransform } from '@angular/core';
import { formatNumber } from '../format';

/** Nombre abrégé à la française : 12 345, 45,6 k, 1,2 M. */
@Pipe({ name: 'num' })
export class NumPipe implements PipeTransform {
  transform(v: number | null | undefined) { return formatNumber(v); }
}
