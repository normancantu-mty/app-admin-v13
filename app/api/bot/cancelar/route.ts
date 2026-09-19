/**
 * AG-06 FASE 5 — CANCELAR. La unica ruta que sirve para las cinco fases.
 *
 * ─── EL DEFECTO QUE CIERRA ──────────────────────────────────────────────────
 * Hasta hoy el boton "Cancelar" y el texto "no" solo hacian
 * `_memoria.pop(chat)`: borraban la memoria del PROCESO de Python y nada mas.
 * La fila de `bot_borradores` se quedaba en `PENDIENTE` **para siempre**, y con
 * ella el unico hueco que permite el indice `bot_borradores_uno_pendiente`. El
 * mensaje *"Cancelado. No escribi nada"* era cierto sobre el ledger y falso
 * sobre el rastro: si habia rastro, y era un rastro que no se cerraba nunca.
 *
 * ─── POR QUE NO LLEVA SELLO ─────────────────────────────────────────────────
 * El sello protege lo que se va a ESCRIBIR: garantiza que la fila del INSERT es
 * la que se enseno. Cancelar no escribe ninguna fila del negocio — apaga un
 * borrador —, asi que exigir el sello solo lograria que un borrador con el
 * sello roto fuera imposible de cancelar, que es exactamente al reves de lo que
 * se quiere. Lo que si se comprueba, y es lo que importa, es **de quien es el
 * borrador**: el mismo 403 que confirmar.
 *
 * ─── IDEMPOTENTE A PROPOSITO ────────────────────────────────────────────────
 * Cancelar dos veces no es un error: el segundo "no" de una persona que dudo
 * tiene que contestar lo mismo que el primero. Un borrador ya CANCELADO
 * devuelve `ok: true` con `ya_estaba: true`. Uno ya CONFIRMADO **no** se toca y
 * se dice claro: esa captura ya es una fila del ledger y el camino para
 * deshacerla es anular, no cancelar.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      borrador_id?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')

    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio()

    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, estado')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    // Mismo criterio que confirmar: el borrador es de quien lo creo. Sin esto,
    // cualquiera dado de alta podria apagarle la captura a otro con solo tener
    // el id — un dano pequeno, pero gratuito.
    if (borrador.telegram_id !== telegramId) {
      return NextResponse.json({ error: 'Ese borrador no es tuyo.' }, { status: 403 })
    }
    if (borrador.estado === 'CONFIRMADO') {
      return NextResponse.json(
        { error: 'Eso ya quedo escrito. Para deshacerlo hay que anularlo, no cancelarlo.' },
        { status: 409 }
      )
    }
    if (borrador.estado === 'CANCELADO') {
      return NextResponse.json({ ok: true, ya_estaba: true })
    }

    const { error } = await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('id', borradorId)
      // La condicion de carrera real: dos "no" seguidos, o un "no" mientras el
      // proponer de otra captura ya lo estaba cancelando. Acotar el UPDATE al
      // estado que se leyo evita pisar un CONFIRMADO que entro en medio.
      .eq('estado', 'PENDIENTE')

    if (error) {
      console.error('[bot] no pude cancelar el borrador', borradorId, error)
      return NextResponse.json({ error: 'No pude cancelarlo.' }, { status: 500 })
    }

    return NextResponse.json({ ok: true, ya_estaba: false })
  } catch (e) {
    console.error('[bot] cancelar reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
