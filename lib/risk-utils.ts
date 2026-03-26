import { supabase } from './supabase'

// ============================================================================
// INTERFACES - Anti-Fraud Engine & Traffic Lights
// ============================================================================

export interface MovimientoFecha {
  id_entidad_relacionada?: string
  id_entidad_destino?: string
  fecha_movimiento?: string
  fecha_transaccion?: string
}

export interface InventarioLedger {
  id_entidad_destino: string
  id_producto: string
  tipo_movimiento: string
  cantidad: number
}

export interface ListaPrecio {
  precio_final: number
}

export interface Producto {
  id: string
  listas_precios?: ListaPrecio[]
}

export interface RiesgoJineteo {
  valorFisico: number
  deudaPendiente: number
  riesgo: number
  estado: 'SANO' | 'FALTANTE'
}

// ============================================================================
// DATA FETCHING - Server-Side Only
// ============================================================================

export async function getMovimientosFinanzas(): Promise<MovimientoFecha[]> {
  try {
    const { data, error } = await supabase
      .from('finanzas_ledger')
      .select('id_entidad_relacionada, fecha_movimiento')

    if (error) {
      console.error('Error fetching finanzas movements:', error?.message, error?.details, error?.hint)
      return []
    }

    return data || []
  } catch (error: any) {
    console.error('Error in getMovimientosFinanzas:', error?.message)
    return []
  }
}

export async function getMovimientosInventario(): Promise<MovimientoFecha[]> {
  try {
    const { data, error } = await supabase
      .from('inventario_ledger')
      .select('id_entidad_destino, fecha_movimiento')

    if (error) {
      console.error('Error fetching inventario movements:', error?.message, error?.details, error?.hint)
      return []
    }

    return data || []
  } catch (error: any) {
    console.error('Error in getMovimientosInventario:', error?.message)
    return []
  }
}

export async function getInventarioLedger(): Promise<InventarioLedger[]> {
  try {
    const { data, error } = await supabase
      .from('inventario_ledger')
      .select('id_entidad_destino, id_producto, tipo_movimiento, cantidad')

    if (error) {
      console.error('Error fetching inventario_ledger:', error?.message, error?.details, error?.hint)
      return []
    }

    return data || []
  } catch (error: any) {
    console.error('Error in getInventarioLedger:', error?.message)
    return []
  }
}

export async function getProductos(): Promise<Producto[]> {
  try {
    const { data, error } = await supabase
      .from('catalogo_productos')
      .select('id, nombre, sku, tipo, listas_precios(precio_final)')

    if (error) {
      console.error('Error fetching productos:', error?.message, error?.details, error?.hint)
      return []
    }

    return data || []
  } catch (error: any) {
    console.error('Error in getProductos:', error?.message)
    return []
  }
}

// ============================================================================
// PURE FUNCTIONS - Business Logic (Anti-Fraud Math)
// ============================================================================

/**
 * Calculate the most recent movement date for an entity
 * Searches both finanzas_ledger and inventario_ledger
 */
export function calcularUltimoMovimiento(
  idEntidad: string,
  movimientosFinanzas: MovimientoFecha[],
  movimientosInventario: MovimientoFecha[]
): Date | null {
  const fechasFinanzas = movimientosFinanzas
    .filter(m => m.id_entidad_relacionada === idEntidad && m.fecha_movimiento)
    .map(m => new Date(m.fecha_movimiento!))

  const fechasInventario = movimientosInventario
    .filter(m => m.id_entidad_destino === idEntidad && m.fecha_movimiento)
    .map(m => new Date(m.fecha_movimiento!))

  const todasFechas = [...fechasFinanzas, ...fechasInventario]

  if (todasFechas.length === 0) return null

  return new Date(Math.max(...todasFechas.map(f => f.getTime())))
}

/**
 * Calculate traffic light based on days since last movement
 * 🟢 < 7 days, 🟡 7-14 days, 🔴 > 15 days
 */
export function getSemaforoMovimiento(ultimoMovimiento: Date | null): string {
  if (!ultimoMovimiento) return '🔴'

  const hoy = new Date()
  const diasTranscurridos = Math.floor((hoy.getTime() - ultimoMovimiento.getTime()) / (1000 * 60 * 60 * 24))

  if (diasTranscurridos < 7) return '🟢'
  if (diasTranscurridos <= 14) return '🟡'
  return '🔴'
}

/**
 * Calculate physical inventory value for an entity
 * Stock quantity × precio_final of each product
 */
export function calcularValorFisicoInventario(
  idEntidad: string,
  inventario: InventarioLedger[],
  productos: Producto[]
): number {
  // Calculate current stock per product
  const stockPorProducto = new Map<string, number>()

  inventario
    .filter(mov => mov.id_entidad_destino === idEntidad)
    .forEach(mov => {
      const stockActual = stockPorProducto.get(mov.id_producto) || 0
      if (mov.tipo_movimiento === 'ENTRADA') {
        stockPorProducto.set(mov.id_producto, stockActual + mov.cantidad)
      } else if (mov.tipo_movimiento === 'SALIDA') {
        stockPorProducto.set(mov.id_producto, stockActual - mov.cantidad)
      }
    })

  // Calculate total value: stock × precio_final (from listas_precios)
  let valorTotal = 0

  stockPorProducto.forEach((cantidad, idProducto) => {
    const producto = productos.find(p => p.id === idProducto)
    if (producto && cantidad > 0) {
      // Extract price from listas_precios array (1-to-many relationship)
      const precio = producto.listas_precios?.[0]?.precio_final || 0
      valorTotal += cantidad * precio
    }
  })

  return valorTotal
}

/**
 * ANTI-FRAUD FORMULA: Pending Debt - Physical Inventory Value
 * If > 0: FALTANTE (Shortage/Fraud Risk)
 * If <= 0: SANO (Healthy)
 */
export function calcularRiesgoJineteo(
  deudaPendiente: number,
  valorFisico: number
): RiesgoJineteo {
  const riesgo = deudaPendiente - valorFisico

  return {
    valorFisico,
    deudaPendiente,
    riesgo,
    estado: riesgo > 0 ? 'FALTANTE' : 'SANO'
  }
}
