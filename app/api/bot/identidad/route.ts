/**
 * FASE 9 (D94/D95) — QUIEN ES ESTA PERSONA. **No escribe. Nunca.**
 *
 * En un grupo el bot recibe mensajes de varias personas y tiene que saber, de
 * cada una, si esta dada de alta, como llamarla ("Propuesto por Kevin") y si su
 * VA espera aprobacion. Un `telegram_id` sin alta recibe `registrado: false` y
 * nada mas: ni la lista de entidades, ni quien mas esta dado de alta.
 *
 * Contesta 200 tambien al desconocido (con `registrado: false`) porque el bot
 * lo necesita para decir, una sola vez, "No te tengo registrado. Norman,
 * ¿quien es?". Lo unico que revela es que ese id no esta dado de alta — que es
 * justo lo que el bot va a decir en voz alta en el grupo.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { esAprobador } from '@/lib/bot-permisos'
import { actorDe, nombreDeEtiqueta } from '@/lib/bot-aprobacion'

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
    const identidad = await resolverIdentidad(clienteDeServicio(request), telegramId)
    if (!identidad) return NextResponse.json({ ok: true, registrado: false })
    return NextResponse.json({
      ok: true,
      registrado: true,
      etiqueta: identidad.etiqueta,
      nombre: nombreDeEtiqueta(identidad.etiqueta),
      rol: identidad.rolEntidad,
      entidad: identidad.nombreEntidad,
      requiere_aprobacion: identidad.requiereAprobacion,
      aprobador: esAprobador(actorDe(identidad))
    })
  } catch (e) {
    console.error('[bot/identidad]', e)
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }
}
