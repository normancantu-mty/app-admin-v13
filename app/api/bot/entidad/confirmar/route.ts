/**
 * AG-06 FASE 5 — EL ALTA DE UN DISTRIBUIDOR O UN LOCAL. El "va".
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ningun dato de la
 * entidad.** Que se va a crear lo dice el borrador sellado, y el sello se
 * recalcula aqui antes de escribir nada: entre el "voy a dar de alta a Juan con
 * 20%" y el "va" no hay ningun camino por el que ese 20 pueda volverse 100.
 *
 * Orden identico al de `anular/confirmar`, incluido que el discriminador `tipo`
 * se mira ANTES que el sello: un borrador de otra familia nunca empataria el
 * hash y caeria por la rama del sello roto, que CANCELA — y cancelarle a
 * alguien su captura por un error de enrutamiento es un dano real.
 *
 * ─── LA CONTRASENA SE GENERA AQUI, NO EN LA PROPUESTA (D11) ─────────────────
 *
 * Si se generara al proponer, quedaria escrita en claro dentro de
 * `bot_borradores.payload` — una credencial guardada en una tabla de borradores,
 * a cambio de nada: no es un dato del negocio que haya que congelar entre el
 * mensaje y el "va". Se genera cuando de verdad se crea la cuenta, se ensena una
 * vez, y no se guarda en ningun lado nuestro.
 *
 * ─── EL RASTRO ─────────────────────────────────────────────────────────────
 *
 * `entidades` no tiene trigger de bitacora: `auditoria_logs` cubre los dos
 * ledgers y los tickets, no el directorio. O sea que de un alta hecha por chat
 * **no queda ningun rastro en la base**, y por eso este endpoint deja el suyo en
 * el log de la aplicacion. Va el `telegram_id`, el autor y el id creado; **nunca
 * el token ni la contrasena**, que son las dos cosas que no pueden aparecer en
 * una linea de log.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera, actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import {
  crearEntidad,
  generarPassword,
  puedeDarDeAlta,
  type ActorDeAlta,
  type PuertaDeAuth
} from '@/lib/entidad-servidor'
import {
  mensajeDeAltaHecha,
  selloAltaCoincide,
  type PayloadAlta
} from '@/lib/bot-entidad'

export const dynamic = 'force-dynamic'

interface BorradorGuardado {
  tipo?: string
  fila: PayloadAlta
  meta: { id_entidad: string; nombrePadre: string | null; avisos: string[] }
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

    const actor: ActorDeAlta = { idEntidad: quien.idEntidad, rol: quien.rolEntidad }
    if (permisoDeAccion(actorDe(quien), 'entidad') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.entidad }, { status: 403 })
    }

    // El permiso, otra vez. No es redundante: entre la propuesta y el "va"
    // pueden pasar horas, y a alguien le pueden haber quitado el rol de ADMIN.
    if (!puedeDarDeAlta(actor)) {
      return NextResponse.json(
        { error: 'Solo administracion da de alta distribuidores y locales.' },
        { status: 403 }
      )
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorGuardado
    // El discriminador, ANTES del sello. Ver el encabezado.
    if (guardado?.tipo !== 'alta_entidad') {
      return NextResponse.json({ error: 'Ese borrador no es un alta.' }, { status: 409 })
    }
    const fila = guardado?.fila

    if (!fila || !selloAltaCoincide(fila, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el borrador de alta', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No cree nada: vuelve a pedirmela.' },
        { status: 409 }
      )
    }
    if (!selloAltaCoincide(fila, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No cree nada.' },
        { status: 409 }
      )
    }

    // ── D98: el VA de quien requiere aprobacion NO crea nada ────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'un alta de cliente')
    }

    // ── LA CONTRASENA. Se genera aqui, se ensena una vez, no se guarda. ────
    const password = fila.rol === 'DST' ? generarPassword() : null

    // La puerta de Auth. Se inyecta en vez de llamarla desde `crearEntidad`
    // para que la logica del alta se pueda probar sin un servidor de Auth
    // detras — y para que aqui se vea, en un solo lugar, que lo unico que sale
    // de la transaccion es esta llamada HTTP.
    const puertaAuth: PuertaDeAuth = {
      crear: async (email, clave) => {
        const { data, error } = await supabase.auth.admin.createUser({
          email,
          password: clave,
          email_confirm: true
        })
        if (error || !data?.user?.id) {
          throw new Error(error?.message ?? 'No pude crear el acceso.')
        }
        return data.user.id
      },
      borrar: async (authId) => {
        const { error } = await supabase.auth.admin.deleteUser(authId)
        if (error) throw new Error(error.message)
      }
    }

    const creada = await crearEntidad(supabase, actor, fila, password, puertaAuth)

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: creada.id,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    // EL RASTRO QUE LA BASE NO GUARDA. Ver el encabezado. Sin token, sin clave.
    console.info(
      '[bot][alta] rol=%s zona=%s entidad=%s nombre=%s borrador=%s telegram_id=%s autor=%s',
      fila.rol,
      fila.zona,
      creada.id,
      creada.nombre,
      borradorId,
      telegramId,
      `telegram:${identidad.etiqueta}`
    )

    return NextResponse.json({
      ok: true,
      id_entidad: creada.id,
      nombre: creada.nombre,
      cuenta: creada.cuenta,
      mensaje: mensajeDeAltaHecha(fila, password)
    })
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : 'Error interno.'
    console.error('[bot] entidad/confirmar reviento:', e)
    return NextResponse.json({ error: mensaje }, { status: 500 })
  }
}
