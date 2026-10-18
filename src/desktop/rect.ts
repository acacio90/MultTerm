/** Retângulo em pixels independentes de DPI (o mesmo formato do Electron). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Menor retângulo que contém todas as áreas (ex.: as áreas úteis de todos os monitores). */
export function unionRect(areas: Rect[]): Rect {
  if (!areas.length) throw new Error('nenhuma tela');
  const x = Math.min(...areas.map((a) => a.x));
  const y = Math.min(...areas.map((a) => a.y));
  const right = Math.max(...areas.map((a) => a.x + a.width));
  const bottom = Math.max(...areas.map((a) => a.y + a.height));
  return { x, y, width: right - x, height: bottom - y };
}
