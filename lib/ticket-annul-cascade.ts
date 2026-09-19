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

/** Lo que devuelve `anular_ticket_atomica`: cuantas filas toco de cada lado. */
export interface CascadaAnulada {
  finanzas: number
  inventario: number
  /**
   * Cotizaciones que volvieron a quedar libres. Es 0 casi siempre —la mayoria
   * de las ventas no vienen de una cotizacion— y por eso el RPC no lo exige.
   * Ver la migracion `20260919153518`.
   */
  cotizaciones: number
}

/**
 * ─── UN SOLO RPC, Y ANTES ERAN TRES UPDATE SUELTOS ──────────────────────────
 *
 * Hasta el 2026-09-19 esto eran tres `update()` en fila: encabezado, dinero,
 * inventario. PostgREST abre y cierra una transaccion **por peticion**, asi que
 * entre uno y otro no habia nada que los atara. Si el tercero fallaba, quedaba
 * el ticket anulado y su movimiento de inventario todavia ACTIVO — o sea stock
 * descontado por una venta que ya no existe. Y como el inventario no se guarda
 * como total sino que se replaya desde el ledger entero, esa fila huerfana no
 * se ve en ninguna pantalla: el almacen simplemente dice de menos, para siempre.
 *
 * `anular_ticket_atomica` (migracion `20260919151831`) mete los tres en la
 * MISMA transaccion de Postgres. Desde `20260919153518` son cuatro: se suma la
 * cotizacion que origino la venta, que si no se liberaba quedaba CONVERTIDA
 * apuntando a un ticket muerto. Es la gemela de lo que ERP-11 le hizo a la
 * venta, para el lado que habia quedado sin cubrir.
 *
 * **El comportamiento visible no cambia** — mismos criterios, mismo orden,
 * mismos filtros de `status` — salvo en un punto, y es a mejor: si el ticket no
 * existe, ahora lanza en vez de contestar 200 habiendo tocado cero filas (la
 * leccion de ERP-66).
 *
 * `SECURITY INVOKER`: dentro del RPC siguen corriendo el RLS y el trigger
 * `tg_vigilar_update_no_admin` con el rol de quien llama. La ventana de 12 h de
 * un DST no se evapora por haber pasado a ser una funcion.
 */
export async function annulComercialCascadePorTicketId(
  supabase: SupabaseClient<Database>,
  ticketId: string
): Promise<CascadaAnulada> {
  if (!ticketId || !UUID_REGEX.test(ticketId)) {
    throw new Error('Ticket inválido para anulación en cascada.')
  }

  const { data, error } = await supabase.rpc('anular_ticket_atomica', {
    p_ticket_id: ticketId
  })

  if (error) throw new Error(error.message)

  const conteo = (data ?? {}) as {
    finanzas?: unknown
    inventario?: unknown
    cotizaciones?: unknown
  }
  return {
    finanzas: Number(conteo.finanzas) || 0,
    inventario: Number(conteo.inventario) || 0,
    cotizaciones: Number(conteo.cotizaciones) || 0
  }
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
