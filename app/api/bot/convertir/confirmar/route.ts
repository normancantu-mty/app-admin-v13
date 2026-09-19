/**
 * AG-06 FASE 5 · PASO 6 — CONVERTIR UNA COTIZACION EN VENTA. El "va".
 *
 * Entra `{telegram_id, borrador_id, sello}`. **No entra ni un precio ni un
 * folio.** La venta que se va a escribir viene sellada dentro del borrador, y el
 * hash cubre la venta ENTERA: cada renglon, cada precio congelado, el comprador
 * y la cuenta. Entre el mensaje que la persona leyo y el ticket no hay donde
 * meter un precio distinto.
 *
 * ─── LAS DOS ESCRITURAS, Y POR QUE NO CABEN EN UNA SOLA TRANSACCION ─────────
 *
 * Primero `registrarVenta` —que por dentro es `registrar_venta_atomica`, un solo
 * RPC, las cuatro tablas de la venta atomicas—, y despues el `UPDATE` de la
 * cotizacion a `CONVERTIDA` con su `id_ticket`. Son dos peticiones a PostgREST,
 * o sea dos transacciones, porque el `id_ticket` que la segunda necesita **no
 * existe hasta que la primera termina**. Meterlas en una sola RPC pediria
 * reescribir `registrar_venta_atomica` para que ademas supiera de cotizaciones,
 * y eso es acoplar el motor de ventas a una tabla que casi ninguna venta usa.
 *
 * El orden importa y es este a proposito. Si falla el segundo paso queda una
 * VENTA BUENA y una cotizacion que sigue VIGENTE: se ve, se puede volver a
 * intentar, y el peor caso es una segunda venta duplicada que se anula. Al
 * reves —marcar primero y vender despues— quedaria una cotizacion CONVERTIDA
 * apuntando a un ticket que no existe, que ademas el `CHECK` no deja escribir.
 *
 * El `CHECK cotizaciones_convertida_lleva_ticket` obliga a que `estado` e
 * `id_ticket` se muevan JUNTOS, asi que el UPDATE es uno solo y no dos.
 *
 * ─── Y SI EL SEGUNDO PASO FALLA, SE DICE ───────────────────────────────────
 *
 * No se anula la venta para "dejar todo como estaba": la venta es el hecho real
 * —el inventario ya salio— y la marca de la cotizacion es contabilidad de
 * seguimiento. Se contesta con el ticket y con el aviso de que la cotizacion se
 * quedo sin marcar, que es lo unico que alguien puede accionar.
 */

import { NextResponse } from 'next/server'
import { clienteDeServicio, resolverIdentidad, tokenValido } from '@/lib/bot-servidor'
import { registrarVenta, type OperadorDeVenta } from '@/lib/venta-servidor'
import {
  mensajeDeConversionHecha,
  selloConversionCoincide,
  type LineaConvertida,
  type PayloadConversion
} from '@/lib/bot-conversion'

export const dynamic = 'force-dynamic'

interface BorradorConversion {
  tipo?: string
  fila: PayloadConversion
  meta: {
    id_entidad: string
    nombre_comprador: string
    hoy: string
    lineas: LineaConvertida[]
    avisos: string[]
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
        { error: 'Cerrar ventas por chat es de la matriz; tu alta no alcanza.' },
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

    const guardado = borrador.payload as unknown as BorradorConversion
    // El discriminador, ANTES del sello. Un borrador de otra familia nunca
    // empata el hash y caeria por la rama que CANCELA.
    if (guardado?.tipo !== 'conversion') {
      return NextResponse.json({ error: 'Ese borrador no es una conversion.' }, { status: 409 })
    }
    const fila = guardado?.fila

    if (!fila || !selloConversionCoincide(fila, borrador.sello)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('id', borradorId)
      console.error('[bot] SELLO ROTO en la base para la conversion', borradorId)
      return NextResponse.json(
        { error: 'La propuesta cambio desde que te la ensene. No escribo nada: vuelve a pedirmela.' },
        { status: 409 }
      )
    }
    if (!selloConversionCoincide(fila, selloRecibido)) {
      return NextResponse.json(
        { error: 'El sello no empata con lo que te ensene. No escribo nada.' },
        { status: 409 }
      )
    }

    const venta = fila.venta

    // La identidad, otra vez contra la fila sellada. El sello garantiza que la
    // venta no cambio; no garantiza que quien la propuso siga pudiendo
    // escribirla.
    if (
      venta.id_vendedor !== identidad.idEntidad ||
      !identidad.cuentas.some((c) => c.id === venta.id_cuenta_destino) ||
      venta.usuario_creador !== `telegram:${identidad.etiqueta}`
    ) {
      return NextResponse.json(
        { error: 'Tu alta cambio desde que propusiste esto. Vuelve a pedirmelo.' },
        { status: 409 }
      )
    }

    // ── LA CARRERA: QUE NADIE LA HAYA CONVERTIDO MIENTRAS TANTO ───────────
    // Entre la propuesta y el "va" pueden pasar horas, y la misma cotizacion se
    // puede haber cerrado desde la pantalla o desde otro chat. Sin esta lectura,
    // dos "va" seguidos escriben dos ventas de la misma cotizacion: la segunda
    // solo fallaria al marcar, cuando el inventario ya salio dos veces.
    const { data: cotAhora } = await supabase
      .from('cotizaciones')
      .select('id, folio, estado, id_ticket')
      .eq('id', fila.id_cotizacion)
      .maybeSingle()

    if (!cotAhora) {
      return NextResponse.json({ error: 'Esa cotizacion ya no existe.' }, { status: 409 })
    }
    if (cotAhora.estado === 'CONVERTIDA' || cotAhora.id_ticket) {
      return NextResponse.json(
        { error: `${cotAhora.folio} ya se convirtio en venta. No la cobro dos veces.` },
        { status: 409 }
      )
    }

    // ── 1. LA VENTA ───────────────────────────────────────────────────────
    const operador: OperadorDeVenta = {
      email: venta.usuario_creador,
      idEntidad: identidad.idEntidad,
      rol: identidad.rolEntidad
    }

    const resultado = await registrarVenta(supabase, operador, {
      idVendedor: venta.id_vendedor,
      idComprador: venta.id_comprador,
      idCuentaDestino: venta.id_cuenta_destino,
      condicion_pago: venta.condicion_pago,
      subtotalCatalogo: venta.subtotal_catalogo,
      totalCobradoReal: venta.total_cobrado_real,
      // Los tres campos fiscales los ignora el motor: los recalcula el mismo
      // contra la cuenta destino. Van en cero para que quede claro que de aqui
      // no sale ningun impuesto.
      montoBaseIngreso: 0,
      impuestoIvaCalculado: 0,
      impuestoIepsCalculado: 0,
      items: venta.items
    })

    if (!resultado.ok || !resultado.ticketId) {
      // El borrador se queda PENDIENTE: el RPC es atomico, no dejo nada a
      // medias, y la propuesta sigue siendo valida. Tipicamente es inventario
      // insuficiente, que se resuelve produciendo y volviendo a decir "va".
      return NextResponse.json(
        { error: resultado.error ?? 'No pude escribir la venta.' },
        { status: 422 }
      )
    }

    // ── 2. LA MARCA EN LA COTIZACION ──────────────────────────────────────
    // Las dos columnas en el MISMO update: el CHECK las amarra. Y se exige la
    // fila devuelta, porque la leccion de ERP-66 es que un UPDATE denegado por
    // RLS contesta 200 con cero filas y sin error.
    const { data: marcada, error: errMarca } = await supabase
      .from('cotizaciones')
      .update({ estado: 'CONVERTIDA', id_ticket: resultado.ticketId })
      .eq('id', fila.id_cotizacion)
      .select('id')

    const seMarco = !errMarca && (marcada?.length ?? 0) === 1

    await supabase
      .from('bot_borradores')
      .update({
        estado: 'CONFIRMADO',
        id_registro: resultado.ticketId,
        resuelto_en: new Date().toISOString()
      })
      .eq('id', borradorId)

    // El rastro propio. `cotizaciones` no tiene trigger de bitacora, asi que de
    // este UPDATE no queda nada en `auditoria_logs`. Sin token.
    console.info(
      '[bot][conversion] cotizacion=%s folio=%s ticket=%s marcada=%s borrador=%s telegram_id=%s autor=%s',
      fila.id_cotizacion,
      fila.folio,
      resultado.ticketId,
      seMarco,
      borradorId,
      telegramId,
      venta.usuario_creador
    )

    if (!seMarco) {
      console.error('[bot][conversion] la venta se escribio pero la cotizacion no se marco:', errMarca)
      return NextResponse.json({
        ok: true,
        ticket_id: resultado.ticketId,
        cotizacion_marcada: false,
        mensaje:
          `✅ La venta quedo: ticket TCK-${resultado.ticketId.slice(0, 8)}.\n\n` +
          `⚠ Pero NO pude marcar ${fila.folio} como convertida, asi que va a seguir ` +
          `apareciendo como abierta. La venta es buena; lo que falta es la marca.`
      })
    }

    return NextResponse.json({
      ok: true,
      ticket_id: resultado.ticketId,
      cotizacion_marcada: true,
      mensaje: mensajeDeConversionHecha(
        fila.folio,
        resultado.ticketId,
        venta.total_cobrado_real
      )
    })
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : 'Error interno.'
    console.error('[bot] convertir/confirmar reviento:', e)
    return NextResponse.json({ error: mensaje }, { status: 500 })
  }
}
