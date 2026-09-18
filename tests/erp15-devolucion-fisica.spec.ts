import { test, expect } from '@playwright/test'
import { motivoEntidadFaltante } from '../lib/inventario-invariante'
import {
  isTipoMovimientoEntrada,
  isTipoMovimientoSalida,
  isTipoMovimientoTraslado
} from '../lib/inventario-types'

/**
 * ERP-15 · la devolucion fisica es UNA fila con las dos entidades.
 *
 * POR QUE ESTE ARCHIVO EXISTE, y no basta con que la suite este en verde:
 * hoy hay CERO filas de `DEVOLUCION_FISICA` en las 488 del ledger, asi que
 * `tests/vistas-equivalencia.spec.ts` no tiene sobre que discrepar. Una prueba
 * que nunca se vio fallar no demuestra nada. Estas son las que fallan si
 * alguien deshace el arreglo.
 */

const MATRIZ = 'ent-matriz'
const DISTRI = 'ent-distribuidor'

test.describe('ERP-15 · la devolucion fisica no se puede escribir a medias', () => {
  test('la fila completa pasa', () => {
    expect(
      motivoEntidadFaltante({
        tipo_movimiento: 'DEVOLUCION_FISICA',
        id_entidad_origen: DISTRI,
        id_entidad_destino: MATRIZ
      })
    ).toBeNull()
  })

  test('CONTROL NEGATIVO: sin origen se detiene, que era el defecto exacto', () => {
    // Esta era la forma que la base aceptaba antes de la migracion
    // `20260918014009`: entraba a la matriz y no salia de nadie, asi que el
    // producto existia en los dos lados a la vez.
    const motivo = motivoEntidadFaltante({
      tipo_movimiento: 'DEVOLUCION_FISICA',
      id_entidad_destino: MATRIZ
    })
    expect(motivo).not.toBeNull()
    expect(motivo).toContain('id_entidad_origen')
    expect(motivo).toContain('ERP-15')
  })

  test('CONTROL NEGATIVO: sin destino tambien se detiene', () => {
    const motivo = motivoEntidadFaltante({
      tipo_movimiento: 'DEVOLUCION_FISICA',
      id_entidad_origen: DISTRI
    })
    expect(motivo).not.toBeNull()
    expect(motivo).toContain('id_entidad_destino')
  })

  test('CONTROL NEGATIVO: salir y llegar a la misma entidad no movio nada', () => {
    const motivo = motivoEntidadFaltante({
      tipo_movimiento: 'DEVOLUCION_FISICA',
      id_entidad_origen: MATRIZ,
      id_entidad_destino: MATRIZ
    })
    expect(motivo).not.toBeNull()
    expect(motivo).toContain('no movio nada')
  })

  test('un traslado esta en las DOS listas a proposito, y eso se afirma aqui', () => {
    // Si alguien "limpia" esto creyendo que es un error de dedo, la vista
    // `v_stock_por_cubeta` y el replay de TypeScript dejan de coincidir: la
    // vista SI resta al origen desde la migracion `20260918014009`.
    expect(isTipoMovimientoTraslado('DEVOLUCION_FISICA')).toBe(true)
    expect(isTipoMovimientoEntrada('DEVOLUCION_FISICA')).toBe(true)
    expect(isTipoMovimientoSalida('DEVOLUCION_FISICA')).toBe(true)
  })

  test('y NINGUN otro tipo es traslado: la excepcion no se contagia', () => {
    for (const tipo of ['ENTRADA_COMPRA', 'SALIDA_VENTA', 'PRODUCCION', 'MERMA', 'TRASPASO', 'ENTRADA_CONCESION', 'SALIDA_CONCESION']) {
      expect(isTipoMovimientoTraslado(tipo), `${tipo} no deberia ser traslado`).toBe(false)
      expect(
        isTipoMovimientoEntrada(tipo) && isTipoMovimientoSalida(tipo),
        `${tipo} no puede ser entrada y salida a la vez`
      ).toBe(false)
    }
  })
})
