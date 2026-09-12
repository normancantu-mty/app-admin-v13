/**
 * Un solo lugar decide el default de comision_base_local cuando llega
 * NULL o undefined. Los caminos que la leian con defaults distintos
 * (0 y 15) llaman aqui. Conservador para Norman: sin dato, comision 0
 * -no se regala nada-.
 */
export function comisionBaseLocalDecimal(valor: number | null | undefined): number {
  const safe = Number(valor ?? 0)
  if (!Number.isFinite(safe)) return 0
  return safe > 1 ? safe / 100 : safe
}
