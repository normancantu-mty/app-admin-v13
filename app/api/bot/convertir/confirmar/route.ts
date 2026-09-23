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
import {
  abrirPuerta,
  pasarAEspera,
  reclamarAprobacion,
  actorDe,
  alcanceDeCaptura,
  redDe
} from '@/lib/bot-aprobacion'
import { permisoDeAccion, MENSAJE_NO_PERMITIDO } from '@/lib/bot-permisos'
import { registrarVenta, type OperadorDeVenta } from '@/lib/venta-servidor'
import {
  juzgarConversion,
  mensajeDeConversionHecha,
  selloConversionCoincide,
  type CotizacionParaConvertir,
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

    const supabase = clienteDeServicio(request)
    const quien = await resolverIdentidad(supabase, telegramId)
    if (!quien) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    if (permisoDeAccion(actorDe(quien), 'convertir') === 'no') {
      return NextResponse.json({ error: MENSAJE_NO_PERMITIDO['convertir'] }, { status: 403 })
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
      .select(
        'id, folio, fecha, estado, zona, total, id_comprador, nombre_prospecto, vigente_hasta, id_ticket, id_vendedor'
      )
      .eq('id', fila.id_cotizacion)
      .maybeSingle()

    if (!cotAhora) {
      return NextResponse.json({ error: 'Esa cotizacion ya no existe.' }, { status: 409 })
    }
    // FASE 10 (D106): un DST convierte SOLO SUS cotizaciones, comprobado otra
    // vez aqui, contra la fila releida; y solo a su red, como la venta.
    if (identidad.rolEntidad !== 'ADMIN') {
      if (cotAhora.id_vendedor !== identidad.idEntidad) {
        return NextResponse.json(
          { error: 'Esa cotizacion no es tuya. Solo conviertes las que hiciste tu.' },
          { status: 403 }
        )
      }
      const red = await redDe(supabase, identidad, alcanceDeCaptura(identidad))
      if (red !== null && venta.id_comprador && !red.has(venta.id_comprador)) {
        return NextResponse.json({ error: 'Ese comprador no es de tu red. No escribo nada.' }, { status: 403 })
      }
    }
    if (cotAhora.estado === 'CONVERTIDA' || cotAhora.id_ticket) {
      return NextResponse.json(
        { error: `${cotAhora.folio} ya se convirtio en venta. No la cobro dos veces.` },
        { status: 409 }
      )
    }

    // ── LOS 7 DIAS, OTRA VEZ, AQUI (D12/D13, 2026-09-19) ──────────────────
    // El defecto que cierra: la puerta de los 7 dias vivia SOLO en el
    // `proponer`. Entre la propuesta y el "va" pueden pasar dias — se propone
    // el lunes por la noche y se pica "VA, hazla venta" el miercoles — y la
    // venta se escribia igual, con precios de hace 9 dias. `anular/confirmar`
    // ya hacia su segunda pasada; `convertir` no.
    //
    // Se juzga la cotizacion RELEIDA, no la copia que viaja sellada dentro del
    // borrador (D13): juzgar el borrador es juzgar una foto vieja, y ademas se
    // perderia lo que haya cambiado entre medias. Y con `new Date()` del
    // momento del "va", que es el punto entero del arreglo.
    //
    // Los renglones se cuentan sobre los que se van a VENDER — son los que el
    // sello cubre y los unicos que se van a escribir; `juzgarConversion` solo
    // los usa para rechazar una cotizacion vacia.
    const cotRevisada: CotizacionParaConvertir = {
      id: cotAhora.id,
      folio: cotAhora.folio,
      fecha: String(cotAhora.fecha),
      estado: cotAhora.estado,
      zona: cotAhora.zona,
      total: Number(cotAhora.total) || 0,
      id_comprador: cotAhora.id_comprador,
      nombre_prospecto: cotAhora.nombre_prospecto,
      vigente_hasta: cotAhora.vigente_hasta ? String(cotAhora.vigente_hasta) : null
    }
    const juicio = juzgarConversion(cotRevisada, venta.items.length)
    if (!juicio.ok) {
      // 422 y CERO filas escritas (D14). No se ofrece recotizar desde aqui: se
      // dice que caduco y que hay que volver a empezar con /convertir. El
      // borrador se queda PENDIENTE a proposito — no se cancela algo que la
      // persona no cancelo, y el proximo `proponer` lo apaga solo.
      console.warn(
        '[bot] conversion caducada entre la propuesta y el va:',
        cotRevisada.folio,
        juicio.motivo
      )
      return NextResponse.json({ error: juicio.mensaje, motivo: juicio.motivo }, { status: 422 })
    }

    // ── D98: el VA de quien requiere aprobacion NO escribe ──────────────────
    if (puerta.modo === 'esperar') {
      return pasarAEspera(supabase, borradorId, identidad, 'una venta desde cotizacion')
    }
    // D106: con dos aprobadores, el primero que aprieta gana; el otro no escribe.
    const reclamo = await reclamarAprobacion(supabase, borradorId, puerta.modo)
    if (reclamo) return reclamo

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
