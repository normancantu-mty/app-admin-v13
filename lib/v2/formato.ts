/**
 * Front v2 — formato de cifras y fechas. Escrito el 2026-10-29 por el ejecutor
 * del Front v2 (lanzado por el Socio). Puro: sin red, sin base.
 */

import { ZONA_NEGOCIO } from '@/lib/actividad'

const MXN = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })
const MXN0 = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0
})
const NUM = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 })

/** $12,059.33 */
export function mxn(n: number): string {
  return MXN.format(Number(n) || 0)
}

/** $12,059 (sin centavos, para tarjetas grandes y ejes) */
export function mxn0(n: number): string {
  return MXN0.format(Math.round(Number(n) || 0))
}

/** $12k / $1.2k / $850 — para etiquetas de gráfica */
export function mxnCorto(n: number): string {
  const v = Number(n) || 0
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  if (a >= 1000) return `${s}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`
  return `${s}$${Math.round(a)}`
}

export function num(n: number): string {
  return NUM.format(Number(n) || 0)
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

/** 'YYYY-MM' de una fecha, en hora de México. */
export function mesMx(fecha: string | Date): string {
  const d = typeof fecha === 'string' ? new Date(fecha) : fecha
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA_NEGOCIO,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(d)
  const y = partes.find((p) => p.type === 'year')?.value
  const m = partes.find((p) => p.type === 'month')?.value
  return `${y}-${m}`
}

/** 'oct' de 'YYYY-MM' */
export function nombreMesCorto(mes: string): string {
  const m = Number(mes.slice(5, 7))
  return MESES[m - 1] ?? mes
}

/** Meses 'YYYY-MM' de `desde` a `hasta`, inclusive. */
export function rangoMeses(desde: string, hasta: string): string[] {
  const out: string[] = []
  let [y, m] = desde.split('-').map(Number)
  const [yf, mf] = hasta.split('-').map(Number)
  let guard = 0
  while ((y < yf || (y === yf && m <= mf)) && guard < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
    guard += 1
  }
  return out
}

/** '27 oct 23:59' en hora de México */
export function fechaHoraMx(fecha: string | null): string {
  if (!fecha) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: ZONA_NEGOCIO,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
    .format(new Date(fecha))
    .replace('.', '')
}

/** '27 oct 2026' en hora de México */
export function fechaMx(fecha: string | null): string {
  if (!fecha) return '—'
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: ZONA_NEGOCIO,
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })
    .format(new Date(fecha))
    .replace('.', '')
}

const TIPOS_LEGIBLES: Record<string, string> = {
  INGRESO_VENTA: 'Ingreso por venta',
  ABONO_DEUDA: 'Abono de deuda',
  INGRESO_TRASPASO: 'Traspaso recibido',
  EGRESO_TRASPASO: 'Traspaso enviado',
  SALDO_INICIAL: 'Saldo de arranque',
  GASTO_OPERATIVO: 'Gasto',
  COMPRA_INSUMOS: 'Compra de insumos',
  SUBSIDIO_FISCAL: 'Subsidio fiscal',
  CARGO_DEUDA: 'Cargo de deuda',
  PASIVO_IVA: 'IVA por pagar',
  PASIVO_IEPS: 'IEPS por pagar',
  INGRESO_COMISION: 'Comisión',
  COMISION_PASIVA: 'Comisión pasiva',
  DEUDA_A_MATRIZ: 'Deuda a matriz'
}

export function tipoLegible(tipo: string | null): string {
  if (!tipo) return '—'
  return TIPOS_LEGIBLES[tipo] ?? tipo
}
