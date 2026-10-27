/** Page de connexion (avec ou sans paramètres). */
export function isLoginUrl(url: string | null | undefined): boolean {
  return /^\/login(?:[/?#]|$)/.test(url ?? '');
}

/**
 * Adresse où aller après la connexion : locale uniquement (« /logs », jamais « //site » ni une adresse absolue),
 * jamais la page de connexion elle-même. Une adresse imbriquée (/login?returnUrl=/login?returnUrl=/logs), laissée par
 * plusieurs requêtes refusées en même temps à l'expiration de la session, est déroulée jusqu'à la vraie page.
 */
export function safeReturnUrl(url: string | null | undefined): string {
  let current = url ?? '';
  for (let i = 0; i < 10 && isLoginUrl(current); i++) {
    current = new URL(current, 'http://local').searchParams.get('returnUrl') ?? '';
  }
  const local = /^\/(?![/\\])/.test(current) && !/[\u0000-\u001f]/.test(current);
  return local && !isLoginUrl(current) ? current : '/';
}
