/**
 * MERMA DESDE EL BOT — PROPONER (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 3). Entra `{telegram_id, chat_id?, texto}`. No escribe inventario: lee el
 * catalogo y el stock, y guarda un borrador sellado. La escritura es
 * `/api/bot/merma/confirmar` con VA, y usa `escribirSalidaCascada`, la misma que
 * el boton "Reportar merma" de la web.
 *
 * Contesta, sin escribir nada:
 *  - `no_es_merma: true` si el texto no habla de merma o no nombra un producto:
 *    el bot sigue su camino normal con ese mensaje.
 *  - `pregunta` si falta UNA cosa (que producto, cuantas) o no alcanza el stock.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { leerStockParaCascada } from '@/lib/salida-cascada'
import {
  MENSAJE_MERMA_NO_PERMITIDA,
  PERMISO_MERMA,
  hablaDeMerma,
  leerMerma,
  mensajeDeMerma,
  payloadDeMerma,
  piezasTexto,
  planDeCascada,
  preguntaDeMerma,
  sellarMerma
} from '@/lib/bot-merma'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; chat_id?: unknown; texto?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    const texto = String(cuerpo.texto ?? '').slice(0, 500)
    if (!hablaDeMerma(texto)) return NextResponse.json({ ok: false, no_es_merma: true })

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }

    const { data: catalogo, error: errorCatalogo } = await supabase
      .from('catalogo_productos')
      .select('id, nombre')
      .eq('tipo', 'TERMINADO')
      .order('nombre')
    if (errorCatalogo) {
      return NextResponse.json({ error: 'No pude leer el catalogo.' }, { status: 500 })
    }
    const productos = (catalogo ?? []).map((p) => ({ id: p.id, nombre: String(p.nombre ?? '') }))
    const lectura = leerMerma(texto, productos)
    if (!lectura.ok && lectura.falta === 'producto' && lectura.opciones.length === 0) {
      // "se rompio la llanta": habla de romper, pero no de un producto. No es merma.
      return NextResponse.json({ ok: false, no_es_merma: true })
    }

    // El permiso, despues de saber que SI es merma: a quien no le toca se le dice.
    if (permisoDeAccion(actorDe(identidad), PERMISO_MERMA) === 'no') {
      return NextResponse.json({ error: MENSAJE_MERMA_NO_PERMITIDA }, { status: 403 })
    }
    if (!lectura.ok) return NextResponse.json({ ok: false, pregunta: preguntaDeMerma(lectura) })

    const stock = await leerStockParaCascada(supabase, identidad.idEntidad, lectura.producto.id)
    if (!planDeCascada(lectura.cantidad, stock.pagado, stock.consignado).alcanza) {
      return NextResponse.json({
        ok: false,
        pregunta:
          `En ${identidad.nombreEntidad} el libro solo tiene ${piezasTexto(stock.pagado + stock.consignado)} de ` +
          `${lectura.producto.nombre}; no puedo sacar ${piezasTexto(lectura.cantidad)}. No escribi nada.`
      })
    }

    const payload = payloadDeMerma(lectura, identidad.idEntidad, `telegram:${identidad.etiqueta}`, texto)

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarMerma(payload)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: {
          tipo: 'merma',
          merma: payload,
          meta: { producto: lectura.producto.nombre, entidad: identidad.nombreEntidad, stock }
        } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de merma:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeMerma(payload, lectura.producto.nombre, identidad.nombreEntidad, stock)
    })
  } catch (e) {
    console.error('[bot] proponer merma reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
