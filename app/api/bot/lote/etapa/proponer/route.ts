/**
 * Lote v2 — proponer una ETAPA de un lote que ya existe (aditivo 2, destilacion).
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * Mismo patron que el lote: aqui NO se escribe nada del lote. Sale un borrador
 * `lote_etapa` sellado; lo escribe `etapa/confirmar` (con la puerta de
 * aprobacion: lo del TRABAJADOR espera el Aprobar de Norman o Kevin).
 *
 * El aditivo 2 llega por SKU opaco (`ing-al` / `ing-az`, ERP-84), nunca por su
 * nombre real: cual es el 1 y cual el 2 lo dice el YAML del bot.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  leerInsumosDeLote,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { esEtapaConVa, mensajeDeEtapa, normalizarEtapa, sellarEtapa } from '@/lib/bot-lote-ciclo'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      codigo_lote?: unknown
      etapa?: unknown
      kg?: unknown
      insumo_sku?: unknown
      garrafas?: unknown
      notas?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    if (!esEtapaConVa(cuerpo.etapa)) {
      return NextResponse.json({ error: 'Etapa invalida.' }, { status: 400 })
    }
    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(identidad), 'lote') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['lote'] }, { status: 403 })
    }

    const codigo = String(cuerpo.codigo_lote ?? '').trim()
    if (codigo === '') return NextResponse.json({ error: 'De cual lote? Dame el codigo.' }, { status: 422 })
    const { data: lote } = await supabase
      .from('lotes')
      .select('id, codigo_lote, fecha_inicio')
      .ilike('codigo_lote', codigo)
      .maybeSingle()
    if (!lote) return NextResponse.json({ error: `No encontre el lote ${codigo}.` }, { status: 422 })

    const sinTipos = supabase as unknown as SupabaseClient
    const { data: ya } = await sinTipos
      .from('lote_etapas')
      .select('id')
      .eq('id_lote', lote.id)
      .eq('etapa', cuerpo.etapa)
      .maybeSingle()
    if (ya) {
      return NextResponse.json(
        { error: `La etapa ${cuerpo.etapa === 'aditivo_2' ? 'del aditivo 2' : 'de destilacion'} del lote ${lote.codigo_lote} ya esta registrada.` },
        { status: 409 }
      )
    }

    let idInsumoAditivo: string | null = null
    if (cuerpo.etapa === 'aditivo_2') {
      const sku = String(cuerpo.insumo_sku ?? '').trim().toLowerCase()
      const insumos = await leerInsumosDeLote(supabase)
      idInsumoAditivo = insumos.find((i) => (i.sku ?? '').toLowerCase() === sku)?.id ?? null
    }

    const r = normalizarEtapa(
      { etapa: cuerpo.etapa, kg: cuerpo.kg, garrafas: cuerpo.garrafas, notas: cuerpo.notas },
      {
        idLote: lote.id,
        codigoLote: lote.codigo_lote,
        fechaInicio: lote.fecha_inicio,
        telegramId,
        etiqueta: identidad.etiqueta,
        ahora: new Date(),
        idInsumoAditivo
      }
    )
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 422 })

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }
    const sello = sellarEtapa(r.payload)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: { tipo: 'lote_etapa', etapa: r.payload } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de etapa:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }
    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      codigo_lote: lote.codigo_lote,
      mensaje: mensajeDeEtapa(r.payload)
    })
  } catch (e) {
    console.error('[bot] proponer etapa reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
