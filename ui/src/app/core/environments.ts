import { signal } from '@angular/core';
import type { EnvironmentInfo } from './models';

/**
 * Environnements connus de l'interface : dernières listes reçues de /api/environments/stats (Api.environmentStats les
 * retient), pour que les libellés et couleurs réglés dans Administration › Environnements s'appliquent partout
 * (envTone, envColor et envLabel de shared/rich-option.ts), y compris aux valeurs reçues affichées dans les logs.
 */
interface Known {
  /** Nom (en minuscules) → environnement. */
  byName: Map<string, EnvironmentInfo>;
  /** Application + valeur reçue (en minuscules) → environnement : une même valeur peut désigner un autre environnement selon l'application. */
  byApp: Map<string, EnvironmentInfo>;
  /** Valeur reçue (en minuscules) → environnement, toutes applications confondues (le premier dans l'ordre du sélecteur). */
  byRaw: Map<string, EnvironmentInfo>;
}

const empty = (): Known => ({ byName: new Map(), byApp: new Map(), byRaw: new Map() });
const known = signal<Known>(empty());

/** Incrémenté quand les réglages changent (page d'administration) : la barre du haut recharge alors sa liste. */
export const environmentsVersion = signal(0);

const appKey = (service: string, raw: string) => `${service}\u0001${raw.toLowerCase()}`;

/**
 * Retient une liste reçue de l'API. Liste de toutes les applications : elle remplace ce qui était connu (environnement
 * supprimé, valeur déplacée) ; liste d'une seule application : elle complète.
 */
export function rememberEnvironments(list: readonly EnvironmentInfo[], complete: boolean) {
  known.update((current) => {
    const next = complete ? empty() : { byName: new Map(current.byName), byApp: new Map(current.byApp), byRaw: new Map(current.byRaw) };
    const seenRaw = new Set<string>();
    for (const e of list) {
      next.byName.set(e.name.toLowerCase(), e);
      for (const raw of e.raw ?? []) {
        const key = raw.toLowerCase();
        if (seenRaw.has(key)) continue;
        seenRaw.add(key);
        next.byRaw.set(key, e);
      }
      for (const app of e.apps ?? []) for (const raw of app.raw) next.byApp.set(appKey(app.service, raw), e);
    }
    return next;
  });
}

/**
 * Environnement d'une valeur : nom d'un environnement du sélecteur, ou valeur reçue (rattachée selon l'application si elle
 * est connue). null : inconnu (environnement masqué, ou liste pas encore reçue).
 */
export function knownEnvironment(env: string | null | undefined, service?: string | null): EnvironmentInfo | null {
  if (!env) return null;
  const k = known();
  const key = env.toLowerCase();
  return (service ? k.byApp.get(appKey(service, env)) : undefined) ?? k.byName.get(key) ?? k.byRaw.get(key) ?? null;
}

/** Réglages enregistrés : la barre du haut recharge sa liste (environmentsVersion). */
export function environmentsChanged() {
  environmentsVersion.update((v) => v + 1);
}
