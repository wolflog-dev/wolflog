/** Planifications en clair : intervalles, heures fixes, jours (0 = dimanche … 6 = samedi, comme le serveur). */

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Jours en clair : « tous les jours », « du lundi au vendredi », « lundi, mercredi ». */
export function describeDays(days: number[] | null | undefined): string {
  if (!days?.length || days.length === 7) return 'tous les jours';
  const set = new Set(days);
  if (set.size === 5 && WEEKDAYS.every((d) => set.has(d))) return 'du lundi au vendredi';
  if (set.size === 2 && set.has(0) && set.has(6)) return 'le week-end';
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => set.has(d)).map((d) => DAY_NAMES[d]).join(', ');
}

/** « toutes les 5 min », « chaque heure », « tous les 2 jours ». */
export function everyLabel(seconds: number): string {
  const units: [number, string, string, boolean][] = [[86400, 'jour', 'jours', false], [3600, 'heure', 'h', true], [60, 'minute', 'min', true], [1, 'seconde', 's', true]];
  const [size, one, many, feminine] = units.find(([u]) => seconds % u === 0 && seconds >= u) ?? units[3];
  const n = seconds / size;
  if (n === 1) return `chaque ${one}`;
  return `${feminine ? 'toutes' : 'tous'} les ${n} ${many}`;
}

/** Durée en minutes, courte : « 5 min », « 2 h », « 1 h 30 », « 3 j ». */
export function durationLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} j`;
  if (minutes >= 60) return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
  return `${minutes} min`;
}

/** « à 08:00 et 12:00, du lundi au vendredi ». */
export function scheduleLabel(times: string[], days: number[] | null | undefined): string {
  const list = times.length > 1 ? `${times.slice(0, -1).join(', ')} et ${times[times.length - 1]}` : times[0];
  return `à ${list}, ${describeDays(days)}`;
}

/** Plage horaire en clair : « de 08:00 à 19:00 », « à partir de 22:00 », « toute la journée ». */
export function hoursLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (from && to && from !== to) return `de ${from} à ${to}`;
  if (from && !to) return `à partir de ${from}`;
  if (!from && to) return `jusqu'à ${to}`;
  return 'toute la journée';
}
