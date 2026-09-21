/**
 * AG-05 Fase 3 — La logica pura de la VENTA por Telegram.
 *
 * Mismo principio que las Fases 1 y 2: **el LLM propone; de aqui en adelante
 * nadie lo vuelve a generar.** Se normaliza contra listas cerradas, se sella, se
 * ensena, y lo que se escribe es ese objeto exacto.
 *
 * ─── LO QUE ESTE ARCHIVO **NO** HACE, Y ES LO MAS IMPORTANTE ────────────────
 *
 * **No calcula ni una comision, ni un impuesto que se escriba, ni una deduccion
 * de inventario.** Todo eso vive en `lib/venta-servidor.ts` (`registrarVenta`),
 * que es el MISMO codigo que corre la pantalla del POS. Este archivo solo arma
 * el `ProcesarVentaPOSPayload` —quien vende, a quien, que renglones y a que
 * precio— y lo sella. Si algun dia hay que cambiar una regla del dinero, se
 * cambia alla y este archivo ni se entera: es exactamente la propiedad por la
 * que se extrajo la venta de la sesion en vez de copiarla al bot.
 *
 * Los impuestos que SI se calculan aqui (`calculateReverseTaxes`) son **para el
 * mensaje que la persona lee**, no para la fila: `registrarVenta` los vuelve a
 * calcular por su cuenta con la misma funcion y la misma cuenta. Si algun dia
 * discreparan, manda la fila — y la prueba `tests/bot-venta.spec.ts` compara las
 * dos para que eso no pase callado.
 *
 * ─── EL ALCANCE, DECLARADO EN EL CODIGO Y NO EN UN COMENTARIO ───────────────
 *
 * El bot cubre **la venta que Norman dicta de verdad**: contado o concesion,
 * comprador directo o publico en general, desde el inventario de quien vende.
 *
 * **La triangulacion de inventario se RECHAZA por nombre** (`RECHAZO_TRIANGULACION`).
 * Son cinco campos acoplados —vendedor, origen de inventario, comprador LOC, su
 * DST padre y la cuenta— donde equivocarse mueve dinero de terceros: le abona
 * deuda a un distribuidor que no vendio, o le paga comision al que no puso la
 * mercancia. Un rechazo explicito es una implementacion completa de un alcance
 * declarado; media implementacion silenciosa no.
 *
 * Lo mismo con la **cuenta fiscal** (`FULL_TAX`): una venta facturada separa IVA
 * e IEPS reales contra el SAT y exige que el comprador sea un LOC
 * (`validarCompradorContraCuentaFiscal`). Esa va en la pantalla. El bot ni la
 * ofrece —`cuentaUsableporElBot` ya la filtra de `identidad.cuentas`— y ademas
 * la rechaza por nombre aqui, que es la mitad que convierte el filtro en regla.
 */

import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'
import { calculateWaterfall } from '@/lib/pricing-waterfall'
import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { buscarPorNombre, type ResultadoNombre } from '@/lib/bot-nombres'
import { candidatosPorTamano } from '@/lib/bot-tamanos'
import {
  TOPE_DESCUENTO_PORCENTAJE,
  descuentoDelPayload,
  lineasDeDescuento,
  sinDescuento,
  type DescuentoAplicado
} from '@/lib/bot-descuento'

// ============================================================================
// 1. LOS DOS RECHAZOS DEL ALCANCE
// ============================================================================

export const RECHAZO_TRIANGULACION =
  'Esa es una venta triangulada (sale del inventario de un distribuidor y la cobra la ' +
  'matriz). Eso va en la pantalla: son cinco datos amarrados y equivocarme ahi le mueve ' +
  'el dinero a un tercero.'

/**
 * El regimen de la cuenta, o `null` si la columna trae algo que no se reconoce.
 *
 * **Refleja a `resolveTipoFiscalidadCuenta` de `lib/venta-servidor.ts`, que ante
 * un valor raro LANZA** en vez de suponer LIBRE. Aqui devuelve `null` y el
 * endpoint contesta con una frase; el motor sigue siendo el que manda al
 * escribir. Suponer LIBRE ante un valor desconocido seria dejar de separar IVA e
 * IEPS sin que nadie se entere — la falla silenciosa exacta que ERP-21 cerro al
 * mover la fiscalidad del NOMBRE de la cuenta a su COLUMNA.
 */
export function tipoFiscalidadDeCuenta(raw: string | null | undefined): TipoFiscalidad | null {
  const valor = (raw ?? '').toUpperCase()
  return valor === 'FULL_TAX' || valor === 'IVA_ONLY' || valor === 'LIBRE' ? valor : null
}

export const RECHAZO_CUENTA_FISCAL =
  'Esa venta va contra la cuenta fiscal, o sea facturada con IVA e IEPS. Eso va en la ' +
  'pantalla: el comprador tiene que ser un local y el desglose lo revisa el contador.'

/**
 * Hay triangulacion si se pidio un origen de inventario que NO es el vendedor.
 *
 * Se pregunta aqui, puro, para poder probarlo sin base: el endpoint solo mira lo
 * que devuelve esto. **Vacio no es triangulacion**: no decir nada significa
 * "sale de mi inventario", que es el caso de siempre.
 */
export function pideTriangulacion(origenPedido: unknown, idVendedor: string): boolean {
  const origen = String(origenPedido ?? '').trim()
  return origen !== '' && origen !== idVendedor
}

// ============================================================================
// 2. EL PRODUCTO — el modelo dice un NOMBRE, el servidor resuelve el uuid
// ============================================================================

export interface ProductoDelCatalogo {
  id: string
  sku: string | null
  nombre: string
  /** Mililitros por botella. `null` en lo que no es botella (la pasta). */
  ml_por_unidad: number | null
  /** El precio de lista YA resuelto por la zona del comprador. Lo pone el endpoint. */
  precio_final: number
}

/**
 * Empata contra el catalogo por nombre **o por SKU**, con el mismo criterio de
 * tres pasadas que el deudor (`lib/bot-nombres.ts`). Las dos formas valen igual:
 * Norman dice "plata 750" y tambien "plata-750".
 *
 * Si da mas de uno, o ninguno, **no se adivina**: se pregunta con botones.
 * Vender el producto equivocado no se corrige solo — hay que anular el ticket,
 * que ademas ya movio inventario.
 */
export function buscarProducto(
  dicho: unknown,
  catalogo: readonly ProductoDelCatalogo[]
): ResultadoNombre<ProductoDelCatalogo> {
  const porNombre = buscarPorNombre(dicho, catalogo, (p) =>
    p.sku ? [p.nombre, p.sku] : [p.nombre]
  )
  if (porNombre.ok) return porNombre

  // ── LA CUARTA PASADA: EL TAMANO (D37/D38, 2026-09-19) ────────────────────
  // Va DESPUES de las tres de nombre, no antes: un nombre que empata exacto
  // sigue ganando. Entra justo donde el comparador literal se rendia -- `750 ml`
  // con un espacio, `750` pelado, `3/4`, `grandes`, `mini` -- que es como Norman
  // escribe de verdad y es la conversacion que fracaso el 2026-09-19.
  //
  // Si el tamano deja MAS de uno (`chicas`: 250 o 50) no se adivina: se
  // devuelve `ambiguo` con esos candidatos y se pregunta con un boton. Y si no
  // deja ninguno, manda el resultado de nombre tal cual -- que es como
  // "20 de cerveza" sigue sin empatar con nada.
  const porTamano = candidatosPorTamano(dicho, catalogo)
  if (porTamano.length === 1) return { ok: true, elegido: porTamano[0] }
  if (porTamano.length > 1) return { ok: false, motivo: 'ambiguo', candidatos: porTamano }

  return porNombre
}

/**
 * La zona cuando el comprador no tiene una. **Es la misma constante y el mismo
 * default que `getPrecioAplicable` en `app/pos/page.tsx`** (`|| 'Zacatecas'`).
 * No es una preferencia: es la zona de calle, la que cobra Fresnillo.
 */
export const ZONA_POR_DEFECTO = 'Zacatecas'

export interface ProductoConPrecios {
  id: string
  sku: string | null
  nombre: string
  ml_por_unidad: number | null
  precios: readonly { zona: string; precio_final: number }[]
}

/**
 * Aplana el catalogo a la zona del comprador, igual que la pantalla.
 *
 * El `?? 0` es deliberado y copia a `getPrecioAplicable`: un producto sin precio
 * para esa zona vale cero aqui, y `normalizarVenta` lo rechaza por nombre en vez
 * de escribir una venta de cero pesos. La pantalla lo deja pasar porque ahi se
 * ve el renglon en $0.00 antes de cobrar; por chat no se ve nada, asi que la
 * unica forma de que no pase callado es detenerse.
 */
export function aProductoDelCatalogo(p: ProductoConPrecios, zona: string): ProductoDelCatalogo {
  return {
    id: p.id,
    sku: p.sku,
    nombre: p.nombre,
    ml_por_unidad: p.ml_por_unidad,
    precio_final: Number(p.precios.find((l) => l.zona === zona)?.precio_final ?? 0)
  }
}

// ============================================================================
// 3. EL PAYLOAD Y SU SELLO
// ============================================================================

export interface RenglonVenta {
  id_producto: string
  cantidad: number
  precio_unitario: number
  subtotal_linea: number
}

/**
 * Lo que se sella. **Es exactamente el `ProcesarVentaPOSPayload` que recibe
 * `registrarVenta`**, con los nombres de la base y no los de la pantalla, mas el
 * `usuario_creador` que sirve para volver a comprobar la identidad al confirmar.
 *
 * Los tres campos fiscales del payload del POS (`montoBaseIngreso`,
 * `impuestoIvaCalculado`, `impuestoIepsCalculado`) **no entran aqui a proposito**:
 * `registrarVenta` los ignora y los recalcula con `calculateReverseTaxes` contra
 * la cuenta destino (ver sus lineas del desglose fiscal). Sellar un numero que
 * el motor va a tirar seria sellar una promesa que nadie cumple.
 */
export interface PayloadVenta {
  id_vendedor: string
  id_comprador: string | null
  id_cuenta_destino: string
  condicion_pago: 'CONTADO' | 'CONCESION'
  items: RenglonVenta[]
  subtotal_catalogo: number
  total_cobrado_real: number
  usuario_creador: string
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_VENTA = [
  'condicion_pago',
  'id_comprador',
  'id_cuenta_destino',
  'id_vendedor',
  'items',
  'subtotal_catalogo',
  'total_cobrado_real',
  'usuario_creador'
] as const

export function ventaCanonica(payload: PayloadVenta): string {
  return canonizar(payload, LLAVES_VENTA)
}

export function sellarVenta(payload: PayloadVenta): string {
  return sellar(payload, LLAVES_VENTA)
}

export function selloVentaCoincide(payload: PayloadVenta, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_VENTA, sello)
}

// ============================================================================
// 4. LA PUERTA: lo que devuelve el LLM se normaliza aqui y en ningun otro lado
// ============================================================================

/** Arriba de esto no se captura por chat. Mismo tope que el abono, por la misma razon. */
export const TOPE_VENTA = 500000
/** Una sola linea de mas de mil piezas es casi siempre un "20" que se oyo "2000". */
export const TOPE_PIEZAS_POR_LINEA = 1000

export interface CompradorDeVenta {
  id: string
  nombre: string
  rol: string
  zona: string | null
  comision_base: number | null
  comision_base_local: number | null
  aplica_redondeo_costo: boolean | null
}

export interface LineaPedida {
  producto: ProductoDelCatalogo
  cantidad: number
}

export interface ContextoVenta {
  idVendedor: string
  nombreVendedor: string
  comprador: CompradorDeVenta | null
  idCuentaDestino: string
  nombreCuentaDestino: string
  tipoFiscalidadCuenta: TipoFiscalidad
  etiqueta: string
  lineas: readonly LineaPedida[]
  /**
   * El descuento **ya resuelto y ya topado por la ruta** (D55/D56).
   *
   * Va en el CONTEXTO y no en `PropuestaVentaLLM` a proposito, y la distincion
   * es la misma que separa `id_producto` de `producto`: lo que esta en la
   * propuesta es lo que dijo el modelo, y lo que esta en el contexto es lo que
   * el servidor ya verifico. `aplicarDescuento` corre en
   * `app/api/bot/venta/proponer/route.ts` y el que se pasa del tope nunca llega
   * hasta aqui: se va en **422**.
   */
  descuento?: DescuentoAplicado
}

export interface PropuestaVentaLLM {
  condicion_pago?: unknown
  /**
   * El total que la persona dijo, si lo dijo. **No se escribe nunca**: el precio
   * sale de `listas_precios` y de la cascada, no de la boca. Se usa solo para
   * avisar cuando los dos numeros no coinciden — ver `AVISO_MONTO_DISCREPA`.
   */
  monto?: unknown
}

/** Arriba de un peso de diferencia se avisa. Abajo es redondeo y no significa nada. */
export const TOLERANCIA_MONTO_DICHO = 1

export interface DesgloseRenglon {
  nombre: string
  cantidad: number
  precioLista: number
  precioUnitario: number
  subtotal: number
}

export interface ResultadoVentaOk {
  ok: true
  payload: PayloadVenta
  avisos: string[]
  desglose: DesgloseRenglon[]
  fiscal: { montoBase: number; iva: number; ieps: number }
}

export interface ResultadoVentaFallido {
  ok: false
  error: string
}

function roundTo2(valor: number): number {
  return Number(valor.toFixed(2))
}

/**
 * CONTADO salvo que se diga lo contrario, con las palabras que Norman usa.
 *
 * **El default es el que no genera deuda.** Equivocarse hacia CONTADO deja una
 * venta cobrada que en realidad esta fiada: se ve en la caja y se corrige. Al
 * reves, un CONCESION inventado le carga una deuda a alguien que ya pago, y esa
 * si se descubre cobrando dos veces.
 */
export function normalizarCondicionPago(dicho: unknown): 'CONTADO' | 'CONCESION' {
  const texto = String(dicho ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  // `fiar` se conjuga: "se la fie", "se la fio", "fiado", "fiada". Se listan las
  // formas con limite de palabra en vez de una raiz suelta — "fi" empataria
  // "fin", "fiesta" y "confirmar", y un CONCESION inventado le carga una deuda a
  // alguien que ya pago.
  if (
    /concesion|consigna|credito|a pagar|me paga despues|queda debiendo|\bfi(?:ado|ada|ar|e|o)\b/.test(
      texto
    )
  ) {
    return 'CONCESION'
  }
  return 'CONTADO'
}

/**
 * El precio de UNA pieza para este comprador.
 *
 * ─── ES EL MISMO CRITERIO QUE LA PANTALLA, A PROPOSITO ──────────────────────
 * Copia exacta de `getCostoFinalParaCarrito` (`app/pos/page.tsx`): precio de
 * lista para un cliente cualquiera; `calculateWaterfall(...).tuCosto` cuando el
 * comprador es DST o LOC, porque a un distribuidor no se le cobra el precio de
 * publico sino su costo. Se llama a la MISMA funcion con los MISMOS tres
 * argumentos —sin `simulacionFiscal`, o sea fiscalidad LIBRE— para que un
 * cambio en la cascada mueva las dos a la vez.
 */
export function precioParaComprador(
  producto: ProductoDelCatalogo,
  comprador: CompradorDeVenta | null
): number {
  if (comprador && (comprador.rol === 'DST' || comprador.rol === 'LOC')) {
    const cascada = calculateWaterfall(
      { listas_precios: [{ precio_final: producto.precio_final }] },
      comprador,
      comprador.rol
    )
    return roundTo2(cascada.tuCosto)
  }
  return roundTo2(producto.precio_final)
}

/**
 * Convierte lo que el endpoint ya resolvio en la venta exacta que se va a
 * escribir.
 *
 * **Nada de lo que el LLM manda llega crudo a la base.** El producto ya es un
 * uuid del catalogo (lo empato `buscarProducto`), el comprador ya es un uuid de
 * la red, la cuenta sale del alta, el precio sale de `listas_precios` y de la
 * cascada — el modelo no pone ni un numero. Lo unico suyo que sobrevive es
 * **cuantas piezas** y **si fue de contado**, y las dos se ensenan antes del
 * "va".
 */
export function normalizarVenta(
  propuesta: PropuestaVentaLLM,
  contexto: ContextoVenta
): ResultadoVentaOk | ResultadoVentaFallido {
  const avisos: string[] = []

  if (contexto.lineas.length === 0) {
    return { ok: false, error: 'No entendi que producto se vendio.' }
  }

  const condicionPago = normalizarCondicionPago(propuesta.condicion_pago)

  // Una concesion sin comprador entra a nombre del centinela "PENDIENTE DE
  // ASIGNAR" y abre un aviso W4 (`resolverCompradorDeVenta`). Eso es correcto
  // para la pantalla, donde la mercancia YA salio y hay que registrar el hecho;
  // aqui no, porque aqui todavia no se ha escrito nada y preguntar cuesta un
  // boton. Una deuda que nadie debe es exactamente lo que la cola de avisos
  // existe para limpiar: mejor no crearla.
  if (condicionPago === 'CONCESION' && !contexto.comprador) {
    return { ok: false, error: 'Una venta a concesion necesita saber a quien. Quien se la llevo?' }
  }

  // ── Los renglones. Se agrupan por producto ANTES de armar el payload ──────
  // `registrarVenta` suma las cantidades por producto para calcular la cascada
  // de stock, pero escribe un `ticket_detalles` por renglon. Dos renglones del
  // mismo producto en un ticket son un documento que se lee mal; y si alguien
  // dicta "10 de 750 y otras 5 de 750", lo que quiso decir son 15.
  const porProducto = new Map<string, { producto: ProductoDelCatalogo; cantidad: number }>()
  for (const linea of contexto.lineas) {
    const cantidad = Number(linea.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0 || !Number.isInteger(cantidad)) {
      return {
        ok: false,
        error: `No entendi cuantas piezas de ${linea.producto.nombre}. Tienen que ser piezas enteras.`
      }
    }
    const previa = porProducto.get(linea.producto.id)
    porProducto.set(linea.producto.id, {
      producto: linea.producto,
      cantidad: (previa?.cantidad ?? 0) + cantidad
    })
    if (previa) {
      avisos.push(
        `Junte los dos renglones de ${linea.producto.nombre}: quedan ` +
          `${previa.cantidad + cantidad} piezas en uno solo.`
      )
    }
  }

  const items: RenglonVenta[] = []
  const desglose: DesgloseRenglon[] = []
  for (const { producto, cantidad } of porProducto.values()) {
    if (cantidad > TOPE_PIEZAS_POR_LINEA) {
      return {
        ok: false,
        error:
          `${cantidad} piezas de ${producto.nombre} es demasiado para capturar por chat ` +
          `(el tope es ${TOPE_PIEZAS_POR_LINEA}). Si es correcto, va en la pantalla.`
      }
    }
    if (!(producto.precio_final > 0)) {
      return {
        ok: false,
        error:
          `${producto.nombre} no tiene precio de lista para esa zona. No invento un precio: ` +
          'capturalo en la pantalla o dame de alta el precio primero.'
      }
    }
    const precioUnitario = precioParaComprador(producto, contexto.comprador)
    if (!(precioUnitario > 0)) {
      return {
        ok: false,
        error: `El precio de ${producto.nombre} para ${contexto.comprador?.nombre ?? 'ese comprador'} me sale en cero. No lo escribo.`
      }
    }
    const subtotal = roundTo2(precioUnitario * cantidad)
    items.push({
      id_producto: producto.id,
      cantidad,
      precio_unitario: precioUnitario,
      subtotal_linea: subtotal
    })
    desglose.push({
      nombre: producto.nombre,
      cantidad,
      precioLista: roundTo2(producto.precio_final),
      precioUnitario,
      subtotal
    })
  }

  const total = roundTo2(items.reduce((suma, i) => suma + i.subtotal_linea, 0))
  if (!(total > 0)) {
    return { ok: false, error: 'La venta me sale en cero. No escribo eso.' }
  }
  if (total > TOPE_VENTA) {
    return {
      ok: false,
      error:
        `Una venta de ${total} pesos por chat no: el tope es ${TOPE_VENTA}. ` +
        'Si es correcto, se captura en la pantalla.'
    }
  }

  // ── D55/D56: EL DESCUENTO ─────────────────────────────────────────────────
  // Llega ya resuelto y ya topado por la ruta. **Se vuelve a revisar aqui** por
  // la misma razon por la que `_frase_de_hecho_suelto` revalida `otro_hecho`:
  // esta funcion es exportada y se llama desde una prueba, desde un endpoint y
  // manana desde donde sea. Una funcion que arma un payload de dinero no puede
  // confiar en que su llamador ya valido.
  const descuento = contexto.descuento ?? sinDescuento(total)
  if (Math.abs(descuento.subtotal - total) > 0.005) {
    return {
      ok: false,
      error: 'El descuento se calculo sobre un total que ya no es el mismo. No lo escribo.'
    }
  }
  if (descuento.porcentaje > TOPE_DESCUENTO_PORCENTAJE) {
    return {
      ok: false,
      error:
        `Un descuento de ${descuento.porcentaje}% no lo aplico por chat: ` +
        `el tope es ${TOPE_DESCUENTO_PORCENTAJE}%.`
    }
  }
  if (!(descuento.total > 0) || descuento.total > total + 0.005) {
    return { ok: false, error: 'Ese descuento me deja un cobro que no tiene sentido. No lo escribo.' }
  }
  if (descuento.hay) {
    avisos.push(
      `Lleva descuento: de lista ${pesos(descuento.subtotal)}, se cobran ` +
        `${pesos(descuento.total)}. La diferencia queda escrita en el ticket.`
    )
  }

  // ── El monto dicho contra el monto de lista ───────────────────────────────
  // **Avisa, no detiene.** El precio del ERP es el de `listas_precios` mas la
  // cascada, y ese es el que se escribe; lo que la persona dijo no puede entrar
  // a la fila porque entonces un numero dictado escribiria dinero directo. Pero
  // callarse la diferencia seria peor: si Norman dice "a tres mil" y de lista
  // salen 3,500, el que esta mal puede ser cualquiera de los dos —la lista sin
  // actualizar, o el precio que de verdad cobro— y **el unico que puede saber
  // cual es el que lo dijo**. Por eso se le ensena la diferencia en vez de
  // decidirla aqui.
  // **Se compara contra lo que se va a COBRAR, no contra la lista** (D55): con
  // un descuento dictado, el numero que la persona tiene en la cabeza es el
  // rebajado, y avisar de una diferencia que el descuento ya explica seria
  // ruido que ensena a ignorar los avisos.
  const dicho = Number(propuesta.monto)
  const cobrado = descuento.total
  if (Number.isFinite(dicho) && dicho > 0 && Math.abs(dicho - cobrado) > TOLERANCIA_MONTO_DICHO) {
    avisos.push(
      `Dijiste $${dicho.toFixed(2)} y me salen $${cobrado.toFixed(2)}. ` +
        'Voy a escribir el mio. Si el bueno es el otro, dimelo y lo capturamos en la pantalla.'
    )
  }

  if (contexto.comprador && contexto.comprador.id === contexto.idVendedor) {
    return { ok: false, error: 'El comprador y el vendedor son la misma entidad. No escribo eso.' }
  }

  // Solo para el mensaje. La fila la recalcula `registrarVenta` con esta misma
  // funcion y esta misma cuenta.
  //
  // **Sobre el COBRADO, no sobre la lista.** `registrarVenta` recalcula los
  // impuestos contra `totalCobradoReal`; si aqui se usara el de lista, un
  // ticket con descuento ensenaria un IVA que la fila no va a tener. La prueba
  // `tests/bot-venta.spec.ts` compara las dos para que no se separen callado.
  const fiscal = calculateReverseTaxes(descuento.total, contexto.tipoFiscalidadCuenta)
  if (fiscal.iva > 0 || fiscal.ieps > 0) {
    avisos.push(
      `Esa cuenta es ${contexto.tipoFiscalidadCuenta}: del total se separan ` +
        `$${fiscal.iva.toFixed(2)} de IVA y $${fiscal.ieps.toFixed(2)} de IEPS.`
    )
  }

  return {
    ok: true,
    avisos,
    desglose,
    fiscal: { montoBase: fiscal.montoBase, iva: fiscal.iva, ieps: fiscal.ieps },
    payload: {
      id_vendedor: contexto.idVendedor,
      id_comprador: contexto.comprador?.id ?? null,
      id_cuenta_destino: contexto.idCuentaDestino,
      condicion_pago: condicionPago,
      items,
      // ── D55 (Fase 6): AQUI ES DONDE LAS DOS COLUMNAS SE SEPARAN ───────────
      // Hasta hoy este comentario decia: *"son el mismo numero [...] el bot no
      // aplica descuentos: no hay campo donde dictarlos."* **Ya hay campo.**
      //
      // `subtotal_catalogo` es lo que cuesta de lista y `total_cobrado_real` es
      // lo que de verdad entra a la caja. Sin descuento siguen siendo el mismo
      // numero, bit por bit — `sinDescuento(total).total === total` — que es lo
      // que garantiza que una venta normal no cambie ni un centavo.
      subtotal_catalogo: total,
      total_cobrado_real: descuento.total,
      usuario_creador: `telegram:${contexto.etiqueta}`
    }
  }
}

// ============================================================================
// 5. EL MENSAJE DE CONFIRMACION
// ============================================================================

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Lo que lee la persona antes de decir "va".
 *
 * ─── POR QUE ENSENA EL PRECIO DE LISTA AL LADO DEL COBRADO ──────────────────
 * **Automation bias**: una confirmacion que se aprueba reconociendo el patron no
 * es una revision. En una venta a distribuidor el dato que de verdad puede estar
 * mal no es la cantidad —esa la dijo la persona— sino **que precio se le
 * aplico**, porque ese sale de la cascada y nadie lo dicto. Ensenar los dos
 * numeros juntos es lo unico que permite cacharlo sin abrir la pantalla.
 */
export function mensajeDeConfirmacionVenta(
  payload: PayloadVenta,
  contexto: {
    nombreVendedor: string
    nombreComprador: string
    nombreCuentaDestino: string
    desglose: readonly DesgloseRenglon[]
    /** Solo la etiqueta de la promocion. Las cifras salen del payload. */
    motivoDescuento?: string
  },
  avisos: readonly string[]
): string {
  const piezas = payload.items.reduce((suma, i) => suma + i.cantidad, 0)
  // **Las dos cifras salen del payload sellado**, no de una variable paralela:
  // ver `descuentoDelPayload`. Asi el mensaje no puede decir una cosa y la fila
  // otra ni aunque alguien cambie el orden de las llamadas.
  const descuento = descuentoDelPayload(
    payload.subtotal_catalogo,
    payload.total_cobrado_real,
    contexto.motivoDescuento ?? ''
  )

  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `VENTA ${payload.condicion_pago}`,
    `VENDE:      ${contexto.nombreVendedor}`,
    `COMPRA:     ${contexto.nombreComprador}`,
    ''
  ]

  for (const r of contexto.desglose) {
    const distinto =
      Math.abs(r.precioUnitario - r.precioLista) > 0.005
        ? `  (lista ${pesos(r.precioLista)})`
        : ''
    lineas.push(`   ${r.cantidad} x ${r.nombre} a ${pesos(r.precioUnitario)}${distinto} = ${pesos(r.subtotal)}`)
  }

  const cuantas = `(${piezas} ${piezas === 1 ? 'pieza' : 'piezas'})`
  if (descuento.hay) {
    // D55: **las dos cifras a la vista.** Un total mas bajo, solo, se lee como
    // un error de precios; con la lista al lado se lee como la promocion.
    const tres = lineasDeDescuento(descuento)
    tres[tres.length - 1] += `   ${cuantas}`
    lineas.push('', ...tres)
  } else {
    lineas.push('', `TOTAL:      ${pesos(payload.total_cobrado_real)}   ${cuantas}`)
  }

  if (payload.condicion_pago === 'CONTADO') {
    lineas.push(`El dinero entra a "${contexto.nombreCuentaDestino}".`)
  } else {
    lineas.push(`No entra dinero: queda a deber ${pesos(payload.total_cobrado_real)}.`)
  }

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}
