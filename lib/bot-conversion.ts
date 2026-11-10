/**
 * AG-06 FASE 5 · PASO 6 — CONVERTIR UNA COTIZACION EN VENTA. La logica pura.
 *
 * ─── UNA COTIZACION NO SE VUELVE VENTA POR CONTARLA (D15) ───────────────────
 *
 * *"Solo si se dice explicitamente."* El enrutador tiene una intencion aparte
 * (`convertir`), y consultar cotizaciones, recotizar o preguntar por un folio no
 * la disparan. La razon no es de estilo: una conversion escribe cuatro tablas,
 * descuenta inventario real y crea un ticket. Si "¿que le cotice a Juan?" la
 * pudiera provocar, el error seria una venta de verdad.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOS SIETE DIAS, Y POR QUE NO SON LOS QUINCE DE LA VIGENCIA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Son **dos numeros distintos porque miden dos cosas distintas**, y eso es
 * deliberado, no un descuido que haya que unificar:
 *
 *   `VIGENCIA_POR_DEFECTO` (15) ... lo que se le PROMETE AL CLIENTE. Es un
 *                                   compromiso comercial: hasta esa fecha, ese
 *                                   precio se respeta.
 *   `DIAS_PARA_CONVERTIR`  (7) .... hasta cuando se puede cerrar la venta **por
 *                                   chat, a ciegas**. Es un limite de confianza
 *                                   sobre datos congelados, no una promesa.
 *
 * La conversion por chat reusa los precios que quedaron guardados en
 * `cotizacion_detalles` hace dias, y nadie vuelve a mirar el catalogo antes de
 * decir "va". A la semana, la probabilidad de que la lista se haya movido deja
 * de ser despreciable. Pasados los 7 dias la cotizacion **puede seguir siendo
 * valida para el cliente** —y se dice asi, con todas sus letras— pero ya no se
 * cierra hablando: se recotiza, que vuelve a leer precios de hoy.
 *
 * ─── LOS DIAS SE CUENTAN EN CALENDARIO DE MEXICO, NO RESTANDO INSTANTES ─────
 *
 * `fecha` es un `date`, no un timestamp. Restar `Date.now()` menos una fecha da
 * milisegundos, y dividir entre 86,400,000 convierte "ayer a las 23:00" en 0.4
 * dias. Peor: a las 18:01 de Zacatecas, `new Date().toISOString()` ya dice
 * manana, asi que una cotizacion de hoy nace con un dia de edad. Aqui se restan
 * DIAS DE CALENDARIO, y el de hoy sale de `hoyEnMX()`.
 *
 * ─── Y EL PRECIO DE HOY SE ENSENA SIEMPRE, AUNQUE SEA EL MISMO ──────────────
 *
 * Ensenarlo solo cuando cambia convierte su ausencia en informacion que hay que
 * saber leer: quien no ve la columna tiene que acordarse de que "no verla
 * significa que no se movio". Y si algun dia la comparacion se rompe, el
 * sintoma seria exactamente el mismo que el caso bueno — silencio. Enseñandolo
 * siempre, un renglon sin precio de hoy es visiblemente un defecto.
 */

import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { fechaParaPersona } from '@/lib/fechas'
import { hoyEnMX } from '@/lib/date-format'
import type { PayloadVenta, RenglonVenta } from '@/lib/bot-venta'

// ============================================================================
// 1. LA VENTANA
// ============================================================================

/**
 * Siete dias desde la `fecha` de la cotizacion. Ver el encabezado: es un numero
 * DISTINTO de `VIGENCIA_POR_DEFECTO` a proposito, y el dia que alguien los
 * quiera igualar tiene que leer por que son dos.
 */
export const DIAS_PARA_CONVERTIR = 7

/**
 * Dias de CALENDARIO entre dos fechas `AAAA-MM-DD`.
 *
 * En UTC porque aqui ya no hay hora que respetar, solo dias: `Date.UTC` no
 * tiene saltos de horario de verano que hagan que un dia dure 23 horas. Quien
 * pone el "hoy" en hora de Mexico es `hoyEnMX()`, antes de llamar aqui.
 */
export function diasDeCalendario(desde: string, hasta: string): number {
  const a = Date.UTC(...(partes(desde) as [number, number, number]))
  const b = Date.UTC(...(partes(hasta) as [number, number, number]))
  return Math.round((b - a) / 86400000)
}

function partes(fecha: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha ?? ''))
  if (!m) return [1970, 0, 1]
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
}

// ============================================================================
// 2. EL JUICIO
// ============================================================================

/** Lo minimo que hace falta saber de una cotizacion para juzgarla. */
export interface CotizacionParaConvertir {
  id: string
  folio: string
  fecha: string
  estado: string
  zona: string
  total: number
  id_comprador: string | null
  nombre_prospecto: string | null
  vigente_hasta: string | null
}

export type MotivoNoConvertible =
  | 'ya-convertida'
  | 'fuera-de-los-siete-dias'
  | 'sin-comprador'
  | 'sin-renglones'

export interface ConversionPermitida {
  ok: true
  diasDesdeLaCotizacion: number
  /** `true` si la cotizacion ya vencio para el cliente pero aun cabe en los 7. */
  vencidaParaElCliente: boolean
}

export interface ConversionRechazada {
  ok: false
  motivo: MotivoNoConvertible
  mensaje: string
  /** `true` si lo correcto es ofrecer recotizar en vez de solo decir que no. */
  ofrecerRecotizar: boolean
}

export type JuicioDeConversion = ConversionPermitida | ConversionRechazada

export function juzgarConversion(
  cot: CotizacionParaConvertir,
  renglones: number,
  ahora: Date = new Date()
): JuicioDeConversion {
  if (cot.estado === 'CONVERTIDA') {
    return {
      ok: false,
      motivo: 'ya-convertida',
      mensaje: `${cot.folio} ya se convirtio en venta. No la vuelvo a cobrar.`,
      ofrecerRecotizar: false
    }
  }

  if (renglones === 0) {
    return {
      ok: false,
      motivo: 'sin-renglones',
      mensaje: `${cot.folio} no tiene ningun renglon. No hay que vender.`,
      ofrecerRecotizar: false
    }
  }

  // ─── SIN COMPRADOR NO HAY VENTA, Y AHORA SI HAY SALIDA ────────────────────
  // Una cotizacion puede ir a nombre de un prospecto suelto (`nombre_prospecto`),
  // que es justo para lo que sirve: cotizarle a alguien que todavia no es
  // nadie en el sistema. Pero una venta se asienta contra una entidad y su
  // cuenta; un nombre en texto no tiene donde recibir el dinero ni de donde
  // salir el inventario.
  //
  // Antes del Paso 5 esto era un callejon sin salida. Hoy no: darlo de alta se
  // hace en el mismo chat, y por eso el mensaje lo dice en vez de solo negarse.
  if (!cot.id_comprador) {
    return {
      ok: false,
      motivo: 'sin-comprador',
      mensaje:
        `${cot.folio} esta a nombre de ${cot.nombre_prospecto || 'un prospecto'}, que todavia ` +
        `no esta dado de alta. Una venta necesita a quien cobrarle. Dalo de alta y te la ` +
        `recotizo a su nombre.`,
      ofrecerRecotizar: false
    }
  }

  const hoy = hoyEnMX(ahora)
  const dias = diasDeCalendario(cot.fecha, hoy)
  const vencidaParaElCliente = Boolean(cot.vigente_hasta && cot.vigente_hasta < hoy)

  if (dias > DIAS_PARA_CONVERTIR) {
    return {
      ok: false,
      motivo: 'fuera-de-los-siete-dias',
      mensaje: mensajeFueraDePlazo(cot, dias, vencidaParaElCliente),
      // La cotizacion puede seguir siendo buena para el cliente. Lo que caduco
      // es cerrarla a ciegas por chat, asi que la salida es recotizar — que
      // vuelve a leer los precios de hoy.
      ofrecerRecotizar: true
    }
  }

  // Una fecha futura es una cotizacion con la fecha mal puesta. No se convierte
  // a ciegas algo cuyo dia no cuadra.
  if (dias < 0) {
    return {
      ok: false,
      motivo: 'fuera-de-los-siete-dias',
      mensaje: `${cot.folio} esta fechada el ${fechaParaPersona(cot.fecha)}, que todavia no llega. No la convierto.`,
      ofrecerRecotizar: false
    }
  }

  return { ok: true, diasDesdeLaCotizacion: dias, vencidaParaElCliente }
}

function mensajeFueraDePlazo(
  cot: CotizacionParaConvertir,
  dias: number,
  vencidaParaElCliente: boolean
): string {
  const cabeza =
    `${cot.folio} es del ${fechaParaPersona(cot.fecha)}: ya pasaron ${dias} dias y por chat solo cierro ` +
    `las de ${DIAS_PARA_CONVERTIR} dias o menos, porque los precios que trae estan congelados ` +
    `desde entonces.`
  if (vencidaParaElCliente) {
    return `${cabeza}\n\nAdemas su vigencia ya vencio el ${fechaParaPersona(cot.vigente_hasta)}.`
  }
  return (
    `${cabeza}\n\nPara el cliente sigue vigente hasta el ${cot.vigente_hasta ? fechaParaPersona(cot.vigente_hasta) : '(sin fecha)'}, ` +
    `asi que el precio se le respeta — pero la capturamos en la pantalla, o te la recotizo ` +
    `con los precios de hoy.`
  )
}

// ============================================================================
// 3. EL PRECIO COTIZADO CONTRA EL DE HOY
// ============================================================================

export interface LineaConvertida {
  id_producto: string
  nombre: string
  cantidad: number
  /** El que quedo congelado en `cotizacion_detalles`. Es el que se cobra. */
  precio_cotizado: number
  /** Lo que costaria hoy la misma pieza. Solo informativo, se ensena SIEMPRE. */
  precio_hoy: number | null
  subtotal: number
}

export type MovimientoDePrecio = 'igual' | 'subio' | 'bajo' | 'desconocido'

export function comoSeMovio(linea: LineaConvertida): MovimientoDePrecio {
  if (linea.precio_hoy === null) return 'desconocido'
  const d = linea.precio_hoy - linea.precio_cotizado
  if (Math.abs(d) < 0.005) return 'igual'
  return d > 0 ? 'subio' : 'bajo'
}

/**
 * La diferencia total, en pesos, entre cobrar lo cotizado y cobrar lo de hoy.
 *
 * Positiva = la lista subio y se esta respetando un precio mas barato (le cuesta
 * dinero a la casa). Negativa = la lista bajo y el cliente pagaria de mas por
 * el precio que se le prometio; eso tambien hay que verlo antes de decir "va".
 */
export function diferenciaContraHoy(lineas: readonly LineaConvertida[]): number {
  let d = 0
  for (const l of lineas) {
    if (l.precio_hoy === null) continue
    d += (l.precio_hoy - l.precio_cotizado) * l.cantidad
  }
  return Math.round(d * 100) / 100
}

// ============================================================================
// 4. EL PAYLOAD Y SU SELLO
// ============================================================================

/**
 * Lo que se sella. Lleva DENTRO el `PayloadVenta` exacto que va a recibir
 * `registrarVenta`, para que el sello cubra la venta entera —cada precio, cada
 * cantidad, el comprador y la cuenta— y no solo el folio.
 *
 * Sellar nada mas `id_cotizacion` seria un sello inutil: entre la propuesta y el
 * "va", el confirmar tendria que volver a armar la venta, y ahi es justo donde
 * se cuela un precio distinto del que la persona leyo.
 */
export interface PayloadConversion {
  id_cotizacion: string
  folio: string
  venta: PayloadVenta
  usuario_creador: string
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts` — la canonizacion es
 * RECURSIVA, asi que `venta` (un objeto anidado) entra entero y ordenado. */
export const LLAVES_CONVERSION = [
  'folio',
  'id_cotizacion',
  'usuario_creador',
  'venta'
] as const

export function conversionCanonica(payload: PayloadConversion): string {
  return canonizar(payload, LLAVES_CONVERSION)
}

export function sellarConversion(payload: PayloadConversion): string {
  return sellar(payload, LLAVES_CONVERSION)
}

export function selloConversionCoincide(payload: PayloadConversion, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_CONVERSION, sello)
}

// ============================================================================
// 5. EL MENSAJE
// ============================================================================

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export interface ContextoDeConversion {
  nombreComprador: string
  nombreCuenta: string
  condicionPago: 'CONTADO' | 'CONCESION'
  diasDesdeLaCotizacion: number
  vencidaParaElCliente: boolean
  avisos: readonly string[]
}

/**
 * Lo que se ensena antes del "va".
 *
 * **Las dos columnas de precio salen siempre**, aunque sean identicas. Ver el
 * encabezado: una columna que solo aparece cuando hay diferencia hace que su
 * ausencia signifique algo, y eso es justo lo que no se puede pedir de un
 * mensaje que se lee en un celular entre dos cosas.
 */
export function mensajeDeConversion(
  cot: CotizacionParaConvertir,
  lineas: readonly LineaConvertida[],
  payload: PayloadVenta,
  ctx: ContextoDeConversion
): string {
  const l: string[] = []
  l.push(
    `Convierto ${cot.folio} (del ${fechaParaPersona(cot.fecha)}, hace ${ctx.diasDesdeLaCotizacion} ` +
      `${ctx.diasDesdeLaCotizacion === 1 ? 'dia' : 'dias'}) en venta a ${ctx.nombreComprador}:`
  )
  l.push('')

  for (const linea of lineas) {
    const movimiento = comoSeMovio(linea)
    const hoy =
      linea.precio_hoy === null
        ? 'hoy: no hay precio de lista'
        : movimiento === 'igual'
          ? `hoy ${pesos(linea.precio_hoy)} — igual`
          : `hoy ${pesos(linea.precio_hoy)} — ${movimiento}`
    l.push(
      `· ${linea.cantidad} x ${linea.nombre}: ${pesos(linea.precio_cotizado)} ` +
        `(${hoy})  =  ${pesos(linea.subtotal)}`
    )
  }

  l.push('')
  l.push(`TOTAL: ${pesos(payload.total_cobrado_real)}`)

  const dif = diferenciaContraHoy(lineas)
  if (Math.abs(dif) >= 0.01) {
    // Se cobra lo COTIZADO: una cotizacion es una promesa de precio, y respetarla
    // es el punto entero de haberla hecho. Pero el numero se dice, porque quien
    // decide si esa promesa todavia conviene es Norman, no este archivo.
    l.push(
      dif > 0
        ? `⚠ Con precios de hoy serian ${pesos(payload.total_cobrado_real + dif)}. ` +
            `Le respeto lo cotizado: son ${pesos(dif)} menos para la casa.`
        : `⚠ Con precios de hoy serian ${pesos(payload.total_cobrado_real + dif)}. ` +
            `Lo cotizado le sale ${pesos(-dif)} mas caro al cliente; se lo respeto igual ` +
            `porque asi se lo prometimos.`
    )
  }

  if (ctx.vencidaParaElCliente) {
    l.push(
      `⚠ Su vigencia vencio el ${fechaParaPersona(cot.vigente_hasta)}, pero todavia cae en los ` +
        `${DIAS_PARA_CONVERTIR} dias para cerrarla por chat.`
    )
  }

  l.push('')
  l.push(
    ctx.condicionPago === 'CONTADO'
      ? `Contado, entra a ${ctx.nombreCuenta}.`
      : `Concesion: no entra dinero, suma ${pesos(payload.total_cobrado_real)} a su deuda.`
  )

  for (const aviso of ctx.avisos) l.push(aviso)
  return l.join('\n')
}

export function mensajeDeConversionHecha(folio: string, ticketId: string, total: number): string {
  return (
    `✅ ${folio} queda CONVERTIDA. Ticket TCK-${ticketId.slice(0, 8)}, ${pesos(total)}.\n` +
    `Si la anulas, la cotizacion se libera sola y la puedes volver a convertir.`
  )
}

/** Solo para que el endpoint no tenga que importar `RenglonVenta` aparte. */
export type { RenglonVenta }
