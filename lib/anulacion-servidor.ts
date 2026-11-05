/**
 * AG-06 FASE 5 — LA ANULACION, SIN SESION.
 *
 * ─── POR QUE ESTE ARCHIVO EXISTE ────────────────────────────────────────────
 * Es el MISMO movimiento que el commit `9b73c58` le hizo a la venta
 * (`app/actions/pos.ts` -> `lib/venta-servidor.ts`), por la misma razon y con
 * el mismo cuidado: el bot de Telegram no tiene sesion de operador. Vive en
 * `app/actions/audit.ts` un cuerpo de logica que decide **quien puede anular
 * que**, y ese cuerpo estaba atado a `cookies()` y a `getCurrentUser()`, o sea
 * a un navegador con cookie. El bot entra con `service_role` y un
 * `telegram_id`: no puede llamar a nada de eso.
 *
 * **La alternativa era copiar la logica al endpoint del bot, y no se hizo.**
 * Dos verdades sobre la anulacion es exactamente la deuda declarada del repo
 * (TKT-034/TKT-035, la duplicacion entre `pos.ts` y `auditoria.ts`, que ya
 * produjo drift una vez). Asi que la logica se MUDO aqui, entera, y
 * `app/actions/audit.ts` quedo con lo unico que de verdad es suyo: resolver la
 * sesion, y revalidar las rutas de Next.
 *
 * ─── EL PELIGRO QUE ESTE ARCHIVO TIENE QUE ATAJAR SOLO ──────────────────────
 * El bot usa `service_role`. El trigger `tg_vigilar_update_no_admin`
 * (migracion `20260903043105`) abre con
 * `IF mi_rol() IS NULL OR mi_rol() = 'ADMIN' THEN RETURN NEW`, y con
 * `service_role` **`mi_rol()` es NULL**: los tres candados de la base —solo se
 * cambia `status`, solo de `ACTIVO` a `ANULADO`, solo dentro de la ventana— NO
 * se aplican. Y el RLS tampoco, porque ninguna tabla tiene
 * `FORCE ROW LEVEL SECURITY`.
 *
 * **Consecuencia: la autorizacion que hay aqui es la UNICA que existe cuando
 * llama el bot.** No es una segunda linea de defensa. Es la linea.
 * `tests/anulacion-servidor.spec.ts` prueba cada regla con su control negativo
 * — una prueba que solo comprueba el camino feliz, con `service_role` debajo,
 * da verde sobre una puerta abierta.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Tables } from '@/types/database'
import {
  annulComercialCascadePorTicketId,
  assertAdminOAnulacionTicketPropia,
  assertPermiteAnularTicketEnPerfil
} from '@/lib/ticket-annul-cascade'
import { VENTANA_EDICION_ERROR, VENTANA_EDICION_MS } from '@/lib/constants'
import {
  esMarcaDeTraspaso,
  esPataDeTraspaso,
  juzgarPareja,
  MENSAJE_PAREJA_INCOMPLETA,
  MENSAJE_SIN_MARCA
} from '@/lib/traspaso-pareja'

export type ClienteDeAnulacion = SupabaseClient<Database>

/**
 * Quien anula. **Tres datos y ninguno sale de una cookie**, que es lo que hace
 * que esto lo pueda llamar tanto una server action con sesion como el bot con
 * su `telegram_id` ya resuelto contra `bot_identidades`.
 *
 * `idEntidad` es `entidades.id` (lo que `getCurrentUser()` devuelve como `id`),
 * no el `auth.users.id`: es con lo que se compara la paternidad de un LOC.
 */
export interface ActorDeAnulacion {
  idEntidad: string
  email: string
  rol: string
}

export const LOCKED_RECORD_ERROR =
  'Forbidden: Record is locked. Deletion window has expired for your role.'

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

async function dstPuedeOperarPerfilDetalle(
  supabase: ClienteDeAnulacion,
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
  // El puente legacy: las dos columnas se leen, igual que en todo el repo.
  const padre = data.id_nodo_padre ?? data.id_padre
  return padre === dstEntityId
}

export async function assertDistribuidoresHistorialAnnul(
  supabase: ClienteDeAnulacion,
  movimiento: {
    id_entidad_relacionada: string | null
    fecha_movimiento: string | null
  },
  actor: ActorDeAnulacion,
  perfilEntidadId: string,
  opts?: { omitVentanaHorariaDst?: boolean }
) {
  const rol = actor.rol.toUpperCase()
  if (rol === 'ADMIN') return

  if (rol !== 'DST') {
    throw new Error('No autorizado para anular desde este perfil.')
  }

  if (movimiento.id_entidad_relacionada !== perfilEntidadId) {
    throw new Error('El movimiento no pertenece al perfil visualizado.')
  }

  const dstAllowed = await dstPuedeOperarPerfilDetalle(supabase, actor.idEntidad, perfilEntidadId)
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
  if (Date.now() - tsMs > VENTANA_EDICION_MS) {
    throw new Error(VENTANA_EDICION_ERROR)
  }
}

/**
 * Las dos reglas de siempre para anular una fila suelta: **es tuya** y **es
 * reciente**. `ADMIN` salta las dos, exactamente como en la app — D3 lo dice
 * explicito: *no inventes una regla distinta para el bot*.
 *
 * La ventana sale de `VENTANA_EDICION_MS` (`lib/constants.ts`), **importada y
 * no copiada**. El numero tambien vive en el trigger de Postgres, duplicado a
 * la fuerza porque Postgres no lee TypeScript; `tests/candados-base.spec.ts`
 * vigila que los dos digan lo mismo.
 */
export function assertAnnullmentAllowed(
  row: { usuario_creador: string | null; fecha_movimiento: string | null },
  actor: { email: string; rol: string }
) {
  const rol = actor.rol.toUpperCase()
  if (rol === 'ADMIN') {
    return
  }

  if (row.usuario_creador !== actor.email) {
    throw new Error('Forbidden: You can only annul records created by your own user.')
  }

  const createdAtMs = row.fecha_movimiento ? new Date(row.fecha_movimiento).getTime() : NaN
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(LOCKED_RECORD_ERROR)
  }

  // D-E25: el candado temporal es UNO y es el mismo para todo rol que no sea
  // ADMIN. Antes eran 24 h para DST y 15 min para WORKER, y el resto de los
  // roles no-ADMIN se colaba sin ninguna ventana por el final de la funcion.
  if (Date.now() - createdAtMs > VENTANA_EDICION_MS) {
    throw new Error(LOCKED_RECORD_ERROR)
  }
}

/**
 * Lo que la anulacion de una fila de finanzas va a tocar, **antes de tocarlo**.
 *
 * Existe por D4: una fila con `id_ticket` no se anula sola — arrastra la venta
 * entera. Hoy eso es correcto y no se cambia; lo que estaba mal es que nadie lo
 * dijera antes del "va". Esto cuenta las filas de verdad para poder decirlo con
 * numeros: *"esa fila es de la venta TCK-xxxx; anularla anula el ticket, N
 * filas de dinero y M de inventario"*.
 *
 * Las mismas dos consultas que hace la cascada, con el mismo criterio, para que
 * el conteo no pueda mentirle a la accion que viene despues.
 */
export interface AlcanceDeAnulacion {
  idTicket: string | null
  filasFinanzas: number
  filasInventario: number
}

export async function medirAlcanceDeAnulacion(
  supabase: ClienteDeAnulacion,
  idTicket: string | null
): Promise<AlcanceDeAnulacion> {
  if (!idTicket) return { idTicket: null, filasFinanzas: 0, filasInventario: 0 }

  const [fin, inv] = await Promise.all([
    supabase
      .from('finanzas_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('id_ticket', idTicket)
      .in('status', ['ACTIVO', 'APPROVED']),
    supabase
      .from('inventario_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ACTIVO')
      .ilike('notas', `%${idTicket}%`)
  ])

  return {
    idTicket,
    filasFinanzas: fin.count ?? 0,
    filasInventario: inv.count ?? 0
  }
}

export interface ResultadoAnulacion {
  success: true
  /** El ticket que se arrastro, si la fila era de una venta. */
  idTicket: string | null
}

/**
 * Las dos patas de un traspaso, en UN update: un statement es una transaccion.
 * Sin marca, o con la pareja incompleta, no se anula nada. Ver `lib/traspaso-pareja.ts`.
 */
async function anularTraspasoCompleto(
  supabase: ClienteDeAnulacion,
  marca: string | null | undefined
): Promise<void> {
  if (!esMarcaDeTraspaso(marca)) throw new Error(MENSAJE_SIN_MARCA)

  const { data: patas, error: lecturaError } = await supabase
    .from('finanzas_ledger')
    .select('id, tipo_movimiento, monto, status')
    .eq('subcategoria', marca)
    .order('id')
    // Una pareja son dos filas: pedir tres alcanza para ver una tercera y rechazarla.
    .limit(3)
  if (lecturaError) throw new Error(`Error al leer el traspaso: ${lecturaError.message}`)

  const juicio = juzgarPareja(patas ?? [])
  if (!juicio.ok) throw new Error(juicio.error)

  const { data: anuladas, error: annullError } = await supabase
    .from('finanzas_ledger')
    .update({ status: 'ANULADO' })
    .in('id', juicio.ids)
    .eq('status', 'ACTIVO')
    .select('id')
  if (annullError) throw new Error(`Error al anular el traspaso: ${annullError.message}`)
  if ((anuladas?.length ?? 0) !== 2) throw new Error(MENSAJE_PAREJA_INCOMPLETA)
}

/**
 * Anula UNA fila de `finanzas_ledger`. Si la fila cuelga de un ticket, anula la
 * venta entera — ticket, dinero e inventario — **en una sola transaccion**
 * (`anular_ticket_atomica`, ver `lib/ticket-annul-cascade.ts`).
 *
 * Es el cuerpo exacto de `anularMovimientoFinanzas` de `app/actions/audit.ts`,
 * sin `cookies()`, sin `getCurrentUser()` y sin `revalidatePath()`.
 */
export async function anularFinanzas(
  supabase: ClienteDeAnulacion,
  actor: ActorDeAnulacion,
  id: string,
  options?: { perfilEntidadId?: string }
): Promise<ResultadoAnulacion> {
  if (!id) {
    throw new Error('ID de movimiento inválido.')
  }

  if (actor.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }

  const { data: movimientoRaw, error: fetchError } = await supabase
    .from('finanzas_ledger')
    .select('id, usuario_creador, fecha_movimiento, status, id_entidad_relacionada, id_ticket, tipo_movimiento, subcategoria')
    .eq('id', id)
    .single()

  if (fetchError || !movimientoRaw) {
    throw new Error('No se encontró el movimiento financiero.')
  }

  const movimiento = movimientoRaw as FinanzaLedgerRow & {
    id_entidad_relacionada: string | null
    tipo_movimiento?: string | null
    subcategoria?: string | null
  }

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
      actor,
      options.perfilEntidadId,
      { omitVentanaHorariaDst: Boolean(movimiento.id_ticket) }
    )
  } else {
    assertAnnullmentAllowed(movimiento, { email: actor.email, rol: actor.rol })
  }

  const idTicket = movimiento.id_ticket ? String(movimiento.id_ticket).trim() : ''

  if (idTicket) {
    // `assertAdminOAnulacionTicketPropia` y `assertPermiteAnularTicketEnPerfil`
    // esperan un actor con `id`, que es el `entidades.id`. Se traduce aqui para
    // no tocar `lib/ticket-annul-cascade.ts`, que ya lo usa la app con esa forma.
    const actorTicket = { id: actor.idEntidad, email: actor.email, rol: actor.rol }
    if (options?.perfilEntidadId) {
      await assertPermiteAnularTicketEnPerfil(
        supabase,
        idTicket,
        options.perfilEntidadId,
        actorTicket
      )
    } else {
      await assertAdminOAnulacionTicketPropia(supabase, idTicket, actorTicket)
    }
    await annulComercialCascadePorTicketId(supabase, idTicket)
    return { success: true, idTicket }
  }

  // Una pata de traspaso no se anula sola: es dinero que aparece o desaparece.
  if (esPataDeTraspaso(movimiento.tipo_movimiento)) {
    await anularTraspasoCompleto(supabase, movimiento.subcategoria)
    return { success: true, idTicket: null }
  }

  const { error: annullError } = await supabase
    .from('finanzas_ledger')
    .update({ status: 'ANULADO' })
    .eq('id', id)

  if (annullError) {
    throw new Error(`Error al anular movimiento financiero: ${annullError.message}`)
  }

  return { success: true, idTicket: null }
}

/**
 * Anula UNA fila de `inventario_ledger`.
 *
 * La marca `| ANULADO` se AÑADE a `notas`, nunca las sustituye: dentro de
 * `notas` vive `ticket:<uuid>`, que es **el unico enlace** entre inventario y
 * ticket (esa tabla no tiene columna `id_ticket`). Pisarlo rompe la cascada en
 * silencio — la venta se anularia y su movimiento fisico se quedaria activo.
 */
export async function anularInventario(
  supabase: ClienteDeAnulacion,
  actor: ActorDeAnulacion,
  id: string
): Promise<ResultadoAnulacion> {
  if (!id) {
    throw new Error('ID de movimiento inválido.')
  }

  if (actor.rol === 'SOCIO') {
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
  assertAnnullmentAllowed(movimiento, { email: actor.email, rol: actor.rol })

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

  return { success: true, idTicket: null }
}
