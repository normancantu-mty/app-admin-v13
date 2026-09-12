import { test, expect } from '@playwright/test'

import {
  claveDeLibro,
  diferenciasDeConteo,
  resumenDeDescuadres,
  soloDescuadres,
  validarConteo,
  type ConteoCapturado,
  type LibroPorSku
} from '../lib/conteo'

/**
 * ERP-54 — pruebas PURAS del conteo fisico. Sin base y sin navegador: corren
 * siempre, tambien en CI, que es justo lo que ERP-70 dice que les falta a las
 * de equivalencia.
 */

const GUAJILLO_750 = '11111111-aaaa-4aaa-8aaa-111111111111'
const GUAJILLO_250 = '22222222-bbbb-4bbb-8bbb-222222222222'

const HOY = '2026-09-12'

function conteo(parcial: Partial<ConteoCapturado> = {}): ConteoCapturado {
  return {
    idEntidad: 'e0000000-0000-4000-8000-000000000001',
    fechaConteo: HOY,
    lineas: [{ idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 14 }],
    ...parcial
  }
}

test.describe('ERP-54 · validacion del conteo', () => {
  test('un conteo normal no tiene nada que reclamar', () => {
    expect(validarConteo(conteo(), HOY)).toEqual([])
  })

  test('la fecha del hecho no puede ser futura', () => {
    const errores = validarConteo(conteo({ fechaConteo: '2026-09-13' }), HOY)
    expect(errores.join(' ')).toContain('futura')
  })

  test('un conteo de hoy SI vale: el limite es futuro, no pasado', () => {
    expect(validarConteo(conteo({ fechaConteo: HOY }), HOY)).toEqual([])
  })

  test('el mismo SKU dos veces en la misma cubeta se rechaza', () => {
    const errores = validarConteo(
      conteo({
        lineas: [
          { idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 14 },
          { idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 9 }
        ]
      }),
      HOY
    )
    expect(errores.join(' ')).toContain('dos veces')
  })

  test('el mismo SKU en DOS cubetas distintas es legitimo', () => {
    const errores = validarConteo(
      conteo({
        lineas: [
          { idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 14 },
          { idProducto: GUAJILLO_750, cubeta: 'PAGADO', piezasContadas: 3 }
        ]
      }),
      HOY
    )
    expect(errores).toEqual([])
  })

  test('no se cuentan botellas negativas ni fracciones', () => {
    expect(
      validarConteo(conteo({ lineas: [{ idProducto: GUAJILLO_750, cubeta: 'PAGADO', piezasContadas: -1 }] }), HOY)
        .join(' ')
    ).toContain('menos de cero')

    expect(
      validarConteo(conteo({ lineas: [{ idProducto: GUAJILLO_750, cubeta: 'PAGADO', piezasContadas: 2.5 }] }), HOY)
        .join(' ')
    ).toContain('fracciones')
  })

  test('un conteo vacio no es un conteo parcial: es nada', () => {
    expect(validarConteo(conteo({ lineas: [] }), HOY).join(' ')).toContain('ni una linea')
  })
})

test.describe('ERP-54 · la diferencia contra el libro', () => {
  const libro: LibroPorSku = new Map([
    [claveDeLibro('CONSIGNADO', GUAJILLO_750), 20],
    [claveDeLibro('CONSIGNADO', GUAJILLO_250), 9]
  ])

  test('faltante: el libro dice 20, en el piso hay 14', () => {
    const [fila] = diferenciasDeConteo(
      [{ idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 14 }],
      libro
    )
    expect(fila.libroDecia).toBe(20)
    expect(fila.diferencia).toBe(6)
  })

  test('sobrante: la diferencia sale negativa, no se recorta a cero', () => {
    const [fila] = diferenciasDeConteo(
      [{ idProducto: GUAJILLO_250, cubeta: 'CONSIGNADO', piezasContadas: 12 }],
      libro
    )
    expect(fila.diferencia).toBe(-3)
  })

  test('un SKU que el libro no conoce vale 0 y NO se salta', () => {
    const [fila] = diferenciasDeConteo(
      [{ idProducto: 'ffffffff-cccc-4ccc-8ccc-ffffffffffff', cubeta: 'PAGADO', piezasContadas: 4 }],
      libro
    )
    expect(fila.libroDecia).toBe(0)
    expect(fila.diferencia).toBe(-4)
  })

  test('la cubeta separa: contar lo PAGADO no toca lo CONSIGNADO', () => {
    const [fila] = diferenciasDeConteo(
      [{ idProducto: GUAJILLO_750, cubeta: 'PAGADO', piezasContadas: 0 }],
      libro
    )
    expect(fila.libroDecia, 'las 20 son de la cubeta CONSIGNADO').toBe(0)
  })

  test('las lineas que cuadran se guardan igual, y no son descuadre', () => {
    const diferencias = diferenciasDeConteo(
      [
        { idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 20 },
        { idProducto: GUAJILLO_250, cubeta: 'CONSIGNADO', piezasContadas: 4 }
      ],
      libro
    )
    expect(diferencias).toHaveLength(2)
    expect(soloDescuadres(diferencias)).toHaveLength(1)
  })
})

test.describe('ERP-54 · el renglon que lee un humano', () => {
  const libro: LibroPorSku = new Map([
    [claveDeLibro('CONSIGNADO', GUAJILLO_750), 20],
    [claveDeLibro('CONSIGNADO', GUAJILLO_250), 9]
  ])

  test('cuadrado: lo dice sin rodeos', () => {
    const diferencias = diferenciasDeConteo(
      [{ idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 20 }],
      libro
    )
    expect(resumenDeDescuadres(diferencias)).toContain('cuadro con el libro')
  })

  test('faltantes y sobrantes no se cancelan entre si', () => {
    const diferencias = diferenciasDeConteo(
      [
        { idProducto: GUAJILLO_750, cubeta: 'CONSIGNADO', piezasContadas: 14 },
        { idProducto: GUAJILLO_250, cubeta: 'CONSIGNADO', piezasContadas: 12 }
      ],
      libro
    )

    const resumen = resumenDeDescuadres(diferencias)
    expect(resumen).toContain('faltan 6')
    expect(resumen).toContain('sobran 3')
    expect(resumen, 'dos SKU sin cuadrar, no uno neto').toContain('2 SKU')
  })
})
