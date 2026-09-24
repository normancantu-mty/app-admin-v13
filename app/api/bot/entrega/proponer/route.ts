/**
 * FASE 11 (D112) — Se propone una ENTREGA DE EFECTIVO y se SELLA.
 *
 * Entra el monto (y, si propone la matriz, el nombre del DST). Sale un borrador
 * sellado y el texto que la persona lee antes del VA. **Aqui NO se escribe nada
 * en `finanzas_ledger`.** La regla de quien entrega por quien vive en
 * `decidirEntrega` (`lib/bot-entrega.ts`): el DST solo la suya.
 *
 * Lo que decide este endpoint y no el bot:
 *   · el DST — si habla un DST, es EL; si habla la matriz, se empata el nombre
 *     contra la lista cerrada de DST/LOC y, con duda, se pregunta con botones;
 *   · las dos cuentas — origen, la propia del DST; destino, la de la matriz.
 */

import { NextResponse } from 'next/server'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  leerCuentaDelDeudor,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { chatDelBorrador, permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { actorDe, cuentaDeLaMatrizParaAbono } from '@/lib/bot-aprobacion'
import { buscarDeudor, type Deudor } from '@/lib/bot-abonos'
import {
  decidirEntrega,
  mensajeDeConfirmacionEntrega,
  normalizarMonto,
  sellarEntrega,
  type PayloadEntrega
} from '@/lib/bot-entrega'

export const dynamic = 'force-dynamic'

const TOPE_OPCIONES = 9

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      chat_id?: unknown
      monto?: unknown
      /** El nombre que dijo la matriz. Solo se usa para BUSCAR. */
      entidad?: unknown
      /** Cuando ya se eligio con un boton: el uuid, validado contra la lista. */
      id_entidad?: unknown
      nota?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'telegram_id invalido.' }, { status: 400 })
    }

    const supabase = clienteDeServicio(request)
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta. Pideselo a Norman.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(identidad), 'entrega_efectivo') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['entrega_efectivo'] }, { status: 403 })
    }

    const monto = normalizarMonto(cuerpo.monto)
    if (!monto.ok) return NextResponse.json({ error: monto.error }, { status: 422 })

    // ── Quien entrega. La lista cerrada: DST y LOC dados de alta ──────────────
    const { data: nodos, error: errorNodos } = await supabase
      .from('entidades')
      .select('id, nombre, rol')
      .in('rol', ['DST', 'LOC'])
    if (errorNodos) {
      return NextResponse.json({ error: 'No pude leer a los distribuidores.' }, { status: 500 })
    }
    const lista: Deudor[] = (nodos ?? []).map((n) => ({
      id_entidad: n.id,
      nombre: String(n.nombre ?? ''),
      rol: String(n.rol ?? ''),
      deuda: 0,
      dias_sin_abono: null
    }))

    const idPedido = String(cuerpo.id_entidad ?? '')
    const dicho = String(cuerpo.entidad ?? '').trim()
    let objetivo: Deudor | undefined
    if (identidad.rolEntidad === 'DST' && idPedido === '' && dicho === '') {
      // Un DST que dice "entregue 3,000" habla de SI MISMO.
      objetivo = lista.find((d) => d.id_entidad === identidad.idEntidad)
    } else if (idPedido !== '') {
      objetivo = lista.find((d) => d.id_entidad === idPedido)
      if (!objetivo) {
        return NextResponse.json({ error: 'Ese ya no aparece entre los distribuidores. Vuelve a dictarlo.' }, { status: 422 })
      }
    } else {
      const hallazgo = buscarDeudor(dicho, lista)
      if (!hallazgo.ok) {
        return NextResponse.json({
          ok: false,
          hay_que_elegir: true,
          motivo: hallazgo.motivo,
          mensaje:
            hallazgo.motivo === 'sin-nombre'
              ? 'De quien es la entrega de efectivo?'
              : `No se a quien te refieres con "${dicho}". Es alguno de estos?`,
          opciones: hallazgo.candidatos.slice(0, TOPE_OPCIONES).map((d) => ({
            id_entidad: d.id_entidad,
            nombre: d.nombre,
            rol: d.rol
          }))
        })
      }
      objetivo = hallazgo.deudor
    }
    if (!objetivo) {
      return NextResponse.json({ error: 'No encuentro tu alta de distribuidor.' }, { status: 422 })
    }

    const decision = decidirEntrega(
      { rol: identidad.rolEntidad, idEntidad: identidad.idEntidad },
      { id: objetivo.id_entidad, rol: objetivo.rol }
    )
    if (!decision.ok) return NextResponse.json({ error: decision.error }, { status: 403 })

    // ── Las dos cuentas ────────────────────────────────────────────────────────
    const origen = await leerCuentaDelDeudor(supabase, objetivo.id_entidad)
    if (!origen.ok) {
      return NextResponse.json(
        { error: `No puedo registrar la entrega de ${objetivo.nombre}: ${origen.motivo}.` },
        { status: 422 }
      )
    }
    const matriz = await cuentaDeLaMatrizParaAbono(supabase)
    if (!matriz) {
      return NextResponse.json({ error: 'No encuentro la cuenta de la matriz. No propongo nada.' }, { status: 500 })
    }
    if (origen.idCuenta === matriz.id) {
      return NextResponse.json({ error: 'Origen y destino serian la misma cuenta. No escribo eso.' }, { status: 422 })
    }

    const payload: PayloadEntrega = {
      id_entidad: objetivo.id_entidad,
      monto: monto.monto,
      id_cuenta_origen: origen.idCuenta,
      id_cuenta_destino: matriz.id,
      fecha_movimiento: new Date().toISOString(),
      usuario_creador: `telegram:${identidad.etiqueta}`,
      nota: String(cuerpo.nota ?? '').trim().slice(0, 200)
    }

    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarEntrega(payload)
    const espera = decision.siempreEspera || identidad.requiereAprobacion
    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        chat_id: chatDelBorrador(cuerpo.chat_id, telegramId),
        sello,
        payload: {
          tipo: 'entrega_efectivo',
          entrega: payload,
          meta: {
            nombre: objetivo.nombre,
            rol: objetivo.rol,
            nombre_cuenta_origen: origen.nombre,
            nombre_cuenta_destino: matriz.nombre
          }
        } as unknown as Json
      })
      .select('id')
      .single()
    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de entrega:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      id_entidad: objetivo.id_entidad,
      nombre: objetivo.nombre,
      mensaje: mensajeDeConfirmacionEntrega(payload, {
        nombre: objetivo.nombre,
        cuentaOrigen: origen.nombre,
        cuentaDestino: matriz.nombre,
        espera
      })
    })
  } catch (e) {
    console.error('[bot] proponer entrega reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
