import { test, expect } from '@playwright/test'
import {
  CONSULTAS,
  entidadALaQueSeAcota,
  esAdministrador,
  esConsultaValida,
  pesos,
  piezas,
  pieDeConsulta,
  sinDatos,
  textoCartera,
  textoStock,
  textoVentas
} from '../lib/bot-consultas'
import type { FilaCarteraVista, FilaStockPorCubeta, FilaVentasPorMes } from '../lib/vistas'

/**
 * AG-04 Fase 3 — las pruebas de las consultas.
 *
 * Lo que vigilan no es el formato: es que **el bot no pueda contestar un numero
 * que no existe**. Una escritura mala se ANULA y se ve en el ledger; una
 * consulta que miente no deja rastro y se convierte en una decision tomada con
 * un dato inventado.
 */

const ADMIN = { idEntidad: 'e-admin', rol: 'ADMIN', nombreEntidad: 'CEO Admin' }
const DIST = { idEntidad: 'e-dist', rol: 'DST', nombreEntidad: 'Delirio 85' }

test.describe('el alcance se decide en un solo lugar', () => {
  test('ADMIN ve todo; cualquier otro rol ve SOLO lo suyo', () => {
    expect(esAdministrador(ADMIN)).toBe(true)
    expect(entidadALaQueSeAcota(ADMIN)).toBeNull()

    expect(esAdministrador(DIST)).toBe(false)
    expect(entidadALaQueSeAcota(DIST)).toBe('e-dist')
  })

  test('un rol que no se pudo leer NO es admin: el default es el restrictivo', () => {
    // `resolverIdentidad` pone 'DESCONOCIDO' si falla la lectura de la entidad.
    // Un default permisivo convierte un error de red en una fuga de datos.
    const roto = { idEntidad: 'e-x', rol: 'DESCONOCIDO', nombreEntidad: '?' }
    expect(esAdministrador(roto)).toBe(false)
    expect(entidadALaQueSeAcota(roto)).toBe('e-x')
    for (const r of ['', 'admin', 'Admin', 'LOC', 'DST', 'SOCIO']) {
      expect(esAdministrador({ ...roto, rol: r }), r).toBe(false)
    }
  })

  test('la consulta sale de una lista cerrada', () => {
    for (const c of CONSULTAS) expect(esConsultaValida(c)).toBe(true)
    for (const malo of ['ventas ', 'STOCK', 'borrar', '', null, 7, {}]) {
      expect(esConsultaValida(malo), JSON.stringify(malo)).toBe(false)
    }
  })
})

test.describe('cero filas NO es cero pesos', () => {
  test('sin filas dice que no hay dato, y no imprime un cero', () => {
    const s = textoStock([], null)
    expect(s).toContain('No tengo datos')
    expect(s).not.toContain('$0')

    const c = textoCartera([])
    expect(c).toContain('No tengo datos')
    expect(c).not.toContain('$0.00')

    expect(textoVentas([])).toContain('No tengo datos')
    expect(sinDatos('x')).toContain('No es que sea cero')
  })

  test('y el control positivo: CON filas si imprime la cifra', () => {
    const filas: FilaStockPorCubeta[] = [
      {
        id_entidad: 'e1',
        entidad: 'Delirio 85',
        id_producto: 'p1',
        producto: 'Chile 750',
        cubeta: 'PAGADO',
        stock: 12
      }
    ]
    const s = textoStock(filas, null)
    expect(s).toContain('12 piezas')
    expect(s).toContain('Delirio 85')
    expect(s).not.toContain('No tengo datos')
  })
})

test.describe('los numeros salen de la vista y nunca se recalculan mal', () => {
  test('el stock en 0 no se lista, pero tampoco borra el resto', () => {
    const filas: FilaStockPorCubeta[] = [
      { id_entidad: 'e1', entidad: 'A', id_producto: 'p1', producto: 'X', cubeta: 'PAGADO', stock: 0 },
      { id_entidad: 'e2', entidad: 'B', id_producto: 'p1', producto: 'X', cubeta: 'PAGADO', stock: 5 }
    ]
    const s = textoStock(filas, null)
    expect(s).toContain('5 piezas')
    expect(s).not.toContain('A:')
  })

  test('una pieza va en singular: el detalle que delata un formateo a mano', () => {
    expect(piezas(1)).toBe('1 pieza')
    expect(piezas(2)).toBe('2 piezas')
    expect(piezas(0)).toBe('0 piezas')
  })

  test('el peso lleva SIEMPRE dos decimales', () => {
    expect(pesos(1234.5)).toBe('$1,234.50')
    expect(pesos(0)).toBe('$0.00')
  })
})

test.describe('la cartera no inventa un porcentaje que la vista dejo en null', () => {
  const base = {
    id_entidad: 'e1',
    nombre: 'Dulceria el Eden',
    rol: 'LOC' as const,
    recibidas: 10,
    salidas: 0,
    libro_dice: 10,
    generado: 3610,
    abonado: 0,
    estimado_en_piso: 0,
    deuda: 3610,
    ultimo_abono: null,
    dias_sin_abono: null,
    referencia_dias: 'NINGUNA' as const,
    prioridad: 0,
    calculado_en: '2026-09-12T17:00:00.000Z'
  }

  test('porcentaje null se dice con palabras, NO como 0%', () => {
    const t = textoCartera([{ ...base, porcentaje_pagado: null } as FilaCarteraVista])
    expect(t).toContain('no genero deuda')
    expect(t).not.toContain('0% pagado')
    expect(t).toContain('nunca ha abonado')
  })

  test('y el control positivo: el porcentaje sale x100, NO como fraccion', () => {
    // El valor es el REAL de produccion para Delirio 85 el 2026-09-12.
    // Escrito asi a proposito: la version anterior de esta prueba usaba `42`
    // asumiendo escala 0-100, y por eso paso en verde mientras el bot decia
    // "1% pagado" donde lo real era 75.7%. **Una prueba escrita con mi
    // suposicion en vez de con el dato de la vista no prueba nada** (E-243).
    const t = textoCartera([
      { ...base, porcentaje_pagado: 0.75713288108539505188, dias_sin_abono: 18 } as FilaCarteraVista
    ])
    expect(t).toContain('75.7% pagado')
    expect(t).not.toContain('1% pagado')
    expect(t).toContain('18 d sin abonar')
  })

  test('una fraccion chica no se redondea a 0%, que seria otra mentira', () => {
    const t = textoCartera([{ ...base, porcentaje_pagado: 0.004 } as FilaCarteraVista])
    expect(t).toContain('0.4% pagado')
  })

  test('sin deuda no aparece en la cartera: no se llama a quien no debe', () => {
    const t = textoCartera([{ ...base, deuda: 0, porcentaje_pagado: 100 } as FilaCarteraVista])
    expect(t).toContain('No tengo datos')
  })

  test('ordena por deuda: es el orden en que se decide a quien llamar', () => {
    const t = textoCartera([
      { ...base, nombre: 'Chico', deuda: 100, porcentaje_pagado: 0 } as FilaCarteraVista,
      { ...base, nombre: 'Grande', deuda: 9000, porcentaje_pagado: 0 } as FilaCarteraVista
    ])
    expect(t.indexOf('Grande')).toBeLessThan(t.indexOf('Chico'))
    expect(t).toContain('$9,100.00 por cobrar')
  })
})

test.describe('contado y concesion NUNCA se suman en una sola cifra', () => {
  test('se imprimen por separado, porque una concesion no es dinero cobrado', () => {
    const filas: FilaVentasPorMes[] = [
      {
        mes: '2026-08-01',
        tickets: 10,
        vendido: 5000,
        vendido_contado: 3000,
        vendido_concesion: 2000,
        tickets_concesion: 4,
        compradores: 7
      }
    ]
    const t = textoVentas(filas)
    expect(t).toContain('$5,000.00')
    expect(t).toContain('contado $3,000.00')
    expect(t).toContain('concesion $2,000.00')
  })

  test('un null de contado no se imprime como "NaN"', () => {
    const filas: FilaVentasPorMes[] = [
      {
        mes: '2026-08-01',
        tickets: 1,
        vendido: 100,
        vendido_contado: null,
        vendido_concesion: null,
        tickets_concesion: 0,
        compradores: 1
      }
    ]
    const t = textoVentas(filas)
    expect(t).not.toContain('NaN')
    expect(t).toContain('contado $0.00')
  })
})

test('toda respuesta dice de que vista salio: un numero sin procedencia no se manda', () => {
  const pie = pieDeConsulta('v_cartera', '2026-09-12T17:00:00.000Z')
  expect(pie).toContain('v_cartera')
  expect(pie).toContain('calculado')
  expect(pieDeConsulta('v_stock_por_cubeta')).toContain('al momento')
  // Una fecha basura no rompe la respuesta ni imprime "Invalid Date".
  expect(pieDeConsulta('v_cartera', 'no-es-fecha')).not.toContain('Invalid')
})
