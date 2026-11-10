/**
 * FASE 9 (D95) — ESCRIBIR EL ALTA DE UN MIEMBRO QUE NORMAN VIO. Solo Norman.
 *
 * Mismo patron que toda `confirmar`: se relee el borrador, discriminador, los
 * dos sellos, y un solo INSERT en `bot_identidades`. El `unique` de
 * `telegram_id` y de `etiqueta` es la ultima defensa si entre la propuesta y
 * el VA alguien registro a la misma persona.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  permisoDeAccion,
  puedeRegistrarEnLaMatriz,
  MENSAJE_MATRIZ_SOLO_NORMAN,
  MENSAJE_NO_PERMITIDO
} from '@/lib/bot-permisos'
import { abrirPuerta, actorDe } from '@/lib/bot-aprobacion'
import { selloMiembroCoincide, type PayloadAltaMiembro } from '@/lib/bot-miembro'

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
    if (permisoDeAccion(actorDe(quien), 'registrar') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO.registrar }, { status: 403 })
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
    // 2026-11-10: `puerta.modo` no se mira a proposito. Para Cristian (con
    // marca) sale `esperar`, pero Norman decidio que sus altas queden directas;
    // el freno es que no registra a la Matriz y que toda alta nace con marca.

    const guardado = borrador.payload as unknown as {
      tipo?: string
      alta?: PayloadAltaMiembro
      meta?: { nombre?: string; entidad?: string }
    }
    if (guardado?.tipo !== 'alta_miembro') {
      return NextResponse.json({ error: 'Ese borrador no es un alta de miembro.' }, { status: 409 })
    }
    const alta = guardado.alta
    if (!alta || !selloMiembroCoincide(alta, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No registro nada.' },
        { status: 409 }
      )
    }
    if (!selloMiembroCoincide(alta, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene.' }, { status: 409 })
    }
    if (alta.creado_por !== `telegram:${puerta.autor.etiqueta}`) {
      return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto.' }, { status: 409 })
    }
    // 2026-11-10: la misma regla que en `proponer`, releida aqui por si la
    // entidad paso a ADMIN entre la propuesta y el VA.
    if (!puedeRegistrarEnLaMatriz(actorDe(quien))) {
      const { data: destino } = await supabase.from('entidades').select('rol').eq('id', alta.id_entidad).maybeSingle()
      if (!destino || destino.rol === 'ADMIN') {
        return NextResponse.json({ error: MENSAJE_MATRIZ_SOLO_NORMAN }, { status: 403 })
      }
    }

    const { data: creada, error } = await supabase
      .from('bot_identidades')
      .insert({
        telegram_id: alta.telegram_id,
        etiqueta: alta.etiqueta,
        id_entidad: alta.id_entidad,
        id_cuenta_destino: alta.id_cuenta_destino,
        requiere_aprobacion: alta.requiere_aprobacion,
        creado_por: alta.creado_por,
        activo: true
      })
      .select('id')
      .single()
    if (error || !creada) {
      const choque = (error as { code?: string } | null)?.code === '23505'
      return NextResponse.json(
        { error: choque ? 'Esa persona o ese nombre ya estan registrados.' : 'No pude registrarlo.' },
        { status: choque ? 409 : 500 }
      )
    }

    await supabase
      .from('bot_borradores')
      .update({ estado: 'CONFIRMADO', id_registro: creada.id, resuelto_en: new Date().toISOString() })
      .eq('id', borradorId)

    return NextResponse.json({
      ok: true,
      miembro_telegram_id: alta.telegram_id,
      chat_id: borrador.chat_id ?? telegramId,
      mensaje: `Listo: ${guardado.meta?.nombre ?? alta.etiqueta} queda registrado como ${guardado.meta?.entidad ?? 'su entidad'}.`
    })
  } catch (e) {
    console.error('[bot] confirmar alta de miembro reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
