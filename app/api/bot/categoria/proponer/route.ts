/**
 * 2026-11-03 — PROPONER una categoria/subcategoria nueva desde el bot.
 * Escrito por el ejecutor del Socio (bot ERP equipo).
 *
 * Entra `{telegram_id, chat_id?, tipo?, categoria, subcategoria}`. Se valida con
 * la MISMA regla que la pantalla (`lib/categorias-movimiento.ts`), se sella y se
 * guarda el borrador. No escribe en `categorias_movimiento`: eso lo hace
 * `confirmar`, con el VA de Norman (o, si lo propuso alguien del equipo, con el
 * Aprobar de Norman: `permisoDeAccion(..., 'categoria')`).
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import {
  mensajeDeAltaCategoria,
  sellarCategoria,
  validarAltaCategoria,
  type FilaCategoria,
  type PayloadAltaCategoria
} from '@/lib/categorias-movimiento'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      tipo?: unknown
      categoria?: unknown
      subcategoria?: unknown
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
    if (permisoDeAccion(actorDe(identidad), 'categoria') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.categoria }, { status: 403 })
    }

    const { data: filas, error: errLectura } = await supabase
      .from('categorias_movimiento')
      .select('tipo, categoria, subcategoria, orden')
    if (errLectura) {
      return NextResponse.json({ error: 'No pude leer la lista de categorias.' }, { status: 500 })
    }
    const juicio = validarAltaCategoria(cuerpo, (filas ?? []) as FilaCategoria[])
    if (!juicio.ok) {
      return NextResponse.json({ error: `No la propongo: ${juicio.motivo}.` }, { status: 422 })
    }

    const alta: PayloadAltaCategoria = {
      tipo: juicio.tipo,
      categoria: juicio.categoria,
      subcategoria: juicio.subcategoria,
      orden: juicio.orden,
      creado_por: `telegram:${identidad.etiqueta}`
    }
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }
    const sello = sellarCategoria(alta)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: { tipo: 'alta_categoria', alta, meta: { categoria_nueva: juicio.categoriaNueva } } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de categoria:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeAltaCategoria(juicio)
    })
  } catch (e) {
    console.error('[bot] proponer categoria reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
