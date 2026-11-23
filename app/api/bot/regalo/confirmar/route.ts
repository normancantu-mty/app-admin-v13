/**
 * REGALO DESDE EL BOT — CONFIRMAR. Escrito el 2026-11-20 por un ejecutor del Socio.
 *
 * Entra `{telegram_id, borrador_id, sello}` y nada mas: el regalo se relee de
 * `bot_borradores` y se compara contra los dos sellos (el guardado y el que
 * trae el bot), igual que la merma. Pasa por la puerta de aprobacion
 * (`abrirPuerta`): si quien dicta requiere aprobacion, queda en espera.
 *
 * La escritura es `registrarRegalo` (`lib/regalos-servidor.ts`): la MISMA que
 * el formulario de `/panel/regalos`. La existencia se vuelve a leer al
 * escribir; si no alcanza, se escribe igual y se avisa.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera, reclamarAprobacion, liberarReclamo, marcarConfirmado, actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion } from '@/lib/bot-permisos'
import { botellasTexto, renglonDePersona } from '@/lib/regalos'
import { idMatriz, leerCartera, registrarRegalo } from '@/lib/regalos-servidor'
import { MENSAJE_REGALO_NO_PERMITIDO, PERMISO_REGALO, selloRegaloCoincide, type PayloadRegalo } from '@/lib/bot-regalo'

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
    if (permisoDeAccion(actorDe(quien), PERMISO_REGALO) === 'no') {
      return NextResponse.json({ error: MENSAJE_REGALO_NO_PERMITIDO }, { status: 403 })
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
    const guardado = borrador.payload as unknown as { tipo?: string; regalo?: PayloadRegalo }
    if (guardado?.tipo !== 'regalo') {
      return NextResponse.json({ error: 'Ese borrador no es un regalo.' }, { status: 409 })
    }
    const regalo = guardado.regalo
    if (!regalo || !selloRegaloCoincide(regalo, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el regalo', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloRegaloCoincide(regalo, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }
    if (regalo.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json({ error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' }, { status: 409 })
    }
    const matriz = await idMatriz(supabase)
    if (regalo.id_entidad !== matriz.id) {
      return NextResponse.json({ error: 'La matriz cambio desde que propusiste esto. Vuelve a dictarlo.' }, { status: 409 })
    }

    if (puerta.modo === 'esperar') return pasarAEspera(supabase, borradorId, identidad, 'un regalo')
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    // ── LA ESCRITURA: la MISMA que el formulario de /panel/regalos ───────────
    const resultado = await registrarRegalo(
      supabase,
      { fecha: regalo.fecha, quien_regalo: regalo.quien_regalo, motivo: regalo.motivo, lineas: regalo.lineas },
      regalo.id_entidad,
      regalo.usuario_creador
    )
    if (!resultado.ok) {
      await liberarReclamo(supabase, borradorId, puerta.modo)
      console.error('[bot] no se pudo escribir el regalo', borradorId, resultado.error)
      return NextResponse.json({ error: `No lo escribi: ${resultado.error}` }, { status: 409 })
    }

    const avisoMarca = await marcarConfirmado(supabase, borradorId, resultado.id)
    const total = regalo.lineas.reduce((a, l) => a + l.cantidad, 0)
    // El contador ya con este regalo. Si la lectura falla, el regalo YA quedo: solo no se ensena.
    let contador = ''
    try {
      contador = `\nVa: ${renglonDePersona(await leerCartera(supabase), regalo.quien_regalo)}.`
    } catch (e) {
      console.error('[bot] regalo escrito, pero no pude leer el contador:', e)
    }
    return NextResponse.json({
      ok: true,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      id_regalo: resultado.id,
      filas_inventario: resultado.filas,
      avisos: resultado.avisos,
      mensaje:
        `Listo: regalo de ${regalo.quien_regalo}, ${botellasTexto(total)} (${regalo.motivo}). Bajo el inventario.` +
        contador +
        (resultado.avisos.length ? `\nAVISO: ${resultado.avisos.join('\n')}` : '')
    })
  } catch (e) {
    console.error('[bot] confirmar regalo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
