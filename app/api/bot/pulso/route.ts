/**
 * `/pulso` del bot — que reponer (semanas de producto terminado en la matriz) y
 * a quien llamar (dias sin surtir de cada local y distribuidor). Escrito el
 * 2026-11-08 por un ejecutor del Socio. **No escribe.**
 *
 * Sale de `leerPulso`, la MISMA funcion que pinta la tarjeta "Pulso" del panel:
 * el bot no calcula, solo recibe el texto ya formateado (`textoPulso`). Misma
 * forma y mismo permiso que `/botellas` (`app/api/bot/botellas/route.ts`): el de
 * `ventas` de la tabla de la Fase 9 (`lib/bot-permisos.ts`) — cifra de la
 * empresa, solo la matriz; en grupo va por privado.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { actorDe } from '@/lib/bot-aprobacion'
import { esGrupo, permisoDeConsulta } from '@/lib/bot-permisos'
import { pieDeConsulta } from '@/lib/bot-consultas'
import { textoPulso } from '@/lib/pulso'
import { leerPulso } from '@/lib/pulso-leer'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }
  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; chat_id?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }
    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }
    const permiso = permisoDeConsulta(actorDe(identidad), 'ventas')
    if (!permiso.ok) {
      return NextResponse.json(
        { error: 'Esa consulta es de la empresa; tu alta solo alcanza a lo tuyo.' },
        { status: 403 }
      )
    }
    const datos = await leerPulso(supabase)
    return NextResponse.json({
      ok: true,
      texto: textoPulso(datos) + pieDeConsulta('transacciones_tickets + v_stock_por_cubeta + inventario_ledger'),
      privado: permiso.privado && esGrupo(cuerpo.chat_id, telegramId)
    })
  } catch (e) {
    console.error('[bot] pulso reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
