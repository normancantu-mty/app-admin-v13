import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from './paginacion'
import { ultimaActividad, ultimaActividadPorNodo, type FuentesActividad } from './actividad'

/**
 * Lectura (server-only) de las fuentes de `lib/actividad.ts`. La usan el Dashboard
 * General (`getLiderazgoRed`) y el directorio: misma lectura, misma regla, mismo numero.
 * Escrito el 2026-10-29 por el Socio (ejecutor), ronda 2 de la auditoria.
 *
 * Los tres ledgers se paginan (ERP-25): uno truncado no da error, da una fecha vieja.
 * El corte de arranque sale de las mismas filas de finanzas (categoria ARRANQUE, viva),
 * que es lo que leia `leerFechaArranque`.
 */
type Cliente = SupabaseClient<Database>

type FilaFinanzas = { id_entidad_relacionada: string | null; fecha_movimiento: string | null; status: string | null; categoria: string | null }
type FilaInventario = { id_entidad_destino: string | null; id_entidad_origen: string | null; fecha_movimiento: string | null; status: string | null }
type FilaTicket = { id_comprador: string | null; fecha_transaccion: string | null; status: string | null }

export async function leerFuentesActividad(supabase: Cliente): Promise<Required<Omit<FuentesActividad, 'seguimiento'>>> {
  const [finanzas, inventario, tickets] = await Promise.all([
    fetchTodasLasFilas<FilaFinanzas>(
      () => supabase.from('finanzas_ledger').select('id_entidad_relacionada, fecha_movimiento, status, categoria').order('id'),
      'actividad: finanzas_ledger'
    ),
    fetchTodasLasFilas<FilaInventario>(
      () => supabase.from('inventario_ledger').select('id_entidad_destino, id_entidad_origen, fecha_movimiento, status').order('id'),
      'actividad: inventario_ledger'
    ),
    fetchTodasLasFilas<FilaTicket>(
      () => supabase.from('transacciones_tickets').select('id_comprador, fecha_transaccion, status').order('id'),
      'actividad: transacciones_tickets'
    )
  ])
  const fechaArranque = ultimaActividad(
    finanzas.filter((r) => r.categoria === 'ARRANQUE' && r.status !== 'ANULADO').map((r) => r.fecha_movimiento)
  )
  return { finanzas, inventario, tickets, fechaArranque }
}

export type NodoConSeguimiento = {
  id: string
  fecha_ultimo_seguimiento?: string | null
  ultimo_seguimiento?: string | null
}

/** Ultima actividad de cada nodo, leida y calculada con la regla unica. */
export async function leerUltimaActividadRed(
  supabase: Cliente,
  nodos: readonly NodoConSeguimiento[]
): Promise<Map<string, Date | null>> {
  const fuentes = await leerFuentesActividad(supabase)
  const seguimiento = new Map(nodos.map((n) => [n.id, n.fecha_ultimo_seguimiento ?? n.ultimo_seguimiento ?? null]))
  return ultimaActividadPorNodo(
    nodos.map((n) => n.id),
    { ...fuentes, seguimiento }
  )
}
