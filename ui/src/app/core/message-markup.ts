/**
 * Modèles de message des alertes : conversion entre le texte enregistré (Markdown réduit, voir MessageTemplate côté serveur)
 * et le contenu HTML de l'éditeur.
 *   **gras**  _italique_  [texte](url)  « - » en début de ligne : liste
 *   {{variable}} : étiquette non modifiable     @[Nom](identifiant) : mention
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Étiquette d'une variable dans l'éditeur. */
export function variableChip(name: string, label: string): string {
  return `<span class="var" contenteditable="false" data-var="${esc(name)}">${esc(label)}</span>`;
}

export function mentionChip(name: string, id: string): string {
  return `<span class="mention" contenteditable="false" data-name="${esc(name)}" data-id="${esc(id)}">@${esc(name)}</span>`;
}

// ------------------------------------------------------------------ texte → HTML de l'éditeur

export function markupToHtml(markup: string | null | undefined, labels: Record<string, string>): string {
  const lines = (markup ?? '').replace(/\r/g, '').split('\n');
  let html = '';
  let list = false;
  for (const line of lines) {
    const item = line.startsWith('- ') || line.startsWith('• ');
    if (item !== list) {
      html += item ? '<ul>' : '</ul>';
      list = item;
    }
    const inner = inlineToHtml(item ? line.slice(2) : line, labels);
    html += item ? `<li>${inner || '<br>'}</li>` : `<div>${inner || '<br>'}</div>`;
  }
  if (list) html += '</ul>';
  return html;
}

function inlineToHtml(s: string, labels: Record<string, string>): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += esc(s[i + 1]);
      i += 2;
      continue;
    }
    if (s.startsWith('{{', i)) {
      const end = s.indexOf('}}', i + 2);
      const name = end > 0 ? s.slice(i + 2, end).trim().toLowerCase() : '';
      if (/^[\w.]+$/.test(name)) {
        out += variableChip(name, labels[name] ?? name);
        i = end + 2;
        continue;
      }
    }
    if (s.startsWith('**', i)) {
      const end = s.indexOf('**', i + 2);
      if (end > i + 2) {
        out += `<b>${inlineToHtml(s.slice(i + 2, end), labels)}</b>`;
        i = end + 2;
        continue;
      }
    }
    if (s[i] === '_' && (i === 0 || !/[\p{L}\d]/u.test(s[i - 1]))) {
      const end = italicEnd(s, i + 1);
      if (end > i + 1) {
        out += `<i>${inlineToHtml(s.slice(i + 1, end), labels)}</i>`;
        i = end + 1;
        continue;
      }
    }
    if (s.startsWith('@[', i)) {
      const m = brackets(s, i + 1);
      if (m && m.target) {
        out += mentionChip(m.label.trim(), m.target.trim());
        i = m.next;
        continue;
      }
    }
    if (s[i] === '[') {
      const m = brackets(s, i);
      if (m) {
        out += `<a href="${esc(m.target.trim())}">${inlineToHtml(m.label, labels)}</a>`;
        i = m.next;
        continue;
      }
    }
    out += esc(s[i]);
    i++;
  }
  return out;
}

function italicEnd(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s.startsWith('{{', j)) {
      const close = s.indexOf('}}', j);
      if (close > 0) { j = close + 1; continue; }
    }
    if (s[j] === '_' && (j + 1 === s.length || !/[\p{L}\d]/u.test(s[j + 1]))) return j;
  }
  return -1;
}

function brackets(s: string, open: number): { label: string; target: string; next: number } | null {
  const close = s.indexOf(']', open + 1);
  if (close < 0 || s[close + 1] !== '(') return null;
  // Parenthèses équilibrées : une URL peut en contenir.
  let depth = 0;
  let end = -1;
  for (let j = close + 2; j < s.length && end < 0; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && depth-- === 0) end = j;
  }
  if (end < 0) return null;
  return { label: s.slice(open + 1, close), target: s.slice(close + 2, end), next: end + 1 };
}

// ------------------------------------------------------------------ HTML de l'éditeur → texte

/** Caractères qui changeraient le sens du texte saisi s'ils n'étaient pas protégés. */
const escapeText = (s: string) =>
  s.replace(/\u00a0/g, ' ').replace(/\\/g, '\\\\').replace(/\*\*/g, '\\*\\*').replace(/\{\{/g, '\\{{').replace(/\[/g, '\\[').replace(/_/g, '\\_');

export function htmlToMarkup(root: HTMLElement): string {
  const lines: string[] = [];
  let current = '';
  let open = false;
  const flush = () => {
    if (open || current) lines.push(current);
    current = '';
    open = false;
  };

  const walk = (el: Node) => {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        current += escapeText(node.textContent ?? '');
        open = true;
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      const tag = node.tagName;
      if (tag === 'BR') {
        flush();
        open = true;
      } else if (tag === 'UL' || tag === 'OL') {
        if (open || current) flush();
        for (const li of Array.from(node.children)) lines.push('- ' + inline(li).trim());
      } else if (tag === 'DIV' || tag === 'P' || tag === 'LI') {
        if (open || current) flush();
        walk(node);
        flush();
      } else {
        current += inline(node);
        open = true;
      }
    }
  };
  walk(root);
  if (current) lines.push(current);
  // Retire les lignes vides en fin de message et les <br> finaux de contenteditable.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '');
  if (!(node instanceof HTMLElement)) return '';
  if (node.classList.contains('caret')) return '';
  if (node.classList.contains('var')) return `{{${node.dataset['var']}}}`;
  if (node.classList.contains('mention')) return `@[${node.dataset['name']}](${node.dataset['id']})`;
  const inner = Array.from(node.childNodes).map(inline).join('');
  const tag = node.tagName;
  const style = node.style;
  if (tag === 'BR') return ' ';
  const bold = tag === 'B' || tag === 'STRONG' || Number(style.fontWeight) >= 600 || style.fontWeight === 'bold';
  const italic = tag === 'I' || tag === 'EM' || style.fontStyle === 'italic';
  let out = inner;
  if (tag === 'A') {
    const href = node.getAttribute('href') ?? '';
    return href ? `[${inner}](${href})` : inner;
  }
  if (out.trim()) {
    if (italic) out = `_${out}_`;
    if (bold) out = `**${out}**`;
  }
  return out;
}

/** Texte d'une ligne de titre (pas de mise en forme, une seule ligne). */
export function singleLine(markup: string): string {
  return markup.replace(/\n+/g, ' ').trim();
}
