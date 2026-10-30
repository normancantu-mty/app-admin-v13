import { test, expect } from '@playwright/test'

import {
  apiladoPorMes,
  armarVentasCobros,
  filtrar,
  mesesDelPeriodo,
  ranking,
  serieGeneral,
  totales,
  type CobroCrudo,
  type TicketCrudo
} from '../lib/v2/ventas-cobros'

/**
 * Pruebas PURAS de la tarjeta "Vendido y cobrado por mes" (Front v2). Sin base y sin
 * navegador: la base esta vacia de ventas, asi que el agrupado se prueba aqui con
 * datos falsos. Escrito el 2026-10-30 por un ejecutor del Socio.
 */

const ENT = new Map([
  ['adm', { nombre: 'Matriz', rol: 'ADMIN' }],
  ['dst1', { nombre: 'Distribuidor Uno', rol: 'DST' }],
  ['loc1', { nombre: 'Local Uno', rol: 'LOC' }],
  ['loc2', { nombre: 'Local Dos', rol: 'LOC' }]
])
const CUENTAS_MATRIZ = new Set(['cta-efectivo'])

function ticket(id: string, fecha: string, condicion: string, comprador: string, vendedor: string, total: number, lineas: [string, number, number][]): TicketCrudo {
  return {
    id,
    fecha_transaccion: fecha,
    condicion_pago: condicion,
    id_comprador: comprador,
    id_vendedor: vendedor,
    total_cobrado_real: total,
    ticket_detalles: lineas.map(([prod, cantidad, subtotal]) => ({
      id_producto: prod,
      cantidad,
      subtotal_linea: subtotal,
      catalogo_productos: { nombre: prod.toUpperCase() }
    }))
  }
}

function cobro(p: Partial<CobroCrudo>): CobroCrudo {
  return {
    monto: 0,
    fecha_movimiento: '2026-08-10T12:00:00-06:00',
    tipo_movimiento: 'ABONO_DEUDA',
    status: 'ACTIVO',
    categoria: null,
    id_ticket: null,
    id_entidad_relacionada: null,
    id_cuenta_destino: 'cta-efectivo',
    ...p
  }
}

const TICKETS: TicketCrudo[] = [
  // 31 de julio 23:30 en Mexico = 1 de agosto en UTC: tiene que caer en JULIO.
  ticket('t1', '2026-07-31T23:30:00-06:00', 'CONTADO', 'loc1', 'adm', 900, [
    ['plata750', 2, 600],
    ['plata375', 4, 400]
  ]), // descuento de ticket: lineas suman 1000, se cobro 900
  ticket('t2', '2026-08-05T10:00:00-06:00', 'CONCESION', 'dst1', 'adm', 3000, [['plata750', 10, 3000]]),
  ticket('t3', '2026-08-20T10:00:00-06:00', 'CONTADO', 'loc2', 'dst1', 500, [['plata750', 1, 500]]) // venta del DST: solo "toda la red"
]

const COBROS: CobroCrudo[] = [
  cobro({ tipo_movimiento: 'INGRESO_VENTA', monto: 900, id_ticket: 't1', fecha_movimiento: '2026-07-31T23:30:00-06:00', id_entidad_relacionada: 'adm' }),
  cobro({ monto: 1000, id_entidad_relacionada: 'dst1' }), // abono sin ticket -> concesion, dst1
  cobro({ monto: 777, id_entidad_relacionada: 'loc2', id_cuenta_destino: 'cta-del-dst' }), // Account_Firewall: no es de la matriz
  cobro({ monto: 555, id_entidad_relacionada: 'dst1', categoria: 'ABONO_PENDIENTE' }), // no cuenta
  cobro({ monto: 444, id_entidad_relacionada: 'dst1', status: 'ANULADO' }) // no cuenta
]

const DATOS = armarVentasCobros(TICKETS, COBROS, CUENTAS_MATRIZ, ENT)

test('agrupa en hora de Mexico y reparte el total del ticket por producto sin perder el descuento', () => {
  const t1 = DATOS.ventas.filter((v) => v.mes === '2026-07')
  expect(t1.reduce((a, v) => a + v.pesos, 0)).toBe(900)
  expect(t1.find((v) => v.prod === 'plata750')?.pesos).toBe(540)
  expect(t1.find((v) => v.prod === 'plata375')?.pesos).toBe(360)
  expect(DATOS.productos.plata750).toBe('PLATA750')
})

test('cobrado: solo cuentas de la matriz, sin ABONO_PENDIENTE ni anulados', () => {
  expect(DATOS.cobros.reduce((a, c) => a + c.pesos, 0)).toBe(1900)
  const abono = DATOS.cobros.find((c) => c.pesos === 1000)
  expect(abono?.canal).toBe('CONCESION')
  expect(abono?.cli).toBe('dst1')
  const contado = DATOS.cobros.find((c) => c.pesos === 900)
  expect(contado?.cli).toBe('loc1') // del ticket, no del vendedor
  expect(contado?.mes).toBe('2026-07')
})

test('meses del periodo', () => {
  expect(mesesDelPeriodo('3m', '2026-10', DATOS, null)).toEqual(['2026-08', '2026-09', '2026-10'])
  expect(mesesDelPeriodo('12m', '2026-02', DATOS, null)[0]).toBe('2025-03')
  expect(mesesDelPeriodo('anio', '2026-03', DATOS, null)).toEqual(['2026-01', '2026-02', '2026-03'])
  expect(mesesDelPeriodo('todo', '2026-10', DATOS, '2026-09')[0]).toBe('2026-07')
  const vacio = { ventas: [], cobros: [], productos: {}, clientes: {} }
  expect(mesesDelPeriodo('todo', '2026-10', vacio, '2026-10')).toEqual(['2026-10'])
})

test('totales y % cobrado; la red suma la venta del DST y no da %', () => {
  const meses = mesesDelPeriodo('todo', '2026-10', DATOS, null)
  const m = totales(filtrar(DATOS, meses, 'matriz'), 'pesos', 'matriz')
  expect(m).toEqual({ vendido: 3900, cobrado: 1900, pct: 48.7 })
  const red = totales(filtrar(DATOS, meses, 'red'), 'pesos', 'red')
  expect(red).toEqual({ vendido: 4400, cobrado: 1900, pct: null })
  expect(totales(filtrar(DATOS, meses, 'matriz'), 'piezas', 'matriz')).toEqual({ vendido: 16, cobrado: null, pct: null })
  expect(totales(filtrar(DATOS, ['2026-10'], 'matriz'), 'pesos', 'matriz')).toEqual({ vendido: 0, cobrado: 0, pct: null })
})

test('vista general: contado/concesion por mes y linea de cobrado', () => {
  const meses = ['2026-07', '2026-08']
  const s = serieGeneral(meses, filtrar(DATOS, meses, 'matriz'), 'pesos')
  expect(s).toEqual({ contado: [900, 0], concesion: [0, 3000], cobrado: [900, 1000] })
})

test('ranking por producto (sin cobro) y por cliente (con cobro), con «Otros»', () => {
  const meses = ['2026-07', '2026-08']
  const f = filtrar(DATOS, meses, 'red')
  const prod = ranking('producto', f, 'piezas', DATOS)
  expect(prod.map((r) => [r.clave, r.vendido, r.cobrado])).toEqual([
    ['plata750', 13, null],
    ['plata375', 4, null]
  ])
  const cli = ranking('cliente', f, 'pesos', DATOS)
  expect(cli[0]).toEqual({ clave: 'dst1', nombre: 'Distribuidor Uno · DST', vendido: 3000, cobrado: 1000 })
  const top1 = ranking('cliente', f, 'pesos', DATOS, 1)
  expect(top1.map((r) => r.clave)).toEqual(['dst1', '_otros'])
  expect(top1[1].vendido).toBe(1400)
  expect(top1[1].cobrado).toBe(900)
})

test('apilado por mes: top + Otros, suma igual al total', () => {
  const meses = ['2026-07', '2026-08']
  const f = filtrar(DATOS, meses, 'red')
  const s = apiladoPorMes('cliente', meses, f, 'pesos', DATOS, 1)
  expect(s.map((x) => x.clave)).toEqual(['dst1', '_otros'])
  expect(s[0].valores).toEqual([0, 3000])
  expect(s[1].valores).toEqual([900, 500])
})

