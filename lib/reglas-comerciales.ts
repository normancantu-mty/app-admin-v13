/**
 * REGLA COMERCIAL — comisiones, precio al nodo y deuda.
 *
 * Implementa `Claude/Fresnillo/ERP_Fresnillo/REGLAS_COMERCIALES.md` (Norman,
 * 2026-09-02) como funciones puras. **Nadie importa este archivo todavia**: se
 * escribio para medir la brecha contra el sistema vivo, no para cambiarlo. El
 * cambio de los caminos de escritura es otra sesion, con estas pruebas ya en
 * verde como red.
 *
 * La regla, en tres lineas:
 *
 *     Base     = PP / 1.7748   si la venta entra por la cuenta fiscal
 *     Base     = PP            en cualquier otra cuenta
 *     Comision = %  x  Base                  <- SIEMPRE sobre Base, nunca sobre PP
 *     Deuda    = PP  -  comisiones de esa cadena
 *
 * TODO EL DINERO SE MUEVE EN CENTAVOS ENTEROS, como ya hace `lib/abonos.ts`.
 * Con floats, `599 / 1.7748 * 0.20` deja residuos que hacen que el mismo ticket
 * de un mes a otro no de el mismo peso. Las funciones publicas reciben y
 * devuelven pesos por comodidad del llamador; por dentro nunca hay un float.
 *
 * OJO CON EL REDONDEO: `aplica_redondeo_costo` sube el costo del nodo al PESO
 * entero siguiente (`Math.ceil`), no al centavo — siempre a favor de la Matriz.
 * Es la regla vigente en `app/actions/pos.ts` y `lib/pricing-waterfall.ts`, y
 * esta sesion NO la cambia.
 */

import { FACTOR_RECONSTRUCCION } from './finance-utils'

// ─── Centavos ────────────────────────────────────────────────────────────────

/** Pesos -> centavos enteros. */
export function aCentavos(pesos: number): number {
  return Math.round(pesos * 100)
}

/** Centavos enteros -> pesos con dos decimales exactos. */
export function aPesos(centavos: number): number {
  return Number((centavos / 100).toFixed(2))
}

/**
 * Sube al PESO entero siguiente, en centavos. Es el `Math.ceil` de
 * `aplica_redondeo_costo`: $479.20 -> $480, no -> $479.21.
 */
export function techoAPesoEntero(centavos: number): number {
  return Math.ceil(centavos / 100) * 100
}

function exigirPorcentaje(valor: number, nombre: string): number {
  if (!Number.isFinite(valor) || valor < 0 || valor > 1) {
    throw new Error(
      `${nombre} debe venir como decimal entre 0 y 1 (0.20 = 20%), llego: ${valor}`
    )
  }
  return valor
}

// ─── Las cinco piezas de la regla ────────────────────────────────────────────

/**
 * Base de calculo de las comisiones.
 *
 * REGLAS_COMERCIALES.md, "Las tres piezas": la Base es `PP / 1.7748` **solo si
 * la venta entra por la cuenta fiscal** (`Cuenta Fresnillo`, donde se paga IEPS
 * e IVA). En cualquier otra cuenta, Base = PP.
 *
 * Textual de Norman: *"cuando el distribuidor pague a la cuenta de Fresnillo,
 * es decir que vaya a pagar IEPS e IVA, el debe cobrar todas sus comisiones
 * sobre la base, no sobre el precio final con impuestos."*
 *
 * @param precioPublico PP en pesos, de `listas_precios` segun la zona del comprador.
 * @param esCuentaFiscal true si la cuenta destino es la fiscal.
 * @returns Base en pesos.
 */
export function baseDesdePrecioPublico(precioPublico: number, esCuentaFiscal: boolean): number {
  return aPesos(baseCentavos(aCentavos(precioPublico), esCuentaFiscal))
}

function baseCentavos(ppCentavos: number, esCuentaFiscal: boolean): number {
  if (!esCuentaFiscal) return ppCentavos
  return Math.round(ppCentavos / FACTOR_RECONSTRUCCION)
}

/**
 * Comision de un nodo: `%  x  Base`.
 *
 * REGLAS_COMERCIALES.md, "La formula". El porcentaje se aplica a la Base, NO al
 * precio publico. En efectivo las dos cosas coinciden porque Base = PP; en la
 * cuenta fiscal no, y ahi es donde el sistema de hoy se aparta de la regla.
 *
 * Ejemplo B del documento: 750 ml, PP $599, Cuenta Fresnillo, 20% ->
 * Base $337.50, comision **$67.50** (no $119.80).
 *
 * @param porcentaje Decimal (0.20 = 20%), como lo guarda `entidades`.
 */
export function comision(precioPublico: number, porcentaje: number, esCuentaFiscal: boolean): number {
  return aPesos(comisionCentavos(aCentavos(precioPublico), porcentaje, esCuentaFiscal))
}

function comisionCentavos(ppCentavos: number, porcentaje: number, esCuentaFiscal: boolean): number {
  exigirPorcentaje(porcentaje, 'porcentaje de comision')
  return Math.round(baseCentavos(ppCentavos, esCuentaFiscal) * porcentaje)
}

/**
 * Precio unitario que se le cobra al nodo: `PP - comision`, con el techo al
 * peso entero cuando `aplica_redondeo_costo` es true.
 *
 * REGLAS_COMERCIALES.md, "La formula" + "Lo que el sistema hace HOY": la deuda
 * nace con la comision del distribuidor ya descontada del precio (opcion **i**,
 * la que eligio Norman). El `Math.ceil` va siempre a favor de la Matriz.
 *
 * Casos del documento, en efectivo (Base = PP, 20%):
 *   750 ml $599 -> $480 · 250 ml $179 -> $144 · 50 ml $69 -> $56
 */
export function precioParaNodo(
  precioPublico: number,
  porcentaje: number,
  esCuentaFiscal: boolean,
  aplicaRedondeo: boolean
): number {
  return aPesos(
    precioParaNodoCentavos(aCentavos(precioPublico), [porcentaje], esCuentaFiscal, aplicaRedondeo)
  )
}

/**
 * Igual que `precioParaNodo` pero con varias comisiones sobre la misma
 * mercancia (la cadena Matriz -> DST -> LOC descuenta local + red).
 */
function precioParaNodoCentavos(
  ppCentavos: number,
  porcentajes: readonly number[],
  esCuentaFiscal: boolean,
  aplicaRedondeo: boolean
): number {
  const comisiones = porcentajes.reduce(
    (suma, pct) => suma + comisionCentavos(ppCentavos, pct, esCuentaFiscal),
    0
  )
  const crudo = ppCentavos - comisiones
  return aplicaRedondeo ? techoAPesoEntero(crudo) : crudo
}

export type RolComprador = 'DST' | 'LOC'

export interface PorcentajesCadena {
  /** `comision_base` del DST. Solo aplica si **el** vende a cliente final. */
  base?: number
  /** `comision_hijo_local` del DST. Solo aplica cuando **su local** vende. */
  red?: number
  /** `comision_base_local` del LOC. Siempre que el local vende. */
  local?: number
}

export interface EntregaInput {
  /** Precio publico unitario, en pesos. */
  pp: number
  cantidad: number
  rolComprador: RolComprador
  porcentajes: PorcentajesCadena
  esCuentaFiscal: boolean
  aplicaRedondeo: boolean
}

export interface DeudaEntrega {
  /** Base unitaria en pesos. */
  base: number
  /** Comisiones unitarias por concepto, en pesos. */
  comisiones: { base: number; red: number; local: number }
  /** Suma de comisiones unitarias, en pesos. */
  comisionTotalUnitaria: number
  /** Precio unitario cobrado al nodo, ya con techo si aplica, en pesos. */
  precioUnitario: number
  /** `precioUnitario x cantidad`, en pesos. Esto es la deuda del asiento. */
  deuda: number
}

/**
 * Deuda de una entrega completa.
 *
 * REGLAS_COMERCIALES.md, "Los tres porcentajes, y cuando aplica cada uno":
 * **un distribuidor nunca cobra las dos.** O vende el (`comision_base`), o
 * vende su local (`comision_hijo_local`). Por eso el rol del comprador decide
 * que porcentajes entran a la cadena:
 *
 *   - `rolComprador: 'DST'`  ->  se descuenta solo `base`.
 *   - `rolComprador: 'LOC'`  ->  se descuentan `local` + `red`, nunca `base`.
 *
 * Los tres escenarios del documento, 750 ml PP $599, David (base 20%, red 15%),
 * su local 15%:
 *
 *   A · DST directo, efectivo        -> deuda $480   (ceil de $479.20)
 *   B · DST directo, Cuenta Fresnillo -> deuda $532  (ceil de $531.50)
 *   C · vende su local, efectivo     -> Matriz recibe $419.30 (sin techo)
 */
export function deudaPorEntrega(input: EntregaInput): DeudaEntrega {
  const { pp, cantidad, rolComprador, porcentajes, esCuentaFiscal, aplicaRedondeo } = input

  if (!Number.isInteger(cantidad) || cantidad < 0) {
    throw new Error(`cantidad debe ser un entero >= 0, llego: ${cantidad}`)
  }

  const ppCentavos = aCentavos(pp)

  const pctBase = rolComprador === 'DST' ? (porcentajes.base ?? 0) : 0
  const pctLocal = rolComprador === 'LOC' ? (porcentajes.local ?? 0) : 0
  const pctRed = rolComprador === 'LOC' ? (porcentajes.red ?? 0) : 0

  const comisionBase = comisionCentavos(ppCentavos, pctBase, esCuentaFiscal)
  const comisionLocal = comisionCentavos(ppCentavos, pctLocal, esCuentaFiscal)
  const comisionRed = comisionCentavos(ppCentavos, pctRed, esCuentaFiscal)

  const precioUnitario = precioParaNodoCentavos(
    ppCentavos,
    [pctBase, pctLocal, pctRed],
    esCuentaFiscal,
    aplicaRedondeo
  )

  return {
    base: aPesos(baseCentavos(ppCentavos, esCuentaFiscal)),
    comisiones: {
      base: aPesos(comisionBase),
      red: aPesos(comisionRed),
      local: aPesos(comisionLocal)
    },
    comisionTotalUnitaria: aPesos(comisionBase + comisionLocal + comisionRed),
    precioUnitario: aPesos(precioUnitario),
    deuda: aPesos(precioUnitario * cantidad)
  }
}

export interface AjusteTraspasoInput {
  pp: number
  /** `comision_base_local` del LOC que recibe. */
  comisionLocal: number
  /** `comision_hijo_local` del DST que entrega. */
  comisionRed: number
  /** `comision_base` del DST, la que ya se le descontó al registrar la deuda. */
  comisionBase: number
  esCuentaFiscal: boolean
  /** Unidades traspasadas. Por omision 1, para razonar por botella. */
  cantidad?: number
}

/**
 * Ajuste que se le carga al DST cuando la mercancia pasa a uno de sus locales.
 *
 * REGLAS_COMERCIALES.md, "RESUELTO — la opcion elegida por Norman": la deuda
 * nace al 80% porque al entregar todavia no se sabe quien va a vender. Cuando
 * la mercancia pasa a un local, la cadena entrega `local + red` en vez de
 * `base`, y la diferencia se asienta como ajuste:
 *
 *     Ajuste = (comision_local + comision_red - comision_base)  x  Base
 *
 * Con 15% + 15% - 20% da **10% x Base** ($59.90 por botella de 750 ml en
 * efectivo). Positivo = el DST debe MAS de lo registrado; negativo = debe menos.
 *
 * Razon de Norman para elegir esta ruta: *"quiero que el distribuidor no se
 * asuste cuando vea la deuda."*
 *
 * OJO, ORDEN DE OPERACIONES: los porcentajes se suman ANTES de tocar la Base,
 * tal como esta escrita la formula del documento. Redondear cada comision por
 * separado y luego restarlas da un centavo de mas en la ruta fiscal
 * (15% de $337.50 = $50.625 -> $50.63 dos veces -> ajuste $33.76 en vez de
 * $33.75). Un centavo por botella, pero se acumula y descuadra el ledger.
 *
 * @returns Ajuste en pesos (sin techo: es un asiento contable, no un precio).
 */
export function ajusteTraspasoDstALocal(input: AjusteTraspasoInput): number {
  const { pp, comisionLocal, comisionRed, comisionBase, esCuentaFiscal, cantidad = 1 } = input

  if (!Number.isInteger(cantidad) || cantidad < 0) {
    throw new Error(`cantidad debe ser un entero >= 0, llego: ${cantidad}`)
  }

  exigirPorcentaje(comisionLocal, 'comisionLocal')
  exigirPorcentaje(comisionRed, 'comisionRed')
  exigirPorcentaje(comisionBase, 'comisionBase')

  // El neto puede ser negativo (si `base` supera a `local + red`), por eso se
  // combina primero y no se valida como porcentaje.
  const porcentajeNeto = comisionLocal + comisionRed - comisionBase
  const ppCentavos = aCentavos(pp)
  const unitario = Math.round(baseCentavos(ppCentavos, esCuentaFiscal) * porcentajeNeto)

  return aPesos(unitario * cantidad)
}
