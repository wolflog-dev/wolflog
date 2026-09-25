import { Injectable, computed, signal } from '@angular/core';
import { Range } from './models';
import { readSetting, writeSetting } from './settings';

export interface RangePreset {
  label: string;
  long: string;
  from: string;
}

export const PRESETS: RangePreset[] = [
  { label: '5 min', long: '5 dernières minutes', from: '5m' },
  { label: '15 min', long: '15 dernières minutes', from: '15m' },
  { label: '1 h', long: 'Dernière heure', from: '1h' },
  { label: '6 h', long: '6 dernières heures', from: '6h' },
  { label: '24 h', long: '24 dernières heures', from: '24h' },
  { label: '3 j', long: '3 derniers jours', from: '3d' },
  { label: '7 j', long: '7 derniers jours', from: '7d' },
  { label: '30 j', long: '30 derniers jours', from: '30d' },
];

/** Plage de temps et filtre de services partagés par toutes les pages. */
@Injectable({ providedIn: 'root' })
export class AppState {
  readonly from = signal(readSetting('wolflog.from', '1h'));
  readonly to = signal(readSetting('wolflog.to', ''));
  readonly service = signal(readSetting('wolflog.service', ''));
  /** Environnement (prod, staging…) : ajouté à toutes les requêtes de l'API par l'intercepteur. */
  readonly env = signal(readSetting('wolflog.env', ''));
  readonly autoRefresh = signal(readSetting('wolflog.refresh', '0') === '1');
  /** Incrémenté pour forcer le rechargement des pages. */
  readonly tick = signal(0);

  readonly range = computed<Range>(() => ({ from: this.from(), to: this.to() }));
  readonly isRelative = computed(() => !this.to());
  readonly label = computed(() => {
    const preset = PRESETS.find((p) => p.from === this.from());
    if (preset && !this.to()) return preset.long;
    return `${formatShort(this.from())} → ${this.to() ? formatShort(this.to()) : 'maintenant'}`;
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.applyRefresh();
  }

  setRelative(from: string) {
    this.from.set(from);
    this.to.set('');
    this.persist();
  }

  setAbsolute(from: Date, to: Date) {
    this.from.set(from.toISOString());
    this.to.set(to.toISOString());
    this.persist();
  }

  setService(service: string) {
    this.service.set(service);
    writeSetting('wolflog.service', service);
    this.refresh();
  }

  setEnv(env: string) {
    this.env.set(env);
    writeSetting('wolflog.env', env);
    this.refresh();
  }

  toggleAutoRefresh() {
    this.autoRefresh.update((v) => !v);
    writeSetting('wolflog.refresh', this.autoRefresh() ? '1' : '0');
    this.applyRefresh();
  }

  refresh() {
    this.tick.update((t) => t + 1);
  }

  private applyRefresh() {
    if (this.timer) clearInterval(this.timer);
    this.timer = this.autoRefresh() ? setInterval(() => this.isRelative() && this.refresh(), 10_000) : null;
  }

  private persist() {
    writeSetting('wolflog.from', this.from());
    writeSetting('wolflog.to', this.to());
  }
}

function formatShort(v: string): string {
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
