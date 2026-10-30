/**
 * Cobranza v2 — semaforo y reparto por banda, con datos FALSOS (sin base, sin red).
 * Escrito el 2026-10-30 por un ejecutor del Socio: hoy todos los deudores reales
 * estan en verde, asi que el rojo solo se puede ejercitar aqui.
 */

import { test, expect } from '@playwright/test'
import { armarFilasCobranza } from '@/components/v2/cobranza/leer'
import { bandaDe, pctPorBanda, totalesPorBanda } from '@/components/v2/cobranza/semaforo'
import type { FilaCarteraVista } from '@/lib/vistas'

function fila(id: string, deuda: number, dias: number | null, extra: Partial<FilaCarteraVista> = {}): FilaCarteraVista {
  return {
    id_entidad: id,
    nombre: `Nodo ${id}`,
    rol: 'DST',
    recibidas: 10,
    salidas: 4,
    libro_dice: 6,
    generado: deuda + 100,
    abonado: 100,
    porcentaje_pagado: 0.5,
    estimado_en_piso: 6,
    deuda,
    ultimo_abono: dias === null ? null : '2026-08-01T12:00:00-06:00',
    dias_sin_abono: dias,
    referencia_dias: dias === null ? 'NINGUNA' : 'ABONO',
    prioridad: deuda * (dias ?? 0),
    calculado_en: '2026-10-30T00:00:00Z',
    id_acreedor: null,
    ...extra
  }
}

test('umbrales: 30 verde, 31 amarillo, 60 amarillo, 61 rojo, null gris', () => {
  expect(bandaDe(30)).toBe('verde')
  expect(bandaDe(31)).toBe('amarillo')
  expect(bandaDe(60)).toBe('amarillo')
  expect(bandaDe(61)).toBe('rojo')
  expect(bandaDe(null)).toBe('gris')
})

test('reparto por banda: monto, deudores y % del total (con rojo)', () => {
  const cartera = [fila('a', 6000, 90), fila('b', 3000, 45), fila('c', 1000, 10), fila('d', 0, 200)]
  const filas = armarFilasCobranza(cartera, new Map([['a', 500]]), undefined, new Map([['a', '2026-07-15T10:00:00-06:00']]))
  // La fila sin deuda se cae; el orden de v_cartera se respeta.
  expect(filas.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  expect(filas[0].banda).toBe('rojo')
  expect(filas[0].ultimoAbonoMonto).toBe(500)
  expect(filas[0].ultimaEntrega).toBe('2026-07-15T10:00:00-06:00')
  expect(filas[1].ultimaEntrega).toBeNull()
  const tot = totalesPorBanda(filas)
  expect(tot.rojo).toEqual({ n: 1, monto: 6000 })
  expect(tot.amarillo).toEqual({ n: 1, monto: 3000 })
  expect(tot.verde).toEqual({ n: 1, monto: 1000 })
  const pct = pctPorBanda(tot)
  expect(pct.rojo).toBeCloseTo(60, 6)
  expect(pct.amarillo).toBeCloseTo(30, 6)
  expect(pct.verde).toBeCloseTo(10, 6)
  expect(pct.rojo + pct.amarillo + pct.verde + pct.gris).toBeCloseTo(100, 6)
})

test('sin deuda no hay reparto: todo 0, sin dividir entre 0', () => {
  const pct = pctPorBanda(totalesPorBanda([]))
  expect(pct).toEqual({ rojo: 0, amarillo: 0, verde: 0, gris: 0 })
})
