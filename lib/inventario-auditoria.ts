import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'

export interface StockEsperadoItem {
  idProducto: string
  producto: string
  stockEsperado: number
}

export interface StockPorCubeta {
  stockPagado: StockEsperadoItem[]
  stockConsignado: StockEsperadoItem[]
}

export interface DeduccionCascadaResultado {
  deduccionPagado: number
  deduccionConsignado: number
}

export interface CalcularDeduccionCascadaInput {
  cantidadDeducir: number
  stockPagadoActual: number
  stockConsignadoActual: number
}

/**
 * Zero-Trust waterfall rule:
 * always burns from bucket PAGADO first, and only overflows into CONSIGNADO.
 * Throws when requested deduction exceeds total physical stock available.
 */
export function calcularDeduccionCascada(
  params: CalcularDeduccionCascadaInput
): DeduccionCascadaResultado {
  const { cantidadDeducir, stockPagadoActual, stockConsignadoActual } = params

  if (
    !Number.isFinite(cantidadDeducir) ||
    !Number.isFinite(stockPagadoActual) ||
    !Number.isFinite(stockConsignadoActual)
  ) {
    throw new Error('Parámetros inválidos: se requieren números finitos.')
  }

  if (cantidadDeducir < 0 || stockPagadoActual < 0 || stockConsignadoActual < 0) {
    throw new Error('Parámetros inválidos: no se permiten cantidades negativas.')
  }

  const deduccionPagado = Math.min(cantidadDeducir, stockPagadoActual)
  const restante = cantidadDeducir - deduccionPagado
  const deduccionConsignado = Math.min(restante, stockConsignadoActual)

  if (restante > stockConsignadoActual) {
    throw new Error('Stock insuficiente: la deducción excede el total físico disponible.')
  }

  return { deduccionPagado, deduccionConsignado }
}

function getServiceRoleSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

export async function getStockEsperadoPorEntidad(idEntidad: string): Promise<StockEsperadoItem[]> {
  const { stockPagado, stockConsignado } = await getStockPorCubetaPorEntidad(idEntidad)
  const stockMap = new Map<string, StockEsperadoItem>()

  for (const row of [...stockPagado, ...stockConsignado]) {
    const current = stockMap.get(row.idProducto)
    if (!current) {
      stockMap.set(row.idProducto, { ...row })
      continue
    }
    current.stockEsperado = Math.round(((current.stockEsperado + row.stockEsperado) + Number.EPSILON) * 10000) / 10000
  }

  return Array.from(stockMap.values())
}

export async function getStockPorCubetaPorEntidad(idEntidad: string): Promise<StockPorCubeta> {
  const entidadId = idEntidad?.trim()
  if (!entidadId) {
    throw new Error('Entidad inválida para auditoría.')
  }

  const supabase = getServiceRoleSupabaseClient()
  const { data: movimientos, error: movimientosError } = await supabase
    .from('inventario_ledger')
    .select('id_producto, tipo_movimiento, cantidad, cubeta, id_entidad_destino, id_entidad_origen')
    .in('status', ['ACTIVO', 'APPROVED'])
    .or(`id_entidad_destino.eq.${entidadId},id_entidad_origen.eq.${entidadId}`)

  if (movimientosError) {
    throw new Error(`Error al calcular stock esperado: ${movimientosError.message}`)
  }

  const stockMapPagado = new Map<string, number>()
  const stockMapConsignado = new Map<string, number>()
  for (const mov of movimientos || []) {
    if (!mov.id_producto) continue

    const cubeta = mov.cubeta === 'CONSIGNADO' ? 'CONSIGNADO' : 'PAGADO'
    const targetMap = cubeta === 'CONSIGNADO' ? stockMapConsignado : stockMapPagado
    const actual = targetMap.get(mov.id_producto) || 0
    const cantidad = Number(mov.cantidad) || 0
    const tipo = mov.tipo_movimiento || ''

    if (mov.id_entidad_destino === entidadId && isTipoMovimientoEntrada(tipo)) {
      targetMap.set(mov.id_producto, actual + cantidad)
      continue
    }

    if (mov.id_entidad_origen === entidadId && isTipoMovimientoSalida(tipo)) {
      targetMap.set(mov.id_producto, actual - cantidad)
    }
  }

  const idsProductos = Array.from(new Set([
    ...stockMapPagado.keys(),
    ...stockMapConsignado.keys()
  ]))
  if (idsProductos.length === 0) {
    return { stockPagado: [], stockConsignado: [] }
  }

  const { data: productos, error: productosError } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, tipo')
    .in('id', idsProductos)

  if (productosError) {
    throw new Error(`Error al obtener catálogo para auditoría: ${productosError.message}`)
  }

  const productosTerminados = (productos || []).filter((p) => p.tipo === 'TERMINADO')
  const nombrePorId = new Map(productosTerminados.map((p) => [p.id, p.nombre]))
  const idsTerminados = new Set(productosTerminados.map((p) => p.id))

  const mapToRows = (stockMap: Map<string, number>): StockEsperadoItem[] =>
    idsProductos
      .filter((idProducto) => idsTerminados.has(idProducto))
      .map((idProducto) => ({
        idProducto,
        producto: nombrePorId.get(idProducto) || 'Producto sin nombre',
        stockEsperado: Math.round(((stockMap.get(idProducto) || 0) + Number.EPSILON) * 10000) / 10000
      }))
      .filter((row) => row.stockEsperado > 0)

  return {
    stockPagado: mapToRows(stockMapPagado),
    stockConsignado: mapToRows(stockMapConsignado)
  }
}
