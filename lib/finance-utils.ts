// --- CONSTANTES FISCALES ---
export const TASA_IVA = 0.16
export const TASA_IEPS = 0.53 // Ajustar segun el % de la destileria
export const FACTOR_RECONSTRUCCION = 1 + TASA_IEPS + (1 + TASA_IEPS) * TASA_IVA
// ---------------------------

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
    iva = (montoBase + ieps) * TASA_IVA
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

/** Categoría sentinel: abono registrado pero excluido de KPIs hasta aprobación ADMIN. */
export const CATEGORIA_ABONO_PENDIENTE = 'ABONO_PENDIENTE'
/** Categoría post-aprobación con desglose fiscal aplicable. */
export const CATEGORIA_ABONO_REAL = 'ABONO_REAL'

export function esAbonoPendienteAprobacion(categoria: string | null | undefined): boolean {
  return categoria === CATEGORIA_ABONO_PENDIENTE
}

/** Movimiento que impacta caja, saldos y KPIs (excluye anulados y abonos pendientes). */
export function movimientoContableEfectivo(
  status: string,
  categoria?: string | null
): boolean {
  if (status === 'ANULADO' || status === 'PENDING' || status === 'REJECTED') return false
  if (esAbonoPendienteAprobacion(categoria)) return false
  return status === 'ACTIVO' || status === 'APPROVED'
}

function textoConceptoFiscal(
  categoria?: string | null,
  categoriaGasto?: string | null,
  descripcion?: string | null
): string {
  return `${categoria ?? ''} ${categoriaGasto ?? ''} ${descripcion ?? ''}`.toUpperCase()
}

export function esPagoImpuestoIva(mov: {
  tipo_movimiento: string
  categoria?: string | null
  categoria_gasto?: string | null
  descripcion?: string | null
}): boolean {
  if (mov.tipo_movimiento !== 'GASTO_OPERATIVO') return false
  const texto = textoConceptoFiscal(mov.categoria, mov.categoria_gasto, mov.descripcion)
  return (
    texto.includes('FUGA_FISCAL_IVA') ||
    texto.includes('FUGA FISCAL IVA') ||
    texto.includes('PAGO IVA')
  )
}

export function esPagoImpuestoIeps(mov: {
  tipo_movimiento: string
  categoria?: string | null
  categoria_gasto?: string | null
  descripcion?: string | null
}): boolean {
  if (mov.tipo_movimiento !== 'GASTO_OPERATIVO') return false
  const texto = textoConceptoFiscal(mov.categoria, mov.categoria_gasto, mov.descripcion)
  return (
    texto.includes('FUGA_FISCAL_IEPS') ||
    texto.includes('FUGA FISCAL IEPS') ||
    texto.includes('PAGO IEPS')
  )
}
