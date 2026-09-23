/**
 * AG-06 FASE 5 — ANULAR Y CORREGIR. La propuesta.
 *
 * Mismo molde que `app/api/bot/gasto/proponer/route.ts`: token -> telegram_id
 * seguro -> identidad -> se arma lo que se va a hacer -> se SELLA -> se guarda
 * el borrador -> se contesta con el mensaje y el sello. Entre esta respuesta y
 * el `confirmar` no viaja ninguna fila.
 *
 * ─── PERO AQUI EL SELLO PROTEGE OTRA COSA ───────────────────────────────────
 *
 * En la captura, el sello congela la fila que se va a ESCRIBIR. Aqui congela la
 * fila que se va a TOCAR. Es la misma propiedad puesta del otro lado: entre que
 * el bot ensena "voy a anular el gasto de $340 de gasolina" y el "va", no hay
 * ningun camino por el que el uuid pueda cambiar. Sin sello, un id distinto en
 * el `confirmar` anularia otra fila enseñando el mensaje de esta.
 *
 * ─── Y LA LISTA ES EL UNICO MODO DE SEÑALAR UNA FILA (D2) ───────────────────
 *
 * *"Un movimiento que se va a anular NO se identifica NUNCA por texto libre."*
 * El enrutador tiene prohibido decir cual; solo dice que se quiere anular algo.
 * Quien decide es la persona, picando un boton de una lista que arma el
 * servidor. Dictar "anula el gasto de mil pesos" con dos gastos de mil pesos es
 * exactamente como se anula la fila equivocada.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador } from '@/lib/bot-permisos'
import { buscarEnLaLista, listarAnulables } from '@/lib/bot-anulables'
import {
  medirAlcanceDeAnulacion,
  type AlcanceDeAnulacion
} from '@/lib/anulacion-servidor'
import {
  esAccionDeLista,
  esAdminDelBot,
  mensajeDeAnulacion,
  mensajeDeEdicion,
  mensajeDeRecaptura,
  normalizarDescripcionNueva,
  puedeEditarDescripcion,
  sellarAnulacion,
  textoDeLaLista,
  type ActorDelBot,
  type ModoAnulacion,
  type PayloadAnulacion
} from '@/lib/bot-anulacion'
import { normalizarPropuesta, type PayloadGasto } from '@/lib/bot-gastos'
import { leerCatalogo } from '@/lib/bot-servidor'
import { actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'

export const dynamic = 'force-dynamic'

const MODOS: readonly ModoAnulacion[] = ['anular', 'recapturar', 'editar_descripcion']

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      /** FASE 9 (D94): el chat donde se hablo; en privado es la persona. */
      chat_id?: unknown
      tabla?: unknown
      id_movimiento?: unknown
      modo?: unknown
      descripcion_nueva?: unknown
      recaptura?: unknown
      /** Solo para el verbo de la pregunta. Ver `esAccionDeLista`. */
      accion?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    // El actor del bot. `autor` es lo que el bot escribe en `usuario_creador`
    // en cada INSERT, asi que es con lo que `assertAnnullmentAllowed` va a
    // comparar despues. Se arma de la identidad, nunca del cuerpo.
    const actor: ActorDelBot = {
      rol: identidad.rolEntidad,
      autor: `telegram:${identidad.etiqueta}`
    }

    // ── SIN MOVIMIENTO: SE OFRECE LA LISTA ────────────────────────────────
    const idMovimiento = String(cuerpo.id_movimiento ?? '').trim()
    if (idMovimiento === '') {
      const lista = await listarAnulables(supabase, actor)
      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'movimiento',
        // `accion` solo escoge el verbo con el que se pregunta; lo que se va a
        // escribir lo decide `modo`, que viaja dentro del sello. Un cuerpo que
        // mienta aqui cambia una palabra, no una fila.
        mensaje: textoDeLaLista(lista, actor, esAccionDeLista(cuerpo.accion) ? cuerpo.accion : 'anular'),
        // El bot guarda ESTA lista y el boton lleva el indice contra ella. El
        // uuid nunca viaja en el `callback_data`: no cabe en 64 bytes y ademas
        // un indice contra una lista declarada por el servidor es mas dificil
        // de falsificar que un uuid suelto.
        opciones: lista.map((m) => ({
          tabla: m.tabla,
          id: m.id,
          etiqueta: m.etiqueta,
          detalle: m.detalle,
          arrastra_venta: Boolean(m.id_ticket),
          // Para poder corregir UN campo sin volver a llamar al modelo, en
          // cuanto se escoge el movimiento. Viajan aqui para que escoger de la
          // lista no tenga que abrir un borrador que a lo mejor no se usa.
          valores: m.valores
        }))
      })
    }

    const tabla = String(cuerpo.tabla ?? 'finanzas')
    if (tabla !== 'finanzas' && tabla !== 'inventario') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const modo = String(cuerpo.modo ?? 'anular') as ModoAnulacion
    if (!MODOS.includes(modo)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    // ── LA FILA, COMPROBADA CONTRA EL MISMO FILTRO DE LA LISTA ────────────
    const movimiento = await buscarEnLaLista(supabase, actor, tabla, idMovimiento)
    if (!movimiento) {
      return NextResponse.json(
        {
          error: esAdminDelBot(actor)
            ? 'Ese movimiento ya no esta activo. Pideme la lista otra vez.'
            : 'Ese movimiento no es tuyo, o ya paso la ventana para tocarlo.'
        },
        { status: 403 }
      )
    }

    // ── EL ALCANCE REAL (D4), MEDIDO CONTRA LA BASE ───────────────────────
    const alcance: AlcanceDeAnulacion = await medirAlcanceDeAnulacion(
      supabase,
      movimiento.id_ticket
    )

    let payload: PayloadAnulacion = {
      modo,
      tabla,
      id_movimiento: movimiento.id,
      id_ticket: movimiento.id_ticket,
      usuario_creador: actor.autor,
      recaptura: null,
      descripcion_nueva: null
    }
    let mensaje = ''
    let avisos: string[] = []

    if (modo === 'anular') {
      mensaje = mensajeDeAnulacion(movimiento, alcance)
    } else if (modo === 'editar_descripcion') {
      if (tabla !== 'finanzas') {
        return NextResponse.json(
          { error: 'Eso no se edita: lo anulo y lo recapturamos.' },
          { status: 422 }
        )
      }
      const juicio = puedeEditarDescripcion(actor, {
        id_ticket: movimiento.id_ticket,
        status: 'ACTIVO'
      })
      if (!juicio.ok) {
        return NextResponse.json({ error: `No puedo: ${juicio.motivo}.` }, { status: 403 })
      }
      const texto = normalizarDescripcionNueva(cuerpo.descripcion_nueva)
      if (!texto.ok) {
        return NextResponse.json({ error: texto.error }, { status: 422 })
      }
      payload = { ...payload, descripcion_nueva: texto.texto }
      avisos = [...texto.avisos]
      const { data: actualRaw } = await supabase
        .from('finanzas_ledger')
        .select('descripcion')
        .eq('id', movimiento.id)
        .maybeSingle()
      mensaje = mensajeDeEdicion(movimiento, actualRaw?.descripcion ?? null, texto.texto, avisos)
    } else {
      // ── RECAPTURAR (D6): anular y volver a escribir, en UN "va" ────────
      // FASE 10 (D102): recapturar ESCRIBE un gasto, asi que pide el permiso
      // del gasto (la tabla de la Fase 9): un DST o un LOC no registran gastos,
      // tampoco por la puerta de "corregir".
      if (permisoDeAccion(actorDe(identidad), 'gasto') === 'no') {
        return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.gasto }, { status: 403 })
      }
      if (tabla !== 'finanzas') {
        return NextResponse.json(
          { error: 'Por ahora solo se recaptura un movimiento de dinero.' },
          { status: 422 }
        )
      }
      if (movimiento.id_ticket) {
        // Una venta no se "recaptura" como gasto: se anula y se vuelve a
        // vender. Escribir un GASTO_OPERATIVO en lugar de una venta anulada
        // descuadraria la cartera, el inventario y el ticket a la vez.
        return NextResponse.json(
          {
            error:
              'Esa fila es de una venta. La anulo entera y la vuelves a capturar como venta, ' +
              'pero no la puedo reescribir como gasto.'
          },
          { status: 422 }
        )
      }
      const catalogo = await leerCatalogo(supabase)
      const normal = normalizarPropuesta(
        (cuerpo.recaptura ?? {}) as Record<string, unknown>,
        { idCuenta: identidad.idCuenta, etiqueta: identidad.etiqueta },
        new Date(),
        catalogo
      )
      if (!normal.ok) {
        return NextResponse.json({ error: normal.error }, { status: 422 })
      }
      const nueva: PayloadGasto = normal.payload
      payload = { ...payload, recaptura: nueva }
      avisos = [...normal.avisos]
      mensaje = mensajeDeRecaptura(movimiento, nueva, alcance)
      if (avisos.length) mensaje += '\n\n' + avisos.join('\n')
    }

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // `bot_borradores_uno_pendiente` es un UNIQUE parcial sobre `telegram_id`
    // con `estado = 'PENDIENTE'`: proponer algo nuevo TIENE que cancelar lo
    // anterior, o el insert revienta con 23505. Mismo criterio que los cinco
    // `proponer` de las fases 3 y 4, y por la misma razon: con dos borradores
    // abiertos un "va" es ambiguo.    // Fase 8 (D79): con `conservar_pendientes` la propuesta se SUMA a las que
    // esperan su boton (varios hechos en un mensaje). Sin el, lo de siempre.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarAnulacion(payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        estado: 'PENDIENTE',
        payload: {
          // El discriminador. Se comprueba ANTES del sello en el `confirmar`:
          // un borrador de otra familia nunca empata el hash, y sin esta linea
          // seria CANCELADO por sello roto — un dano real por un enrutamiento
          // equivocado.
          tipo: 'anulacion',
          fila: payload,
          meta: {
            id_entidad: identidad.idEntidad,
            detalle: movimiento.detalle,
            alcance,
            avisos
          }
        } as unknown as never
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no pude guardar el borrador de anulacion:', error)
      return NextResponse.json({ error: 'No pude prepararlo. No toque nada.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje,
      modo,
      arrastra_venta: Boolean(movimiento.id_ticket),
      // Lo que la fila dice hoy, para que el bot pueda cambiar UN campo sin
      // volver a llamar al modelo. Memoria del proceso, no autoridad.
      valores: movimiento.valores,
      detalle: movimiento.detalle
    })
  } catch (e) {
    console.error('[bot] anular/proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
