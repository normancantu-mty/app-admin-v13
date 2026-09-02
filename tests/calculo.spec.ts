import { test, expect } from '@playwright/test'
import { calculateReverseTaxes } from '../lib/finance-utils'
import { calcularDeduccionCascada } from '../lib/inventario-auditoria'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '../lib/inventario-types'

/**
 * Pruebas puramente aritmeticas: sin base de datos, sin red, sin navegador.
 * Cubren las tres piezas de calculo que mueven dinero e inventario.
 */

test.describe('calculateReverseTaxes: base + ieps + iva reconstruyen el cobro', () => {
  test('FULL_TAX sobre $1000', () => {
    const { montoBase, ieps, iva } = calculateReverseTaxes(1000, 'FULL_TAX')

    expect(montoBase + ieps + iva).toBeCloseTo(1000, 2)
    expect(ieps).toBeGreaterThan(0)
    expect(iva).toBeGreaterThan(0)
  })

  test('IVA_ONLY sobre $1000: no genera IEPS', () => {
    const { montoBase, ieps, iva } = calculateReverseTaxes(1000, 'IVA_ONLY')

    expect(montoBase + ieps + iva).toBeCloseTo(1000, 2)
    expect(ieps).toBe(0)
    expect(iva).toBeGreaterThan(0)
  })

  test('LIBRE sobre $1000: todo es base, cero impuestos', () => {
    const { montoBase, ieps, iva } = calculateReverseTaxes(1000, 'LIBRE')

    expect(montoBase + ieps + iva).toBeCloseTo(1000, 2)
    expect(montoBase).toBe(1000)
    expect(ieps).toBe(0)
    expect(iva).toBe(0)
  })
})

test.describe('calcularDeduccionCascada: la cubeta PAGADO se quema primero', () => {
  test('si PAGADO alcanza, CONSIGNADO no se toca', () => {
    const resultado = calcularDeduccionCascada({
      cantidadDeducir: 30,
      stockPagadoActual: 50,
      stockConsignadoActual: 100
    })

    expect(resultado).toEqual({ deduccionPagado: 30, deduccionConsignado: 0 })
  })

  test('solo lo que sobra desborda a CONSIGNADO', () => {
    const resultado = calcularDeduccionCascada({
      cantidadDeducir: 70,
      stockPagadoActual: 50,
      stockConsignadoActual: 100
    })

    expect(resultado).toEqual({ deduccionPagado: 50, deduccionConsignado: 20 })
  })

  test('lanza error cuando la deduccion excede el stock fisico total', () => {
    expect(() =>
      calcularDeduccionCascada({
        cantidadDeducir: 100,
        stockPagadoActual: 10,
        stockConsignadoActual: 20
      })
    ).toThrow(/Stock insuficiente/)
  })
})

/**
 * Los 9 tipos que SI existen en el CHECK de inventario_ledger.
 * lib/inventario-types.ts declara ademas DEVOLUCION_FISICA, INGRESO_TRASPASO
 * y EGRESO_TRASPASO, que la base rechazaria (ERP-15). Esta prueba se queda
 * deliberadamente con los 9 reales.
 */
const TIPOS_REALES_EN_CHECK = [
  'ENTRADA_COMPRA',
  'SALIDA_VENTA',
  'PRODUCCION',
  'MERMA',
  'TRASPASO',
  'ANULADO',
  'ENTRADA_CONCESION',
  'SALIDA_CONCESION',
  'LIQUIDACION_INTERNA'
] as const

test.describe('clasificacion de los 9 tipos de movimiento reales', () => {
  const esperado: Record<(typeof TIPOS_REALES_EN_CHECK)[number], 'entrada' | 'salida' | 'ninguno'> = {
    ENTRADA_COMPRA: 'entrada',
    PRODUCCION: 'entrada',
    ENTRADA_CONCESION: 'entrada',
    SALIDA_VENTA: 'salida',
    MERMA: 'salida',
    TRASPASO: 'salida',
    SALIDA_CONCESION: 'salida',
    ANULADO: 'ninguno',
    LIQUIDACION_INTERNA: 'ninguno'
  }

  test('cada tipo cae en exactamente una categoria (o en ninguna)', () => {
    for (const tipo of TIPOS_REALES_EN_CHECK) {
      const entrada = isTipoMovimientoEntrada(tipo)
      const salida = isTipoMovimientoSalida(tipo)

      expect(entrada && salida, `${tipo} no puede ser entrada y salida a la vez`).toBe(false)
      expect(entrada, `${tipo} como entrada`).toBe(esperado[tipo] === 'entrada')
      expect(salida, `${tipo} como salida`).toBe(esperado[tipo] === 'salida')
    }
  })

  test('null, undefined y basura no se clasifican', () => {
    for (const valor of [null, undefined, '', 'NO_EXISTE']) {
      expect(isTipoMovimientoEntrada(valor)).toBe(false)
      expect(isTipoMovimientoSalida(valor)).toBe(false)
    }
  })
})
