/**
 * 2026-11-05 — PROPONER un traspaso entre cuentas propias.
 *
 * Entra `{telegram_id, chat_id?, conservar_pendientes?, propuesta: {monto,
 * origen_id, destino_id, concepto?, fecha?}}`. No escribe en el ledger: valida
 * contra la lista cerrada de cuentas del alta, lee los dos saldos de
 * `saldo_cuenta`, sella y ensena. Un origen que queda en negativo se AVISA y no
 * se bloquea: lo decide Norman con su VA.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { chatDelBorrador } from '@/lib/bot-permisos'
import { clienteDeServicio, conservaPendientes, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  leerCuentasDeTraspaso,
  leerSaldo,
  mensajeDeTraspaso,
  normalizarTraspaso,
  puedeTraspasar,
  sellarTraspaso,
  MENSAJE_SIN_SALDO,
  MENSAJE_SOLO_NORMAN,
  type PayloadTraspaso,
  type PropuestaTraspaso
} from '@/lib/bot-traspaso'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      conservar_pendientes?: unknown
      propuesta?: PropuestaTraspaso
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
    if (!puedeTraspasar(identidad)) {
      return NextResponse.json({ error: MENSAJE_SOLO_NORMAN }, { status: 403 })
    }

    const cuentas = await leerCuentasDeTraspaso(supabase, identidad)
    if (!cuentas) {
      return NextResponse.json({ error: 'No pude leer tus cuentas.' }, { status: 500 })
    }

    const normal = normalizarTraspaso(cuerpo.propuesta ?? {}, cuentas, identidad.etiqueta)
    if (!normal.ok) {
      return NextResponse.json({ error: normal.error }, { status: 422 })
    }
    const { fila, meta, avisos } = normal

    const [saldoOrigen, saldoDestino] = await Promise.all([
      leerSaldo(supabase, fila.id_cuenta_origen),
      leerSaldo(supabase, fila.id_cuenta_destino)
    ])
    if (saldoOrigen === null || saldoDestino === null) {
      return NextResponse.json({ error: MENSAJE_SIN_SALDO }, { status: 500 })
    }

    // Mismo criterio que los otros `proponer`: un solo PENDIENTE por persona
    // (UNIQUE parcial), salvo los varios hechos de un mismo mensaje.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const payload: PayloadTraspaso = { tipo: 'traspaso', fila, meta }
    const sello = sellarTraspaso(fila)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: payload as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no pude guardar el borrador de traspaso:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeTraspaso(fila, meta, { origen: saldoOrigen, destino: saldoDestino }, avisos)
    })
  } catch (e) {
    console.error('[bot] proponer traspaso reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
