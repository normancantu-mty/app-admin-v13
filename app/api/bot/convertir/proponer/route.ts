/**
 * AG-06 FASE 5 · PASO 6 — CONVERTIR UNA COTIZACION EN VENTA. La propuesta.
 *
 * Mismo molde de siempre. Lo propio de este endpoint son tres cosas:
 *
 *  1. **La cotizacion se escoge de una lista con botones, nunca por texto.** Es
 *     la misma regla de D2 que para anular, y por la misma razon: "convierte la
 *     de Juan" con dos cotizaciones de Juan cierra la venta equivocada. Aqui
 *     ademas hay folio, asi que la lista lo ensena y el boton lleva el INDICE.
 *
 *  2. **Los precios que se cobran son los CONGELADOS en `cotizacion_detalles`**,
 *     y los de hoy se leen solo para ensenarlos al lado. Una cotizacion es una
 *     promesa de precio; recalcularla al convertir seria no haberla hecho.
 *
 *  3. **La venta entera se sella**, no el folio. Ver `PayloadConversion`.
 *
 * ─── LO QUE LA COTIZACION NO SABE Y HAY QUE PREGUNTAR ───────────────────────
 *
 * `cotizaciones` no guarda condicion de pago ni cuenta destino, y son las dos
 * cosas que deciden si entra dinero y con que regimen fiscal. No se adivinan:
 * van por boton, igual que en la venta dictada.
 */

import { NextResponse } from 'next/server'
import {
  clienteDeServicio,
  leerCatalogoDeVenta,
  leerCompradoresDeVenta,
  leerCuentaDeVenta,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import { precioParaComprador, TOPE_VENTA, type PayloadVenta, type RenglonVenta } from '@/lib/bot-venta'
import {
  juzgarConversion,
  mensajeDeConversion,
  sellarConversion,
  type CotizacionParaConvertir,
  type LineaConvertida,
  type PayloadConversion
} from '@/lib/bot-conversion'
import { hoyEnMX } from '@/lib/date-format'

export const dynamic = 'force-dynamic'

/** Cuantas cotizaciones se ofrecen de un jalon. Mismo criterio que la lista de
 * anulables: lo que se lee de un vistazo en un celular. */
const COTIZACIONES_OFRECIDAS = 8

function redondear(n: number): number {
  return Math.round(n * 100) / 100
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      id_cotizacion?: unknown
      condicion_pago?: unknown
      id_cuenta_destino?: unknown
    }

    const telegramId = Number(cuerpo.telegram_id)
    if (!Number.isSafeInteger(telegramId)) {
      return NextResponse.json({ error: 'Peticion invalida.' }, { status: 400 })
    }

    const supabase = clienteDeServicio()
    const identidad = await resolverIdentidad(supabase, telegramId)
    if (!identidad) {
      return NextResponse.json({ error: 'No te tengo dado de alta.' }, { status: 403 })
    }
    // Mismo alcance que capturar una venta: una conversion ES una venta.
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Cerrar ventas por chat es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    // ── SIN COTIZACION: SE OFRECE LA LISTA (D2) ───────────────────────────
    const idCotizacion = String(cuerpo.id_cotizacion ?? '').trim()
    if (idCotizacion === '') {
      const { data, error } = await supabase
        .from('cotizaciones')
        .select('id, folio, fecha, estado, total, nombre_prospecto, id_comprador, vigente_hasta, zona')
        .in('estado', ['VIGENTE', 'VENCIDA'])
        .order('fecha', { ascending: false })
        .limit(8) // Literal para que el centinela de ERP-25 lo pueda leer.
      if (error) throw new Error(error.message)

      const filas = (data ?? []).slice(0, COTIZACIONES_OFRECIDAS)
      if (filas.length === 0) {
        return NextResponse.json(
          { error: 'No tengo ninguna cotizacion abierta que convertir.' },
          { status: 404 }
        )
      }

      const nombres = await nombresDeEntidad(
        supabase,
        filas.map((f) => f.id_comprador).filter((x): x is string => Boolean(x))
      )

      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'cotizacion',
        mensaje: 'Cual convierto en venta?',
        opciones: filas.map((f) => ({
          id: f.id,
          etiqueta:
            `${f.folio} · ${f.fecha} · ` +
            `$${Number(f.total).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`,
          detalle: nombres.get(f.id_comprador ?? '') ?? f.nombre_prospecto ?? '(sin destinatario)',
          estado: f.estado
        }))
      })
    }

    // ── LA COTIZACION Y SUS RENGLONES ─────────────────────────────────────
    const { data: cotRaw } = await supabase
      .from('cotizaciones')
      .select('id, folio, fecha, estado, zona, total, id_comprador, nombre_prospecto, vigente_hasta')
      .eq('id', idCotizacion)
      .maybeSingle()

    if (!cotRaw) {
      return NextResponse.json({ error: 'Esa cotizacion ya no existe.' }, { status: 404 })
    }
    const cot: CotizacionParaConvertir = {
      id: cotRaw.id,
      folio: cotRaw.folio,
      fecha: String(cotRaw.fecha),
      estado: cotRaw.estado,
      zona: cotRaw.zona,
      total: Number(cotRaw.total) || 0,
      id_comprador: cotRaw.id_comprador,
      nombre_prospecto: cotRaw.nombre_prospecto,
      vigente_hasta: cotRaw.vigente_hasta ? String(cotRaw.vigente_hasta) : null
    }

    const { data: detallesRaw, error: errDet } = await supabase
      .from('cotizacion_detalles')
      .select('id_producto, cantidad, precio_unitario')
      .eq('id_cotizacion', idCotizacion)
      .limit(1000) // ERP-25: el tope explicito, aunque una cotizacion nunca lo roce.
    if (errDet) throw new Error(errDet.message)
    const detalles = detallesRaw ?? []

    // ── EL JUICIO: LOS 7 DIAS, EL ESTADO, EL COMPRADOR (D15) ──────────────
    const juicio = juzgarConversion(cot, detalles.length)
    if (!juicio.ok) {
      return NextResponse.json(
        {
          error: juicio.mensaje,
          motivo: juicio.motivo,
          // El bot usa esto para ofrecer el boton de recotizar en vez de dejar
          // a la persona en un callejon sin salida.
          ofrecer_recotizar: juicio.ofrecerRecotizar
        },
        { status: 422 }
      )
    }

    // ── LO QUE LA COTIZACION NO SABE ──────────────────────────────────────
    const condicion = String(cuerpo.condicion_pago ?? '')
    if (condicion !== 'CONTADO' && condicion !== 'CONCESION') {
      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'condicion_pago',
        mensaje: `${cot.folio}: se la cobras ahora o se la dejas a deber?`,
        opciones: [
          { valor: 'CONTADO', etiqueta: 'De contado' },
          { valor: 'CONCESION', etiqueta: 'A consignacion' }
        ]
      })
    }

    const idCuenta = String(cuerpo.id_cuenta_destino ?? '').trim()
    // La lista cerrada de la identidad. Una cuenta que no este aqui no se puede
    // nombrar: ni el modelo ni el proceso del bot pueden inventar una vetada o
    // de otra entidad.
    if (!idCuenta || !identidad.cuentas.some((c) => c.id === idCuenta)) {
      return NextResponse.json({
        ok: true,
        hay_que_elegir: true,
        campo: 'cuenta',
        mensaje: 'A que cuenta entra?',
        opciones: identidad.cuentas.map((c) => ({ valor: c.id, etiqueta: c.nombre }))
      })
    }

    const cuenta = await leerCuentaDeVenta(supabase, idCuenta)
    if (!cuenta) {
      return NextResponse.json({ error: 'Esa cuenta ya no existe.' }, { status: 422 })
    }

    // ── EL PRECIO DE HOY, SOLO PARA ENSENARLO AL LADO ─────────────────────
    const compradores = await leerCompradoresDeVenta(supabase)
    const comprador = compradores.find((c) => c.id === cot.id_comprador) ?? null
    if (!comprador) {
      return NextResponse.json(
        { error: 'El comprador de esa cotizacion ya no esta en la red. No la convierto.' },
        { status: 422 }
      )
    }
    if (comprador.id === identidad.idEntidad) {
      return NextResponse.json(
        { error: 'El comprador y el vendedor son la misma entidad. No escribo eso.' },
        { status: 422 }
      )
    }

    const catalogo = await leerCatalogoDeVenta(supabase)
    // La zona de la COTIZACION, no la de hoy: el precio de hoy que se ensena
    // tiene que ser comparable con el que se congelo, y comparar contra otra
    // zona seria comparar dos cosas distintas y llamarlo "subio".
    const precioHoyDe = new Map<string, number | null>()
    const nombreDe = new Map<string, string>()
    for (const p of catalogo) {
      nombreDe.set(p.id, p.nombre)
      const lista = p.precios.find((x) => x.zona === cot.zona)
      precioHoyDe.set(
        p.id,
        lista
          ? precioParaComprador(
              {
                id: p.id,
                sku: p.sku,
                nombre: p.nombre,
                ml_por_unidad: p.ml_por_unidad,
                precio_final: lista.precio_final
              },
              comprador
            )
          : null
      )
    }

    const lineas: LineaConvertida[] = []
    const items: RenglonVenta[] = []
    for (const d of detalles) {
      const precio = redondear(Number(d.precio_unitario) || 0)
      const cantidad = Number(d.cantidad) || 0
      if (!(precio > 0) || !(cantidad > 0)) {
        return NextResponse.json(
          { error: `${cot.folio} tiene un renglon en cero. No la convierto.` },
          { status: 422 }
        )
      }
      const subtotal = redondear(precio * cantidad)
      lineas.push({
        id_producto: d.id_producto,
        nombre: nombreDe.get(d.id_producto) ?? '(producto fuera del catalogo)',
        cantidad,
        precio_cotizado: precio,
        // `null` cuando el producto salio del catalogo o perdio precio de lista.
        // Se ensena como "no hay precio de lista", no como "igual".
        precio_hoy: precioHoyDe.get(d.id_producto) ?? null,
        subtotal
      })
      items.push({
        id_producto: d.id_producto,
        cantidad,
        precio_unitario: precio,
        subtotal_linea: subtotal
      })
    }

    const total = redondear(items.reduce((s, i) => s + i.subtotal_linea, 0))
    if (!(total > 0)) {
      return NextResponse.json({ error: 'Esa conversion sale en cero. No escribo eso.' }, { status: 422 })
    }
    if (total > TOPE_VENTA) {
      return NextResponse.json(
        { error: `Una venta de ${total} pesos por chat no: el tope es ${TOPE_VENTA}.` },
        { status: 422 }
      )
    }

    const venta: PayloadVenta = {
      id_vendedor: identidad.idEntidad,
      id_comprador: comprador.id,
      id_cuenta_destino: idCuenta,
      condicion_pago: condicion,
      items,
      // Igual que en la venta dictada: el bot no aplica descuentos, no hay campo
      // donde dictarlos. Los dos numeros son el mismo.
      subtotal_catalogo: total,
      total_cobrado_real: total,
      usuario_creador: `telegram:${identidad.etiqueta}`
    }

    const payload: PayloadConversion = {
      id_cotizacion: cot.id,
      folio: cot.folio,
      venta,
      usuario_creador: venta.usuario_creador
    }

    const avisos: string[] = []
    if (Math.abs(total - cot.total) >= 0.01) {
      // Pasa si alguien toco los renglones despues de cotizar. El total de la
      // cabecera y la suma de los renglones son dos columnas distintas y nada
      // las amarra.
      avisos.push(
        `⚠ La cotizacion dice $${cot.total.toFixed(2)} en el encabezado y sus renglones ` +
          `suman $${total.toFixed(2)}. Cobro la suma de los renglones.`
      )
    }
    if (lineas.some((l) => l.precio_hoy === null)) {
      avisos.push('⚠ Hay renglones sin precio de lista hoy: no puedo compararlos.')
    }

    const mensaje = mensajeDeConversion(cot, lineas, venta, {
      nombreComprador: comprador.nombre,
      nombreCuenta: cuenta.nombre ?? '(cuenta)',
      condicionPago: condicion,
      diasDesdeLaCotizacion: juicio.diasDesdeLaCotizacion,
      vencidaParaElCliente: juicio.vencidaParaElCliente,
      avisos
    })

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // `bot_borradores_uno_pendiente` es un UNIQUE parcial sobre `telegram_id`
    // con `estado = 'PENDIENTE'`: proponer algo nuevo TIENE que cancelar lo
    // anterior, o el insert revienta con 23505. Mismo criterio que los cinco
    // `proponer` de las fases 3 y 4, y por la misma razon: con dos borradores
    // abiertos un "va" es ambiguo.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarConversion(payload)

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        estado: 'PENDIENTE',
        payload: {
          // El discriminador, que en el `confirmar` se mira ANTES del sello.
          tipo: 'conversion',
          fila: payload,
          meta: {
            id_entidad: identidad.idEntidad,
            nombre_comprador: comprador.nombre,
            hoy: hoyEnMX(),
            lineas,
            avisos
          }
        } as unknown as never
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no pude guardar el borrador de conversion:', error)
      return NextResponse.json({ error: 'No pude prepararlo. No escribi nada.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      mensaje,
      folio: cot.folio,
      total,
      avisos
    })
  } catch (e) {
    console.error('[bot] convertir/proponer reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}

async function nombresDeEntidad(
  supabase: ReturnType<typeof clienteDeServicio>,
  ids: readonly string[]
): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter(Boolean))]
  if (unicos.length === 0) return new Map()
  const { data } = await supabase.from('entidades').select('id, nombre').in('id', unicos)
  const mapa = new Map<string, string>()
  for (const e of data ?? []) mapa.set(e.id, e.nombre ?? '')
  return mapa
}
