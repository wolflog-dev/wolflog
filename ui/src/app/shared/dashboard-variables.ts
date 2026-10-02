import { DashboardVariable, Panel } from '../core/models';

const TEXT_FIELDS = ['query', 'metric'] as const;

/** Valeur prête pour un filtre de recherche : entre guillemets si elle contient des espaces. */
function quote(v: string) {
  return /\s/.test(v) ? `"${v.replace(/"/g, '')}"` : v;
}

/**
 * Expression qui trouve $nom, suivi d'autre chose qu'une lettre ou un chiffre. Le nom est échappé : un nom en cours
 * de saisie (« ( », « a.b »…) ne casse rien et ne correspond qu'à lui-même.
 */
function tokenPattern(name: string) {
  return new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`, 'g');
}

/**
 * Remplace $nom dans un panneau par la valeur choisie.
 * Sans valeur (« Tous »), le filtre qui contient la variable disparaît : le panneau porte alors sur tout.
 */
export function resolvePanel(panel: Panel, variables: DashboardVariable[], values: Record<string, string>): Panel {
  if (!variables.length) return panel;
  const p: Panel = { ...panel };
  for (const v of variables) {
    // Variable sans nom (en cours de saisie) : rien à remplacer.
    if (!v.name) continue;
    const token = '$' + v.name;
    const value = values[v.name] ?? '';
    const pattern = tokenPattern(v.name);
    for (const key of TEXT_FIELDS) {
      const current = p[key];
      if (!current || !current.includes(token)) continue;
      p[key] = value
        ? current.replace(pattern, () => quote(value))
        : current.split(/\s+/).filter((part) => !part.includes(token)).join(' ') || null;
    }
    // Remplacement par fonction : une valeur contenant « $& » ou « $1 » est insérée telle quelle.
    if (p.service?.includes(token)) p.service = value ? p.service.replace(pattern, () => value) : null;
    if (p.groupBy?.includes(token)) p.groupBy = value ? p.groupBy.replace(pattern, () => value) : null;
    if (p.field?.includes(token)) p.field = value ? p.field.replace(pattern, () => value) : null;
    if (p.title.includes(token)) p.title = p.title.replace(pattern, () => value || 'tous');
  }
  return p;
}

/** La variable est-elle utilisée par au moins un panneau ? */
export function isUsed(v: DashboardVariable, panels: Panel[]) {
  if (!v.name) return false;
  const token = '$' + v.name;
  return panels.some((p) => [p.query, p.metric, p.service, p.groupBy, p.field, p.title].some((x) => x?.includes(token)));
}
