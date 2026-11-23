/**
 * REGALO DESDE EL BOT — PROPONER. Escrito el 2026-11-20 por un ejecutor del Socio.
 *
 * Entra `{telegram_id, chat_id?, texto}`. No escribe inventario: lee catalogo y
 * existencia de la matriz y guarda un borrador sellado. La escritura es
 * `/api/bot/regalo/confirmar` con VA, y usa `registrarRegalo`, la misma que el
 * formulario de `/panel/regalos`.
 *
 * Contesta, sin escribir nada:
 *  - `no_es_regalo: true` si el texto no habla de regalar (o "regalo" es
 *    sustantivo: "iba de regalo") o no dice piezas: el
 *    bot sigue su camino normal con ese mensaje.
 *  - `pregunta` si falta UNA cosa (quien, motivo, una presentacion que no existe).
 *  - `consulta: true` + `texto` si lo que pide es el contador ("regalos", "cuantos
 *    regalos lleva Kevin"): botellas y razones, nunca dinero.
 * `completa: {falta, dicho}` es la respuesta a esa pregunta: se junta con `texto`.
 * Nunca pide costo ni precio. Si no alcanza la existencia NO pregunta: la propuesta lo avisa y se guarda igual.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { completarRegalo, fechaMenosDias, hablaDeRegalo, leerConsultaRegalos, leerRegalo, nombraBotella, textoContador } from '@/lib/regalos'
import { hoyMx, idMatriz, leerCartera, leerProductosRegalo, stocksDe } from '@/lib/regalos-servidor'
import {
  MENSAJE_REGALO_NO_PERMITIDO,
  PERMISO_REGALO,
  mensajeDeRegalo,
  preguntaDeRegalo,
  sellarRegalo,
  type PayloadRegalo
} from '@/lib/bot-regalo'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; chat_id?: unknown; texto?: unknown; completa?: { falta?: unknown; dicho?: unknown } }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    let texto = String(cuerpo.texto ?? '').slice(0, 500)
    if (cuerpo.completa) texto = completarRegalo(texto, String(cuerpo.completa.falta ?? ''), String(cuerpo.completa.dicho ?? '').slice(0, 300))
    if (!hablaDeRegalo(texto)) return NextResponse.json({ ok: false, no_es_regalo: true })

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }

    if (!cuerpo.completa && leerConsultaRegalos(texto, identidad.etiqueta, []) !== null) {
      if (permisoDeAccion(actorDe(identidad), PERMISO_REGALO) === 'no') {
        return NextResponse.json({ error: MENSAJE_REGALO_NO_PERMITIDO }, { status: 403 })
      }
      const cartera = await leerCartera(supabase)
      const pide = leerConsultaRegalos(texto, identidad.etiqueta, cartera.porPersona.map((g) => g.clave))
      return NextResponse.json({ ok: true, consulta: true, texto: textoContador(cartera, pide?.quien ?? '') })
    }

    const productos = await leerProductosRegalo(supabase)
    const lectura = leerRegalo(texto, productos, identidad.etiqueta)
    // "me regalaron un dia libre": habla de regalar, pero no de piezas. No es un regalo de botellas.
    // "regale una botella en la expo" SI es de botellas: se pregunta cual (antes caia a gasto y pedia el costo).
    if (!lectura.ok && (lectura.falta === 'no_es_regalo' || (lectura.falta === 'piezas' && !nombraBotella(texto)))) return NextResponse.json({ ok: false, no_es_regalo: true })

    // El permiso, despues de saber que SI es un regalo: a quien no le toca se le dice.
    if (permisoDeAccion(actorDe(identidad), PERMISO_REGALO) === 'no') {
      return NextResponse.json({ error: MENSAJE_REGALO_NO_PERMITIDO }, { status: 403 })
    }
    if (!lectura.ok) {
      return NextResponse.json({ ok: false, falta: lectura.falta, texto, pregunta: preguntaDeRegalo(lectura, productos) })
    }

    const matriz = await idMatriz(supabase)
    const lineas = lectura.piezas.map((x) => ({ id_producto: x.producto.id, cantidad: x.cantidad }))
    const stocks = await stocksDe(supabase, matriz.id, lineas.map((l) => l.id_producto))
    const payload: PayloadRegalo = {
      id_entidad: matriz.id,
      // "ayer Kevin regalo..." -> ayer. Otra fecha: el formulario web.
      fecha: fechaMenosDias(hoyMx(), lectura.diasAtras),
      quien_regalo: lectura.quien,
      motivo: lectura.motivo,
      usuario_creador: `telegram:${identidad.etiqueta}`,
      lineas
    }

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarRegalo(payload)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: { tipo: 'regalo', regalo: payload, meta: { entidad: matriz.nombre } } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de regalo:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeRegalo(payload, productos, matriz.nombre, stocks)
    })
  } catch (e) {
    console.error('[bot] proponer regalo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
