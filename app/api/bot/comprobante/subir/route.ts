/**
 * 2026-11-03 -- GUARDA LA FOTO DE UN TICKET Y LA LIGA A SU MOVIMIENTO.
 *
 * Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).
 *
 * Solo la llama el bot, y solo DESPUES del clic de Norman: el movimiento tiene
 * que existir ya en `finanzas_ledger`. Esta ruta no escribe dinero: una foto
 * nunca crea un gasto.
 *
 * Es idempotente: la ruta en el bucket lleva el sha256 y la fila tiene
 * `unique (id_movimiento, sha256)`. Si la subida se corta entre el bucket y la
 * fila, el reintento del bot termina el trabajo sin duplicar nada.
 *
 * El modo ensayo sale antes de todo: su cliente no envuelve `storage`.
 */
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { esPeticionDeEnsayo } from '@/lib/bot-ensayo'
import {
  BUCKET_COMPROBANTES,
  filaDeComprobante,
  rutaDeComprobante,
  validarSubida
} from '@/lib/bot-comprobante'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  if (esPeticionDeEnsayo(request)) {
    return NextResponse.json({ ok: false, ensayo: true, error: 'En ensayo no se sube nada.' })
  }
  try {
    const validado = validarSubida(await request.json())
    if (!validado.ok) return NextResponse.json({ error: validado.error }, { status: 400 })
    const { subida } = validado

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, subida.telegramId)
    if (!identidad) return NextResponse.json({ error: 'No autorizado.' }, { status: 403 })

    const movimiento = await supabase
      .from('finanzas_ledger')
      .select('id')
      .eq('id', subida.idMovimiento)
      .maybeSingle()
    if (movimiento.error) {
      console.error('[bot/comprobante/subir] ledger', movimiento.error)
      return NextResponse.json({ error: 'No pude leer el movimiento.' }, { status: 502 })
    }
    if (!movimiento.data) {
      return NextResponse.json({ error: 'Ese movimiento no existe.' }, { status: 404 })
    }

    const ruta = rutaDeComprobante(subida.idMovimiento, subida.sha256)
    const subido = await supabase.storage
      .from(BUCKET_COMPROBANTES)
      .upload(ruta, subida.bytes, { contentType: 'image/jpeg', upsert: true })
    if (subido.error) {
      console.error('[bot/comprobante/subir] storage', subido.error)
      return NextResponse.json({ error: 'No pude guardar la foto.' }, { status: 502 })
    }

    // La tabla es nueva y `types/database.ts` es generado: se regenera aparte.
    const sinTipos = supabase as unknown as SupabaseClient
    const fila = await sinTipos
      .from('comprobantes_gasto')
      .upsert(filaDeComprobante(subida, ruta), {
        onConflict: 'id_movimiento,sha256',
        ignoreDuplicates: true
      })
    if (fila.error) {
      console.error('[bot/comprobante/subir] fila', fila.error)
      return NextResponse.json({ error: 'No pude ligar la foto.' }, { status: 502 })
    }
    return NextResponse.json({ ok: true, ruta })
  } catch (e) {
    console.error('[bot/comprobante/subir]', e)
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }
}
