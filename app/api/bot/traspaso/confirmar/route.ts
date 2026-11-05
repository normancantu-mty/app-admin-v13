/**
 * 2026-11-05 — Se escribe el TRASPASO exacto que se enseno.
 *
 * Entra `{telegram_id, borrador_id, sello}`: ni un monto ni un uuid. Las dos filas
 * salen del borrador sellado y van en UN insert: un statement de PostgREST es una
 * transaccion, asi que entran las dos o ninguna, sin migracion.
 *
 * El doble clic y el reintento los frena la llave primaria: los ids nacieron al
 * proponer (`lib/bot-traspaso.ts`). Un segundo insert da 23505, no escribe nada, y
 * se contesta como lo que es: ya estaba.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, marcarConfirmado } from '@/lib/bot-aprobacion'
import {
  filasDeTraspaso,
  leerCuentasDeTraspaso,
  leerSaldo,
  mensajeFinalDeTraspaso,
  puedeTraspasar,
  selloTraspasoCoincide,
  MENSAJE_SOLO_NORMAN,
  type PayloadTraspaso
} from '@/lib/bot-traspaso'

export const dynamic = 'force-dynamic'

const MENSAJE_YA_ESTABA = 'Ese traspaso ya estaba escrito. No lo aplique dos veces.'

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
    if (!puedeTraspasar(quien)) {
      return NextResponse.json({ error: MENSAJE_SOLO_NORMAN }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }

    const guardado = borrador.payload as unknown as PayloadTraspaso
    if (guardado?.tipo !== 'traspaso' || !guardado.fila || !guardado.meta) {
      return NextResponse.json({ error: 'Ese borrador no es un traspaso.' }, { status: 409 })
    }
    const { fila, meta } = guardado

    // El segundo clic, cuando el primero ya termino.
    if (borrador.estado === 'CONFIRMADO' && Number(borrador.telegram_id) === telegramId) {
      return NextResponse.json({ ok: true, ya_estaba: true, filas_escritas: 0, mensaje: MENSAJE_YA_ESTABA })
    }

    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // Sin espera ni aprobacion ajena: un traspaso solo lo escribe quien lo dicto.
    if (puerta.modo !== 'directo') {
      return NextResponse.json({ error: MENSAJE_SOLO_NORMAN }, { status: 403 })
    }

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!selloTraspasoCoincide(fila, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para el traspaso', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloTraspasoCoincide(fila, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }

    // ── Lo que el sello no puede garantizar, RELEIDO ─────────────────────────
    const cuentas = await leerCuentasDeTraspaso(supabase, quien)
    const origen = cuentas?.find((c) => c.id === fila.id_cuenta_origen)
    const destino = cuentas?.find((c) => c.id === fila.id_cuenta_destino)
    if (
      !origen ||
      !destino ||
      origen.id === destino.id ||
      destino.solo_egresos ||
      fila.usuario_creador !== `telegram:${quien.etiqueta}`
    ) {
      return NextResponse.json(
        { error: 'Las cuentas o tu alta cambiaron desde la propuesta. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── UN INSERT, DOS FILAS ────────────────────────────────────────────────
    const { data: creadas, error } = await supabase
      .from('finanzas_ledger')
      .insert(filasDeTraspaso(fila))
      .select('id')
    if (error?.code === '23505') {
      // Ya estan las dos: un doble clic simultaneo, o un reintento tras perder la
      // marca del borrador. No se escribio nada.
      await marcarConfirmado(supabase, borradorId, fila.id_egreso)
      return NextResponse.json({ ok: true, ya_estaba: true, filas_escritas: 0, mensaje: MENSAJE_YA_ESTABA })
    }
    if (error || creadas?.length !== 2) {
      console.error('[bot] no se pudo escribir el traspaso:', error, creadas?.length)
      return NextResponse.json({ error: 'No pude escribirlo. No quedo nada a medias.' }, { status: 500 })
    }

    const avisoMarca = await marcarConfirmado(supabase, borradorId, fila.id_egreso)
    const [saldoOrigen, saldoDestino] = await Promise.all([
      leerSaldo(supabase, fila.id_cuenta_origen),
      leerSaldo(supabase, fila.id_cuenta_destino)
    ])
    const saldos =
      saldoOrigen === null || saldoDestino === null ? null : { origen: saldoOrigen, destino: saldoDestino }

    return NextResponse.json({
      ok: true,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      ids: creadas.map((c) => c.id),
      filas_escritas: 2,
      mensaje: mensajeFinalDeTraspaso(fila, meta, saldos)
    })
  } catch (e) {
    console.error('[bot] confirmar traspaso reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
