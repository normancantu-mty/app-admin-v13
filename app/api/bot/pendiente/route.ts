/**
 * Fase 8 (D77) — PENDIENTE. **Este endpoint no escribe. Nunca.**
 *
 * Devuelve los borradores `PENDIENTE` de quien pregunta, de menos de 30
 * minutos, con su sello: lo que el bot necesita para que el boton VA de una
 * propuesta que sigue en pantalla funcione aunque el proceso se haya
 * reiniciado. El sello no es un secreto nuevo: es el mismo que `proponer` ya le
 * devolvio al bot, y sin el token del bot esta ruta contesta 401.
 *
 * Solo ve lo de su `telegram_id`: la consulta filtra por esa columna, y el
 * `telegram_id` sin alta en `bot_identidades` recibe 403 antes de leer nada.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { pendientesVigentes, VIDA_DEL_PENDIENTE_MS, type FilaBorrador } from '@/lib/bot-pendiente'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json(
        { error: 'No te tengo dado de alta. Pideselo a Norman.' },
        { status: 403 }
      )
    }

    const ahora = new Date()
    const desde = new Date(ahora.getTime() - VIDA_DEL_PENDIENTE_MS).toISOString()
    const { data, error } = await supabase
      .from('bot_borradores')
      .select('id, sello, payload, estado, creado_en')
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')
      .gte('creado_en', desde)
      .order('creado_en', { ascending: true })

    if (error) {
      console.error('[bot/pendiente] no pude leer los borradores:', error)
      return NextResponse.json({ error: 'No pude leer lo pendiente.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      pendientes: pendientesVigentes((data ?? []) as FilaBorrador[], ahora)
    })
  } catch (e) {
    console.error('[bot/pendiente]', e)
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }
}
