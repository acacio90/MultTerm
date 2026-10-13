/** Converte as notas da release (o GitHub entrega em HTML) em texto simples para a ajuda. */
export function releaseNotesText(notes: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof notes === 'string') raw = notes;
  else if (Array.isArray(notes)) raw = notes.map((n) => (n as { note?: string }).note ?? '').join('\n');
  if (!raw) return undefined;
  const text = htmlToText(raw);
  return text || undefined;
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', rarr: '→', larr: '←', hellip: '…',
};

export function htmlToText(html: string): string {
  return html
    .replace(/\r/g, '')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6]|ul|ol|div|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
