/**
 * Constantes del negocio (Actualizado para Fresnillo IEPS 53% + IVA)
 */
const TASA_IEPS = 0.53
const TASA_IVA = 0.16
const FACTOR_FRESNILLO = 1.7748 // (1 + 0.53) * 1.16

export type TipoCuentaDestino = 'EFECTIVO' | 'CUENTA_PERSONAL' | 'CUENTA_FRESNILLO'

/**
 * Tipo de fiscalidad para cálculo de impuestos
 */
export type TipoFiscalidad = 'LIBRE' | 'IVA_ONLY' | 'FULL_TAX'

/**
 * Interfaz para el resultado de cálculo de impuestos inversos
 */
export interface ReverseTaxesResult {
  montoBase: number
  ieps: number
  iva: number
}

/**
 * Interfaz para el resultado de cálculo de comisiones en cascada
 */
export interface CascadeCommissionsResult {
  comisionDistribuidor: number
  comisionLocal: number
}

/**
 * Calcula el monto base e impuestos a partir del precio final cobrado
 * aplicando matemática inversa según el tipo de fiscalidad
 * 
 * @param precioFinalCobrado - Precio final que incluye impuestos
 * @param tipoFiscalidad - Tipo de fiscalidad: 'FULL_TAX', 'IVA_ONLY' o 'LIBRE'
 * @returns Objeto con montoBase, ieps e iva calculados
 */
export function calculateReverseTaxes(
  precioFinalCobrado: number,
  tipoFiscalidad: TipoFiscalidad = 'FULL_TAX'
): ReverseTaxesResult {
  let montoBase: number
  let ieps: number
  let iva: number

  if (tipoFiscalidad === 'FULL_TAX') {
    montoBase = precioFinalCobrado / FACTOR_RECONSTRUCCION
    ieps = montoBase * TASA_IEPS
    iva = montoBase * TASA_IVA
  } else if (tipoFiscalidad === 'IVA_ONLY') {
    montoBase = precioFinalCobrado / 1.16
    ieps = 0
    iva = montoBase * TASA_IVA
  } else {
    montoBase = precioFinalCobrado
    ieps = 0
    iva = 0
  }

  return {
    montoBase: Math.round(montoBase * 100) / 100,
    ieps: Math.round(ieps * 100) / 100,
    iva: Math.round(iva * 100) / 100
  }
}

/**
 * Calcula las comisiones en cascada para Distribuidor y Local
 * basándose siempre en el monto base de la venta (sin impuestos)
 * 
 * @param montoBaseVenta - Monto base de la venta sin impuestos
 * @param porcentajeDistribuidor - Porcentaje de comisión del distribuidor (0-100)
 * @param porcentajeLocal - Porcentaje de comisión del local (0-100)
 * @returns Objeto con comisiones en dinero para distribuidor y local
 */
export function calculateCascadeCommissions(
  montoBaseVenta: number,
  porcentajeDistribuidor: number,
  porcentajeLocal: number
): CascadeCommissionsResult {
  const comisionDistribuidor = montoBaseVenta * (porcentajeDistribuidor / 100)
  const comisionLocal = montoBaseVenta * (porcentajeLocal / 100)

  return {
    comisionDistribuidor: Math.round(comisionDistribuidor * 100) / 100,
    comisionLocal: Math.round(comisionLocal * 100) / 100
  }
}
