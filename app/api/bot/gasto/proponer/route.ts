/**
 * AG-01 Fase 1 — PASO 2 y 3 de D-E30: se propone UNA fila y se sella.
 *
 * Entra lo que el LLM extrajo del lenguaje natural. Sale un borrador guardado
 * del lado del servidor, con su sello, y el texto que la persona va a leer.
 * **Aqui NO se escribe nada en `finanzas_ledger`.**
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  buscarDuplicado,
  mensajeDeConfirmacion,
  normalizarPropuesta,
  sellarPayload,
  VENTANA_DUPLICADO_HORAS,
  type MovimientoReciente
} from '@/lib/bot-gastos'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      propuesta?: Record<string, unknown>
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio()

    // Un telegram_id sin mapeo NO escribe nada y tampoco averigua si el bot
    // existe para otros. No hay auto-registro (Q-14).
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }

    const normalizada = normalizarPropuesta(
      cuerpo.propuesta ?? {},
      { idCuentaDestino: identidad.idCuentaDestino, etiqueta: identidad.etiqueta },
      new Date()
    )
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
    }

    // ── Duplicados: avisa, no bloquea ───────────────────────────────────────
    const desde = new Date(Date.now() - VENTANA_DUPLICADO_HORAS * 60 * 60 * 1000).toISOString()
    const { data: recientes } = await supabase
      .from('finanzas_ledger')
      .select('id, monto, categoria, descripcion, fecha_movimiento, usuario_creador')
      .eq('tipo_movimiento', 'GASTO_OPERATIVO')
      .eq('status', 'ACTIVO')
      .eq('id_cuenta_destino', identidad.idCuentaDestino)
      .gte('fecha_movimiento', desde)

    const duplicado = buscarDuplicado(
      { monto: normalizada.payload.monto, categoria: normalizada.payload.categoria },
      (recientes ?? []) as MovimientoReciente[],
      new Date()
    )

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // Proponer algo nuevo cancela lo anterior. Con dos abiertos, un "va" es
    // ambiguo, y preguntarle a la persona cual de los dos convierte la interfaz
    // en justo lo que Q-14 prohibe: identificadores que recordar.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarPayload(normalizada.payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        payload: {
          fila: normalizada.payload,
          meta: {
            id_entidad: identidad.idEntidad,
            descripcion_original: normalizada.descripcionOriginal,
            avisos: normalizada.avisos,
            duplicado_de: duplicado?.id ?? null
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje: mensajeDeConfirmacion(
        normalizada.payload,
        { nombreCuenta: identidad.nombreCuenta, nombreEntidad: identidad.nombreEntidad },
        normalizada.avisos,
        duplicado
      )
    })
  } catch (e) {
    console.error('[bot] proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
