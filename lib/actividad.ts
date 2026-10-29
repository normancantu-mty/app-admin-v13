/**
 * Ultima actividad de un nodo de la red y dias desde entonces: **una sola regla para
 * todo el ERP**. Escrito el 2026-10-29 por el Socio (ejecutor), ronda 2 de la auditoria.
 *
 * Antes habia dos: el Dashboard General (`getLiderazgoRed`) contaba tickets + abonos
 * aprobados + el corte de arranque, en bloques de 24 h; el directorio
 * (`app/dashboard/distribuidores/page.tsx`) contaba cualquier fila de los ledgers (incluso
 * ANULADAS en finanzas) + el seguimiento manual, en dias de calendario de la hora del
 * servidor. Medido en la base local: Dulceria el Eden, Mi dulce catrina y Luis Rodriguez
 * salian "Sin contacto" en uno y "Hace 1 dias" en el otro, el mismo dia.
 *
 * La regla:
 *  - Actividad = lo mas reciente entre: cualquier movimiento VIVO (no ANULADO) donde el
 *    nodo es parte (finanzas: id_entidad_relacionada; inventario: destino u origen),
 *    sus tickets vivos como comprador, su seguimiento manual, y el corte de arranque
 *    (ese dia se concilio toda la red, aunque un nodo quedara en 0).
 *  - Dias = dias de CALENDARIO en la zona del negocio (America/Mexico_City), nunca
 *    negativos. Es lo que una persona entiende por "hace N dias". Cambiarlo a bloques de
 *    24 h es cambiar `diasDesde` y nada mas.
 *
 * Modulo puro: sin Supabase ni `next/headers`, lo prueban las pruebas puras.
 */

export const ZONA_NEGOCIO = 'America/Mexico_City'

type Fecha = Date | string | null | undefined

function aMs(f: Fecha): number | null {
  if (f === null || f === undefined || f === '') return null
  const ms = f instanceof Date ? f.getTime() : Date.parse(f)
  return Number.isFinite(ms) ? ms : null
}

/** La fecha mas reciente de la lista; null si ninguna es valida. */
export function ultimaActividad(fechas: readonly Fecha[]): Date | null {
  let max: number | null = null
  for (const f of fechas) {
    const ms = aMs(f)
    if (ms !== null && (max === null || ms > max)) max = ms
  }
  return max === null ? null : new Date(max)
}

function diaCivil(ms: number, zona: string): number {
  // en-CA formatea YYYY-MM-DD
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: zona,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .format(new Date(ms))
    .split('-')
    .map(Number)
  return Date.UTC(y, m - 1, d) / 86400000
}

/** Dias de calendario (zona del negocio) desde `fecha` hasta `ahora`; null si no hay fecha. */
export function diasDesde(fecha: Fecha, ahora: Date = new Date(), zona: string = ZONA_NEGOCIO): number | null {
  const ms = aMs(fecha)
  if (ms === null) return null
  return Math.max(0, diaCivil(ahora.getTime(), zona) - diaCivil(ms, zona))
}

export interface FuentesActividad {
  /** finanzas_ledger: { id_entidad_relacionada, fecha_movimiento, status } */
  finanzas: readonly { id_entidad_relacionada?: string | null; fecha_movimiento?: string | null; status?: string | null }[]
  /** inventario_ledger: { id_entidad_destino, id_entidad_origen, fecha_movimiento, status } */
  inventario: readonly {
    id_entidad_destino?: string | null
    id_entidad_origen?: string | null
    fecha_movimiento?: string | null
    status?: string | null
  }[]
  /** transacciones_tickets: { id_comprador, fecha_transaccion, status } */
  tickets: readonly { id_comprador?: string | null; fecha_transaccion?: string | null; status?: string | null }[]
  /** seguimiento manual por nodo (fecha_ultimo_seguimiento ?? ultimo_seguimiento) */
  seguimiento?: ReadonlyMap<string, Fecha>
  /** corte de arranque (categoria ARRANQUE); cuenta para toda la red */
  fechaArranque?: Fecha
}

const vivo = (status?: string | null) => (status ?? 'ACTIVO') !== 'ANULADO'

/** Ultima actividad de cada nodo pedido, con la regla de arriba. */
export function ultimaActividadPorNodo(ids: readonly string[], f: FuentesActividad): Map<string, Date | null> {
  const porNodo = new Map<string, Fecha[]>(ids.map((id) => [id, [f.fechaArranque, f.seguimiento?.get(id)]]))
  const sumar = (id: string | null | undefined, fecha: Fecha) => {
    if (id) porNodo.get(id)?.push(fecha)
  }
  for (const r of f.finanzas) if (vivo(r.status)) sumar(r.id_entidad_relacionada, r.fecha_movimiento)
  for (const r of f.inventario) {
    if (!vivo(r.status)) continue
    sumar(r.id_entidad_destino, r.fecha_movimiento)
    if (r.id_entidad_origen !== r.id_entidad_destino) sumar(r.id_entidad_origen, r.fecha_movimiento)
  }
  for (const t of f.tickets) if (vivo(t.status)) sumar(t.id_comprador, t.fecha_transaccion)
  return new Map([...porNodo].map(([id, fechas]) => [id, ultimaActividad(fechas)]))
}
