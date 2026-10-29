import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { calcularFugaFiscal } from '../lib/aprobacion-abonos'

/**
 * v2, ronda 3 (2026-10-29, Socio ejecutor): la cola de aprobaciones desglosa por la FISCALIDAD
 * de la cuenta destino, no por una clave fija. En v2 la cuenta personal (hoy "Cuenta Gilberto",
 * clase PERSONAL) es LIBRE: un abono de 1,160 ahi es 1,160 de base y 0 de IVA. El codigo viejo
 * (`case 'CUENTA_PERSONAL'` en `PendingApprovalsPanel.tsx`) le sacaba 160 de IVA.
 */
const PANEL = 'app/dashboard/finanzas/PendingApprovalsPanel.tsx'

function codigoVivo(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}
// Decide por clave fija: un `case 'X':` con las claves viejas por nombre de cuenta.
const DECIDE_POR_CLAVE = /case\s+['"](CUENTA_PERSONAL|CUENTA_FRESNILLO|EFECTIVO)['"]/

test.describe('v2 · desglose de aprobaciones por fiscalidad de la cuenta', () => {
  test('Cuenta Gilberto (LIBRE, clase PERSONAL): 1160 -> base 1160, sin IVA ni IEPS', () => {
    expect(calcularFugaFiscal(1160, { tipo_fiscalidad: 'LIBRE', clase: 'PERSONAL' }))
      .toEqual({ montoBase: 1160, ieps: 0, iva: 0, gastoOperativo: 0 })
  })
  test('Cuenta Fresnillo (FULL_TAX): 1774.80 -> base 1000, IEPS 530, IVA 244.80', () => {
    expect(calcularFugaFiscal(1774.8, { tipo_fiscalidad: 'FULL_TAX', clase: 'FISCAL' }))
      .toEqual({ montoBase: 1000, ieps: 530, iva: 244.8, gastoOperativo: 0 })
  })
  test('IVA_ONLY sigue existiendo como fiscalidad: 1160 -> base 1000, IVA 160', () => {
    expect(calcularFugaFiscal(1160, { tipo_fiscalidad: 'IVA_ONLY' }))
      .toEqual({ montoBase: 1000, ieps: 0, iva: 160, gastoOperativo: 0 })
  })
  test('Efectivo propio (LIBRE, clase EFECTIVO): sin IVA, y la fuga de 160 la absorbe la empresa', () => {
    expect(calcularFugaFiscal(1160, { tipo_fiscalidad: 'LIBRE', clase: 'EFECTIVO' }))
      .toEqual({ montoBase: 1160, ieps: 0, iva: 0, gastoOperativo: 160 })
  })
  test('fiscalidad desconocida o nula: lanza, no supone LIBRE (ERP-21)', () => {
    expect(() => calcularFugaFiscal(100, { tipo_fiscalidad: null })).toThrow(/tipo_fiscalidad/)
    expect(() => calcularFugaFiscal(100, { tipo_fiscalidad: 'CUENTA_PERSONAL' })).toThrow(/tipo_fiscalidad/)
  })
  test('el panel ya no decide por clave fija y delega en calcularFugaFiscal', () => {
    const src = codigoVivo(readFileSync(join(process.cwd(), PANEL), 'utf-8'))
    expect(src).not.toMatch(DECIDE_POR_CLAVE)
    expect(src).toMatch(/calcularFugaFiscal\(/)
  })
  test('control negativo: el predicado si caza el codigo viejo', () => {
    expect("    case 'CUENTA_PERSONAL':").toMatch(DECIDE_POR_CLAVE)
    expect("    case 'FULL_TAX':").not.toMatch(DECIDE_POR_CLAVE)
  })
})
