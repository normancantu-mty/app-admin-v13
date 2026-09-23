/**
 * AG-05 FASE 4 — LA COTIZACION. Se propone completa y se SELLA. No escribe nada.
 *
 * Mismo patron que gasto, abono, venta y lote: entra lo que el LLM extrajo, sale
 * un borrador con su sello y el texto que la persona va a leer. **Este endpoint
 * no toca `cotizaciones` ni `cotizacion_detalles`** — ni, por supuesto, ninguno
 * de los dos ledgers.
 *
 * ─── LA DIFERENCIA CON LA VENTA QUE HAY QUE ENTENDER ────────────────────────
 *
 * En la venta, un nombre que no esta en la red es un ERROR: no se le puede
 * vender a alguien que no existe como nodo. **Aqui es el caso NORMAL.** Se
 * cotiza a quien todavia no compra; exigir que primero se de de alta como
 * distribuidor llenaria la red de nodos que nunca compraron nada.
 *
 * Por eso, cuando el nombre no empata, la respuesta no es un 422: es la misma
 * pregunta con botones **mas** la opcion de tratarlo como prospecto. Y cuando
 * empata con alguien de la red, el precio deja de ser el de lista y pasa a ser
 * SU costo — la misma `precioParaComprador` de la venta, no una copia.
 *
 * ─── POR QUE SOLO ADMIN ─────────────────────────────────────────────────────
 * Igual que la venta y el lote: hoy la unica identidad dada de alta es ADMIN, y
 * las politicas de `insert` de ERP-87 son de ADMIN. El bot entra con
 * `service_role`, que salta la RLS, asi que esta linea es la autorizacion real.
 */

import { NextResponse } from 'next/server'
import { preguntaDeProducto } from '@/lib/bot-tamanos'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  leerCatalogoDeVenta,
  leerCompradoresDeVenta,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import {
  aProductoDelCatalogo,
  buscarProducto,
  precioParaComprador,
  ZONA_POR_DEFECTO,
  type CompradorDeVenta,
  type ProductoDelCatalogo
} from '@/lib/bot-venta'
import {
  escalarAObjetivo,
  mensajeDeConfirmacionCotizacion,
  normalizarCotizacion,
  sellarCotizacion,
  type LineaCotizada
} from '@/lib/bot-cotizacion'
import { aplicarDescuento } from '@/lib/bot-descuento'
import { fechaLocal } from '@/lib/fechas'
import { buscarPorNombre } from '@/lib/bot-nombres'

export const dynamic = 'force-dynamic'

const TOPE_OPCIONES = 9
const TOPE_RENGLONES = 12

interface ProductoPedido {
  producto?: unknown
  id_producto?: unknown
  cantidad?: unknown
}

function opcionesDeProducto(lista: readonly ProductoDelCatalogo[]) {
  return lista.slice(0, TOPE_OPCIONES).map((p) => ({
    id: p.id,
    nombre: p.nombre,
    sku: p.sku,
    precio: p.precio_final
  }))
}

function opcionesDeCliente(lista: readonly CompradorDeVenta[]) {
  return lista.slice(0, TOPE_OPCIONES).map((c) => ({ id: c.id, nombre: c.nombre, rol: c.rol }))
}

export async function POST(request: Request) {
  if (!tokenValido(request)) {
    return NextResponse.json({ error: 'No autorizado.' }, { status: 401 })
  }

  try {
    const cuerpo = (await request.json()) as {
      telegram_id?: unknown
      propuesta?: Record<string, unknown>
      productos?: ProductoPedido[]
      /** El nombre dicho. Solo se usa para BUSCAR en la red. */
      cliente?: unknown
      /** Cuando ya se eligio con un boton: el uuid, validado contra la red. */
      id_comprador?: unknown
      /** El boton "es un prospecto": el nombre se guarda tal cual, sin red. */
      prospecto?: unknown
      /**
       * D51: el TOTAL al que Norman quiere acercarse. Cuando viene, las
       * cantidades de `productos` son solo la PROPORCION: se reescalan contra
       * los precios del catalogo. El modelo no calcula ninguna de las dos cosas.
       */
      objetivo?: unknown
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
    if (identidad.rolEntidad !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Cotizar por chat es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    // ── A QUIEN SE LE COTIZA ────────────────────────────────────────────────
    const clientes = (await leerCompradoresDeVenta(supabase)).filter(
      (c) => c.id !== identidad.idEntidad
    )
    const idPedido = String(cuerpo.id_comprador ?? '')
    const prospectoPedido = String(cuerpo.prospecto ?? '').trim()
    const nombreDicho = String(cuerpo.cliente ?? '').trim()

    let comprador: CompradorDeVenta | null = null
    let nombreProspecto: string | null = null

    if (prospectoPedido !== '') {
      nombreProspecto = prospectoPedido
    } else if (idPedido !== '') {
      comprador = clientes.find((c) => c.id === idPedido) ?? null
      if (!comprador) {
        return NextResponse.json(
          { error: 'Ese cliente ya no esta en la red. Vuelve a dictarlo.' },
          { status: 422 }
        )
      }
    } else if (nombreDicho !== '') {
      const hallazgo = buscarPorNombre(nombreDicho, clientes, (c) => [c.nombre])
      if (hallazgo.ok) {
        comprador = hallazgo.elegido
      } else {
        // **Aqui esta la diferencia con la venta.** No encontrarlo no es un
        // error: puede ser un prospecto, que es el caso normal de una
        // cotizacion. Se pregunta, y una de las opciones es justamente esa.
        const mensaje =
          hallazgo.motivo === 'ambiguo'
            ? `"${nombreDicho}" me da mas de uno. Cual es?`
            : `No tengo a "${nombreDicho}" en la red. Es alguno de estos, o es cliente nuevo?`
        return NextResponse.json({
          ok: false,
          hay_que_elegir: true,
          campo: 'cliente',
          motivo: hallazgo.motivo,
          mensaje,
          // Se ofrece SIEMPRE que haya un nombre que dijo la persona, incluso
          // si resulto ambiguo: "Dulceria" empata con dos de la red y aun asi
          // puede ser una tercera que nunca ha comprado. Quien dicta tiene la
          // lista enfrente y sabe si su cliente esta en ella; esconderle el
          // boton lo obliga a volver a dictar la cotizacion entera.
          permite_prospecto: true,
          nombre_dicho: nombreDicho,
          opciones: opcionesDeCliente(hallazgo.candidatos)
        })
      }
    } else {
      return NextResponse.json({
        ok: false,
        hay_que_elegir: true,
        campo: 'cliente',
        motivo: 'sin-nombre',
        mensaje: 'A quien se la cotizo?',
        permite_prospecto: false,
        nombre_dicho: '',
        opciones: opcionesDeCliente(clientes)
      })
    }

    // ── LOS PRODUCTOS ───────────────────────────────────────────────────────
    const pedidos = Array.isArray(cuerpo.productos) ? cuerpo.productos : []
    if (pedidos.length === 0) {
      return NextResponse.json({ error: 'No entendi que cotizar.' }, { status: 422 })
    }
    if (pedidos.length > TOPE_RENGLONES) {
      return NextResponse.json(
        { error: `Son ${pedidos.length} renglones distintos. Esa cotizacion va en la pantalla.` },
        { status: 422 }
      )
    }

    const zona = comprador?.zona || ZONA_POR_DEFECTO
    const catalogo = (await leerCatalogoDeVenta(supabase)).map((p) => aProductoDelCatalogo(p, zona))
    if (catalogo.length === 0) {
      return NextResponse.json(
        { error: 'No pude leer el catalogo. No propongo nada a ciegas.' },
        { status: 500 }
      )
    }

    const lineas: LineaCotizada[] = []
    for (let i = 0; i < pedidos.length; i++) {
      const pedido = pedidos[i]
      const idProducto = String(pedido.id_producto ?? '')
      let producto: ProductoDelCatalogo | undefined

      if (idProducto !== '') {
        producto = catalogo.find((p) => p.id === idProducto)
        if (!producto) {
          return NextResponse.json(
            { error: 'Ese producto ya no esta en el catalogo. Vuelve a dictarlo.' },
            { status: 422 }
          )
        }
      } else {
        const hallazgo = buscarProducto(pedido.producto, catalogo)
        if (!hallazgo.ok) {
          const dicho = String(pedido.producto ?? '').trim()
          // D39 (2026-09-19): *"No encontre X en el catalogo"* deja de ser una
          // respuesta aceptable cuando el catalogo son tres botellas. Le echaba
          // al usuario la culpa de no conocer el nombre interno del inventario.
          // Ahora se ofrecen las que hay **con su tamano a la vista**, y la
          // pregunta dice que si se entendio.
          const mensaje =
            hallazgo.motivo === 'sin-nombre'
              ? 'No entendi que producto cotizar.'
              : preguntaDeProducto(dicho, hallazgo.candidatos, 'cotizar')
          return NextResponse.json({
            ok: false,
            hay_que_elegir: true,
            campo: 'producto',
            indice: i,
            motivo: hallazgo.motivo,
            mensaje,
            opciones: opcionesDeProducto(hallazgo.candidatos)
          })
        }
        producto = hallazgo.elegido
      }

      lineas.push({ producto, cantidad: Number(pedido.cantidad) })
    }

    // ── D51: EL MONTO OBJETIVO ──────────────────────────────────────────────
    // Se escala DESPUES de resolver los productos, porque el precio sale del
    // catalogo y de la cascada del comprador — nunca de lo que dijo el modelo.
    const avisosPrevios: string[] = []
    // ── D67 (Fase 7): "NO VINO" NO ES LO MISMO QUE "VINO Y NO SIRVE" ────────
    // Hasta hoy `Number(cuerpo.objetivo ?? 0)` y `objetivo > 0`: un -500, un 0 o
    // un "abc" se ignoraban y la ruta contestaba 200 con la cotizacion SIN
    // escalar, sin decir que el objetivo se tiro. Es la clase de silencio de D49.
    // Ausente (undefined, null o "") = cotizacion normal. Presente y no es un
    // numero > 0 = 422 con el motivo. `escalarAObjetivo` ya lo rechazaba; la
    // ruta nunca se lo pasaba.
    const crudoObjetivo = cuerpo.objetivo
    const vinoObjetivo =
      crudoObjetivo !== undefined && crudoObjetivo !== null && crudoObjetivo !== ''
    const objetivo = vinoObjetivo ? Number(crudoObjetivo) : 0
    if (
      vinoObjetivo &&
      (typeof crudoObjetivo === 'boolean' || !Number.isFinite(objetivo) || objetivo <= 0)
    ) {
      return NextResponse.json(
        {
          ok: false,
          motivo: 'objetivo_invalido',
          error: `No entendi el monto objetivo (${String(crudoObjetivo)}). Te cotizo sin escalar, o dime el monto.`
        },
        { status: 422 }
      )
    }
    if (vinoObjetivo) {
      const escalado = escalarAObjetivo(
        lineas.map((l) => ({
          precioUnitario: precioParaComprador(l.producto, comprador),
          cantidad: Number(l.cantidad)
        })),
        objetivo
      )
      if (!escalado.ok) {
        return NextResponse.json({ error: escalado.error }, { status: 422 })
      }
      for (let i = 0; i < lineas.length; i++) lineas[i].cantidad = escalado.cantidades[i]
      // **Se ensena el total que se logro, no el que se pidio.** "Lo mas cercano
      // son $14,984" es la mitad honesta de haber hecho la cuenta; decir 15,000
      // cuando salieron 14,984 seria el mismo defecto de D48 con numeros.
      const pide = objetivo.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      const logra = escalado.total.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      avisosPrevios.push(
        escalado.total === objetivo
          ? `Ajuste las cantidades para llegar a $${pide}.`
          : `Pediste cerca de $${pide}; con piezas enteras lo mas cercano son $${logra}.`
      )
    }

    const hoy = fechaLocal(new Date())
    const contextoCotizacion = {
      idVendedor: identidad.idEntidad,
      nombreVendedor: identidad.nombreEntidad,
      comprador,
      nombreProspecto,
      zona,
      etiqueta: identidad.etiqueta,
      hoy,
      lineas,
      avisosPrevios
    }

    // ── D55/D56: EL DESCUENTO, Y SU TOPE ────────────────────────────────────
    // Mismo procedimiento que en `venta/proponer`, y por las mismas razones:
    // el subtotal de lista lo calcula la funcion pura, el tope lo impone la
    // RUTA (no el prompt), y arriba del tope sale **422** sin escribir nada.
    const deLista = normalizarCotizacion(cuerpo.propuesta ?? {}, contextoCotizacion)
    if (!deLista.ok) {
      return NextResponse.json({ error: deLista.error }, { status: 422 })
    }

    const descuento = aplicarDescuento(
      deLista.payload.total,
      (cuerpo.propuesta as { descuento?: unknown } | undefined)?.descuento
    )
    if (!descuento.ok) {
      return NextResponse.json({ error: descuento.error }, { status: 422 })
    }

    const normalizada = descuento.hay
      ? normalizarCotizacion(cuerpo.propuesta ?? {}, { ...contextoCotizacion, descuento })
      : deLista
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
    }

    // Un solo borrador PENDIENTE por persona, igual que las otras cuatro fases.
    await supabase
      .from('bot_borradores')
      .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
      .eq('telegram_id', telegramId)
      .eq('estado', 'PENDIENTE')

    const sello = sellarCotizacion(normalizada.payload)
    const paraQuien = comprador?.nombre ?? nombreProspecto ?? ''

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        payload: {
          tipo: 'cotizacion',
          cotizacion: normalizada.payload,
          meta: {
            desglose: normalizada.desglose,
            avisos: normalizada.avisos,
            para_quien: paraQuien,
            es_de_la_red: comprador !== null,
            vigente_hasta: normalizada.vigenteHasta,
            // Solo la etiqueta. Las cifras ya van selladas en `cotizacion`.
            motivo_descuento: descuento.motivo
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de cotizacion:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      para_quien: paraQuien,
      es_de_la_red: comprador !== null,
      total: normalizada.payload.total,
      vigencia_dias: normalizada.payload.vigencia_dias,
      vigente_hasta: normalizada.vigenteHasta,
      clientes: opcionesDeCliente(clientes),
      mensaje: mensajeDeConfirmacionCotizacion(
        normalizada.payload,
        normalizada.desglose,
        normalizada.avisos,
        {
          paraQuien,
          esDeLaRed: comprador !== null,
          vigenteHasta: normalizada.vigenteHasta,
          motivoDescuento: descuento.motivo
        }
      )
    })
  } catch (e) {
    console.error('[bot] proponer cotizacion reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
