/**
 * FASE 9 (D98) — LO QUE ESPERA EL APROBAR DE NORMAN. **No escribe. Nunca.**
 *
 * El boton Aprobar que le llega a Norman por privado lleva solo el id del
 * borrador (`apr:<id>`, 40 bytes: `callback_data` aguanta 64). Con esta lectura
 * el bot sabe a que `confirmar` mandarlo y con que sello, **aunque el proceso se
 * haya reiniciado** entre la propuesta de Kevin y el Aprobar de Norman.
 *
 * Solo contesta a quien puede aprobar ese borrador (`puedeAprobar`, Fase 10:
 * Norman o Kevin, nunca el autor; lo de Kevin solo Norman), y solo sobre
 * un borrador en `ESPERA_APROBACION` o un abono `CONFIRMADO` con ids pendientes
 * (D97). El sello no es un secreto nuevo: es el que `proponer` ya le dio al bot.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { esAprobador, puedeAprobar } from '@/lib/bot-permisos'
import { actorDe, nombreDeEtiqueta } from '@/lib/bot-aprobacion'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as { telegram_id?: unknown; borrador_id?: unknown }
    const telegramId = Number(cuerpo.telegram_id)
    const borradorId = String(cuerpo.borrador_id ?? '')
    if (!Number.isSafeInteger(telegramId) || borradorId === '') {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien || !esAprobador(actorDe(quien))) {
      return NextResponse.json({ error: 'Aprobar lo hacen Norman y Kevin.' }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }

    const payload = borrador.payload as unknown as {
      tipo?: string
      meta?: { ids_pendientes?: string[] }
    }
    const idsPendientes = payload?.meta?.ids_pendientes ?? []
    const esAbonoPendiente =
      payload?.tipo === 'abono' && borrador.estado === 'CONFIRMADO' && idsPendientes.length > 0
    if (borrador.estado !== 'ESPERA_APROBACION' && !esAbonoPendiente) {
      return NextResponse.json(
        { error: `Eso ya no espera aprobacion: esta ${borrador.estado.toLowerCase()}.` },
        { status: 409 }
      )
    }

    const autor = await resolverIdentidad(supabase, Number(borrador.telegram_id))
    // FASE 10 (D106): nadie aprueba lo suyo, y lo de Kevin lo aprueba Norman.
    // Un autor que ya no esta dado de alta se trata como Kevin: lo mas cerrado.
    const permitido = puedeAprobar(
      { telegramId: quien.telegramId, rol: quien.rolEntidad, requiereAprobacion: quien.requiereAprobacion },
      {
        telegramId: Number(borrador.telegram_id),
        rol: autor?.rolEntidad ?? 'ADMIN',
        requiereAprobacion: autor?.requiereAprobacion ?? true
      }
    )
    if (!permitido) {
      return NextResponse.json(
        {
          error:
            Number(borrador.telegram_id) === quien.telegramId
              ? 'Nadie aprueba lo suyo: esto espera el Aprobar de otro.'
              : 'Lo que propone Kevin lo aprueba Norman.'
        },
        { status: 403 }
      )
    }
    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      tipo: payload?.tipo ?? null,
      sello: borrador.sello,
      estado: borrador.estado,
      abono_pendiente: esAbonoPendiente,
      chat_id: borrador.chat_id ?? Number(borrador.telegram_id),
      autor_telegram_id: Number(borrador.telegram_id),
      autor: autor ? nombreDeEtiqueta(autor.etiqueta) : '(ya sin alta)',
      aprobador: nombreDeEtiqueta(quien.etiqueta)
    })
  } catch (e) {
    console.error('[bot/aprobacion]', e)
    return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
  }
}
