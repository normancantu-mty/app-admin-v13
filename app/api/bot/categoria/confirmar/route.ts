/**
 * 2026-11-03 — ESCRIBIR la categoria/subcategoria que se enseno. Escrito por el
 * ejecutor del Socio (bot ERP equipo).
 *
 * Mismo patron que toda `confirmar`: se relee el borrador, la puerta
 * (`abrirPuerta`: directo para Norman; `esperar` para el equipo -> pasa a
 * ESPERA_APROBACION y NO escribe; `aprobar` solo para Norman), los dos sellos, y
 * un solo INSERT en `categorias_movimiento`. El UNIQUE(tipo, categoria,
 * subcategoria) es la ultima defensa si alguien la agrego entre medio.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import {
  abrirPuerta,
  actorDe,
  liberarReclamo,
  marcarConfirmado,
  pasarAEspera,
  reclamarAprobacion
} from '@/lib/bot-aprobacion'
import { selloCategoriaCoincide, type PayloadAltaCategoria } from '@/lib/categorias-movimiento'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; borrador_id?: unknown; sello?: unknown }
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
    if (permisoDeAccion(actorDe(quien), 'categoria') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.categoria }, { status: 403 })
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

    const guardado = borrador.payload as unknown as { tipo?: string; alta?: PayloadAltaCategoria; meta?: { categoria_nueva?: boolean } }
    if (guardado?.tipo !== 'alta_categoria') {
      return NextResponse.json({ error: 'Ese borrador no es un alta de categoria.' }, { status: 409 })
    }
    const alta = guardado.alta
    if (!alta || !selloCategoriaCoincide(alta, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      return NextResponse.json({ error: 'La propuesta cambio desde que te la ensene. No agrego nada.' }, { status: 409 })
    }
    if (!selloCategoriaCoincide(alta, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene.' }, { status: 409 })
    }
    if (alta.creado_por !== `telegram:${puerta.autor.etiqueta}`) {
      return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto.' }, { status: 409 })
    }

    // El VA de quien requiere aprobacion NO escribe: espera el Aprobar de Norman.
    if (puerta.modo === 'esperar') {
      return pasarAEspera(
        supabase,
        borradorId,
        puerta.autor,
        `agregar la categoria ${alta.categoria} / ${alta.subcategoria}`
      )
    }
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    const { data: creada, error } = await supabase
      .from('categorias_movimiento')
      .insert({
        tipo: alta.tipo,
        categoria: alta.categoria,
        subcategoria: alta.subcategoria,
        orden: alta.orden,
        activa: true
      })
      .select('id')
      .single()
    if (error || !creada) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      const choque = (error as { code?: string } | null)?.code === '23505'
      return NextResponse.json(
        { error: choque ? 'Esa categoria/subcategoria ya existe. No agregue nada.' : 'No pude agregarla.' },
        { status: choque ? 409 : 500 }
      )
    }
    const aviso = await marcarConfirmado(supabase, borradorId, null)
    return NextResponse.json({
      ok: true,
      chat_id: borrador.chat_id ?? telegramId,
      mensaje: `Listo. Quedo agregada: ${alta.categoria} / ${alta.subcategoria}.`,
      ...(aviso ? { aviso_marca: aviso } : {})
    })
  } catch (e) {
    console.error('[bot] confirmar categoria reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
