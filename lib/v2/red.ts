/**
 * Paridad v2 — lecturas de la red (directorio, seguimiento) y el cliente de
 * servicio. Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Es la MISMA lectura y regla que `/dashboard/distribuidores` (v1): entidades no
 * ADMIN (un DST ve solo su rama), saldos de `v_saldo_entidad` con el cliente de
 * la sesion (security_invoker recorta), y la ultima actividad de
 * `leerUltimaActividadRed` con service role (alimenta el semaforo, no el dinero).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { CurrentUser } from '@/lib/auth-utils'
import { getSemaforoMovimiento } from '@/lib/risk-utils'
import { diasDesde } from '@/lib/actividad'
import { leerUltimaActividadRed } from '@/lib/actividad-servidor'
import { leerSaldosEntidad } from '@/lib/vistas'

type Cliente = SupabaseClient<Database>

export function clienteServicioV2(): Cliente {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const llave = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !llave) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  return createClient<Database>(url, llave, { auth: { persistSession: false, autoRefreshToken: false } })
}

import type { FilaRed, RolRed } from './red-tipos'
export type { FilaRed, RolRed } from './red-tipos'

type Entidad = Database['public']['Tables']['entidades']['Row']

async function leerEntidadesVisibles(client: Cliente, usuario: CurrentUser): Promise<Entidad[]> {
  let q = client.from('entidades').select('*').neq('rol', 'ADMIN').order('rol', { ascending: true })
  if (usuario.rol === 'DST') q = q.or(`id.eq.${usuario.id},id_nodo_padre.eq.${usuario.id}`)
  else if (usuario.rol !== 'ADMIN' && usuario.rol !== 'SOCIO') return []
  const { data, error } = await q
  if (error) throw new Error(`entidades: ${error.message}`)
  return (data ?? []) as Entidad[]
}

export async function leerRed(client: Cliente, usuario: CurrentUser): Promise<FilaRed[]> {
  const entidades = await leerEntidadesVisibles(client, usuario)
  const [saldos, actividad] = await Promise.all([
    leerSaldosEntidad(client),
    leerUltimaActividadRed(clienteServicioV2(), entidades)
  ])
  const saldoPor = new Map(saldos.map((s) => [s.id_entidad, s]))
  return entidades.map((e) => {
    const padreId = (e.id_nodo_padre ?? e.id_padre ?? '').trim() || null
    const padre = entidades.find((x) => x.id === padreId)
    const directa = !e.id_nodo_padre && !e.id_padre
    const s = saldoPor.get(e.id)
    const dias = diasDesde(actividad.get(e.id) ?? null)
    return {
      id: e.id,
      nombre: e.nombre,
      rol: e.rol as RolRed,
      zona: e.zona,
      telefono: e.telefono ?? null,
      comision_base: e.comision_base ?? 0,
      comision_base_local: e.comision_base_local ?? 0,
      comision_hijo_local: e.comision_hijo_local ?? 0,
      aplica_redondeo_costo: e.aplica_redondeo_costo ?? true,
      ubicacionMaps: e.ubicacion_maps ?? null,
      patrocinador: padre ? padre.nombre : directa ? 'Línea directa' : 'Padre no encontrado',
      saldoPendiente: Number(s?.saldo_pendiente_consignacion ?? 0),
      saldoPorPagar: Number(s?.saldo_por_pagar_efectivo ?? 0),
      semaforo: getSemaforoMovimiento(dias),
      diasSeguimiento: dias,
      seguimientoTexto: dias === null ? 'Sin contacto' : `${dias} días`
    }
  })
}
