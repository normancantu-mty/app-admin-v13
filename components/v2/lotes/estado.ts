/**
 * Lotes v2 — el estado de PROCESO de un lote. Desde el 2026-11-19 es una
 * columna: `lotes.estado_proceso` (migracion 20261119215907), contrato
 * compartido con la app movil y el bot. La base lo pasa SOLA a TERMINADO
 * cuando el lote tiene Aditivo 1, Aditivo 2 y Levadura y enzimas (trigger
 * `trg_lote_estado_por_insumos`), salvo DESTILADO, que nunca se degrada.
 * Antes (2026-10-30) el estado se DERIVABA aqui de tandas y fechas
 * (fermentacion / terminado / envasado); ya no: manda la columna. PURO.
 */

export type EstadoLote = 'FERMENTACION' | 'DESTILADO' | 'TERMINADO'

export const ESTADOS_LOTE: EstadoLote[] = ['FERMENTACION', 'TERMINADO', 'DESTILADO']

export const ETIQUETA_ESTADO: Record<EstadoLote, string> = {
  FERMENTACION: 'Fermentación',
  DESTILADO: 'Destilado',
  TERMINADO: 'Terminado'
}

export const CHIP_ESTADO: Record<EstadoLote, string> = {
  FERMENTACION: 'warn',
  TERMINADO: 'info',
  DESTILADO: 'good'
}

export function esEstadoLote(v: unknown): v is EstadoLote {
  return typeof v === 'string' && (ESTADOS_LOTE as string[]).includes(v)
}

/** Lo que venga de la base; algo raro (o la columna aun no leida) cae en FERMENTACION. */
export function estadoLote(v: unknown): EstadoLote {
  return esEstadoLote(v) ? v : 'FERMENTACION'
}

/** Dias entre dos fechas 'YYYY-MM-DD' (sin zona: son columnas `date`). */
export function diasEntreFechas(inicio: string, fin: string): number {
  const a = Date.UTC(Number(inicio.slice(0, 4)), Number(inicio.slice(5, 7)) - 1, Number(inicio.slice(8, 10)))
  const b = Date.UTC(Number(fin.slice(0, 4)), Number(fin.slice(5, 7)) - 1, Number(fin.slice(8, 10)))
  return Math.round((b - a) / 86400000)
}

/**
 * Dias de fermentacion: hasta la fecha de FIN si existe (Fase 7B, 2026-11-07:
 * el fin es el dato; antes mandaba la destilacion), si no hasta la
 * destilacion; si el lote sigue fermentando, los dias que lleva hasta hoy
 * (`enCurso`).
 */
export function diasFermentacion(
  inicio: string,
  fin: string | null,
  destilacion: string | null,
  hoy: string
): { dias: number; enCurso: boolean } {
  const hasta = fin ?? destilacion
  if (hasta) return { dias: Math.max(0, diasEntreFechas(inicio, hasta)), enCurso: false }
  return { dias: Math.max(0, diasEntreFechas(inicio, hoy)), enCurso: true }
}
