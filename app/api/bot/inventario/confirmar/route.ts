/**
 * FASE 9 (D92) — Se escribe la ENTRADA de empaque exacta que se enseno.
 *
 * Entra `{telegram_id, borrador_id, sello}` y nada mas: los renglones se releen
 * de `bot_borradores` y se comparan contra los dos sellos (el guardado y el que
 * manda quien confirma), igual que el lote (`app/api/bot/lote/confirmar`).
 *
 * Escribe `inventario_ledger` con `ENTRADA_COMPRA`, destino la matriz, cubeta
 * PAGADO, ACTIVO: la misma fila que escribe la pantalla de compra de insumos
 * (app/actions/compras.ts:229-236), **sin** la fila de dinero (ver
 * `lib/bot-entrada-insumo.ts`). Todos los renglones van en UN `INSERT`
 * multi-fila: Postgres lo hace atomico, entran todos o ninguno.
 */

import { NextResponse } from 'next/server'
import type { TablesInsert } from '@/types/database'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { abrirPuerta, pasarAEspera, reclamarAprobacion, actorDe } from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { selloEntradaCoincide, type PayloadEntradaInsumo } from '@/lib/bot-entrada-insumo'
import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      borrador_id?: unknown
      sello?: unknown
    }
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
    if (permisoDeAccion(actorDe(quien), 'entrada_insumo') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrada_insumo'] }, { status: 403 })
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
    // De aqui en adelante, la identidad es la del AUTOR del borrador (D98): con
    // el Aprobar de Norman se escribe la captura de Kevin, con su etiqueta.
    const identidad = puerta.autor
    const guardado = borrador.payload as unknown as { tipo?: string; entrada?: PayloadEntradaInsumo }
    // El discriminador ANTES del sello: un borrador de otro tipo no se cancela
    // por llegar a la ruta equivocada.
    if (guardado?.tipo !== 'entrada_insumo') {
      return NextResponse.json({ error: 'Ese borrador no es una entrada de inventario.' }, { status: 409 })
    }
    const entrada = guardado.entrada
    if (!entrada || !selloEntradaCoincide(entrada, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la entrada de insumo', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloEntradaCoincide(entrada, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }
    if (entrada.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── D98: el VA de quien requiere aprobacion NO escribe ──────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'una entrada de inventario')
    }
    // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

    const filas: TablesInsert<'inventario_ledger'>[] = entrada.renglones.map((r) => ({
      id_producto: r.id_insumo,
      tipo_movimiento: 'ENTRADA_COMPRA',
      cantidad: r.cantidad,
      id_entidad_destino: entrada.id_entidad_destino,
      cubeta: 'PAGADO',
      status: 'ACTIVO',
      usuario_creador: entrada.usuario_creador,
      notas: r.nota
    }))
    if (filas.length === 0 || filas.some((f) => !(Number(f.cantidad) > 0))) {
      return NextResponse.json({ error: 'No hay nada que escribir.' }, { status: 422 })
    }
    exigirEntidadDelMovimiento(filas, 'bot.inventario.confirmar')

    const { data: escritas, error } = await supabase.from('inventario_ledger').insert(filas).select('id')
    if (error || !escritas || escritas.length !== filas.length) {
      console.error('[bot] no se pudo escribir la entrada de insumo', borradorId, error)
      return NextResponse.json({ error: 'No pude escribirlo. No entro nada.' }, { status: 500 })
    }

    await supabase
      .from('bot_borradores')
      .update({ estado: 'CONFIRMADO', id_registro: escritas[0].id, resuelto_en: new Date().toISOString() })
      .eq('id', borradorId)

    return NextResponse.json({
      ok: true,
      filas_inventario: escritas.length,
      mensaje: `Entraron ${escritas.length} insumo${escritas.length === 1 ? '' : 's'} al inventario de la matriz.`
    })
  } catch (e) {
    console.error('[bot] confirmar entrada de insumo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
