/**
 * AG-05 FASE 4 — LA COTIZACION. La logica pura de cotizar por Telegram.
 *
 * ─── EN QUE SE PARECE A UNA VENTA Y EN QUE NO ───────────────────────────────
 *
 * Se parece en lo unico que importa del precio: **la cifra sale del mismo lugar
 * y por el mismo camino**. `precioParaComprador` de `lib/bot-venta.ts` — la
 * misma funcion, no una copia — resuelve lista o cascada segun el rol de quien
 * recibe la cotizacion. Una cotizacion que promete un precio distinto del que
 * despues se cobra es peor que no cotizar.
 *
 * No se parece en nada mas, y ahi esta el diseno:
 *   · **no hay cuenta.** Una cotizacion no deposita en ningun lado.
 *   · **no hay condicion de pago.** Contado o concesion se decide el dia que se
 *     vende, no el dia que se promete.
 *   · **no hay impuestos.** El IVA y el IEPS dependen de la cuenta que reciba
 *     el dinero (ERP-21), y aqui no hay ninguna.
 *   · **no hay inventario.** Cotizar no aparta stock: si se apartara, cinco
 *     cotizaciones sin cerrar dejarian la bodega vacia en el sistema y llena en
 *     la realidad.
 *
 * ─── A QUIEN SE LE COTIZA ───────────────────────────────────────────────────
 * O es alguien de la red (`id_comprador`, y entonces el precio es SU costo), o
 * es un prospecto con nombre y nada mas (`nombre_prospecto`, y entonces el
 * precio es el de lista de la zona). **El caso normal es el segundo**: se cotiza
 * a quien todavia no compra.
 *
 * ─── LO QUE ESTE ARCHIVO NO DECIDE ──────────────────────────────────────────
 * El folio. `COT-0001` lo pone una `sequence` de Postgres en el `default` de la
 * columna (ERP-87). Aqui no se cuenta nada ni se arma ningun consecutivo: dos
 * cotizaciones dictadas al mismo tiempo se llevarian el mismo numero.
 */

import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { fechaParaPersona, sumarDias } from '@/lib/fechas'
import {
  precioParaComprador,
  TOPE_PIEZAS_POR_LINEA,
  TOPE_VENTA,
  type CompradorDeVenta,
  type ProductoDelCatalogo
} from '@/lib/bot-venta'
import {
  TOPE_DESCUENTO_PORCENTAJE,
  descuentoDelPayload,
  lineasDeDescuento,
  notaDeDescuento,
  sinDescuento,
  type DescuentoAplicado
} from '@/lib/bot-descuento'

// ============================================================================
// 1. EL PAYLOAD Y SU SELLO
// ============================================================================

export interface RenglonCotizacion {
  id_producto: string
  cantidad: number
  precio_unitario: number
}

export interface PayloadCotizacion {
  id_vendedor: string
  id_comprador: string | null
  nombre_prospecto: string | null
  zona: string
  vigencia_dias: number
  total: number
  notas: string
  usuario_creador: string
  items: RenglonCotizacion[]
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_COTIZACION = [
  'id_comprador',
  'id_vendedor',
  'items',
  'nombre_prospecto',
  'notas',
  'total',
  'usuario_creador',
  'vigencia_dias',
  'zona'
] as const

export function cotizacionCanonica(payload: PayloadCotizacion): string {
  return canonizar(payload, LLAVES_COTIZACION)
}

export function sellarCotizacion(payload: PayloadCotizacion): string {
  return sellar(payload, LLAVES_COTIZACION)
}

export function selloCotizacionCoincide(payload: PayloadCotizacion, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_COTIZACION, sello)
}

// ============================================================================
// 2. LA VIGENCIA
// ============================================================================

/**
 * Quince dias, que es lo que dice el prompt de la FASE 4.
 *
 * El default importa mas de lo que parece: una cotizacion sin fecha de
 * caducidad es una promesa de precio para siempre, y los precios se mueven.
 */
export const VIGENCIA_POR_DEFECTO = 15
/** El `CHECK` de la tabla dice lo mismo. Si cambia uno, cambia el otro. */
export const TOPE_VIGENCIA_DIAS = 365

// ============================================================================
// 2b. EL MONTO OBJETIVO — "que salga en unos 15,000" (D51, Fase 6)
// ============================================================================

/**
 * ─── LA CONVERSACION QUE ESTO CIERRA ────────────────────────────────────────
 *
 * 2026-09-19, con una cotizacion de $10,176.00 recien emitida en pantalla:
 *
 *   Norman: ahora quiere una cotizacion cuyo total sea lo mas cercano a 15,000
 *           pesos, manteniendo una proporcion semejante, hazme esa cotizacion
 *   Bot:    Que le cotizo?
 *   Norman: nose tu dimelo, haz las cuentas
 *   Bot:    Que le cotizo?
 *
 * Dos veces la misma respuesta, la segunda ya con la instruccion explicita
 * enfrente. **Norman creyo que habia sido demasiado exigente; no lo fue.** Los
 * tres precios estaban en la cotizacion que el bot acababa de emitir y la
 * operacion es una regla de tres.
 *
 * ─── POR QUE LA ARITMETICA VIVE AQUI Y NO EN EL PROMPT ──────────────────────
 *
 * Por la misma razon que `id_producto` es lista cerrada: **el modelo no inventa
 * precios.** Aqui entran los precios que ya resolvio el endpoint desde
 * `listas_precios` mas la cascada, y salen CANTIDADES. El modelo aporta un solo
 * numero —el que Norman dijo en voz alta— y ni siquiera lo multiplica.
 *
 * Y es aritmetica pura a proposito: sin catalogo, sin base y sin red, para que
 * `tests/bot-cotizacion.spec.ts` la pueda ejercitar de verdad en vez de leer su
 * codigo fuente.
 */

/** Cuantos pasos de ajuste fino como maximo. Con tres renglones sobran. */
export const TOPE_PASOS_AJUSTE = 40

/**
 * Cuanto puede moverse un renglon del escalado limpio, en tanto por uno.
 *
 * **Esto es lo que mantiene la "proporcion semejante" que pidio Norman.** Sin
 * tope, la busqueda del total mas cercano acabaria vaciando el renglon barato
 * para cuadrar el centavo: daria un total perfecto y una cotizacion que ya no
 * se parece a la que se pidio. Un 15% mueve lo suficiente para acercarse mucho
 * y poco para que la mezcla siga siendo la misma.
 */
export const MARGEN_DE_PROPORCION = 0.15

export interface RenglonEscalable {
  precioUnitario: number
  cantidad: number
}

export interface EscaladoOk {
  ok: true
  cantidades: number[]
  total: number
}

export interface EscaladoFallido {
  ok: false
  error: string
}

/**
 * Escala las cantidades para acercar el total a `objetivo`, en piezas ENTERAS.
 *
 * Dos pasadas, y la segunda es la que de verdad acerca:
 *   1. **regla de tres**, redondeando cada renglon a la pieza mas cercana y
 *      nunca por debajo de 1 — una cotizacion con un renglon en cero es otra
 *      cotizacion, no esta;
 *   2. **ajuste fino de a una pieza**, siempre el paso que mas acerca, dentro
 *      del `MARGEN_DE_PROPORCION` de cada renglon.
 *
 * Nunca devuelve cantidades en cero ni negativas. Cuando ni con una pieza de
 * cada cosa se baja del objetivo, **dice que no se puede** en vez de entregar
 * una cotizacion que no es la que se pidio.
 */
export function escalarAObjetivo(
  renglones: readonly RenglonEscalable[],
  objetivo: number
): EscaladoOk | EscaladoFallido {
  if (renglones.length === 0) {
    return { ok: false, error: 'No hay ninguna cotizacion anterior que escalar.' }
  }
  if (!Number.isFinite(objetivo) || objetivo <= 0) {
    return { ok: false, error: 'No entendi a que total quieres llegar.' }
  }

  const precios: number[] = []
  const actuales: number[] = []
  for (const r of renglones) {
    const precio = Number(r.precioUnitario)
    const cantidad = Number(r.cantidad)
    if (!Number.isFinite(precio) || precio <= 0) {
      return { ok: false, error: 'Un renglon no tiene precio. No escalo sobre eso.' }
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      return { ok: false, error: 'Un renglon no tiene cantidad. No escalo sobre eso.' }
    }
    precios.push(precio)
    actuales.push(cantidad)
  }

  const suma = (cs: readonly number[]) =>
    Number(cs.reduce((t, c, i) => t + c * precios[i], 0).toFixed(2))

  // Una pieza de cada cosa es el piso: por debajo de eso no hay cotizacion que
  // dar. Es el control negativo de Norman ("pedir $5") y se contesta diciendo
  // el numero, no con un "no se puede" pelado.
  const piso = suma(precios.map(() => 1))
  if (objetivo < piso) {
    return {
      ok: false,
      error:
        `Con esos productos lo menos que puedo armar son $${piso.toLocaleString('es-MX', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        })} (una pieza de cada uno). No llego a $${objetivo.toLocaleString('es-MX')}.`
    }
  }

  const totalActual = suma(actuales)
  const factor = objetivo / totalActual

  // ── 1. La regla de tres ───────────────────────────────────────────────────
  const cantidades = actuales.map((c) => Math.max(1, Math.round(c * factor)))

  // ── 2. El ajuste fino, dentro del margen que conserva la proporcion ───────
  const piso_i = cantidades.map((c) => Math.max(1, c - Math.max(1, Math.round(c * MARGEN_DE_PROPORCION))))
  const techo_i = cantidades.map((c) => c + Math.max(1, Math.round(c * MARGEN_DE_PROPORCION)))

  let distancia = Math.abs(suma(cantidades) - objetivo)
  for (let paso = 0; paso < TOPE_PASOS_AJUSTE; paso++) {
    let mejorI = -1
    let mejorD = 0
    let mejorDistancia = distancia
    for (let i = 0; i < cantidades.length; i++) {
      for (const d of [-1, 1]) {
        const propuesta = cantidades[i] + d
        if (propuesta < piso_i[i] || propuesta > techo_i[i]) continue
        cantidades[i] = propuesta
        const nueva = Math.abs(suma(cantidades) - objetivo)
        cantidades[i] = propuesta - d
        if (nueva < mejorDistancia) {
          mejorDistancia = nueva
          mejorI = i
          mejorD = d
        }
      }
    }
    if (mejorI === -1) break
    cantidades[mejorI] += mejorD
    distancia = mejorDistancia
  }

  return { ok: true, cantidades, total: suma(cantidades) }
}

// ============================================================================
// 3. LA PUERTA
// ============================================================================

export interface LineaCotizada {
  producto: ProductoDelCatalogo
  cantidad: number
}

export interface ContextoCotizacion {
  idVendedor: string
  nombreVendedor: string
  /** La entidad de la red a la que se cotiza, si es de la red. */
  comprador: CompradorDeVenta | null
  /** El nombre dicho, cuando NO es de la red. */
  nombreProspecto: string | null
  zona: string
  etiqueta: string
  hoy: string
  lineas: readonly LineaCotizada[]
  /**
   * Avisos que ya trae el endpoint y que tienen que salir en el MISMO mensaje
   * que Norman revisa antes del "va" — hoy solo el del monto objetivo (D51).
   * Van aqui y no concatenados despues porque el mensaje es uno solo: un aviso
   * que llega en otro globo se lee como si fuera de otra cosa.
   */
  avisosPrevios?: readonly string[]
  /**
   * El descuento **ya resuelto y ya topado por la ruta** (D55/D56). Misma razon
   * que en `ContextoVenta`: lo que esta en la propuesta lo dijo el modelo; lo
   * que esta en el contexto ya lo verifico el servidor.
   *
   * ─── DONDE QUEDA ESCRITO, SI `cotizaciones` NO TIENE DOS COLUMNAS ────────
   * La tabla solo tiene `total`. Asi que **`total` es el COBRADO** —que es el
   * numero que el cliente va a pagar y el que se convierte en la venta— y la
   * lista queda implicita en `items.precio_unitario`, que tambien va sellado.
   * El descuento se escribe ademas en `notas` (`notaDeDescuento`), para que el
   * papel lo diga con letras y no haya que restar para verlo.
   */
  descuento?: DescuentoAplicado
}

export interface PropuestaCotizacionLLM {
  vigencia_dias?: unknown
  notas?: unknown
}

export interface DesgloseCotizado {
  nombre: string
  cantidad: number
  precioUnitario: number
  subtotal: number
}

export interface ResultadoCotizacionOk {
  ok: true
  payload: PayloadCotizacion
  avisos: string[]
  desglose: DesgloseCotizado[]
  vigenteHasta: string
}

export interface ResultadoCotizacionFallido {
  ok: false
  error: string
}

function roundTo2(valor: number): number {
  return Number(valor.toFixed(2))
}

/**
 * Convierte lo que el endpoint ya resolvio en la cotizacion exacta que se va a
 * escribir. **Del LLM solo sobreviven las piezas, el nombre del prospecto y la
 * vigencia si la dijo** — todo lo demas son uuids del catalogo y precios de
 * `listas_precios`.
 */
export function normalizarCotizacion(
  propuesta: PropuestaCotizacionLLM,
  contexto: ContextoCotizacion
): ResultadoCotizacionOk | ResultadoCotizacionFallido {
  const avisos: string[] = [...(contexto.avisosPrevios ?? [])]

  // ── A QUIEN ─────────────────────────────────────────────────────────────
  const prospecto = String(contexto.nombreProspecto ?? '').trim()
  if (!contexto.comprador && prospecto === '') {
    return { ok: false, error: 'A quien se la cotizo?' }
  }
  if (contexto.comprador && contexto.comprador.id === contexto.idVendedor) {
    return { ok: false, error: 'Esa cotizacion es para ti mismo. A quien se la hago?' }
  }

  // ── LOS RENGLONES ───────────────────────────────────────────────────────
  if (contexto.lineas.length === 0) {
    return { ok: false, error: 'No entendi que cotizar. Que producto y cuantas piezas?' }
  }

  // Se agrupa por producto por la misma razon que el lote: la tabla tiene
  // `unique (id_cotizacion, id_producto)` y dos renglones del mismo producto
  // reventarian el INSERT entero.
  const porProducto = new Map<string, { producto: ProductoDelCatalogo; cantidad: number }>()
  for (const linea of contexto.lineas) {
    const cantidad = Number(linea.cantidad)
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      return { ok: false, error: `No entendi cuantas piezas de ${linea.producto.nombre}.` }
    }
    if (cantidad > TOPE_PIEZAS_POR_LINEA) {
      return {
        ok: false,
        error: `${cantidad} piezas de ${linea.producto.nombre} es mucho para dictarlo. Eso va en la pantalla.`
      }
    }
    const previo = porProducto.get(linea.producto.id)
    if (previo) {
      previo.cantidad += cantidad
      avisos.push(`${linea.producto.nombre} venia dos veces; lo junte en un renglon.`)
    } else {
      porProducto.set(linea.producto.id, { producto: linea.producto, cantidad })
    }
  }

  const items: RenglonCotizacion[] = []
  const desglose: DesgloseCotizado[] = []
  let total = 0

  for (const { producto, cantidad } of porProducto.values()) {
    const precioUnitario = precioParaComprador(producto, contexto.comprador)
    if (!(precioUnitario > 0)) {
      // Igual que en la venta: un precio de cero por chat no se ve, y una
      // cotizacion de cero pesos es una promesa de regalar el producto.
      return {
        ok: false,
        error: `${producto.nombre} no tiene precio para la zona ${contexto.zona}. No lo cotizo en cero.`
      }
    }
    const subtotal = roundTo2(precioUnitario * cantidad)
    total = roundTo2(total + subtotal)
    items.push({ id_producto: producto.id, cantidad, precio_unitario: precioUnitario })
    desglose.push({ nombre: producto.nombre, cantidad, precioUnitario, subtotal })
  }

  if (total > TOPE_VENTA) {
    // El mismo tope que la venta, y no uno mas flojo porque "una cotizacion no
    // mueve nada": esta cotizacion se convierte en esa venta. Lo que no se
    // puede capturar por chat tampoco se puede prometer por chat.
    return {
      ok: false,
      error: `Son $${total.toLocaleString('es-MX')}. Una cotizacion de ese tamano va en la pantalla.`
    }
  }

  // ── LA VIGENCIA ─────────────────────────────────────────────────────────
  let vigencia = VIGENCIA_POR_DEFECTO
  if (propuesta.vigencia_dias !== undefined && propuesta.vigencia_dias !== null) {
    const dicha = Number(propuesta.vigencia_dias)
    if (!Number.isInteger(dicha) || dicha <= 0 || dicha > TOPE_VIGENCIA_DIAS) {
      return { ok: false, error: `Una vigencia de ${propuesta.vigencia_dias} dias no la entendi.` }
    }
    vigencia = dicha
  }

  // ── D55/D56: EL DESCUENTO ───────────────────────────────────────────────
  // Se revalida aunque la ruta ya lo haya topado, por lo mismo que en la venta:
  // esta funcion la llama un endpoint, una prueba y manana cualquiera.
  const descuento = contexto.descuento ?? sinDescuento(total)
  if (Math.abs(descuento.subtotal - total) > 0.005) {
    return { ok: false, error: 'El descuento se calculo sobre un total que ya no es el mismo.' }
  }
  if (descuento.porcentaje > TOPE_DESCUENTO_PORCENTAJE) {
    return {
      ok: false,
      error:
        `Un descuento de ${descuento.porcentaje}% no lo cotizo por chat: ` +
        `el tope es ${TOPE_DESCUENTO_PORCENTAJE}%.`
    }
  }
  if (!(descuento.total > 0) || descuento.total > total + 0.005) {
    return { ok: false, error: 'Ese descuento me deja un total que no tiene sentido.' }
  }

  // La nota del descuento va ANTES de lo que haya dictado el modelo: lo primero
  // que se lee en el papel es por que el precio no es el de lista.
  const dictadas = String(propuesta.notas ?? '').trim()
  const nota = notaDeDescuento(descuento)
  const notas = [nota, dictadas].filter((n) => n !== '').join(' ')

  const payload: PayloadCotizacion = {
    id_vendedor: contexto.idVendedor,
    id_comprador: contexto.comprador?.id ?? null,
    nombre_prospecto: contexto.comprador ? null : prospecto,
    zona: contexto.zona,
    vigencia_dias: vigencia,
    total: descuento.total,
    notas,
    usuario_creador: `telegram:${contexto.etiqueta}`,
    items
  }

  return { ok: true, payload, avisos, desglose, vigenteHasta: sumarDias(contexto.hoy, vigencia) }
}

// ============================================================================
// 4. EL MENSAJE
// ============================================================================

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Lo que se lee antes del "va".
 *
 * La vigencia va en DIAS y en FECHA. "15 dias" se lee y no se retiene; "hasta
 * el 3 de octubre" es lo que de verdad se le dice al cliente, y es lo que hay
 * que poder desmentir si esta mal.
 */
export function mensajeDeConfirmacionCotizacion(
  payload: PayloadCotizacion,
  desglose: readonly DesgloseCotizado[],
  avisos: readonly string[],
  contexto: {
    paraQuien: string
    esDeLaRed: boolean
    vigenteHasta: string
    /** Solo la etiqueta de la promocion. Las cifras salen de lo sellado. */
    motivoDescuento?: string
  }
): string {
  const lineas: string[] = ['Esta es la cotizacion. Revisala:', '']
  lineas.push(`Para: ${contexto.paraQuien}${contexto.esDeLaRed ? '' : ' (prospecto)'}`)
  lineas.push('')

  for (const d of desglose) {
    const piezas = d.cantidad === 1 ? '1 pieza' : `${d.cantidad} piezas`
    lineas.push(`   ${d.nombre}: ${piezas} x ${pesos(d.precioUnitario)} = ${pesos(d.subtotal)}`)
  }

  // D55: **las dos cifras a la vista.** La lista sale de sumar el desglose, que
  // es lo mismo que `items.precio_unitario` y por lo tanto va sellado; el
  // cobrado es `payload.total`. Ninguno de los dos se recalcula por fuera.
  const lista = Number(desglose.reduce((suma, d) => suma + d.subtotal, 0).toFixed(2))
  const descuento = descuentoDelPayload(lista, payload.total, contexto.motivoDescuento ?? '')
  if (descuento.hay) {
    lineas.push('', ...lineasDeDescuento(descuento))
  } else {
    lineas.push('', `TOTAL: ${pesos(payload.total)}`)
  }
  lineas.push(`Vigencia: ${payload.vigencia_dias} dias (hasta el ${fechaParaPersona(contexto.vigenteHasta)})`)

  if (contexto.esDeLaRed) {
    // Es el precio de SU costo, no el de publico. Decirlo evita que se le pase
    // al cliente final una lista que no era para el.
    lineas.push('Precio de distribuidor, no de publico.')
  }

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para guardarla, o dime que cambio.')
  return lineas.join('\n')
}
