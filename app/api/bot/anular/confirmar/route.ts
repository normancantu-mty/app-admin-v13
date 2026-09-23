/**
 * AG-06 FASE 5 — ANULAR Y CORREGIR. El "va".
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ningun uuid de fila.**
 * Cual se toca lo dice el borrador sellado, y el sello se recalcula aqui antes
 * de tocar nada. Mismo orden que el molde de `gasto/confirmar`, y el
 * discriminador `tipo` se mira ANTES que el sello a proposito: un borrador de
 * otra familia nunca empataria el hash, y caeria por la rama del sello roto,
 * que CANCELA. Cancelar la captura de alguien por haberla mandado al endpoint
 * equivocado es un dano real causado por un error de enrutamiento.
 *
 * ─── LA AUTORIZACION SE VUELVE A HACER AQUI, ENTERA ─────────────────────────
 *
 * El bot entra con `service_role`, y `service_role` **se salta todo el RLS y
 * deja `mi_rol()` en NULL**, que es justo la primera linea de
 * `tg_vigilar_update_no_admin`: el trigger se rinde y deja pasar. O sea que la
 * regla de los 12 h, la de "solo tus propias filas" y la de "solo `status`" no
 * las va a aplicar nadie mas que este archivo y `lib/anulacion-servidor.ts`.
 *
 * Por eso la fila se vuelve a comprobar contra el filtro (`buscarEnLaLista`)
 * aunque ya se hubiera comprobado al proponer: entre la propuesta y el "va"
 * pueden pasar horas, y la ventana de edicion se cierra sola.
 *
 * ─── EL RASTRO ─────────────────────────────────────────────────────────────
 *
 * `tg_forzar_autor` respeta `usuario_creador = 'telegram:<etiqueta>'` **solo en
 * INSERT**. Un UPDATE hecho por `service_role` entra a `auditoria_logs` con
 * `usuario = 'sistema'` y `rol = NULL`: la bitacora registra que algo se anulo
 * y no de quien fue. Por eso este endpoint deja su propio renglon en el log de
 * la aplicacion, con el `borrador_id` y el `telegram_id` — y **nunca el token**,
 * que es lo unico que no puede aparecer en una linea de log.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera } from '@/lib/bot-aprobacion'
import { buscarEnLaLista } from '@/lib/bot-anulables'
import {
  anularFinanzas,
  anularInventario,
  type ActorDeAnulacion
} from '@/lib/anulacion-servidor'
import {
  puedeEditarDescripcion,
  selloAnulacionCoincide,
  type ActorDelBot,
  type AlcanceCascada,
  type PayloadAnulacion
} from '@/lib/bot-anulacion'

export const dynamic = 'force-dynamic'

interface BorradorGuardado {
  tipo?: string
  fila: PayloadAnulacion
  meta: { id_entidad: string; detalle: string; alcance: AlcanceCascada; avisos: string[] }
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      borrador_id?: unknown
      sello?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const selloRecibido = String(cuerpo.sello ?? '')

    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    // Anular no esta en la tabla de permisos de la Fase 9: se queda la regla de
    // siempre (`lib/anulacion-servidor.ts`), y solo se agrega la puerta.
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorGuardado
    // El discriminador, ANTES del sello. Ver el encabezado.
    if (guardado?.tipo !== 'anulacion') {
      return NextResponse.json({ error: 'Ese borrador no es una anulacion.' }, { status: 409 })
    }
    const fila = guardado?.fila

    if (!fila || !selloAnulacionCoincide(fila, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el borrador', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No toco nada: vuelve a pedirmela.' },
        { status: 409 }
      )
    }
    if (!selloAnulacionCoincide(fila, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No toco nada.' },
        { status: 409 }
      )
    }

    const actor: ActorDelBot = {
      rol: identidad.rolEntidad,
      autor: `telegram:${identidad.etiqueta}`
    }
    // La identidad, contra la fila sellada. Si a alguien le cambiaron la
    // etiqueta o el rol entre la propuesta y el "va", esto ya no se ejecuta.
    if (fila.usuario_creador !== actor.autor) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a pedirmelo.' },
        { status: 409 }
      )
    }

    // La segunda pasada del filtro. No es redundante: la ventana de 12 h se
    // cierra sola mientras el mensaje espera en el celular de alguien.
    const vigente = await buscarEnLaLista(supabase, actor, fila.tabla, fila.id_movimiento)
    if (!vigente) {
      return NextResponse.json(
        { error: 'Ese movimiento ya no se puede tocar: o ya esta anulado, o se cerro la ventana.' },
        { status: 409 }
      )
    }

    const actorAnulacion: ActorDeAnulacion = {
      idEntidad: identidad.idEntidad,
      // El correo del actor ES la etiqueta del bot, porque es lo que quedo en
      // `usuario_creador` al capturar. `assertAnnullmentAllowed` compara esas
      // dos cosas, asi que tienen que hablar el mismo idioma.
      email: actor.autor,
      rol: identidad.rolEntidad
    }

    // ── D98: el VA de quien requiere aprobacion NO toca nada ────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'una anulacion o correccion')
    }

    let resultado: Record<string, unknown>

    if (fila.modo === 'editar_descripcion') {
      resultado = await editarDescripcion(supabase, actor, fila)
    } else if (fila.modo === 'recapturar') {
      resultado = await recapturar(supabase, actorAnulacion, fila)
    } else {
      resultado =
        fila.tabla === 'inventario'
          ? { ...(await anularInventario(supabase, actorAnulacion, fila.id_movimiento)) }
          : { ...(await anularFinanzas(supabase, actorAnulacion, fila.id_movimiento)) }
    }

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: fila.id_movimiento,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    // EL RASTRO QUE LA BITACORA NO VA A GUARDAR. Ver el encabezado: en un
    // UPDATE hecho por `service_role`, `auditoria_logs` anota `usuario =
    // 'sistema'`. Aqui queda quien, que y por cual borrador. El token no.
    console.info(
      '[bot][anulacion] modo=%s tabla=%s fila=%s ticket=%s borrador=%s telegram_id=%s autor=%s',
      fila.modo,
      fila.tabla,
      fila.id_movimiento,
      fila.id_ticket ?? '-',
      borradorId,
      telegramId,
      actor.autor
    )

    return NextResponse.json({ ok: true, modo: fila.modo, ...resultado })
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : 'Error interno.'
    console.error('[bot] anular/confirmar reviento:', e)
    // Los mensajes de `lib/anulacion-servidor.ts` son los de la app y estan
    // escritos para que los lea una persona ("Este registro ya no se puede
    // modificar..."). Se pasan tal cual: traducirlos aqui los haria divergir.
    return NextResponse.json({ error: mensaje }, { status: 422 })
  }
}

type Cliente = ReturnType<typeof clienteDeServicio>

/**
 * La UNICA edicion real que existe (D6), y la unica regla que la sostiene.
 *
 * El trigger dice que un no-ADMIN solo puede cambiar `status`. Con
 * `service_role` el trigger se rinde, asi que la regla se aplica aqui — otra
 * vez, aunque ya se hubiera aplicado al proponer, porque el rol tambien puede
 * cambiar entre una cosa y la otra.
 *
 * Y se cuentan las filas tocadas: la leccion de ERP-66 es que un UPDATE negado
 * no da error, devuelve cero filas y un 200.
 */
async function editarDescripcion(
  supabase: Cliente,
  actor: ActorDelBot,
  fila: PayloadAnulacion
): Promise<Record<string, unknown>> {
  if (fila.tabla !== 'finanzas' || !fila.descripcion_nueva) {
    throw new Error('Eso no se edita: lo anulo y lo recapturamos.')
  }
  const { data: actual } = await supabase
    .from('finanzas_ledger')
    .select('id, id_ticket, status')
    .eq('id', fila.id_movimiento)
    .maybeSingle()
  if (!actual) throw new Error('No se encontro el movimiento.')

  const juicio = puedeEditarDescripcion(actor, {
    id_ticket: actual.id_ticket,
    status: actual.status
  })
  if (!juicio.ok) throw new Error(`No puedo: ${juicio.motivo}.`)

  const { data: tocadas, error } = await supabase
    .from('finanzas_ledger')
    .update({ descripcion: fila.descripcion_nueva })
    .eq('id', fila.id_movimiento)
    .in('status', ['ACTIVO', 'APPROVED'])
    .select('id')

  if (error) throw new Error(error.message)
  if (!tocadas || tocadas.length !== 1) {
    throw new Error('No pude cambiarlo: la fila cambio de estado. No toque nada.')
  }
  return { filas_tocadas: tocadas.length, descripcion: fila.descripcion_nueva }
}

/**
 * "Corregir" = anular y volver a escribir, en UN "va" (D6).
 *
 * ─── EL ORDEN, Y POR QUE ES ESTE ────────────────────────────────────────────
 *
 * Primero se anula, despues se escribe. **No hay transaccion**: en este repo no
 * hay un solo `BEGIN`/`COMMIT` (CLAUDE.md), asi que uno de los dos pasos puede
 * quedarse solo. Los dos ordenes fallan distinto y el que se escoge es el que
 * falla mejor:
 *
 *   · anular y luego fallar al escribir deja **una fila de menos**, y lo dice
 *     en el mismo mensaje. La persona esta en el chat, en ese momento, y
 *     vuelve a dictarlo;
 *   · escribir y luego fallar al anular deja **la fila DOS veces**, contando
 *     doble en la cartera y en el corte del mes, y sin decir nada.
 *
 * Y no hay compensacion: "desanular" no existe — el contrato del ledger tiene
 * una sola transicion, `ACTIVO -> ANULADO` (regla 6). Escribir una compensacion
 * que la violara seria peor que el fallo que intenta arreglar.
 */
async function recapturar(
  supabase: Cliente,
  actor: ActorDeAnulacion,
  fila: PayloadAnulacion
): Promise<Record<string, unknown>> {
  if (fila.tabla !== 'finanzas' || !fila.recaptura) {
    throw new Error('Eso no se recaptura por aqui.')
  }

  await anularFinanzas(supabase, actor, fila.id_movimiento)

  const { data: creada, error } = await supabase
    .from('finanzas_ledger')
    .insert(fila.recaptura)
    .select('id')
    .single()

  if (error || !creada) {
    console.error('[bot] recaptura: anule pero no pude escribir la nueva', error)
    throw new Error(
      'Anule la fila vieja pero no pude escribir la nueva. Dictamela otra vez como gasto: ' +
        'la vieja ya NO cuenta.'
    )
  }

  return { anulada: fila.id_movimiento, id: creada.id }
}
