import { AlertChannel, AlertKind, ChannelType, AlertRule, Probe, Slo } from '../core/models';
import { AGGREGATES } from './dashboard-panel';

export const ALERT_KINDS: { value: AlertKind; label: string; hint: string; example: string; icon: string }[] = [
  { value: 'http', label: 'Requêtes HTTP', hint: "Taux d'erreur, latence ou débit des requêtes reçues par un service", example: "ex. plus de 5 % d'erreurs sur l'API", icon: 'requests' },
  { value: 'error', label: 'Nouvelle erreur', hint: 'Une exception jamais vue, ou une erreur résolue qui revient', example: 'ex. après un déploiement', icon: 'errors' },
  { value: 'silence', label: 'Service muet', hint: "Un service n'envoie plus de logs ni de traces", example: "ex. l'application est arrêtée", icon: 'mute' },
  { value: 'query', label: 'Requête personnalisée', hint: 'Un calcul sur les logs, spans ou métriques, comparé à un seuil', example: 'ex. plus de 10 logs « paiement refusé » en 5 min', icon: 'sigma' },
  { value: 'probe', label: 'Sonde', hint: 'Un site ou un port ne répond plus, ou son certificat TLS expire', example: 'ex. le site public est en panne', icon: 'uptime' },
  { value: 'slo', label: 'Objectif (SLO)', hint: "Le budget d'erreur d'un objectif se consomme trop vite", example: 'ex. 99,9 % menacé', icon: 'slos' },
  { value: 'health', label: 'Santé de Wolflog', hint: 'Disque presque plein, écriture en échec, plus aucune donnée reçue', example: 'ex. disque à 95 %', icon: 'system' },
];

/** Icône d'un type d'alerte (listes, choix du formulaire). */
export function kindIcon(kind: string): string {
  return ALERT_KINDS.find((k) => k.value === kind)?.icon ?? 'alerts';
}

/** Libellé d'un type d'alerte. */
export function kindLabel(kind: string): string {
  return ALERT_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

export const WINDOWS = [
  { value: 1, label: '1 min', hint: 'Très réactif, sensible aux pics' }, { value: 5, label: '5 min', hint: 'Réactif : le choix courant' },
  { value: 10, label: '10 min', hint: 'Réactif, moins de bruit' }, { value: 15, label: '15 min', hint: 'Équilibré' },
  { value: 30, label: '30 min', hint: 'Lissé' }, { value: 60, label: '1 h', hint: 'Lissé, suit la tendance' },
  { value: 360, label: '6 h', hint: 'Tendance de fond' }, { value: 1440, label: '24 h', hint: 'Sur une journée entière' },
];

export const HTTP_STATS = [
  { value: 'errorRate', label: "le taux d'erreur (5xx)", unit: '%', series: 'errorRate', icon: 'percent', tone: 'danger', desc: 'Part des réponses en erreur serveur' },
  { value: 'p95', label: 'la latence p95', unit: 'ms', series: 'p95', icon: 'timer', tone: 'warn', desc: '95 % des requêtes répondent plus vite' },
  { value: 'p99', label: 'la latence p99', unit: 'ms', series: 'p99', icon: 'timer', tone: 'warn', desc: 'Seules 1 % des requêtes sont plus lentes' },
  { value: 'p50', label: 'la latence médiane', unit: 'ms', series: 'p50', icon: 'timer', tone: 'info', desc: 'La moitié des requêtes répondent plus vite' },
  { value: 'rate', label: 'le débit', unit: 'req/s', series: 'rate', icon: 'bolt', tone: 'accent', desc: 'Requêtes reçues par seconde' },
];

const AGGREGATE_ICONS: Record<string, string> = {
  count: 'hash', rate: 'bolt', distinct: 'layers', avg: 'chart-line', sum: 'sigma', min: 'arrow-down', max: 'arrow-up',
};

/** Icône d'un calcul (nombre, moyenne, percentile…) pour les listes déroulantes. */
export function aggregateIcon(value: string): string {
  return AGGREGATE_ICONS[value] ?? 'gauge';
}

/** Précision courte sur un calcul : sur quoi il porte. */
export function aggregateHint(value: string, numeric: boolean): string {
  if (value === 'count') return "Nombre d'évènements";
  if (value === 'rate') return 'Évènements par seconde';
  if (value === 'distinct') return "Valeurs différentes d'un champ";
  return numeric ? 'Calculé sur un champ numérique' : '';
}

export function newRule(kind: AlertKind = 'http'): AlertRule {
  return {
    id: '', name: '', enabled: true, kind, severity: 'critical', comparison: 'above',
    threshold: kind === 'http' ? 5 : kind === 'slo' ? 14.4 : kind === 'probe' ? 14 : 0,
    windowMinutes: kind === 'silence' ? 15 : kind === 'slo' ? 60 : 5, forMinutes: 0, repeatMinutes: 0, minCount: kind === 'http' ? 20 : 0,
    channels: [], notifyResolved: true, stat: 'errorRate', source: 'logs', aggregate: 'count', includeRegressions: true,
  };
}

/** Description courte d'une règle, en français. */
export function describeRule(r: AlertRule, probes: Probe[] = [], slos: Slo[] = []): string {
  const win = WINDOWS.find((w) => w.value === r.windowMinutes)?.label ?? `${r.windowMinutes} min`;
  const scope = r.service ? ` de ${r.service}` : r.perService ? ' par service' : '';
  const cmp = r.comparison === 'below' ? '<' : '>';
  switch (r.kind) {
    case 'http': {
      const s = HTTP_STATS.find((x) => x.value === (r.stat ?? 'errorRate'));
      return `${s?.label ?? r.stat}${scope}${r.route ? ' ' + r.route : ''} ${cmp} ${r.threshold.toLocaleString('fr-FR')} ${s?.unit ?? ''} sur ${win}`;
    }
    case 'error':
      return `${r.crashesOnly ? 'nouveau crash' : 'nouvelle erreur'}${r.includeRegressions ? ' ou erreur réapparue' : ''}${r.service ? ' dans ' + r.service : ''}`;
    case 'silence':
      return `${r.service ?? 'un service'} muet depuis ${win}`;
    case 'probe':
      return `${probes.find((p) => p.id === r.targetId)?.name ?? 'une sonde'} en panne${r.threshold > 0 ? `, certificat < ${r.threshold} j` : ''}`;
    case 'slo':
      return `${slos.find((s) => s.id === r.targetId)?.name ?? 'un objectif'} : budget consommé > ${(r.threshold || 14.4).toLocaleString('fr-FR')}× sur ${win}`;
    case 'health':
      return r.severity === 'warning' ? 'Wolflog : avertissement ou problème critique' : 'Wolflog : problème critique';
    default: {
      const agg = AGGREGATES.find((a) => a.value === r.aggregate)?.label.replace('…', r.field ?? '') ?? r.aggregate;
      return `${agg} de ${r.source}${r.filter ? ' « ' + r.filter + ' »' : ''}${r.groupBy ? ' par ' + r.groupBy : ''}${scope} ${cmp} ${r.threshold.toLocaleString('fr-FR')} sur ${win}`;
    }
  }
}

export function channelTypeLabel(t: string) {
  return ({ email: 'e-mail', teams: 'Teams', slack: 'Slack', webhook: 'webhook' } as Record<string, string>)[t] ?? t;
}

/** Phrase « qui est prévenu, comment ». */
export function describeNotification(r: AlertRule, channels: AlertChannel[]): string {
  const names = r.channels.map((id) => channels.find((c) => c.id === id)).filter((c): c is AlertChannel => !!c)
    .map((c) => `${c.name} (${channelTypeLabel(c.type)})`);
  const who = names.length ? names.join(', ') : 'personne (visible dans Wolflog seulement)';
  const every: Record<number, string> = { 30: 'toutes les 30 min', 60: 'toutes les heures', 240: 'toutes les 4 h', 1440: 'tous les jours' };
  const repeat = r.repeatMinutes ? `, rappel ${every[r.repeatMinutes] ?? 'toutes les ' + r.repeatMinutes + ' min'}` : '';
  return `${who}${repeat}`;
}

export const CHANNEL_TYPES: { value: ChannelType; label: string; placeholder: string; hint: string; icon: string }[] = [
  { value: 'email', label: 'E-mail', placeholder: 'astreinte@mondomaine.fr, dev@mondomaine.fr', hint: 'Adresses séparées par des virgules. Le serveur SMTP se règle dans l’onglet Canaux des alertes.', icon: 'mail' },
  { value: 'teams', label: 'Microsoft Teams', placeholder: 'https://….webhook.office.com/… ou URL de workflow', hint: "Dans Teams : canal > Workflows > « Publier dans un canal lorsqu'une requête webhook est reçue », puis coller l'URL.", icon: 'chat' },
  { value: 'slack', label: 'Slack', placeholder: 'https://hooks.slack.com/services/…', hint: 'Application « Incoming Webhooks » de Slack, un webhook par canal.', icon: 'hash' },
  { value: 'webhook', label: 'Webhook', placeholder: 'https://mon-outil/alertes', hint: 'Requête POST JSON : status, rule, severity, message, link, at.', icon: 'webhook' },
];

/** Icône d'un type de canal : enveloppe, bulle (Teams), dièse (Slack), crochet (webhook). */
export function channelIcon(t: string): string {
  return CHANNEL_TYPES.find((c) => c.value === t)?.icon ?? 'bell';
}
