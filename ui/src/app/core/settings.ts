/** Préférences locales (localStorage), sans erreur si le stockage est indisponible (navigation privée, quota). */
export function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}
