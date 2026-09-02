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
      .select('id_entidad_destino, fecha_movimiento, status')

    if (error) {
      console.error('Error fetching inventario movements:', error?.message, error?.details, error?.hint)
      return []
    }

    return (data || []).filter((mov) => mov.status !== 'ANULADO')
  } catch (error: any) {
    console.error('Error in getMovimientosInventario:', error?.message)
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
