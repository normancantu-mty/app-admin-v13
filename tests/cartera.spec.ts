import { test, expect } from '@playwright/test'
import { construirCartera, totalesCartera } from '../lib/cartera-utils'
import type { EntradaCartera } from '../lib/cartera-utils'

/**
 * Pruebas puras de la cartera: sin base, sin red, sin navegador.
 *
 * Los datos son un calco reducido de produccion (verificada el 2026-09-02), no
 * numeros inventados: si la formula de saldo o el criterio de salidas cambian,
 * estas pruebas caen antes de que la pantalla mienta.
 */

const HOY = '2026-09-02T12:00:00.000Z'

const ENT_DELIRIO = 'delirio-85'
const ENT_EDEN = 'dulceria-eden'
const ENT_AEROPUERTO = 'aeropuerto'
const ENT_MARTIN = 'martin-reyes'

function entrada(parcial: Partial<EntradaCartera> = {}): EntradaCartera {
  return {
    entidades: [],
    inventario: [],
    tickets: [],
    finanzas: [],
    hoy: HOY,
    ...parcial
  }
}

test.describe('construirCartera: piezas', () => {
  test('libro dice = recibidas menos TODA salida registrada, sea del tipo que sea', () => {
    // Martin Reyes en produccion: 82 recibidas, 16 de venta y 43 de merma.
    // Si la merma no contara como salida, el libro diria 66 y no 23.
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_MARTIN, nombre: 'Martin Reyes', rol: 'DST' }],
        inventario: [
          mov({ tipo: 'ENTRADA_CONCESION', cantidad: 82, destino: ENT_MARTIN }),
          mov({ tipo: 'SALIDA_VENTA', cantidad: 16, origen: ENT_MARTIN }),
          mov({ tipo: 'MERMA', cantidad: 43, origen: ENT_MARTIN })
        ]
      })
    )

    expect(fila.recibidas).toBe(82)
    expect(fila.salidas).toBe(59)
    expect(fila.libroDice).toBe(23)
  })

  test('los movimientos ANULADOS no cuentan ni como entrada ni como salida', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_DELIRIO, nombre: 'Delirio 85', rol: 'LOC' }],
        inventario: [
          mov({ tipo: 'ENTRADA_CONCESION', cantidad: 414, destino: ENT_DELIRIO }),
          mov({ tipo: 'ENTRADA_CONCESION', cantidad: 100, destino: ENT_DELIRIO, status: 'ANULADO' }),
          mov({ tipo: 'SALIDA_VENTA', cantidad: 228, origen: ENT_DELIRIO }),
          mov({ tipo: 'SALIDA_VENTA', cantidad: 50, origen: ENT_DELIRIO, status: 'ANULADO' })
        ]
      })
    )

    expect(fila.recibidas).toBe(414)
    expect(fila.libroDice).toBe(186)
  })

  test('un nodo que nunca recibio mercancia no genera fila', () => {
    const filas = construirCartera(
      entrada({
        entidades: [{ id: 'venta-mayoreo', nombre: 'Venta mayoreo', rol: 'LOC' }],
        inventario: [mov({ tipo: 'SALIDA_VENTA', cantidad: 5, origen: 'venta-mayoreo' })]
      })
    )

    expect(filas).toHaveLength(0)
  })
})

test.describe('construirCartera: dinero', () => {
  test('% pagado y estimado en piso salen del saldo compartido (Delirio 85)', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_DELIRIO, nombre: 'Delirio 85', rol: 'LOC' }],
        inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 414, destino: ENT_DELIRIO })],
        tickets: [ticket({ comprador: ENT_DELIRIO, real: 80192, base: 80192 })],
        finanzas: [abono({ entidad: ENT_DELIRIO, monto: 60716, fecha: '2026-08-25T18:00:00.000Z' })]
      })
    )

    expect(fila.generado).toBe(80192)
    expect(fila.abonado).toBe(60716)
    expect(fila.deuda).toBe(19476)
    expect(fila.porcentajePagado).toBeCloseTo(0.757, 3)
    expect(fila.estimadoEnPiso).toBe(101)
  })

  test('sin un solo abono: 0% pagado y el piso estimado es todo lo recibido (Dulceria el Eden)', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_EDEN, nombre: 'Dulceria el Eden', rol: 'LOC' }],
        inventario: [
          mov({
            tipo: 'ENTRADA_CONCESION',
            cantidad: 15,
            destino: ENT_EDEN,
            fecha: '2026-07-21T18:00:00.000Z'
          })
        ],
        tickets: [ticket({ comprador: ENT_EDEN, real: 3610, base: 3610 })]
      })
    )

    expect(fila.porcentajePagado).toBe(0)
    expect(fila.deuda).toBe(3610)
    expect(fila.estimadoEnPiso).toBe(15)
    expect(fila.ultimoAbono).toBeNull()
    // Sin abonos, los dias se cuentan desde la entrega: es lo unico que hay.
    expect(fila.referenciaDias).toBe('ENTREGA')
    expect(fila.diasSinAbono).toBe(43)
  })

  test('pagar de mas no produce piso negativo (Aeropuerto pago $6 de mas)', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_AEROPUERTO, nombre: 'Aeropuerto', rol: 'LOC' }],
        inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 260, destino: ENT_AEROPUERTO })],
        tickets: [ticket({ comprador: ENT_AEROPUERTO, real: 41248, base: 41248 })],
        finanzas: [abono({ entidad: ENT_AEROPUERTO, monto: 41254, fecha: '2026-09-01T18:00:00.000Z' })]
      })
    )

    expect(fila.deuda).toBe(-6)
    expect(fila.porcentajePagado).toBeGreaterThan(1)
    expect(fila.estimadoEnPiso).toBe(0)
  })

  test('un abono pendiente de aprobacion no baja la deuda ni sube el % pagado', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_EDEN, nombre: 'Dulceria el Eden', rol: 'LOC' }],
        inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 15, destino: ENT_EDEN })],
        tickets: [ticket({ comprador: ENT_EDEN, real: 3610, base: 3610 })],
        finanzas: [
          abono({
            entidad: ENT_EDEN,
            monto: 1000,
            fecha: '2026-09-01T18:00:00.000Z',
            categoria: 'ABONO_PENDIENTE'
          })
        ]
      })
    )

    expect(fila.abonado).toBe(0)
    expect(fila.deuda).toBe(3610)
  })

  test('el CARGO_DEUDA suma a lo generado (por eso Martin Reyes debe mas que sus tickets)', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: ENT_MARTIN, nombre: 'Martin Reyes', rol: 'DST' }],
        inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 82, destino: ENT_MARTIN })],
        tickets: [ticket({ comprador: ENT_MARTIN, real: 19776, base: 19776 })],
        finanzas: [
          { tipo_movimiento: 'CARGO_DEUDA', monto: 3590, id_entidad_relacionada: ENT_MARTIN, status: 'ACTIVO' },
          abono({ entidad: ENT_MARTIN, monto: 12039, fecha: '2026-06-16T18:00:00.000Z' })
        ]
      })
    )

    expect(fila.generado).toBe(23366)
    expect(fila.deuda).toBe(11327)
  })

  test('un DST paga sobre monto_base_ingreso; un LOC sobre total_cobrado_real', () => {
    const comun = {
      inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 10, destino: 'nodo' })],
      tickets: [ticket({ comprador: 'nodo', real: 7488, base: 4219.07 })]
    }

    const [comoDst] = construirCartera(
      entrada({ ...comun, entidades: [{ id: 'nodo', nombre: 'Nodo', rol: 'DST' }] })
    )
    const [comoLoc] = construirCartera(
      entrada({ ...comun, entidades: [{ id: 'nodo', nombre: 'Nodo', rol: 'LOC' }] })
    )

    expect(comoDst.deuda).toBeCloseTo(4219.07, 2)
    expect(comoLoc.deuda).toBeCloseTo(7488, 2)
  })
})

test.describe('construirCartera: orden de visita', () => {
  test('ordena por deuda x dias, no por deuda sola', () => {
    const filas = construirCartera(
      entrada({
        entidades: [
          { id: 'debe-mas-pago-ayer', nombre: 'Debe mas, pago ayer', rol: 'LOC' },
          { id: 'debe-menos-callado', nombre: 'Debe menos, callado', rol: 'LOC' }
        ],
        inventario: [
          mov({ tipo: 'ENTRADA_CONCESION', cantidad: 100, destino: 'debe-mas-pago-ayer' }),
          mov({ tipo: 'ENTRADA_CONCESION', cantidad: 100, destino: 'debe-menos-callado' })
        ],
        tickets: [
          ticket({ comprador: 'debe-mas-pago-ayer', real: 40000, base: 40000 }),
          ticket({ comprador: 'debe-menos-callado', real: 20000, base: 20000 })
        ],
        finanzas: [
          abono({ entidad: 'debe-mas-pago-ayer', monto: 20000, fecha: '2026-09-01T12:00:00.000Z' }),
          abono({ entidad: 'debe-menos-callado', monto: 10000, fecha: '2026-06-16T12:00:00.000Z' })
        ]
      })
    )

    // 20.000 x 1 dia = 20.000  vs  10.000 x 78 dias = 780.000
    expect(filas.map((f) => f.id)).toEqual(['debe-menos-callado', 'debe-mas-pago-ayer'])
  })

  test('un nodo sin deuda tiene prioridad 0 aunque lleve meses callado', () => {
    const [fila] = construirCartera(
      entrada({
        entidades: [{ id: 'casa-verde', nombre: 'Casa Verde', rol: 'LOC' }],
        inventario: [mov({ tipo: 'ENTRADA_CONCESION', cantidad: 54, destino: 'casa-verde' })],
        tickets: [ticket({ comprador: 'casa-verde', real: 10616, base: 10616 })],
        finanzas: [abono({ entidad: 'casa-verde', monto: 10616, fecha: '2026-07-26T12:00:00.000Z' })]
      })
    )

    expect(fila.deuda).toBe(0)
    expect(fila.diasSinAbono).toBe(38)
    expect(fila.prioridad).toBe(0)
  })
})

test('totalesCartera suma las cuatro columnas sumables', () => {
  const filas = construirCartera(
    entrada({
      entidades: [
        { id: 'a', nombre: 'A', rol: 'LOC' },
        { id: 'b', nombre: 'B', rol: 'LOC' }
      ],
      inventario: [
        mov({ tipo: 'ENTRADA_CONCESION', cantidad: 100, destino: 'a' }),
        mov({ tipo: 'SALIDA_VENTA', cantidad: 40, origen: 'a' }),
        mov({ tipo: 'ENTRADA_CONCESION', cantidad: 50, destino: 'b' })
      ],
      tickets: [
        ticket({ comprador: 'a', real: 1000, base: 1000 }),
        ticket({ comprador: 'b', real: 500, base: 500 })
      ]
    })
  )

  expect(totalesCartera(filas)).toEqual({
    recibidas: 150,
    libroDice: 110,
    estimadoEnPiso: 150,
    deuda: 1500
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

function mov(args: {
  tipo: string
  cantidad: number
  origen?: string
  destino?: string
  status?: string
  fecha?: string
}) {
  return {
    tipo_movimiento: args.tipo,
    cantidad: args.cantidad,
    status: args.status ?? 'ACTIVO',
    id_entidad_origen: args.origen ?? null,
    id_entidad_destino: args.destino ?? null,
    fecha_movimiento: args.fecha ?? '2026-08-01T12:00:00.000Z'
  }
}

function ticket(args: { comprador: string; real: number; base: number; status?: string }) {
  return {
    condicion_pago: 'CONCESION',
    id_comprador: args.comprador,
    monto_base_ingreso: args.base,
    total_cobrado_real: args.real,
    status: args.status ?? 'ACTIVO'
  }
}

function abono(args: { entidad: string; monto: number; fecha: string; categoria?: string }) {
  return {
    tipo_movimiento: 'ABONO_DEUDA',
    monto: args.monto,
    id_entidad_relacionada: args.entidad,
    categoria: args.categoria ?? 'ABONO_REAL',
    status: 'ACTIVO',
    fecha_movimiento: args.fecha
  }
}
