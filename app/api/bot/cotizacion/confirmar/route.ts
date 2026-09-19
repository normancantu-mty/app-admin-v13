/**
 * AG-05 FASE 4 — Se escribe la cotizacion exacta que se enseno, en dos tablas.
 *
 * ─── LA PROPIEDAD DE SEGURIDAD DE ESTE ARCHIVO ──────────────────────────────
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ningun renglon ni
 * ningun precio.** La cotizacion se relee de `bot_borradores`, se le recalcula
 * el hash y se compara contra el sello guardado y contra el que manda quien
 * confirma. Si cualquiera de los dos no empata, no se escribe nada.
 *
 * ─── LO QUE ESTE ARCHIVO NO HACE, Y ES SU RAZON DE SER ──────────────────────
 * No escribe en `inventario_ledger`. No escribe en `finanzas_ledger`. No aparta
 * stock, no genera deuda, no calcula impuestos. **Una cotizacion no es un hecho
 * economico**: es una promesa de precio con fecha de caducidad. El dia que se
 * convierte en venta, el que escribe es `registrarVenta` y el ticket queda en
 * `cotizaciones.id_ticket`.
 *
 * `tests/bot-cotizacion.spec.ts` lee este archivo y falla si aparece el nombre
 * de cualquiera de los dos ledgers.
 *
 * ─── LA ATOMICIDAD ──────────────────────────────────────────────────────────
 * Dos tablas y no hay transaccion (ver CLAUDE.md). `cotizacion_detalles` cuelga
 * de `cotizaciones` con `on delete cascade` y se escribe con UN solo INSERT
 * multi-fila, asi que el unico estado a medias posible es "cabecera sin
 * renglones", y eso se deshace con un solo DELETE. Es seguro precisamente
 * porque una cotizacion a medias no movio dinero ni stock: nada apunta a ella.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import {
  selloCotizacionCoincide,
  type DesgloseCotizado,
  type PayloadCotizacion
} from '@/lib/bot-cotizacion'

export const dynamic = 'force-dynamic'

interface BorradorCotizacion {
  tipo?: string
  cotizacion: PayloadCotizacion
  meta: {
    desglose: DesgloseCotizado[]
    avisos: string[]
    para_quien: string
    es_de_la_red: boolean
    vigente_hasta: string
  }
}

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

    const supabase = clienteDeServicio()

    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Cotizar por chat es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    const { data: borrador } = await supabase
      .from('bot_borradores')
      .select('id, telegram_id, sello, payload, estado')
      .eq('id', borradorId)
      .maybeSingle()

    if (!borrador) {
      return NextResponse.json({ error: 'Ese borrador ya no existe.' }, { status: 404 })
    }
    if (borrador.telegram_id !== telegramId) {
      return NextResponse.json({ error: 'Ese borrador no es tuyo.' }, { status: 403 })
    }
    if (borrador.estado !== 'PENDIENTE') {
      return NextResponse.json(
        { error: `Ese borrador ya esta ${borrador.estado.toLowerCase()}.` },
        { status: 409 }
      )
    }

    const guardado = borrador.payload as unknown as BorradorCotizacion
    // El discriminador ANTES del sello, por la misma razon que en la venta y en
    // el lote: la rama del sello roto CANCELA el borrador, y una ruta
    // equivocada del bot destruiria una captura buena.
    if (guardado?.tipo !== 'cotizacion') {
      return NextResponse.json({ error: 'Ese borrador no es una cotizacion.' }, { status: 409 })
    }

    const cotizacion = guardado.cotizacion

    if (!cotizacion || !selloCotizacionCoincide(cotizacion, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la cotizacion', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a dictarla.' },
        { status: 409 }
      )
    }
    if (!selloCotizacionCoincide(cotizacion, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    // La identidad, contra la fila sellada. Si el alta cambio entre la
    // propuesta y el "va", la cotizacion diria un vendedor que ya no es.
    if (cotizacion.id_vendedor !== identidad.idEntidad) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }
    if (cotizacion.usuario_creador !== `telegram:${identidad.etiqueta}`) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a dictarlo.' },
        { status: 409 }
      )
    }

    // ── 1. LA CABECERA. El folio lo pone la secuencia, no este codigo ───────
    const { data: creada, error: errorCabecera } = await supabase
      .from('cotizaciones')
      .insert({
        id_vendedor: cotizacion.id_vendedor,
        id_comprador: cotizacion.id_comprador,
        nombre_prospecto: cotizacion.nombre_prospecto,
        zona: cotizacion.zona,
        vigencia_dias: cotizacion.vigencia_dias,
        total: cotizacion.total,
        notas: cotizacion.notas || null,
        usuario_creador: cotizacion.usuario_creador
      })
      .select('id, folio, vigente_hasta')
      .single()

    if (errorCabecera || !creada) {
      console.error('[bot] no se pudo crear la cotizacion:', errorCabecera)
      return NextResponse.json(
        { error: 'No pude escribir la cotizacion. No quedo nada a medias.' },
        { status: 500 }
      )
    }

    // ── 2. LOS RENGLONES. Un solo INSERT multi-fila ─────────────────────────
    const { error: errorDetalles } = await supabase.from('cotizacion_detalles').insert(
      cotizacion.items.map((i) => ({
        id_cotizacion: creada.id,
        id_producto: i.id_producto,
        cantidad: i.cantidad,
        precio_unitario: i.precio_unitario
      }))
    )

    if (errorDetalles) {
      console.error('[bot] fallo el detalle de la cotizacion', creada.id, errorDetalles)
      await supabase.from('cotizaciones').delete().eq('id', creada.id)
      return NextResponse.json(
        { error: 'No pude escribir los renglones. Deshice la cotizacion entera.' },
        { status: 500 }
      )
    }

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: creada.id,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    return NextResponse.json({
      ok: true,
      id_cotizacion: creada.id,
      folio: creada.folio,
      vigente_hasta: creada.vigente_hasta,
      total: cotizacion.total,
      para_quien: guardado.meta?.para_quien ?? '',
      // Misma nota que en la venta: Telegram no puede ir por esta ruta solo —
      // necesita el encabezado `x-bot-token`. La baja el proceso del bot y la
      // manda como foto.
      ruta_imagen: `/api/documento/${creada.id}/imagen?tipo=cotizacion`,
      mensaje: `Listo. Quedo la cotizacion ${creada.folio}, vigente hasta el ${creada.vigente_hasta}.`
    })
  } catch (e) {
    console.error('[bot] confirmar cotizacion reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
