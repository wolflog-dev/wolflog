/** Modèle de message prêt à l'emploi, proposé dans l'éditeur (titre et corps au format des modèles). */
export interface MessagePreset {
  id: string;
  label: string;
  icon: string;
  desc: string;
  title: string;
  body: string;
}

/** Modèles proposés dans l'éditeur de message des alertes (variables {{…}} remplacées à l'envoi). */
export const MESSAGE_PRESETS: MessagePreset[] = [
  {
    id: 'court', label: 'Court', icon: 'bolt', desc: "L'essentiel en une ligne, idéal sur mobile",
    title: '{{statut}} · {{regle}}',
    body: '{{message}}',
  },
  {
    id: 'detaille', label: 'Détaillé', icon: 'list', desc: 'Service, valeur, seuil, dernière erreur et lien',
    title: '{{statut}} : {{regle}}',
    body: [
      '**{{message}}**',
      '- Service : **{{service}}** ({{env}})',
      '- Valeur : **{{valeur}}**, seuil {{seuil}} sur {{fenetre}}',
      '- Dernière erreur : {{derniere_erreur}}',
      '_Consigne : {{consigne}}_',
      '[Voir dans Wolflog]({{lien}})',
    ].join('\n'),
  },
  {
    id: 'astreinte', label: 'Astreinte', icon: 'bell', desc: 'Ce qu’il faut savoir pour agir tout de suite',
    title: '[{{severite}}] {{service}} : {{regle}}',
    body: [
      '**{{service}}** ({{env}}) demande une intervention.',
      '{{message}}',
      '_À faire : {{consigne}}_',
      '[Ouvrir dans Wolflog]({{lien}})',
    ].join('\n'),
  },
  {
    id: 'erreur', label: 'Erreur applicative', icon: 'errors', desc: 'Exception, message et nombre d’occurrences',
    title: '{{statut}} : {{exception}} dans {{service}}',
    body: [
      '**{{exception}}** dans **{{service}}** ({{occurrences}} occurrence(s))',
      '{{erreur}}',
      '[Voir l’erreur]({{lien}})',
    ].join('\n'),
  },
];
