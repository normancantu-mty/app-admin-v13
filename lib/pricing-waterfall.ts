import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'

export interface WaterfallResult {
  precioPublico: number;
  tuCosto: number;
  precioLocal: number;
  margenDirecto: number;
  comisionPasiva?: number;
  impuestosRetenidos: number;
  gananciaNeta: number;
}

export function calculateWaterfall(
  producto: any,
  entidad: any,
  rol: string,
  simulacionFiscal?: string,
  localEntidad?: any
): WaterfallResult {
  const precioPublico = producto.listas_precios?.[0]?.precio_final || 0;
  const fiscalidad: TipoFiscalidad = simulacionFiscal === 'FULL_TAX' || simulacionFiscal === 'IVA_ONLY'
    ? simulacionFiscal
    : 'LIBRE';
  const reverse = calculateReverseTaxes(precioPublico, fiscalidad);
  const baseIngreso = reverse.montoBase;
  const impuestos = (reverse.iva || 0) + (reverse.ieps || 0);
  const aplicaRedondeoCosto = Boolean(
    localEntidad?.aplica_redondeo_costo ?? entidad?.aplica_redondeo_costo ?? false
  )

  if (rol === 'ADMIN') {
    const tuCostoNeto = producto.costo_unitario || 0
    let precioLocal = 0
    let gananciaNeta = baseIngreso - tuCostoNeto

    if (localEntidad) {
      const comisionAsignada = localEntidad.rol === 'DST'
        ? (localEntidad.comision_base || 0)
        : (localEntidad.comision_base_local || 0)
      const costoCrudoEntidad = baseIngreso * (1 - comisionAsignada)
      precioLocal = aplicaRedondeoCosto ? Math.ceil(costoCrudoEntidad) : costoCrudoEntidad
      gananciaNeta = precioLocal - tuCostoNeto
    }

    return {
      precioPublico,
      impuestosRetenidos: impuestos,
      tuCosto: tuCostoNeto,
      gananciaNeta,
      margenDirecto: gananciaNeta,
      precioLocal,
      comisionPasiva: 0
    }
  }

  // 1. Ganancia Propia (Sobre la BASE)
  const comisionPropia = rol === 'DST' ? (entidad.comision_base || 0) : (entidad.comision_base_local || 0)
  const gananciaNeta = baseIngreso * comisionPropia

  // 2. Costo Operativo NETO (Solo el liquido, sin impuestos)
  const costoCrudo = baseIngreso - gananciaNeta
  const tuCostoNeto = aplicaRedondeoCosto ? Math.ceil(costoCrudo) : costoCrudo

  // 3. Logica de Red para Locales
  let precioLocal = 0
  let comisionPasiva = 0

  if (rol === 'DST' && localEntidad) {
    const gananciaLocal = baseIngreso * (localEntidad.comision_base_local || 0)
    precioLocal = precioPublico - gananciaLocal
    comisionPasiva = (precioLocal - (tuCostoNeto + impuestos) > 0)
      ? (precioLocal - (tuCostoNeto + impuestos))
      : 0
  }

  return {
    precioPublico,
    impuestosRetenidos: impuestos,
    tuCosto: tuCostoNeto,
    gananciaNeta,
    margenDirecto: gananciaNeta,
    precioLocal,
    comisionPasiva
  };
}
