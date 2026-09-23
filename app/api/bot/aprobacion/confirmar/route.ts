/**
 * FASE 9 (D97) — APROBAR O RECHAZAR EL ABONO DE UN DISTRIBUIDOR DESDE EL BOT.
 *
 * Un abono que un DST confirma por el bot entra como `ABONO_PENDIENTE` (igual
 * que en la app, `app/actions/abonos.ts:572-582`) y a Norman le llega por
 * privado con Aprobar / Rechazar. Esos botones llegan AQUI, y aqui se llama
 * **la misma funcion** que el PATCH de la pantalla de aprobaciones
 * (`lib/aprobacion-abonos.ts`, extraida de `app/api/finanzas/aprobaciones`).
 * Aprobado desde el bot o desde la pantalla da igual: el estado vive en la
 * fila, y el que llega segundo recibe "ya fue procesado".
 *
 * Termina en `/confirmar` a proposito: en ensayo, el bot NUNCA la llama.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { esAprobador } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { resolverAprobacionDeAbono } from '@/lib/aprobacion-abonos'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      borrador_id?: unknown
      accion?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    const accion = cuerpo.accion === 'aprobar' ? 'APPROVE' : cuerpo.accion === 'rechazar' ? 'REJECT' : null
    if (!Number.isSafeInteger(telegramId) || borradorId === '' || !accion) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien || !esAprobador(actorDe(quien))) {
      return NextResponse.json({ error: 'Aprobar abonos lo hace solo Norman.' }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    const payload = borrador?.payload as unknown as {
      tipo?: string
      meta?: { ids_pendientes?: string[]; nombre_deudor?: string }
    }
    const ids = payload?.meta?.ids_pendientes ?? []
    if (!borrador || payload?.tipo !== 'abono' || borrador.estado !== 'CONFIRMADO' || ids.length === 0) {
      return NextResponse.json({ error: 'Ese no es un abono pendiente de aprobar.' }, { status: 409 })
    }

    let hechos = 0
    const errores: string[] = []
    for (const id of ids) {
      const r = await resolverAprobacionDeAbono(supabase, id, accion)
      if (r.ok) hechos++
      else errores.push(r.error)
    }
    if (hechos === 0) {
      return NextResponse.json(
        { error: errores[0] ?? 'No pude procesarlo.', ya_procesado: true },
        { status: 409 }
      )
    }

    const verbo = accion === 'APPROVE' ? 'aprobado' : 'rechazado'
    return NextResponse.json({
      ok: true,
      accion: verbo,
      filas: hechos,
      avisos: errores,
      chat_id: borrador.chat_id ?? Number(borrador.telegram_id),
      autor_telegram_id: Number(borrador.telegram_id),
      mensaje:
        `Abono de ${payload?.meta?.nombre_deudor ?? 'la red'} ${verbo} por Norman` +
        (accion === 'APPROVE' ? ': ya cuenta en la cartera.' : ': no cuenta.')
    })
  } catch (e) {
    console.error('[bot/aprobacion/confirmar]', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
