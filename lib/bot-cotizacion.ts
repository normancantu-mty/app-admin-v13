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
import { sumarDias } from '@/lib/fechas'
import {
  precioParaComprador,
  TOPE_PIEZAS_POR_LINEA,
  TOPE_VENTA,
  type CompradorDeVenta,
  type ProductoDelCatalogo
} from '@/lib/bot-venta'

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
  const avisos: string[] = []

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

  const payload: PayloadCotizacion = {
    id_vendedor: contexto.idVendedor,
    id_comprador: contexto.comprador?.id ?? null,
    nombre_prospecto: contexto.comprador ? null : prospecto,
    zona: contexto.zona,
    vigencia_dias: vigencia,
    total,
    notas: String(propuesta.notas ?? '').trim(),
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
  contexto: { paraQuien: string; esDeLaRed: boolean; vigenteHasta: string }
): string {
  const lineas: string[] = ['Esta es la cotizacion. Revisala:', '']
  lineas.push(`Para: ${contexto.paraQuien}${contexto.esDeLaRed ? '' : ' (prospecto)'}`)
  lineas.push('')

  for (const d of desglose) {
    const piezas = d.cantidad === 1 ? '1 pieza' : `${d.cantidad} piezas`
    lineas.push(`   ${d.nombre}: ${piezas} x ${pesos(d.precioUnitario)} = ${pesos(d.subtotal)}`)
  }

  lineas.push('', `TOTAL: ${pesos(payload.total)}`)
  lineas.push(`Vigencia: ${payload.vigencia_dias} dias (hasta el ${contexto.vigenteHasta})`)

  if (contexto.esDeLaRed) {
    // Es el precio de SU costo, no el de publico. Decirlo evita que se le pase
    // al cliente final una lista que no era para el.
    lineas.push('Precio de distribuidor, no de publico.')
  }

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para guardarla, o dime que cambio.')
  return lineas.join('\n')
}
