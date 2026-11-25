import { test, expect } from '@playwright/test'
import { faltanteDeStock, mensajeFaltaStock, repartirCascada, textoFaltantes } from '../lib/aviso-stock'
import { CATALOGO_AVISOS, exigeAsignacion } from '../lib/avisos'

/** El aviso de falta de existencia, sin red ni base (2026-11-24). */

test.describe('aviso de falta de existencia (puro)', () => {
  test('cuando alcanza, o alcanza justo, no hay faltante', () => {
    expect(faltanteDeStock(5, 3)).toBeNull()
    expect(faltanteDeStock(3, 3)).toBeNull()
    // numeric(10,4): el ruido del punto flotante no es un faltante.
    expect(faltanteDeStock(0.3 - 0.1, 0.2)).toBeNull()
  })

  test('cuando falta dice hay, pide y como queda, con su signo', () => {
    expect(faltanteDeStock(1, 3)).toEqual({ hay: 1, pide: 3, queda: -2 })
    expect(faltanteDeStock(0, 1)).toEqual({ hay: 0, pide: 1, queda: -1 })
    // Un saldo que ya era negativo no se recorta a cero: se dice como es.
    expect(faltanteDeStock(-2, 1)).toEqual({ hay: -2, pide: 1, queda: -3 })
    expect(faltanteDeStock(0.5, 0.75)).toEqual({ hay: 0.5, pide: 0.75, queda: -0.25 })
  })

  test('no pedir nada no es un faltante, aunque el saldo ya sea negativo', () => {
    expect(faltanteDeStock(-2, 0)).toBeNull()
  })

  test('el reparto suma SIEMPRE lo pedido y el faltante queda en PAGADO', () => {
    expect(repartirCascada(5, 10, 10)).toEqual({ deduccionPagado: 5, deduccionConsignado: 0 })
    expect(repartirCascada(5, 3, 10)).toEqual({ deduccionPagado: 3, deduccionConsignado: 2 })
    expect(repartirCascada(5, 1, 1)).toEqual({ deduccionPagado: 4, deduccionConsignado: 1 })
    expect(repartirCascada(5, 0, 0)).toEqual({ deduccionPagado: 5, deduccionConsignado: 0 })
    // Una cubeta negativa no da nada, y tampoco cobra su hoyo otra vez.
    expect(repartirCascada(3, -1, 3)).toEqual({ deduccionPagado: 0, deduccionConsignado: 3 })
    expect(repartirCascada(3, 5, -4)).toEqual({ deduccionPagado: 3, deduccionConsignado: 0 })
    for (const pagado of [-3, 0, 2, 9]) {
      for (const consignado of [-3, 0, 2, 9]) {
        for (const cantidad of [0, 1, 4, 12]) {
          const r = repartirCascada(cantidad, pagado, consignado)
          expect(r.deduccionPagado + r.deduccionConsignado).toBe(cantidad)
          expect(r.deduccionPagado).toBeGreaterThanOrEqual(0)
          expect(r.deduccionConsignado).toBeGreaterThanOrEqual(0)
          // Lo consignado nunca queda negativo por la cascada.
          expect(r.deduccionConsignado).toBeLessThanOrEqual(Math.max(0, consignado))
        }
      }
    }
  })

  test('el texto trae pieza, hay, pides y quedara, y dice que SI entro', () => {
    const faltantes = [
      { idProducto: 'a', pieza: '750ml', hay: 1, pide: 3, queda: -2 },
      { idProducto: 'b', pieza: '250ml', hay: 0, pide: 1, queda: -1 }
    ]
    expect(textoFaltantes(faltantes)).toBe('750ml: hay 1, pides 3, quedará -2; 250ml: hay 0, pides 1, quedará -1')
    const m = mensajeFaltaStock('La venta', 'Matriz', faltantes)
    expect(m).toContain(textoFaltantes(faltantes))
    expect(m).toContain('en Matriz')
    expect(m).toContain('La venta SÍ entró')
    expect(m).toContain('no se ajustó')
  })

  test('W20 existe, es REVISAR y se puede cerrar sin candado', () => {
    const w20 = (CATALOGO_AVISOS as Record<string, { severidad: string }>).W20
    expect(w20?.severidad).toBe('REVISAR')
    expect(exigeAsignacion('W20')).toBe(false)
  })
})
