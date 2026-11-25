/**
 * LO QUE ESTA EN CONCESION, CON EL FALTANTE RESTADO (2026-11-24).
 *
 * Cuando un distribuidor o un local saca mas de lo que marca el sistema, el
 * faltante queda en PAGADO, negativo (`lib/aviso-stock.ts`). Sumar solo lo
 * CONSIGNADO decia 10 "en concesion" cuando la Matriz entrego 8: las 2 que
 * faltaban estaban en el PAGADO negativo del que las entrego.
 *
 * Sin saldos negativos da lo mismo que antes, pieza por pieza.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import { fetchTodasLasFilas } from '@/lib/paginacion'

type ConRol = { rol: string } | { rol: string }[] | null | undefined

export interface MovimientoConcesion {
  id_producto: string | null
  tipo_movimiento: string | null
  cantidad: number | null
  cubeta?: string | null
  status?: string | null
  id_entidad_destino?: string | null
  id_entidad_origen?: string | null
  entidad_destino?: ConRol
  entidad_origen?: ConRol
}

const rolDe = (x: ConRol) => (Array.isArray(x) ? x[0]?.rol : x?.rol)
const redondear4 = (n: number) => Math.round(n * 10000) / 10000

/**
 * Por entidad y producto, el saldo PAGADO que quedo NEGATIVO (solo los negativos).
 * `cuenta` decide que entidades entran; mismas reglas de entrada y salida que
 * `getStockPorCubetaPorEntidad`.
 */
function pagadoNegativo(
  movimientos: readonly MovimientoConcesion[],
  cuenta: (id: string, rol: string | undefined) => boolean
): Map<string, number> {
  const saldos = new Map<string, { producto: string; saldo: number }>()
  for (const m of movimientos) {
    if (!m.id_producto || m.cubeta === 'CONSIGNADO') continue
    if (m.status !== undefined && m.status !== 'ACTIVO' && m.status !== 'APPROVED') continue
    const mueve = (id: string | null | undefined, rol: string | undefined, piezas: number) => {
      if (!id || !cuenta(id, rol)) return
      const llave = `${id}|${m.id_producto}`
      const antes = saldos.get(llave)?.saldo ?? 0
      saldos.set(llave, { producto: m.id_producto as string, saldo: antes + piezas })
    }
    const piezas = Number(m.cantidad) || 0
    if (isTipoMovimientoEntrada(m.tipo_movimiento)) mueve(m.id_entidad_destino, rolDe(m.entidad_destino), piezas)
    if (isTipoMovimientoSalida(m.tipo_movimiento)) mueve(m.id_entidad_origen, rolDe(m.entidad_origen), -piezas)
  }
  const porProducto = new Map<string, number>()
  for (const { producto, saldo } of saldos.values()) {
    if (redondear4(saldo) < 0) porProducto.set(producto, redondear4((porProducto.get(producto) ?? 0) + saldo))
  }
  return porProducto
}

/**
 * Las piezas en concesion de TODA la red, por producto: lo consignado vivo menos el
 * faltante de distribuidores y locales. El negativo de la Matriz no cuenta: no es
 * concesion. Una entidad cuyo rol no se ve tampoco: su libro puede venir a medias.
 */
export function concesionPorProducto(movimientos: readonly MovimientoConcesion[]): Map<string, number> {
  const total = new Map<string, number>()
  for (const m of movimientos) {
    if (!m.id_producto || m.cubeta !== 'CONSIGNADO' || m.status !== 'ACTIVO') continue
    const tipo = m.tipo_movimiento ?? ''
    const piezas = Number(m.cantidad) || 0
    // AJUSTE_INVENTARIO (2026-11-03): correccion del ADMIN sobre la cubeta, cantidad CON SIGNO.
    const signo =
      tipo.startsWith('ENTRADA') || tipo === 'AJUSTE_INVENTARIO' ? 1 : tipo.startsWith('SALIDA') || tipo === 'MERMA' ? -1 : 0
    total.set(m.id_producto, (total.get(m.id_producto) ?? 0) + signo * piezas)
  }
  const faltante = pagadoNegativo(movimientos, (_id, rol) => rol !== undefined && rol !== 'ADMIN')
  for (const [producto, piezas] of faltante) total.set(producto, redondear4((total.get(producto) ?? 0) + piezas))
  return total
}

export interface FilaConsignado {
  idProducto: string
  producto: string
  stockEsperado: number
}

/** La lista de consignado de UNA entidad con su faltante restado. Lo que queda en 0 no se lista. */
export function restarFaltante(consignado: readonly FilaConsignado[], faltante: readonly FilaConsignado[]): FilaConsignado[] {
  const filas = new Map(consignado.map((f) => [f.idProducto, { ...f }]))
  for (const f of faltante) {
    const antes = filas.get(f.idProducto)?.stockEsperado ?? 0
    filas.set(f.idProducto, { ...f, stockEsperado: redondear4(antes + f.stockEsperado) })
  }
  return Array.from(filas.values()).filter((f) => f.stockEsperado !== 0)
}

/**
 * El faltante (PAGADO negativo) de UNA entidad, producto TERMINADO, leido con el
 * cliente de quien mira: la vista `v_stock_por_cubeta` solo trae lo mayor que cero.
 * Si la lectura falla, la ficha se ve como hoy y queda en el log: no se cae.
 */
export async function leerFaltante(client: SupabaseClient<Database>, idEntidad: string): Promise<FilaConsignado[]> {
  try {
    const movimientos = await fetchTodasLasFilas<MovimientoConcesion>(
      () =>
        client
          .from('inventario_ledger')
          .select('id_producto, tipo_movimiento, cantidad, cubeta, id_entidad_destino, id_entidad_origen')
          .in('status', ['ACTIVO', 'APPROVED'])
          .or(`id_entidad_destino.eq.${idEntidad},id_entidad_origen.eq.${idEntidad}`)
          .order('id'),
      'faltante de la entidad'
    )
    const negativos = pagadoNegativo(movimientos, (id) => id === idEntidad)
    if (negativos.size === 0) return []
    const { data, error } = await client
      .from('catalogo_productos')
      .select('id, nombre')
      .eq('tipo', 'TERMINADO')
      .in('id', Array.from(negativos.keys()))
    if (error) throw new Error(error.message)
    return (data ?? []).map((p) => ({ idProducto: p.id, producto: p.nombre, stockEsperado: negativos.get(p.id) ?? 0 }))
  } catch (e) {
    console.error('Error leyendo el faltante de la entidad', idEntidad, e)
    return []
  }
}
