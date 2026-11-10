/**
 * MERMA DESDE EL BOT — CONFIRMAR (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 3). Entra `{telegram_id, borrador_id, sello}` y nada mas: la merma se
 * relee de `bot_borradores` y se compara contra los dos sellos, igual que la
 * entrada de insumo (`app/api/bot/inventario/confirmar`).
 *
 * La escritura es `escribirSalidaCascada` (`lib/salida-cascada.ts`): la MISMA
 * funcion que llama "Reportar merma" de la web. El stock se vuelve a leer al
 * escribir: si entre la propuesta y el VA ya no alcanza, no se escribe nada.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera, reclamarAprobacion, liberarReclamo, marcarConfirmado, actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion } from '@/lib/bot-permisos'
import { escribirSalidaCascada } from '@/lib/salida-cascada'
import { MENSAJE_MERMA_NO_PERMITIDA, PERMISO_MERMA, piezasTexto, selloMermaCoincide, type PayloadMerma } from '@/lib/bot-merma'

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
    if (!quien) return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    if (permisoDeAccion(actorDe(quien), PERMISO_MERMA) === 'no') {
      return NextResponse.json({ error: MENSAJE_MERMA_NO_PERMITIDA }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // De aqui en adelante, la identidad es la del AUTOR del borrador (D98).
    const identidad = puerta.autor
    const guardado = borrador.payload as unknown as { tipo?: string; merma?: PayloadMerma; meta?: { producto?: string } }
    if (guardado?.tipo !== 'merma') {
      return NextResponse.json({ error: 'Ese borrador no es una merma.' }, { status: 409 })
    }
    const merma = guardado.merma
    if (!merma || !selloMermaCoincide(merma, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la merma', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloMermaCoincide(merma, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }
    if (merma.id_entidad !== identidad.idEntidad || merma.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' }, { status: 409 })
    }

    if (puerta.modo === 'esperar') return pasarAEspera(supabase, borradorId, identidad, 'una merma')
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    // ── LA ESCRITURA: la MISMA funcion que "Reportar merma" de la web ────────
    const resultado = await escribirSalidaCascada(supabase, {
      id_entidad: merma.id_entidad,
      id_producto: merma.id_producto,
      cantidad_a_deducir: merma.cantidad,
      tipo_movimiento: 'MERMA',
      usuario_creador: merma.usuario_creador,
      notas: merma.notas,
      devolverIds: true
    })
    if (!resultado.success) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      console.error('[bot] no se pudo escribir la merma', borradorId, resultado.error)
      return NextResponse.json({ error: `No la escribi: ${resultado.error}` }, { status: 409 })
    }

    const avisoMarca = await marcarConfirmado(supabase, borradorId, resultado.ids[0])
    return NextResponse.json({
      ok: true,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      filas_inventario: resultado.ids.length,
      mensaje: `Salieron ${piezasTexto(merma.cantidad)} de ${guardado.meta?.producto ?? 'ese producto'} como merma.`
    })
  } catch (e) {
    console.error('[bot] confirmar merma reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
