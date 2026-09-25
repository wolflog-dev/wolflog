import { Pipe, PipeTransform } from '@angular/core';
import { formatBytes } from '../format';

/** Taille lisible : o, Ko, Mo, Go. */
@Pipe({ name: 'bytes' })
export class BytesPipe implements PipeTransform {
  transform(v: number) { return formatBytes(v); }
}
