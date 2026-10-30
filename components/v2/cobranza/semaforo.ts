/**
 * Cobranza v2 — el semaforo de "a quien falta cobrarle". Puro: sin red, sin base;
 * lo usan el servidor (card del panel) y el cliente (filtros de la vista completa).
 * Escrito el 2026-10-30 por un ejecutor del Socio.
 *
 * Umbrales: los que ya usaba el ERP v2 en la cartera y en el panel
 * (`dias > 60` crit, `dias > 30` warn; el semaforo del panel cuenta como
 * "Cobranza vencida" los de +60). Los dias son los de `v_cartera.dias_sin_abono`:
 * desde el ultimo abono o, si nunca abono, desde la ultima entrega a concesion.
 * Un nodo que nunca abono NO sale del rojo por eso: se marca aparte ("nunca abono").
 */

export type Banda = 'rojo' | 'amarillo' | 'verde' | 'gris'

/** Mas de 30 dias sin abonar: amarillo. */
export const DIAS_AMARILLO = 30
/** Mas de 60 dias sin abonar: rojo (la "Cobranza vencida" del panel). */
export const DIAS_ROJO = 60

export const BANDAS: Banda[] = ['rojo', 'amarillo', 'verde', 'gris']

export const NOMBRE_BANDA: Record<Banda, string> = {
  rojo: `Más de ${DIAS_ROJO} días`,
  amarillo: `${DIAS_AMARILLO + 1} a ${DIAS_ROJO} días`,
  verde: `${DIAS_AMARILLO} días o menos`,
  gris: 'Sin fecha de referencia'
}

/** Clase de chip del sistema v2 para cada banda. */
export const CHIP_BANDA: Record<Banda, string> = { rojo: 'crit', amarillo: 'warn', verde: 'good', gris: '' }

export function bandaDe(dias: number | null | undefined): Banda {
  if (dias === null || dias === undefined) return 'gris'
  if (dias > DIAS_ROJO) return 'rojo'
  if (dias > DIAS_AMARILLO) return 'amarillo'
  return 'verde'
}

/** Una fila lista para pintar: lo de `v_cartera` mas el monto del ultimo abono. */
export interface FilaCobranza {
  id: string
  nombre: string
  rol: 'DST' | 'LOC'
  deuda: number
  generado: number
  abonado: number
  /** 0-100, ya multiplicado (la vista trae fraccion 0-1). `null` = no genero deuda. */
  pct: number | null
  dias: number | null
  /** De donde salen los dias: el ultimo abono o, si nunca abono, la ultima entrega. */
  referencia: 'ABONO' | 'ENTREGA' | 'NINGUNA'
  ultimoAbono: string | null
  /** Suma de los abonos con la fecha del ultimo (un abono puede venir en varias filas). */
  ultimoAbonoMonto: number | null
  enPiso: number
  recibidas: number
  prioridad: number
  banda: Banda
  /** `null` = le debe a la matriz; si no, el nombre del distribuidor al que le debe. */
  acreedor: string | null
}

export type Totales = Record<Banda, { n: number; monto: number }>

export function totalesPorBanda(filas: FilaCobranza[]): Totales {
  const t: Totales = { rojo: { n: 0, monto: 0 }, amarillo: { n: 0, monto: 0 }, verde: { n: 0, monto: 0 }, gris: { n: 0, monto: 0 } }
  for (const f of filas) {
    t[f.banda].n += 1
    t[f.banda].monto += f.deuda
  }
  for (const b of BANDAS) t[b].monto = Math.round(t[b].monto * 100) / 100
  return t
}

/** "12 d" / "12 d · desde entrega" / "sin referencia". */
export function textoDias(f: Pick<FilaCobranza, 'dias' | 'referencia'>): string {
  if (f.dias === null) return 'sin referencia'
  return `${f.dias} d${f.referencia === 'ENTREGA' ? ' · desde entrega' : ''}`
}
