/**
 * FASE 9 (D92) — PROPONER una entrada de empaque al inventario de la matriz.
 *
 * Llega despues de que un envasado se bloqueo por falta de empaque
 * (`/api/bot/lote/proponer` -> `falta_empaque`). Entra
 * `{telegram_id, texto, envasado: [{id_producto, botellas}]}`: lo que Norman
 * contesto y el envasado que esta esperando. **El universo de insumos lo pone
 * el servidor** (los de la receta de ese envasado, con su stock releido), no
 * el bot: el bot no puede ofrecer un insumo que el envasado no usa.
 *
 * No escribe inventario: guarda un borrador sellado. La escritura es
 * `/api/bot/inventario/confirmar`, con VA. Ver `lib/bot-entrada-insumo.ts`
 * (por que `ENTRADA_COMPRA`, y por que sin dinero).
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe } from '@/lib/bot-aprobacion'
import { inventarioDelEnvasado } from '@/lib/bot-empaque-servidor'
import {
  leerEntradasDichas,
  mensajeDeEntrada,
  payloadDeEntrada,
  sellarEntrada,
  type CandidatoEntrada
} from '@/lib/bot-entrada-insumo'

export const dynamic = 'force-dynamic'

const TOPE_RENGLONES = 20

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      /** FASE 9 (D94): el chat donde se hablo; en privado es la persona. */
      chat_id?: unknown
      texto?: unknown
      envasado?: unknown
    }

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
    // Mismo candado que registrar produccion: el inventario de la matriz es de
    // la matriz.
    if (permisoDeAccion(actorDe(identidad), 'entrada_insumo') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrada_insumo'] }, { status: 403 })
    }

    const crudo = Array.isArray(cuerpo.envasado) ? cuerpo.envasado : []
    if (crudo.length === 0 || crudo.length > TOPE_RENGLONES) {
      return NextResponse.json(
        { error: 'No tengo el envasado que estaba esperando. Dictamelo otra vez.' },
        { status: 422 }
      )
    }
    const envasado = crudo.map((e) => ({
      id_producto: String((e as { id_producto?: unknown }).id_producto ?? ''),
      botellas: Number((e as { botellas?: unknown }).botellas)
    }))
    if (envasado.some((e) => e.id_producto === '' || !Number.isInteger(e.botellas) || e.botellas <= 0)) {
      return NextResponse.json(
        { error: 'No tengo el envasado que estaba esperando. Dictamelo otra vez.' },
        { status: 422 }
      )
    }

    const inv = await inventarioDelEnvasado(supabase, envasado)
    if (!inv.idAdmin) {
      return NextResponse.json({ error: 'No hay entidad ADMIN.' }, { status: 500 })
    }
    const faltaPor = new Map(inv.faltantes.map((f) => [f.id_insumo, f.falta]))
    const insumos = [
      ...new Set(inv.movimientos.filter((m) => m.tipo_movimiento === 'TRASPASO').map((m) => m.id_producto))
    ]
    const candidatos: CandidatoEntrada[] = insumos.map((id) => ({
      id,
      nombre: inv.nombres.get(id) ?? id,
      hay: inv.hay.get(id) ?? 0,
      falta: faltaPor.get(id) ?? 0
    }))

    const lectura = leerEntradasDichas(cuerpo.texto, candidatos)
    if (!lectura.ok) {
      return NextResponse.json({ ok: false, no_entendi: true, mensaje: lectura.error })
    }

    const payload = payloadDeEntrada(lectura.renglones, inv.idAdmin, `telegram:${identidad.etiqueta}`)

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarEntrada(payload)
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: {
          tipo: 'entrada_insumo',
          entrada: payload,
          meta: { renglones: lectura.renglones, avisos: lectura.avisos }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de entrada de insumo:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      renglones: lectura.renglones,
      mensaje: mensajeDeEntrada(lectura.renglones, lectura.avisos)
    })
  } catch (e) {
    console.error('[bot] proponer entrada de insumo reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
