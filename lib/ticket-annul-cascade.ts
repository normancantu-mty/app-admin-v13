/**
 * Anulación en cascada de un evento comercial (ticket): finanzas, inventario y encabezado.
 * Sin DELETE: solo status = 'ANULADO'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { VENTANA_EDICION_ERROR, VENTANA_EDICION_MS } from '@/lib/constants'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Marca estable en inventario_ledger.notas para correlacionar filas POS con transacciones_tickets.id */
export function notasConIdTicket(ticketId: string, notasExistentes?: string | null): string {
  const marca = `ticket:${ticketId}`
  const prev = (notasExistentes ?? '').trim()
  if (!prev) return marca
  if (prev.includes(ticketId)) return prev
  return `${prev} | ${marca}`
}

export async function annulComercialCascadePorTicketId(
  supabase: SupabaseClient<Database>,
  ticketId: string
): Promise<void> {
  if (!ticketId || !UUID_REGEX.test(ticketId)) {
    throw new Error('Ticket inválido para anulación en cascada.')
  }

  const { error: eTicket } = await supabase
    .from('transacciones_tickets')
    .update({ status: 'ANULADO' })
    .eq('id', ticketId)

  if (eTicket) throw new Error(eTicket.message)

  const { error: eLed } = await supabase
    .from('finanzas_ledger')
    .update({ status: 'ANULADO' })
    .eq('id_ticket', ticketId)
    .in('status', ['ACTIVO', 'APPROVED'])

  if (eLed) throw new Error(eLed.message)

  const pattern = `%${ticketId}%`
  const { error: eInv } = await supabase
    .from('inventario_ledger')
    .update({ status: 'ANULADO' })
    .eq('status', 'ACTIVO')
    .ilike('notas', pattern)

  if (eInv) throw new Error(eInv.message)
}

type Actor = { id: string; email: string; rol: string }

export async function assertPermiteAnularTicketEnPerfil(
  supabase: SupabaseClient<Database>,
  ticketId: string,
  perfilEntidadId: string,
  actor: Actor
): Promise<void> {
  if (!perfilEntidadId || !UUID_REGEX.test(perfilEntidadId)) throw new Error('Perfil inválido.')

  const { data: ticket, error: tErr } = await supabase
    .from('transacciones_tickets')
    .select('id, id_comprador, id_vendedor, fecha_transaccion, status')
    .eq('id', ticketId)
    .single()

  if (tErr || !ticket) throw new Error('No se encontró el ticket.')

  if ((ticket.status ?? 'ACTIVO') === 'ANULADO') {
    throw new Error('Este ticket ya está anulado.')
  }

  const touchesProfile =
    ticket.id_comprador === perfilEntidadId || ticket.id_vendedor === perfilEntidadId
  if (!touchesProfile) {
    throw new Error('El ticket no pertenece al perfil visualizado.')
  }

  const rol = String(actor.rol).toUpperCase()
  if (rol === 'SOCIO') throw new Error('No autorizado.')

  if (rol === 'ADMIN' || rol === 'SUB-ADMIN') return

  if (rol === 'DST') {
    const esPropia = perfilEntidadId === actor.id
    let esLocalDelDst = false
    if (!esPropia) {
      const { data: locRow } = await supabase
        .from('entidades')
        .select('id_nodo_padre, id_padre, rol')
        .eq('id', perfilEntidadId)
        .maybeSingle()
      if (locRow?.rol === 'LOC') {
        const padre = locRow.id_nodo_padre ?? locRow.id_padre
        esLocalDelDst = padre === actor.id
      }
    }
    if (!esPropia && !esLocalDelDst) {
      throw new Error('No autorizado: solo puedes anular en tu cuenta o la de tus locales.')
    }
    const tsMs = ticket.fecha_transaccion ? Date.parse(ticket.fecha_transaccion) : NaN
    if (!Number.isFinite(tsMs) || Date.now() - tsMs > VENTANA_EDICION_MS) {
      throw new Error(VENTANA_EDICION_ERROR)
    }
    return
  }

  throw new Error('No autorizado para anular tickets desde este perfil.')
}

export async function assertAdminOAnulacionTicketPropia(
  supabase: SupabaseClient<Database>,
  ticketId: string,
  actor: Actor
): Promise<void> {
  const rol = String(actor.rol).toUpperCase()
  if (rol === 'ADMIN' || rol === 'SUB-ADMIN') return

  const { data: ticket, error: tErr } = await supabase
    .from('transacciones_tickets')
    .select('id, id_comprador, id_vendedor, fecha_transaccion, status')
    .eq('id', ticketId)
    .single()

  if (tErr || !ticket) throw new Error('No se encontró el ticket.')
  if ((ticket.status ?? 'ACTIVO') === 'ANULADO') throw new Error('Este ticket ya está anulado.')

  if (rol !== 'DST') {
    throw new Error('La anulación en cascada por ticket solo la ejecuta administración o tu distribuidor autorizado.')
  }

  const tocaDst = ticket.id_comprador === actor.id || ticket.id_vendedor === actor.id
  if (!tocaDst) {
    throw new Error('No autorizado: el ticket no corresponde a tu entidad.')
  }

  const tsMs = ticket.fecha_transaccion ? Date.parse(ticket.fecha_transaccion) : NaN
  if (!Number.isFinite(tsMs) || Date.now() - tsMs > VENTANA_EDICION_MS) {
    throw new Error(VENTANA_EDICION_ERROR)
  }
}
