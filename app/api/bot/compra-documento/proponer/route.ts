/**
 * 2026-11-08 — PROPONER la compra de un DOCUMENTO de varias lineas (foto de
 * factura, ticket o cotizacion).
 *
 * Escrito el 2026-11-08 por el ejecutor del Socio (bot: compra desde foto, multilinea).
 *
 * Entra `{telegram_id, chat_id?, conservar_pendientes?, documento, elecciones?}`.
 * `documento` es lo que leyo el OCR (lineas + subtotal + IVA + total): DATO, no
 * instruccion. No escribe en ningun ledger. Empata cada linea con un insumo del
 * catalogo, cuadra las sumas y:
 *   · si NO es una compra de insumos (ninguna linea es botella/tapa/corcho/...),
 *     contesta `caer_a_gasto` y el bot sigue con el gasto de siempre;
 *   · si no cuadra o hay lineas que no sabe que son, ensena el resumen SIN
 *     borrador (no hay nada que confirmar todavia);
 *   · si esta listo, guarda UN borrador sellado con los ids de todas las filas
 *     y las cuentas que se van a ofrecer como botones.
 *
 * Solo quien escribe con su propio VA usa esta via (modo `directo`): quien
 * requiere aprobacion cae al gasto de siempre, que ya sabe esperar el Aprobar.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import { chatDelBorrador, permisoDeAccion } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { clienteDeServicio, conservaPendientes, leerCatalogo, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { leerInsumosDeCompra } from '@/lib/bot-compra-servidor'
import {
  categoriaDeFlete,
  fechaDelMovimiento,
  mensajeDeCompraDocumento,
  normalizarDocumento,
  payloadDeCompraDocumento,
  planearCompra,
  sellarCompraDocumento,
  type PayloadCompraDocumento
} from '@/lib/bot-compra-documento'

export const dynamic = 'force-dynamic'

export interface BorradorCompraDocumento {
  tipo: 'compra_documento'
  compra: PayloadCompraDocumento
  meta: { nombre_entidad: string; elecciones: Record<string, string> }
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      conservar_pendientes?: unknown
      documento?: unknown
      elecciones?: unknown
    }
    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }

    // Solo el modo directo: gasto Y entrada de insumo con su propio VA.
    const actor = actorDe(identidad)
    if (
      identidad.requiereAprobacion ||
      permisoDeAccion(actor, 'gasto') !== 'si' ||
      permisoDeAccion(actor, 'entrada_insumo') !== 'si'
    ) {
      return NextResponse.json({ ok: false, caer_a_gasto: true, motivo: 'sin modo directo' })
    }

    const doc = normalizarDocumento(cuerpo.documento)
    if (doc.lineas.length === 0) {
      return NextResponse.json({ ok: false, caer_a_gasto: true, motivo: 'sin lineas' })
    }

    const [insumos, catalogo] = await Promise.all([leerInsumosDeCompra(supabase), leerCatalogo(supabase)])
    if (insumos.length === 0) {
      return NextResponse.json({ ok: false, caer_a_gasto: true, motivo: 'sin catalogo de insumos' })
    }

    const elecciones: Record<string, string> = {}
    if (cuerpo.elecciones && typeof cuerpo.elecciones === 'object') {
      for (const [k, v] of Object.entries(cuerpo.elecciones as Record<string, unknown>)) {
        if (/^\d{1,2}$/.test(k) && typeof v === 'string' && v.length <= 64) elecciones[k] = v
      }
    }

    const plan = planearCompra(doc, insumos, elecciones)
    if (!plan.esCompraDeInsumos) {
      return NextResponse.json({ ok: false, caer_a_gasto: true, motivo: 'no es compra de insumos' })
    }

    // Cotizacion: la fecha del clic (se da por pagada al tocar la cuenta).
    const fechaMovimiento = fechaDelMovimiento(doc, new Date())
    const flete = categoriaDeFlete(catalogo)
    const mensaje = mensajeDeCompraDocumento(plan, {
      nombreEntidad: identidad.nombreEntidad,
      fechaMovimiento,
      flete
    })
    const cuentas = identidad.cuentas.map((c) => ({ id: c.id, nombre: c.nombre }))
    const preguntas = plan.preguntas

    if (!plan.listo) {
      // Nada que confirmar: o no cuadra, o falta que diga que es una linea.
      return NextResponse.json({
        ok: true,
        listo: false,
        cuadra: plan.cuadre.ok,
        borrador_id: null,
        sello: null,
        mensaje,
        cuentas: [],
        preguntas
      })
    }
    if (cuentas.length === 0) {
      return NextResponse.json({ error: 'No tienes ninguna cuenta que el bot pueda usar.' }, { status: 409 })
    }

    const compra = payloadDeCompraDocumento(plan, {
      idGrupo: crypto.randomUUID(),
      nuevoId: () => crypto.randomUUID(),
      idEntidad: identidad.idEntidad,
      usuarioCreador: `telegram:${identidad.etiqueta}`,
      fechaMovimiento,
      flete,
      cuentas: cuentas.map((c) => c.id)
    })

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const payload: BorradorCompraDocumento = {
      tipo: 'compra_documento',
      compra,
      meta: { nombre_entidad: identidad.nombreEntidad, elecciones }
    }
    const sello = sellarCompraDocumento(compra)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: payload as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no pude guardar el borrador de compra de documento:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      listo: true,
      cuadra: true,
      borrador_id: borrador.id,
      sello,
      mensaje,
      cuentas,
      preguntas: []
    })
  } catch (e) {
    console.error('[bot] proponer compra de documento reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
