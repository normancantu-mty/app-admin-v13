import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from '@/lib/dashboard-utils'

/**
 * **Este modulo es server-only.** Sus dos lectores reciben el cliente de
 * Supabase por parametro; no construyen ninguno.
 *
 * Antes importaba `{ supabase } from './supabase'` — el cliente de NAVEGADOR —
 * y lo usaba desde el Server Component `app/dashboard/distribuidores/page.tsx`.
 * Ahi ese cliente no ve las cookies de Next: viaja como `anon`, y desde que la
 * migracion `20260902022000` revoco `SELECT` a `anon` cada consulta respondia
 * `permission denied for table ...`. El `try/catch` se lo tragaba y devolvia
 * `[]`, asi que **todos los semaforos del directorio salian 🔴 sin un solo
 * error visible**. Mismo defecto y misma cura que `lib/dashboard-utils.ts`.
 *
 * Dos cambios de fondo, aparte del cliente:
 * 1. Se pagina con `fetchTodasLasFilas`. Sin `.range()` PostgREST corta en 1000
 *    filas en silencio, e `inventario_ledger` ya va en 468.
 * 2. **Ya no se traga el error.** Si la lectura falla, revienta la pagina — que
 *    es exactamente lo que hacen las lecturas vecinas del mismo directorio
 *    (`getFinanzasLedger`, `getTickets`). Un 500 ruidoso es preferible a un
 *    tablero de semaforos que miente.
 */

type ClienteSupabase = SupabaseClient<Database>

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

export async function getMovimientosFinanzas(
  supabase: ClienteSupabase
): Promise<MovimientoFecha[]> {
  return fetchTodasLasFilas<MovimientoFecha>(
    () => supabase.from('finanzas_ledger').select('id_entidad_relacionada, fecha_movimiento'),
    'semaforo: finanzas_ledger'
  )
}

export async function getMovimientosInventario(
  supabase: ClienteSupabase
): Promise<MovimientoFecha[]> {
  const filas = await fetchTodasLasFilas<MovimientoFecha & { status: string | null }>(
    () => supabase.from('inventario_ledger').select('id_entidad_destino, fecha_movimiento, status'),
    'semaforo: inventario_ledger'
  )

  return filas.filter((mov) => mov.status !== 'ANULADO')
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
