export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** Couleurs des graphiques : info reste neutre pour que warn / error ressortent. */
export const LEVEL_COLORS: Record<string, string> = {
  trace: '#3b3e45',
  debug: '#4e5868',
  info: '#5a6780',
  warn: '#c9973f',
  error: '#d45f5f',
  fatal: '#c0508f',
};

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (Math.abs(n) >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace('.0', '') + ' G';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.0', '') + ' M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1).replace('.0', '') + ' k';
  return Number.isInteger(n) ? n.toLocaleString('fr-FR') : n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatBytes(b: number): string {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(iso: string, withDate = false): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  if (!withDate) return time;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + time;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return '–';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

export function parseJson(s: string | null | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
