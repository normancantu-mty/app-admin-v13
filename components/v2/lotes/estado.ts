/**
 * Lotes v2 — el estado de un lote, derivado de lo que ya esta escrito (no hay
 * columna `estado` en `lotes`, y no se agrega: sin migraciones). Escrito el
 * 2026-10-30 por el ejecutor del Socio. PURO.
 *
 * Regla (la mas simple que no inventa datos):
 *  - ENVASADO: el lote tiene botellas en `lote_envasado` (desde la ronda 5 del
 *    lote v2 el envasado diario va SIN lote, asi que esto solo pasa con lotes del
 *    bot anterior o del ciclo F0).
 *  - TERMINADO: ya salio algo del lote (tandas/garrafas en `lote_salidas`), el bot
 *    registro la etapa `destilacion`, o la fecha de fin de fermentacion ya paso.
 *  - EN FERMENTACION: todo lo demas.
 */

export type EstadoLote = 'fermentacion' | 'terminado' | 'envasado'

export const ESTADOS_LOTE: EstadoLote[] = ['fermentacion', 'terminado', 'envasado']

export const ETIQUETA_ESTADO: Record<EstadoLote, string> = {
  fermentacion: 'En fermentación',
  terminado: 'Terminado',
  envasado: 'Envasado'
}

export const CHIP_ESTADO: Record<EstadoLote, string> = {
  fermentacion: 'warn',
  terminado: 'info',
  envasado: 'good'
}

export function esEstadoLote(v: unknown): v is EstadoLote {
  return typeof v === 'string' && (ESTADOS_LOTE as string[]).includes(v)
}

export function estadoLote(
  l: { botellas: number | null; tandas: number | null; fecha_fin_fermentacion: string | null },
  destilado: boolean,
  hoy: string
): EstadoLote {
  if (Number(l.botellas ?? 0) > 0) return 'envasado'
  if (destilado || Number(l.tandas ?? 0) > 0) return 'terminado'
  if (l.fecha_fin_fermentacion && l.fecha_fin_fermentacion.slice(0, 10) <= hoy) return 'terminado'
  return 'fermentacion'
}

/** Dias entre dos fechas 'YYYY-MM-DD' (sin zona: son columnas `date`). */
export function diasEntreFechas(inicio: string, fin: string): number {
  const a = Date.UTC(Number(inicio.slice(0, 4)), Number(inicio.slice(5, 7)) - 1, Number(inicio.slice(8, 10)))
  const b = Date.UTC(Number(fin.slice(0, 4)), Number(fin.slice(5, 7)) - 1, Number(fin.slice(8, 10)))
  return Math.round((b - a) / 86400000)
}

/**
 * Dias de fermentacion: hasta la destilacion o la fecha de fin si existen; si el
 * lote sigue fermentando, los dias que lleva hasta hoy (`enCurso`).
 */
export function diasFermentacion(
  inicio: string,
  fin: string | null,
  destilacion: string | null,
  hoy: string
): { dias: number; enCurso: boolean } {
  const hasta = destilacion ?? fin
  if (hasta) return { dias: Math.max(0, diasEntreFechas(inicio, hasta)), enCurso: false }
  return { dias: Math.max(0, diasEntreFechas(inicio, hoy)), enCurso: true }
}
