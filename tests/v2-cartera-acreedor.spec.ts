import { test, expect } from '@playwright/test'
import { lineaDeudaConDistribuidor, textoCartera, textoQuienDebe } from '../lib/bot-consultas'
import type { FilaCarteraVista } from '../lib/vistas'

/**
 * v2 (2026-10-29, Socio ejecutor): la cartera de la MATRIZ no suma la deuda de los
 * locales con su distribuidor. Cifras de la carga conciliada
 * (Socio/_checkpoints/conciliacion_locales_2026-10-29.json): con la matriz 49,155.93;
 * locales con su DST 19,382.00 (Al son 11,832 + Ruiz 3,134 con David; Nuevo Ideal
 * 4,416 con Gilberto). Antes el total salia 68,537.93.
 */
const DAVID = 'e-david'
const GILBERTO = 'e-gilberto'
const f = (nombre: string, rol: 'DST' | 'LOC', deuda: number, id_acreedor: string | null) =>
  ({ id_entidad: 'e-' + nombre, nombre, rol, deuda, porcentaje_pagado: null, dias_sin_abono: null, id_acreedor }) as unknown as FilaCarteraVista

const CARGA = [
  f('Al son del Mezcal', 'LOC', 11832, DAVID),
  f('Martin Reyes', 'DST', 11327, null),
  f('Gilberto Franco', 'DST', 8496, null),
  f('Delirio 85', 'LOC', 7992, null),
  f('Aeropuerto', 'LOC', 7000, null),
  f('David Flores', 'DST', 6812.93, null),
  f('Nuevo Ideal', 'LOC', 4416, GILBERTO),
  f('Rey Tiburon', 'LOC', 3568, null),
  f('Dulceria ruiz', 'LOC', 3134, DAVID),
  f('Ale Ortega Expressate', 'DST', 2040, null),
  f('Casa Verde', 'LOC', 1920, null)
]

test.describe('v2 · cartera de la matriz sin doble conteo', () => {
  test('CARTERA suma solo la deuda con la matriz y dice aparte la de los locales con su DST', () => {
    const t = textoCartera(CARGA)
    expect(t).toContain('CARTERA — $49,155.93 por cobrar, 11 deudor(es)')
    expect(t).toContain('no suma $19,382.00 que 3 local(es) le deben a su distribuidor')
    expect(t).not.toContain('68,537.93')
  })

  test('QUIEN DEBE suma solo la deuda con la matriz', () => {
    const t = textoQuienDebe(CARGA)
    expect(t).toContain('QUIEN DEBE — $49,155.93 de concesion')
    expect(t).toContain('no suma $19,382.00')
  })

  test('sin acreedor (filas viejas) el texto no cambia: no hay linea aparte', () => {
    const viejas = CARGA.map((x) => ({ ...x, id_acreedor: undefined }))
    expect(lineaDeudaConDistribuidor(viejas)).toBeNull()
    expect(textoCartera(viejas)).toContain('CARTERA — $68,537.93 por cobrar')
  })

  test('un DST viendo su red: su deuda con la matriz arriba, la de sus locales aparte', () => {
    const red = [f('David Flores', 'DST', 6812.93, null), f('Al son del Mezcal', 'LOC', 11832, DAVID), f('Dulceria ruiz', 'LOC', 3134, DAVID)]
    const t = textoQuienDebe(red)
    expect(t).toContain('QUIEN DEBE — $6,812.93 de concesion')
    expect(t).toContain('no suma $14,966.00 que 2 local(es)')
  })
})
