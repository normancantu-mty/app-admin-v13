/**
 * Inventario v2 compacto — formatos de cantidad para las tablas de inventario y
 * lotes. Escrito el 2026-10-30 por el ejecutor del Socio (inventario compacto).
 * PURO (sin servidor ni navegador): lo usan componentes de los dos lados.
 */

const CANT = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 4 })
const CANT2 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 })

/** Cantidad del ledger sin ceros de relleno: 6 -> '6', 0.125 -> '0.125' (hasta 4 decimales, como la v1). */
export function cant(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—'
  const v = Number(n)
  return Number.isFinite(v) ? CANT.format(v) : '—'
}

/** Cantidad con hasta 2 decimales (litros, kg, grados). */
export function cant2(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—'
  const v = Number(n)
  return Number.isFinite(v) ? CANT2.format(v) : '—'
}

/** 'ENTRADA_COMPRA' -> 'Entrada compra'. El codigo crudo va en el `title`. */
export function tipoMovLegible(tipo: string): string {
  const t = tipo.replace(/_/g, ' ').toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}
