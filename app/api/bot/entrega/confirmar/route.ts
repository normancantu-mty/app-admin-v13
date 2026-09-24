/**
 * FASE 11 (D112) — Se escribe la ENTREGA DE EFECTIVO exacta que se enseno.
 *
 * Entra `{telegram_id, borrador_id, sello}`: ni un monto ni un uuid. La fila
 * sale del borrador sellado, con los dos sellos comprobados, igual que el abono
 * (`app/api/bot/abono/confirmar/route.ts`).
 *
 * La diferencia con el abono, y es a proposito: el DST NO escribe filas
 * `ABONO_PENDIENTE`. Su VA deja el borrador en `ESPERA_APROBACION` (la puerta de
 * Kevin, D98) y la fila se escribe UNA vez, ya aprobada, con el Aprobar de Norman
 * o Kevin. Asi no hace falta un segundo camino de aprobacion para una fila que
 * solo existe para la cartera.
 */

import { NextResponse } from 'next/server'
import type { TablesInsert } from '@/types/database'
import { clienteDeServicio, leerCuentaDelDeudor, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  abrirPuerta,
  pasarAEspera,
  reclamarAprobacion,
  liberarReclamo,
  marcarConfirmado,
  actorDe,
  cuentaDeLaMatrizParaAbono
} from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { decidirEntrega, filaDeEntrega, selloEntregaCoincide, type PayloadEntrega } from '@/lib/bot-entrega'

export const dynamic = 'force-dynamic'

interface BorradorEntrega {
  tipo?: string
  entrega: PayloadEntrega
  meta: { nombre: string; rol: string; nombre_cuenta_origen: string; nombre_cuenta_destino: string }
}

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
    if (permisoDeAccion(actorDe(quien), 'entrega_efectivo') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrega_efectivo'] }, { status: 403 })
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado, chat_id')
      .eq('id', borradorId)
      .maybeSingle()
    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }

    const puerta = await abrirPuerta(supabase, quien, borrador)
    if (!puerta.ok) return puerta.respuesta
    // Desde aqui, la identidad es la del AUTOR (D98).
    const identidad = puerta.autor

    const guardado = borrador.payload as unknown as BorradorEntrega
    if (guardado?.tipo !== 'entrega_efectivo') {
      return NextResponse.json({ error: 'Ese borrador no es una entrega de efectivo.' }, { status: 409 })
    }
    const entrega = guardado.entrega

    // ── LOS DOS SELLOS ──────────────────────────────────────────────────────
    if (!entrega || !selloEntregaCoincide(entrega, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la entrega', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloEntregaCoincide(entrega, selloRecibido)) {
      return NextResponse.json({ error: 'El sello no empata con lo que te ensene. No escribo nada.' }, { status: 409 })
    }

    // ── Todo lo que el sello no puede garantizar, RELEIDO ────────────────────
    const { data: objetivo } = await supabase
      .from('entidades')
      .select('id, rol')
      .eq('id', entrega.id_entidad)
      .maybeSingle()
    const decision = objetivo
      ? decidirEntrega(
          { rol: identidad.rolEntidad, idEntidad: identidad.idEntidad },
          { id: objetivo.id, rol: String(objetivo.rol ?? '') }
        )
      : ({ ok: false, error: 'Ese distribuidor ya no existe.' } as const)
    if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: 403 })

    const origen = await leerCuentaDelDeudor(supabase, entrega.id_entidad)
    const matriz = await cuentaDeLaMatrizParaAbono(supabase)
    if (
      !origen.ok ||
      origen.idCuenta !== entrega.id_cuenta_origen ||
      !matriz ||
      matriz.id !== entrega.id_cuenta_destino ||
      entrega.id_cuenta_origen === entrega.id_cuenta_destino ||
      entrega.usuario_creador !== `telegram:${identidad.etiqueta}`
    ) {
      return NextResponse.json({ error: 'Las cuentas o tu alta cambiaron desde la propuesta. Vuelve a dictarla.' }, { status: 409 })
    }

    // ── La espera: la de Kevin (puerta) y la del DST (siempre) ───────────────
    if (puerta.modo === 'esperar' || (puerta.modo === 'directo' && decision.siempreEspera)) {
      return pasarAEspera(supabase, borradorId, identidad, 'una entrega de efectivo')
    }
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    const fila = filaDeEntrega(entrega) as unknown as TablesInsert<'finanzas_ledger'>
    const { data: creada, error } = await supabase.from('finanzas_ledger').insert(fila).select('id').single()
    if (error || !creada) {
      console.error('[bot] no se pudo escribir la entrega:', error)
      await liberarReclamo(supabase, borradorId, puerta.modo)
      return NextResponse.json({ error: 'No pude escribirla. No quedo nada a medias.' }, { status: 500 })
    }

    const avisoMarca = await marcarConfirmado(supabase, borradorId, creada.id)
    return NextResponse.json({
      ok: true,
      ...(avisoMarca ? { aviso_marca: avisoMarca } : {}),
      ids: [creada.id],
      filas_escritas: 1,
      mensaje: `Listo: registre la entrega de efectivo de $${entrega.monto.toFixed(2)} de ${guardado.meta.nombre}.`
    })
  } catch (e) {
    console.error('[bot] confirmar entrega reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
