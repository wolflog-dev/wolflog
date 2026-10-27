/** Valeur prête pour la barre de recherche : entre guillemets si elle contient des espaces ou des guillemets. */
export function quoteValue(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '')}"` : value;
}

/** Mots de la recherche (les phrases et clé:"valeur" entre guillemets restent entières). */
export function searchTokens(text: string): string[] {
  return text.match(/-?[^\s"]*"[^"]*"\S*|\S+/g) ?? [];
}

/** Clé d'un mot « clé:valeur » ou « -clé:valeur » (en minuscules), sinon null. */
function tokenKey(token: string): { key: string; negated: boolean } | null {
  const negated = token.startsWith('-');
  const body = negated ? token.slice(1) : token;
  const colon = body.indexOf(':');
  return colon > 0 && !body.startsWith('"') ? { key: body.slice(0, colon).toLowerCase(), negated } : null;
}

/**
 * Ajoute « clé:valeur » (ou son exclusion « -clé:valeur ») à la recherche, en remplaçant un filtre de même clé et de
 * même sens ; valeur null : retire ce filtre.
 */
export function setFilter(text: string, key: string, value: string | null, negated = false): string {
  const kept = searchTokens(text).filter((t) => {
    const k = tokenKey(t);
    return !(k && k.key === key.toLowerCase() && k.negated === negated);
  });
  if (value !== null) kept.push(`${negated ? '-' : ''}${key}:${quoteValue(value)}`);
  return kept.join(' ');
}

/** Valeur d'un filtre « clé:valeur » présent dans la recherche (sans exclusion), sinon null. */
export function filterValue(text: string, key: string): string | null {
  for (const t of searchTokens(text)) {
    const k = tokenKey(t);
    if (k && !k.negated && k.key === key.toLowerCase()) return t.slice(t.indexOf(':') + 1).replace(/^"|"$/g, '');
  }
  return null;
}

/** Ajoute un mot ou une phrase libre (exclu avec negated). */
export function addTerm(text: string, term: string, negated = false): string {
  const token = (negated ? '-' : '') + (/\s/.test(term) ? `"${term.replace(/"/g, '')}"` : term);
  return [...searchTokens(text), token].join(' ');
}
