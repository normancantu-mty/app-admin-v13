'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getCurrentUser } from '@/lib/auth-utils'
import type { Tables } from '@/types/database'
import {
  annulComercialCascadePorTicketId,
  assertAdminOAnulacionTicketPropia,
  assertPermiteAnularTicketEnPerfil
} from '@/lib/ticket-annul-cascade'

const DELETE_WINDOW_HOURS_DST = 24
const DELETE_WINDOW_MINUTES_WORKER = 15
const LOCKED_RECORD_ERROR = 'Forbidden: Record is locked. Deletion window has expired for your role.'

type FinanzaLedgerRow = Pick<
  Tables<'finanzas_ledger'>,
  'id' | 'fecha_movimiento' | 'usuario_creador' | 'status' | 'id_entidad_relacionada' | 'id_ticket'
>
interface InventarioLedgerRow {
  id: string
  fecha_movimiento: string | null
  usuario_creador: string | null
  status: string | null
  notas: string | null
}

async function getServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set() {
          // No-op en server action
        },
        remove() {
          // No-op en server action
        }
      }
    }
  )
}

async function dstPuedeOperarPerfilDetalle(
  supabase: Awaited<ReturnType<typeof getServerSupabaseClient>>,
  dstEntityId: string,
  perfilEntidadId: string
): Promise<boolean> {
  if (perfilEntidadId === dstEntityId) return true
  const { data } = await supabase
    .from('entidades')
    .select('id_nodo_padre, id_padre, rol')
    .eq('id', perfilEntidadId)
    .maybeSingle()
  if (!data || data.rol !== 'LOC') return false
  const padre = data.id_nodo_padre ?? data.id_padre
  return padre === dstEntityId
}

async function assertDistribuidoresHistorialAnnul(
  supabase: Awaited<ReturnType<typeof getServerSupabaseClient>>,
  movimiento: {
    id_entidad_relacionada: string | null
    fecha_movimiento: string | null
  },
  currentUser: { id: string; email: string; rol: string },
  perfilEntidadId: string,
  opts?: { omitVentanaHorariaDst?: boolean }
) {
  const rol = currentUser.rol.toUpperCase()
  if (rol === 'ADMIN') return

  if (rol !== 'DST') {
    throw new Error('No autorizado para anular desde este perfil.')
  }

  if (movimiento.id_entidad_relacionada !== perfilEntidadId) {
    throw new Error('El movimiento no pertenece al perfil visualizado.')
  }

  const dstAllowed = await dstPuedeOperarPerfilDetalle(supabase, currentUser.id, perfilEntidadId)
  if (!dstAllowed) {
    throw new Error('No autorizado: solo puedes anular en tu cuenta o la de tus locales.')
  }

  if (opts?.omitVentanaHorariaDst) {
    return
  }

  const tsMs = movimiento.fecha_movimiento ? new Date(movimiento.fecha_movimiento).getTime() : NaN
  if (!Number.isFinite(tsMs)) {
    throw new Error('No se puede determinar la antigüedad del movimiento.')
  }
  const sixHoursMs = 6 * 60 * 60 * 1000
  if (Date.now() - tsMs > sixHoursMs) {
    throw new Error('Ventana de anulación expirada (máximo 6 horas para distribuidores).')
  }
}

function assertAnnullmentAllowed(
  row: { usuario_creador: string | null; fecha_movimiento: string | null },
  currentUser: { email: string; rol: string }
) {
  const rol = currentUser.rol.toUpperCase()
  if (rol === 'ADMIN') {
    return
  }

  if (row.usuario_creador !== currentUser.email) {
    throw new Error('Forbidden: You can only annul records created by your own user.')
  }

  const createdAtMs = row.fecha_movimiento ? new Date(row.fecha_movimiento).getTime() : NaN
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(LOCKED_RECORD_ERROR)
  }

  // Los candados temporales aplican solo para DST y trabajadores.
  if (rol === 'DST') {
    const elapsedHours = (Date.now() - createdAtMs) / (1000 * 60 * 60)
    if (elapsedHours > DELETE_WINDOW_HOURS_DST) {
      throw new Error(LOCKED_RECORD_ERROR)
    }
    return
  }

  if (rol === 'WORKER' || rol === 'TRABAJADOR') {
    const elapsedMinutes = (Date.now() - createdAtMs) / (1000 * 60)
    if (elapsedMinutes > DELETE_WINDOW_MINUTES_WORKER) {
      throw new Error(LOCKED_RECORD_ERROR)
    }
    return
  }
}

export async function bulkDeleteMovements(ids: string[]) {
  if (!ids.length) {
    throw new Error('No se recibieron movimientos para borrar.')
  }

  const currentUser = await getCurrentUser()
  if (!currentUser) {
    throw new Error('Sesión inválida. Inicia sesión nuevamente.')
  }

  if (currentUser.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }

  let count = 0
  for (const id of ids) {
    const result = await anularMovimientoFinanzas(id)
    if (result.success) count += 1
  }

  return { success: true, count }
}

export async function anularMovimientoFinanzas(id: string, options?: { perfilEntidadId?: string }) {
  if (!id) {
    throw new Error('ID de movimiento inválido.')
  }

  const supabase = await getServerSupabaseClient()
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    throw new Error('Sesión inválida. Inicia sesión nuevamente.')
  }

  if (currentUser.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }

  const { data: movimientoRaw, error: fetchError } = await supabase
    .from('finanzas_ledger')
    .select('id, usuario_creador, fecha_movimiento, status, id_entidad_relacionada, id_ticket')
    .eq('id', id)
    .single()

  if (fetchError || !movimientoRaw) {
    throw new Error('No se encontró el movimiento financiero.')
  }

  const movimiento = movimientoRaw as FinanzaLedgerRow & { id_entidad_relacionada: string | null }

  if (movimiento.status === 'ANULADO') {
    throw new Error('El movimiento financiero ya está anulado.')
  }

  if (options?.perfilEntidadId) {
    await assertDistribuidoresHistorialAnnul(
      supabase,
      {
        id_entidad_relacionada: movimiento.id_entidad_relacionada,
        fecha_movimiento: movimiento.fecha_movimiento
      },
      { id: currentUser.id, email: currentUser.email, rol: currentUser.rol },
      options.perfilEntidadId,
      { omitVentanaHorariaDst: Boolean(movimiento.id_ticket) }
    )
  } else {
    assertAnnullmentAllowed(movimiento, { email: currentUser.email, rol: currentUser.rol })
  }

  const idTicket = movimiento.id_ticket ? String(movimiento.id_ticket).trim() : ''

  if (idTicket) {
    const actor = { id: currentUser.id, email: currentUser.email, rol: currentUser.rol }
    if (options?.perfilEntidadId) {
      await assertPermiteAnularTicketEnPerfil(supabase, idTicket, options.perfilEntidadId, actor)
    } else {
      await assertAdminOAnulacionTicketPropia(supabase, idTicket, actor)
    }
    await annulComercialCascadePorTicketId(supabase, idTicket)
    if (options?.perfilEntidadId) {
      revalidatePath(`/dashboard/distribuidores/${options.perfilEntidadId}`)
    }
    revalidatePath('/dashboard/distribuidores')
    revalidatePath('/dashboard/inventario')
    revalidatePath('/dashboard/finanzas')
    return { success: true }
  }

  const { error: annullError } = await supabase
    .from('finanzas_ledger')
    .update({ status: 'ANULADO' })
    .eq('id', id)

  if (annullError) {
    throw new Error(`Error al anular movimiento financiero: ${annullError.message}`)
  }

  revalidatePath('/dashboard/finanzas')
  if (options?.perfilEntidadId) {
    revalidatePath(`/dashboard/distribuidores/${options.perfilEntidadId}`)
  }
  revalidatePath('/dashboard/distribuidores')

  return { success: true }
}

export async function anularMovimientoInventario(id: string) {
  if (!id) {
    throw new Error('ID de movimiento inválido.')
  }

  const supabase = await getServerSupabaseClient()
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    throw new Error('Sesión inválida. Inicia sesión nuevamente.')
  }

  if (currentUser.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }

  const { data: movimientoRaw, error: fetchError } = await supabase
    .from('inventario_ledger')
    .select('id, usuario_creador, fecha_movimiento, status, notas')
    .eq('id', id)
    .single()

  if (fetchError || !movimientoRaw) {
    throw new Error('No se encontró el movimiento de inventario.')
  }

  const movimiento = movimientoRaw as InventarioLedgerRow
  assertAnnullmentAllowed(movimiento, { email: currentUser.email, rol: currentUser.rol })

  if (movimiento.status === 'ANULADO') {
    throw new Error('El movimiento ya está anulado.')
  }

  const notasAnulacion = [movimiento.notas, 'ANULADO'].filter(Boolean).join(' | ')
  const { error: annullError } = await supabase
    .from('inventario_ledger')
    .update({
      status: 'ANULADO',
      notas: notasAnulacion
    })
    .eq('id', id)

  if (annullError) {
    throw new Error(`Error al anular movimiento de inventario: ${annullError.message}`)
  }

  revalidatePath('/dashboard/inventario')
  revalidatePath('/dashboard/distribuidores')

  return { success: true }
}

export async function deleteInventarioMovement(id: string) {
  return anularMovimientoInventario(id)
}
