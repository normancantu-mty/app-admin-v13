/**
 * Front v2 — la aritmetica del dinero que pintan las pantallas `/v2`.
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 * Proyecto `puras`: sin base ni red.
 *
 * Lo que protege: que la regla de `lib/v2/dinero.ts` siga siendo la de
 * `public.saldo_cuenta(uuid)`. Si divergen, la pantalla pinta un saldo y el
 * libro dice otro.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  cascadaDeCaja,
  cuadra,
  dineroPorMes,
  efectoEnCuenta,
  egresosPorCategoria,
  saldoDesdeMovimientos,
  TIPOS_EGRESO,
  TIPOS_INGRESO,
  type MovimientoDinero
} from '@/lib/v2/dinero'
import { esRutaProtegida } from '@/lib/puerta-dashboard'

const EF = 'cuenta-efectivo'
const FI = 'cuenta-fresnillo'
const TR = 'cuenta-transferencias'
const GI = 'cuenta-gilberto'
const MATRIZ = new Set([EF, FI, TR, GI])

let n = 0
function mov(p: Partial<MovimientoDinero>): MovimientoDinero {
  n += 1
  return {
    id: `m${n}`,
    tipo_movimiento: 'GASTO_OPERATIVO',
    monto: 0,
    status: 'ACTIVO',
    categoria: null,
    subcategoria: null,
    categoria_gasto: null,
    descripcion: null,
    fecha_movimiento: '2026-10-28T05:59:00Z',
    id_cuenta_origen: null,
    id_cuenta_destino: null,
    id_entidad_relacionada: null,
    usuario_creador: null,
    ...p
  }
}

// La foto real del arranque conciliado (base local 2026-10-29).
const ARRANQUE = [
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 4690, id_cuenta_destino: EF, categoria: 'ARRANQUE' }),
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 12059.33, id_cuenta_destino: FI, categoria: 'ARRANQUE' }),
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 599, id_cuenta_destino: TR, categoria: 'ARRANQUE' }),
  // CARGO_DEUDA de la cartera: no toca cuentas de la matriz
  mov({ tipo_movimiento: 'CARGO_DEUDA', monto: 11327, categoria: 'ARRANQUE' })
]

test.describe('Front v2 · saldo por cuenta = regla de saldo_cuenta()', () => {
  test('las listas de tipos son las de la funcion SQL (leidas de la migracion)', () => {
    const sql = fs.readFileSync(
      path.join(process.cwd(), 'supabase/migrations/20261028120100_v2_cuentas_clase_y_saldo_inicial.sql'),
      'utf-8'
    )
    for (const t of [...TIPOS_INGRESO, ...TIPOS_EGRESO]) expect(sql, `${t} no esta en saldo_cuenta`).toContain(`'${t}'`)
  })

  test('el arranque da los 4 saldos reales y suma 17,348.33', () => {
    expect(saldoDesdeMovimientos(ARRANQUE, EF)).toBe(4690)
    expect(saldoDesdeMovimientos(ARRANQUE, FI)).toBe(12059.33)
    expect(saldoDesdeMovimientos(ARRANQUE, TR)).toBe(599)
    expect(saldoDesdeMovimientos(ARRANQUE, GI)).toBe(0)
    const pasos = cascadaDeCaja(ARRANQUE, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'))
    expect(pasos[0]).toEqual({ etiqueta: 'Inicio', valor: 0, tipo: 'inicio' })
    expect(pasos.at(-1)?.valor).toBe(17348.33)
  })

  test('egreso usa COALESCE(origen, destino); ingreso solo destino', () => {
    expect(efectoEnCuenta(mov({ monto: 100, id_cuenta_origen: EF }), EF)).toBe(-100)
    expect(efectoEnCuenta(mov({ monto: 100, id_cuenta_destino: EF }), EF)).toBe(-100)
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 599, id_cuenta_origen: EF }), EF)).toBe(0)
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 599, id_cuenta_destino: EF }), EF)).toBe(599)
  })

  test('ANULADO y ABONO_PENDIENTE no cuentan (control negativo)', () => {
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 50, id_cuenta_destino: EF, status: 'ANULADO' }), EF)).toBe(0)
    expect(
      efectoEnCuenta(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 50, id_cuenta_destino: EF, categoria: 'ABONO_PENDIENTE' }), EF)
    ).toBe(0)
  })
})

test.describe('Front v2 · conversion 95/5 en la cascada y por mes', () => {
  // Como la escribe `convertir_transferencias` (migracion 20261028120300): neto
  // de Transferencias a Efectivo como traspaso, y la comision como gasto que
  // sale de Transferencias.
  const conv = [
    ...ARRANQUE,
    mov({ tipo_movimiento: 'EGRESO_TRASPASO', monto: 569.05, id_cuenta_origen: TR, id_cuenta_destino: EF, fecha_movimiento: '2026-10-29T18:00:00Z' }),
    mov({ tipo_movimiento: 'INGRESO_TRASPASO', monto: 569.05, id_cuenta_origen: TR, id_cuenta_destino: EF, fecha_movimiento: '2026-10-29T18:00:00Z' }),
    mov({
      tipo_movimiento: 'GASTO_OPERATIVO',
      monto: 29.95,
      id_cuenta_origen: TR,
      categoria: 'Financieros',
      subcategoria: 'Comisión por conversión de transferencias',
      fecha_movimiento: '2026-10-29T18:00:00Z'
    })
  ]

  test('los traspasos se netean y la comision aparece como gasto Financieros', () => {
    const pasos = cascadaDeCaja(conv, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'))
    const final = pasos.at(-1)!.valor
    expect(cuadra(final, 17348.33 - 29.95)).toBe(true)
    expect(pasos.find((p) => p.etiqueta === 'Financieros')?.valor).toBe(-29.95)
    expect(pasos.find((p) => p.etiqueta === 'Traspasos (neto)')).toBeUndefined()
  })

  test('por mes: el saldo de arranque y los traspasos no son entrada ni salida', () => {
    const [oct] = dineroPorMes(conv, MATRIZ, ['2026-10'])
    expect(oct.entro).toBe(0)
    expect(oct.salio).toBeCloseTo(29.95, 2)
    expect(oct.egresoPorCategoria).toEqual({ Financieros: 29.95 })
  })

  test('egresos por categoria agrupan subcategoria', () => {
    expect(saldoDesdeMovimientos(conv, TR)).toBe(0)
    expect(saldoDesdeMovimientos(conv, EF)).toBe(5259.05)
    const cats = egresosPorCategoria(conv, TR)
    expect(cats).toHaveLength(1)
    expect(cats[0].categoria).toBe('Financieros')
    expect(cats[0].subcategorias[0].subcategoria).toBe('Comisión por conversión de transferencias')
  })
})

test.describe('Front v2 · la puerta cubre /v2', () => {
  test('/v2 y sus subrutas son protegidas, /v2x no', () => {
    expect(esRutaProtegida('/v2')).toBe(true)
    expect(esRutaProtegida('/v2/cartera')).toBe(true)
    expect(esRutaProtegida('/v2x')).toBe(false)
  })
})
