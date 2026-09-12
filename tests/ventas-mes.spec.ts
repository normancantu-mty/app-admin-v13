import { test, expect } from '@playwright/test'

import {
  conTendencia,
  esMesEnCurso,
  mesesEnCaida,
  nombreDelMes,
  totalVendido,
  type VentasDeUnMes
} from '../lib/ventas-mes'

/**
 * Pruebas PURAS de la pantalla de ventas por mes. Sin base y sin navegador.
 *
 * El caso que mas importa de este archivo es `nombreDelMes`: el defecto de
 * huso horario que motivo toda la pantalla se puede colar otra vez por la
 * puerta de atras, al FORMATEAR la fecha, aunque la base la haya agrupado bien.
 */

function mes(m: string, vendido: number, tickets = 1): VentasDeUnMes {
  return {
    mes: m,
    tickets,
    vendido,
    vendido_contado: null,
    vendido_concesion: null,
    tickets_concesion: 0,
    compradores: 1
  }
}

test.describe('ventas por mes · el nombre del mes', () => {
  test('el dia 1 NO se corre al mes anterior', () => {
    // `new Date('2026-08-01')` es medianoche UTC = 31 de julio 18:00 en Mexico.
    // Si esta prueba dice "julio", alguien metio un `new Date` en el camino.
    expect(nombreDelMes('2026-08-01')).toBe('agosto 2026')
  })

  test('enero y diciembre, que son donde se rompen los indices', () => {
    expect(nombreDelMes('2026-01-01')).toBe('enero 2026')
    expect(nombreDelMes('2026-12-01')).toBe('diciembre 2026')
  })

  test('una cadena rara se devuelve tal cual, no se inventa un mes', () => {
    expect(nombreDelMes('no-es-fecha')).toBe('no-es-fecha')
    expect(nombreDelMes('2026-13-01')).toBe('2026-13-01')
  })
})

test.describe('ventas por mes · la tendencia', () => {
  const historia = [mes('2026-07-01', 100), mes('2026-05-01', 50), mes('2026-06-01', 200)]

  test('se ordena del mas viejo al mas nuevo aunque llegue revuelto', () => {
    expect(conTendencia(historia).map((f) => f.mes)).toEqual([
      '2026-05-01',
      '2026-06-01',
      '2026-07-01'
    ])
  })

  test('el mes mas viejo no tiene cambio, y es null y no cero', () => {
    const [primero] = conTendencia(historia)
    expect(primero.cambio, 'cero diria "no cambio"; la verdad es "no hay con que comparar"').toBeNull()
    expect(primero.cambioRelativo).toBeNull()
  })

  test('el cambio se mide contra el mes inmediato anterior', () => {
    const filas = conTendencia(historia)
    expect(filas[1].cambio).toBe(150)
    expect(filas[1].cambioRelativo).toBeCloseTo(3, 10)
    expect(filas[2].cambio).toBe(-100)
    expect(filas[2].cambioRelativo).toBeCloseTo(-0.5, 10)
  })

  test('un mes anterior en cero no produce Infinity', () => {
    const filas = conTendencia([mes('2026-05-01', 0), mes('2026-06-01', 900)])
    expect(filas[1].cambio, 'el absoluto si se puede decir').toBe(900)
    expect(filas[1].cambioRelativo, 'el porcentaje contra cero no significa nada').toBeNull()
  })

  test('el ticket promedio no divide entre cero', () => {
    const filas = conTendencia([mes('2026-05-01', 0, 0)])
    expect(filas[0].ticketPromedio).toBe(0)
  })

  test('el ticket promedio sale de los tickets del mes, no del total', () => {
    const filas = conTendencia([mes('2026-05-01', 1000, 4)])
    expect(filas[0].ticketPromedio).toBe(250)
  })
})

test.describe('ventas por mes · la racha de caida', () => {
  test('tres meses seguidos bajando son tres', () => {
    expect(
      mesesEnCaida([
        mes('2026-05-01', 100),
        mes('2026-06-01', 90),
        mes('2026-07-01', 80),
        mes('2026-08-01', 70)
      ])
    ).toBe(3)
  })

  test('un repunte al final corta la racha aunque antes viniera bajando', () => {
    expect(
      mesesEnCaida([mes('2026-05-01', 100), mes('2026-06-01', 50), mes('2026-07-01', 60)])
    ).toBe(0)
  })

  test('empatar NO cuenta como caida', () => {
    expect(mesesEnCaida([mes('2026-05-01', 100), mes('2026-06-01', 100)])).toBe(0)
  })

  test('un solo mes no tiene racha', () => {
    expect(mesesEnCaida([mes('2026-05-01', 100)])).toBe(0)
    expect(mesesEnCaida([])).toBe(0)
  })
})

test.describe('ventas por mes · el mes en curso', () => {
  test('el mes de hoy se marca como incompleto', () => {
    expect(esMesEnCurso('2026-09-01', '2026-09-12')).toBe(true)
  })

  test('el mes pasado ya esta cerrado', () => {
    expect(esMesEnCurso('2026-08-01', '2026-09-12')).toBe(false)
  })

  test('el mismo mes de otro año no es el mes en curso', () => {
    expect(esMesEnCurso('2025-09-01', '2026-09-12')).toBe(false)
  })
})

test.describe('ventas por mes · la suma de control', () => {
  test('la suma de los meses es el total, que es como se detecta un mes perdido', () => {
    expect(totalVendido([mes('2026-05-01', 78574), mes('2026-06-01', 125082)])).toBe(203656)
  })

  test('sin meses el total es cero, no NaN', () => {
    expect(totalVendido([])).toBe(0)
  })
})
