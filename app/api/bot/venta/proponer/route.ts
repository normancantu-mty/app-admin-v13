/**
 * AG-05 Fase 3 — LA VENTA. Se propone completa y se SELLA. Aqui no se vende nada.
 *
 * Entra lo que el LLM extrajo (que productos, cuantos, a quien, de contado o a
 * concesion). Sale un borrador guardado del lado del servidor, con su sello, y
 * el texto que la persona va a leer. **Este endpoint no toca `ticket_detalles`,
 * ni `finanzas_ledger`, ni `inventario_ledger`.** Escribir es trabajo de
 * `/api/bot/venta/confirmar`, y lo hace llamando a `registrarVenta`, que es el
 * mismo motor de la pantalla.
 *
 * ─── LO QUE ESTE ENDPOINT DECIDE Y EL MODELO NO ─────────────────────────────
 *   · el `id_producto`  — el modelo manda un NOMBRE; se empata contra
 *     `catalogo_productos` (nombre o SKU) y si hay duda se pregunta con botones.
 *   · el `id_comprador` — igual, contra la red, menos el centinela.
 *   · **el PRECIO**     — de `listas_precios` por la zona del comprador, y por
 *     `calculateWaterfall` cuando el comprador es DST o LOC. El modelo no pone
 *     ni un peso: si dicto un monto, se compara y se avisa (ver `bot-venta.ts`).
 *   · el vendedor       — siempre la entidad de la identidad. No hay campo.
 *   · la cuenta         — de la lista cerrada de `bot_identidades`.
 *
 * ─── POR QUE SOLO ADMIN, HOY ────────────────────────────────────────────────
 * Misma decision que la cobranza de la Fase 2, y por la misma razon: hoy la
 * unica identidad dada de alta es ADMIN (Norman), asi que abrirlo a DST o LOC
 * seria escribir un camino que nadie recorre y que nadie ha probado. Una venta
 * de un distribuidor mueve ademas su comision y su deuda con la matriz — no es
 * el mismo movimiento con otro nombre. **El dia que se de de alta un
 * distribuidor esto se decide antes, no se descubre despues.**
 *
 * `registrarVenta` ya lo comprobaria por su cuenta (rechaza operar con otro
 * vendedor, y exige ADMIN para triangular). Esto de aqui es la puerta de
 * enfrente: sirve para dar un mensaje que se entiende en vez de un error del
 * motor a mitad de la captura.
 */

import { NextResponse } from 'next/server'
import { preguntaDeProducto } from '@/lib/bot-tamanos'
import type { Json } from '@/types/database'
import {
  clienteDeServicio,
  conservaPendientes,
  leerCatalogoDeVenta,
  leerCompradoresDeVenta,
  leerCuentaDeVenta,
  resolverIdentidad,
  tokenValido
} from '@/lib/bot-servidor'
import {
  aProductoDelCatalogo,
  buscarProducto,
  mensajeDeConfirmacionVenta,
  normalizarCondicionPago,
  normalizarVenta,
  pideTriangulacion,
  RECHAZO_CUENTA_FISCAL,
  RECHAZO_TRIANGULACION,
  sellarVenta,
  tipoFiscalidadDeCuenta,
  ZONA_POR_DEFECTO,
  type CompradorDeVenta,
  type LineaPedida,
  type ProductoDelCatalogo
} from '@/lib/bot-venta'
import { buscarPorNombre } from '@/lib/bot-nombres'
import { aplicarDescuento } from '@/lib/bot-descuento'
import { esCuentaFiscal } from '@/lib/venta-cuenta-fiscal'

export const dynamic = 'force-dynamic'

/** Cuantas opciones se ofrecen como botones cuando hay que preguntar. */
const TOPE_OPCIONES = 9

/** Una venta de mas renglones distintos que esto se captura en la pantalla. */
const TOPE_RENGLONES = 12

interface ProductoPedido {
  producto?: unknown
  /** Cuando ya se eligio con un boton. Se valida contra el catalogo igual. */
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

function opcionesDeComprador(lista: readonly CompradorDeVenta[]) {
  return lista.slice(0, TOPE_OPCIONES).map((c) => ({
    id: c.id,
    nombre: c.nombre,
    rol: c.rol
  }))
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
      /** El nombre que dijo la persona. Solo se usa para BUSCAR, nunca se escribe. */
      comprador?: unknown
      /** Cuando la persona ya eligio con un boton: el uuid, validado contra la red. */
      id_comprador?: unknown
      /** El boton "publico en general": no hay comprador y no hay que preguntar. */
      publico?: unknown
      id_cuenta?: unknown
      /** Solo existe para poder RECHAZARLO por nombre. Ver `pideTriangulacion`. */
      origen_inventario?: unknown
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
        { error: 'Capturar ventas por chat es de la matriz; tu alta no alcanza.' },
        { status: 403 }
      )
    }

    // ── EL ALCANCE, RECHAZADO POR NOMBRE Y ANTES DE NADA ────────────────────
    // Se comprueba aqui arriba, no al final: si el mensaje pedia una
    // triangulacion, todo lo que venga despues (productos, precios, cuenta) se
    // habria resuelto para una venta que de todas formas no se va a proponer.
    if (pideTriangulacion(cuerpo.origen_inventario, identidad.idEntidad)) {
      return NextResponse.json({ error: RECHAZO_TRIANGULACION }, { status: 422 })
    }

    // ── La cuenta: la de la identidad, o una de SU lista cerrada ────────────
    const pedida = String(cuerpo.id_cuenta ?? '')
    if (pedida !== '' && !identidad.cuentas.some((c) => c.id === pedida)) {
      return NextResponse.json({ error: 'Esa cuenta no es tuya o esta vetada.' }, { status: 422 })
    }
    const idCuentaDestino = pedida !== '' ? pedida : identidad.idCuenta

    const cuenta = await leerCuentaDeVenta(supabase, idCuentaDestino)
    if (!cuenta) {
      return NextResponse.json(
        { error: 'No encuentro esa cuenta. Vuelve a dictarlo.' },
        { status: 422 }
      )
    }
    // La MITAD QUE CONVIERTE EL FILTRO EN REGLA. `cuentaUsableporElBot` ya saca
    // las cuentas fiscales de `identidad.cuentas`, asi que esto no deberia poder
    // pasar — y por eso mismo se comprueba: el dia que alguien cambie aquel
    // filtro, el que avisa es este, en vez de que una venta facturada se cuele
    // por chat con el comprador sin validar.
    if (esCuentaFiscal(cuenta.tipo_fiscalidad)) {
      return NextResponse.json({ error: RECHAZO_CUENTA_FISCAL }, { status: 422 })
    }
    // Y el regimen que si queda se lee de la COLUMNA, no del nombre (ERP-21).
    // Un valor que no se reconoce se detiene: es lo mismo que hace el motor al
    // escribir, y adelantarlo aqui evita proponer una venta que va a reventar.
    const tipoFiscalidadCuenta = tipoFiscalidadDeCuenta(cuenta.tipo_fiscalidad)
    if (!tipoFiscalidadCuenta) {
      return NextResponse.json(
        {
          error:
            `La cuenta "${cuenta.nombre}" tiene un regimen fiscal que no reconozco. ` +
            'No capturo la venta: adivinarlo inventa impuestos.'
        },
        { status: 422 }
      )
    }

    const condicionPago = normalizarCondicionPago(cuerpo.propuesta?.condicion_pago)

    // ── EL COMPRADOR ────────────────────────────────────────────────────────
    // El vendedor no puede ser su propio comprador, asi que **tampoco se ofrece
    // como boton**. `normalizarVenta` lo rechazaria de todas formas, pero un
    // boton que al oprimirlo contesta "no escribo eso" es un boton que no debio
    // estar ahi: la lista que se ensena y la lista que se acepta son la misma.
    const compradores = (await leerCompradoresDeVenta(supabase)).filter(
      (c) => c.id !== identidad.idEntidad
    )
    const idCompradorPedido = String(cuerpo.id_comprador ?? '')
    const nombreDicho = String(cuerpo.comprador ?? '').trim()
    const esPublico = cuerpo.publico === true

    let comprador: CompradorDeVenta | null = null

    if (esPublico) {
      // Un boton explicito. En CONCESION no vale: una consignacion sin dueno es
      // justo la fila que la cola de avisos (W4) existe para limpiar.
      if (condicionPago === 'CONCESION') {
        return NextResponse.json(
          { error: 'A concesion no hay "publico en general": alguien se la llevo. Quien?' },
          { status: 422 }
        )
      }
    } else if (idCompradorPedido !== '') {
      comprador = compradores.find((c) => c.id === idCompradorPedido) ?? null
      if (!comprador) {
        return NextResponse.json(
          { error: 'Ese comprador ya no esta en la red. Vuelve a dictarlo.' },
          { status: 422 }
        )
      }
    } else if (nombreDicho !== '') {
      const hallazgo = buscarPorNombre(nombreDicho, compradores, (c) => [c.nombre])
      if (!hallazgo.ok) {
        const mensaje =
          hallazgo.motivo === 'ambiguo'
            ? `"${nombreDicho}" me da mas de uno. Cual es?`
            : `No encontre a "${nombreDicho}" en la red. Es alguno de estos?`
        return NextResponse.json({
          ok: false,
          hay_que_elegir: true,
          campo: 'comprador',
          motivo: hallazgo.motivo,
          mensaje,
          // El boton de publico en general solo se ofrece cuando de verdad es
          // una opcion valida para esta venta.
          permite_publico: condicionPago === 'CONTADO',
          opciones: opcionesDeComprador(hallazgo.candidatos)
        })
      }
      comprador = hallazgo.elegido
    } else if (condicionPago === 'CONCESION') {
      // No dijo a quien y la venta es a credito. **Se pregunta**, no se cae al
      // centinela: aqui todavia no se ha escrito nada, y preguntar cuesta un
      // boton mientras que un "PENDIENTE DE ASIGNAR" cuesta una deuda que nadie
      // debe y un aviso que alguien tiene que ir a cerrar.
      return NextResponse.json({
        ok: false,
        hay_que_elegir: true,
        campo: 'comprador',
        motivo: 'sin-nombre',
        mensaje: 'A quien se la fiaste?',
        permite_publico: false,
        opciones: opcionesDeComprador(compradores)
      })
    }
    // Si llego hasta aqui con `comprador` en null y es CONTADO, es publico en
    // general: la forma legitima y de siempre de una venta de mostrador.

    if (comprador && comprador.id === identidad.idEntidad) {
      return NextResponse.json(
        { error: 'Ese comprador eres tu mismo. No escribo eso.' },
        { status: 422 }
      )
    }

    // ── LOS PRODUCTOS ───────────────────────────────────────────────────────
    const pedidos = Array.isArray(cuerpo.productos) ? cuerpo.productos : []
    if (pedidos.length === 0) {
      return NextResponse.json({ error: 'No entendi que producto se vendio.' }, { status: 422 })
    }
    if (pedidos.length > TOPE_RENGLONES) {
      return NextResponse.json(
        {
          error:
            `Son ${pedidos.length} renglones distintos. Una venta asi va en la pantalla: ` +
            'por chat no se alcanza a revisar antes de decir que va.'
        },
        { status: 422 }
      )
    }

    const zona = comprador?.zona || ZONA_POR_DEFECTO
    const catalogo = (await leerCatalogoDeVenta(supabase)).map((p) =>
      aProductoDelCatalogo(p, zona)
    )
    if (catalogo.length === 0) {
      return NextResponse.json(
        { error: 'No pude leer el catalogo. No propongo nada a ciegas.' },
        { status: 500 }
      )
    }

    const lineas: LineaPedida[] = []
    for (let i = 0; i < pedidos.length; i++) {
      const pedido = pedidos[i]
      const idPedido = String(pedido.id_producto ?? '')
      let producto: ProductoDelCatalogo | undefined

      if (idPedido !== '') {
        // Vino de un boton. **Se valida contra el catalogo igual**: el proceso
        // del bot no puede nombrar un producto que no este a la venta.
        producto = catalogo.find((p) => p.id === idPedido)
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
              ? 'No entendi que producto se vendio.'
              : preguntaDeProducto(dicho, hallazgo.candidatos, 'vender')
          // Se pregunta **por renglon**, y el `indice` dice cual: una venta de
          // tres productos con dos ambiguos se resuelve en dos botones, no
          // volviendo a dictar la venta entera.
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

    const contextoVenta = {
      idVendedor: identidad.idEntidad,
      nombreVendedor: identidad.nombreEntidad,
      comprador,
      idCuentaDestino,
      nombreCuentaDestino: cuenta.nombre,
      tipoFiscalidadCuenta,
      etiqueta: identidad.etiqueta,
      lineas
    }

    // ── D55/D56: EL DESCUENTO, Y SU TOPE ────────────────────────────────────
    //
    // **El tope se impone AQUI, en la ruta, y no en el prompt.** Un prompt se
    // negocia, una ruta no: por mas que el modelo se convenza de que el 60% va,
    // el 422 sale igual y no se escribe nada.
    //
    // Se normaliza DOS VECES a proposito, y no es desperdicio:
    //   1. la primera, sin descuento, para que el **subtotal de lista** salga de
    //      `listas_precios` y de la cascada, que es el unico lugar de donde
    //      puede salir un precio;
    //   2. `aplicarDescuento` sobre ese subtotal, que es donde vive el tope;
    //   3. la segunda, ya con el descuento resuelto, que es la que se sella.
    //
    // La alternativa era copiar aqui el bucle de precios para calcular el
    // subtotal, y ese es justo el patron que en `pos.ts` / `auditoria.ts` ya
    // produjo drift (ver `BACKLOG.md` TKT-034/035). `normalizarVenta` es pura;
    // llamarla dos veces cuesta microsegundos y garantiza que el numero sobre el
    // que se descuenta sea **exactamente** el que se va a escribir.
    const deLista = normalizarVenta(cuerpo.propuesta ?? {}, contextoVenta)
    if (!deLista.ok) {
      return NextResponse.json({ error: deLista.error }, { status: 422 })
    }

    const descuento = aplicarDescuento(
      deLista.payload.subtotal_catalogo,
      (cuerpo.propuesta as { descuento?: unknown } | undefined)?.descuento
    )
    if (!descuento.ok) {
      return NextResponse.json({ error: descuento.error }, { status: 422 })
    }

    const normalizada = descuento.hay
      ? normalizarVenta(cuerpo.propuesta ?? {}, { ...contextoVenta, descuento })
      : deLista
    if (!normalizada.ok) {
      return NextResponse.json({ error: normalizada.error }, { status: 422 })
    }

    // ── Un solo borrador PENDIENTE por persona ──────────────────────────────
    // La misma regla de las Fases 1 y 2, y **compartida con ellas a proposito**:
    // proponer una venta cancela un gasto o un abono a medias y al reves. Con
    // dos borradores abiertos de distinto tipo, un "va" seria ambiguo.    // Fase 8 (D79): con `conservar_pendientes` la propuesta se SUMA a las que
    // esperan su boton (varios hechos en un mensaje). Sin el, lo de siempre.
    if (!conservaPendientes(cuerpo)) {
      await supabase
        .from('bot_borradores')
        .update({ estado: 'CANCELADO', resuelto_en: new Date().toISOString() })
        .eq('telegram_id', telegramId)
        .eq('estado', 'PENDIENTE')
    }

    const sello = sellarVenta(normalizada.payload)
    const nombreComprador = comprador?.nombre ?? 'Publico en General'

    const { data: borrador, error } = await supabase
      .from('bot_borradores')
      .insert({
        telegram_id: telegramId,
        sello,
        payload: {
          // El discriminador. Sin el, `/venta/confirmar` tendria que adivinar el
          // tipo por la forma del objeto, y adivinar es justo lo que este
          // sistema no hace con nada que escriba dinero.
          tipo: 'venta',
          venta: normalizada.payload,
          meta: {
            nombre_vendedor: identidad.nombreEntidad,
            nombre_comprador: nombreComprador,
            rol_comprador: comprador?.rol ?? 'PUBLICO',
            zona,
            nombre_cuenta_destino: cuenta.nombre,
            desglose: normalizada.desglose,
            avisos: normalizada.avisos,
            // Solo la etiqueta ("promocion de septiembre"). Las cifras ya van
            // en `venta.subtotal_catalogo` / `venta.total_cobrado_real`, que
            // son las selladas; esto es para que el rastro diga POR QUE.
            motivo_descuento: descuento.motivo
          }
        } as unknown as Json
      })
      .select('id')
      .single()

    if (error || !borrador) {
      console.error('[bot] no se pudo guardar el borrador de venta:', error)
      return NextResponse.json({ error: 'No pude guardar la propuesta.' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      borrador_id: borrador.id,
      sello,
      id_comprador: comprador?.id ?? null,
      nombre_comprador: nombreComprador,
      id_cuenta: idCuentaDestino,
      cuentas: identidad.cuentas,
      total: normalizada.payload.total_cobrado_real,
      mensaje: mensajeDeConfirmacionVenta(
        normalizada.payload,
        {
          nombreVendedor: identidad.nombreEntidad,
          nombreComprador,
          nombreCuentaDestino: cuenta.nombre,
          desglose: normalizada.desglose,
          motivoDescuento: descuento.motivo
        },
        normalizada.avisos
      )
    })
  } catch (e) {
    console.error('[bot] proponer venta reviento:', e)
    return NextResponse.json({ error: 'Error interno.' }, { status: 500 })
  }
}
