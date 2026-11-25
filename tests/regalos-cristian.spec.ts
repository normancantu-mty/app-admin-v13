import { test, expect } from '@playwright/test'
import { QUIENES_CONOCIDOS, armarCartera, leerConsultaRegalos, leerRegalo, normalizarQuien, textoContador, type LineaCartera, type ProductoRegalo } from '@/lib/regalos'

/**
 * 2026-11-25: el contador es de Norman, Kevin y Cristian. Sin Cristian en la lista, "de Cristian" se iba a la razon y
 * el regalo se contaba a quien dictaba; y "cristian" (etiqueta del bot) y "Cristian" salian en dos renglones.
 */
const PRODUCTOS: ProductoRegalo[] = [
  { id: 'p-750', nombre: 'Destilado Plata 750ml', ml_por_unidad: 750, costo_unitario: 0 },
  { id: 'p-250', nombre: 'Destilado Plata 250ml', ml_por_unidad: 250, costo_unitario: 0 },
  { id: 'p-50', nombre: 'Destilado Plata 50ml', ml_por_unidad: 50, costo_unitario: 0 }
]

test.describe('regalos (pura): Cristian cuenta como Cristian', () => {
  test('los tres del contador estan en la lista', () => {
    for (const q of ['Norman', 'Kevin', 'Cristian']) expect(QUIENES_CONOCIDOS as readonly string[]).toContain(q)
    expect(normalizarQuien('cristian')).toBe('Cristian')
  })

  test('dicho por Norman, se le cuenta a Cristian y no a quien dicta', () => {
    expect(leerRegalo('Regalo una grande de Cristian en la feria', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Cristian', motivo: 'la feria' })
    expect(leerRegalo('Cristian regalo 2 grandes en la feria', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Cristian' })
    expect(leerRegalo('Regalo 2 minis en la expo', PRODUCTOS, 'cristian')).toMatchObject({ ok: true, quien: 'Cristian' })
  })

  test('un solo renglon en el contador, y "mis regalos" lo encuentra', () => {
    const l = (o: Partial<LineaCartera>): LineaCartera => ({
      id_regalo: 'r1', fecha: '2026-11-25', quien_regalo: 'Cristian', motivo: 'Feria', usuario_creador: null,
      id_producto: 'p-750', producto: 'Destilado Plata 750ml', ml_por_unidad: 750, piezas: 2, ...o
    })
    const c = armarCartera([l({}), l({ id_regalo: 'r2', quien_regalo: 'cristian', piezas: 3 })])
    expect(c.porPersona).toMatchObject([{ clave: 'Cristian', piezas: 5 }])
    expect(leerConsultaRegalos('mis regalos', 'cristian', [])).toEqual({ quien: 'Cristian' })
    expect(textoContador(c, 'Cristian')).toContain('Cristian: 5 botellas')
  })
})
