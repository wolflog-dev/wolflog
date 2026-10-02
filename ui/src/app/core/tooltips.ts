/**
 * Infobulles : tout élément portant un attribut title affiche, après un court délai, une bulle en verre animée
 * à la place de l'infobulle du système. Écouteurs DOM directs (sans détection de changements d'Angular) ;
 * le title est rendu à l'élément dès que le pointeur le quitte. Retourne la fonction de nettoyage.
 */
export function installTooltips(): () => void {
  const tip = document.createElement('div');
  tip.className = 'wl-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);

  let target: HTMLElement | null = null;
  let timer = 0;

  const restore = () => {
    clearTimeout(timer);
    tip.classList.remove('on');
    if (target?.dataset['wlTitle'] !== undefined) {
      if (!target.hasAttribute('title')) target.setAttribute('title', target.dataset['wlTitle']);
      delete target.dataset['wlTitle'];
    }
    target = null;
  };

  const place = () => {
    if (!target?.isConnected) return restore();
    const r = target.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const below = r.top < t.height + 16;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
    const y = below ? r.bottom + 8 : r.top - t.height - 8;
    tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    tip.classList.toggle('below', below);
    tip.classList.add('on');
  };

  const over = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.('[title]');
    if (!(el instanceof HTMLElement) || el === target || el.tagName === 'IFRAME') return;
    const text = el.getAttribute('title')?.trim();
    if (!text) return;
    restore();
    target = el;
    el.dataset['wlTitle'] = el.getAttribute('title') ?? '';
    el.removeAttribute('title'); // pas d'infobulle du système en double
    tip.textContent = text;
    timer = window.setTimeout(place, 380);
  };

  const out = (e: PointerEvent) => {
    if (target && !(e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) restore();
  };

  document.addEventListener('pointerover', over, { passive: true });
  document.addEventListener('pointerout', out, { passive: true });
  document.addEventListener('pointerdown', restore, { passive: true, capture: true });
  document.addEventListener('keydown', restore, { capture: true });
  document.addEventListener('scroll', restore, { passive: true, capture: true });
  return () => {
    restore();
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerout', out);
    document.removeEventListener('pointerdown', restore, { capture: true });
    document.removeEventListener('keydown', restore, { capture: true });
    document.removeEventListener('scroll', restore, { capture: true });
    tip.remove();
  };
}
