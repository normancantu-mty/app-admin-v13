import { test, expect } from '@playwright/test'

import { armarPulso, type EntregaPulso } from '../lib/pulso'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '../lib/avisos'

/**
 * ANCLAJE CONTRA PRODUCCION del "Pulso". Escrito el 2026-11-08 por un ejecutor
 * del Socio.
 *
 * Las filas de abajo son las que `leerPulso` habria leido de produccion el
 * 2026-11-08 a las 20:46 MX (SELECT de solo lectura, mismas columnas). Los
 * numeros esperados NO salieron de esta funcion: salieron de dos SELECT
 * directos e independientes en SQL, con `now() = 2026-11-09 02:46:45.831 UTC`:
 *
 *   COBERTURA (stock de `v_stock_por_cubeta` de la entidad ADMIN; vendidas =
 *   `ticket_detalles` de tickets ACTIVO con vendedor ADMIN, `subtotal_linea > 0`,
 *   desde greatest(now - 28 d, min SALDO_INICIAL = 2026-10-28 05:59 UTC);
 *   11.8665 dias):
 *     750 ml: stock 1,   vendidas 9,  5.31/sem, 0.19 semanas
 *     250 ml: stock 208, vendidas 12, 7.08/sem, 29.38 semanas
 *      50 ml: stock 122, vendidas 48, 28.31/sem, 4.31 semanas
 *
 *   DIAS SIN SURTIR (greatest(ultimo ticket ACTIVO con botella cobrada, ultima
 *   ENTRADA_CONCESION viva de botella), dias de calendario en America/Mexico_City):
 *     10 clientes a 12 dias (la carga del 27/10 23:59 MX), Aeropuerto a 4 dias
 *     (ticket del 04/11 21:29 MX, 1 compra), 3 nunca surtidos (Dulceria el Eden,
 *     Luis Rodriguez, Mi dulce catrina). Atrasados (> 21 d): 0.
 *
 * Si esta prueba se pone roja, la funcion dejo de reproducir el SQL.
 */

const AHORA = new Date('2026-11-09T02:46:45.831Z')
const MATRIZ = 'e0000000-0000-0000-0000-000000000001'
const AEROPUERTO = '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd'
const P750 = 'c1000000-0000-0000-0000-000000000001'
const P250 = 'c1000000-0000-0000-0000-000000000003'
const P50 = 'c1000000-0000-0000-0000-000000000004'
const CARGA = '2026-10-28T05:59:00+00:00'

const TICKETS = [
  {
    id: '0c75f24b-f543-49d4-acdf-30d1bdfb549c',
    fecha_transaccion: '2026-11-07T15:16:06.833+00:00',
    status: 'ACTIVO',
    condicion_pago: 'CONTADO',
    id_comprador: null,
    id_vendedor: MATRIZ,
    ticket_detalles: [{ id_producto: P750, cantidad: 1, subtotal_linea: 599 }]
  },
  {
    id: 'fcb165bf-d354-42c4-9308-596de215f8d9',
    fecha_transaccion: '2026-11-05T03:29:32.559+00:00',
    status: 'ACTIVO',
    condicion_pago: 'CONCESION',
    id_comprador: AEROPUERTO,
    id_vendedor: MATRIZ,
    ticket_detalles: [
      { id_producto: P750, cantidad: 8, subtotal_linea: 3840 },
      { id_producto: P250, cantidad: 12, subtotal_linea: 1728 },
      { id_producto: P50, cantidad: 48, subtotal_linea: 2688 }
    ]
  }
]

const ENTIDADES = [
  { id: MATRIZ, nombre: 'CEO Admin', rol: 'ADMIN' },
  { id: 'a9277d56-17ba-46e2-9a31-e8f77a7d907e', nombre: 'Ale Ortega Expressate', rol: 'DST' },
  { id: 'f0443423-60a0-4156-9bcd-52394ae274fe', nombre: 'David Flores', rol: 'DST' },
  { id: '9f8cd8f6-6623-4f86-b92e-9eba500a8fb4', nombre: 'Gilberto Franco', rol: 'DST' },
  { id: 'be763698-bfa4-4a57-994a-7280199caca9', nombre: 'Luis Rodriguez', rol: 'DST' },
  { id: '9b6dc030-9ec0-4463-9c14-43ae4edea707', nombre: 'Martin Reyes', rol: 'DST' },
  { id: AEROPUERTO, nombre: 'Aeropuerto', rol: 'LOC' },
  { id: '0aaf30d4-cd0c-4f24-907e-e1678e29587e', nombre: 'Al son del Mezcal', rol: 'LOC' },
  { id: '0571273c-fa5f-4985-a3e5-5e8a6a66f380', nombre: 'Casa Verde', rol: 'LOC' },
  { id: '08f06156-c6ba-40bd-ac7a-7981738f9358', nombre: 'Delirio 85', rol: 'LOC' },
  { id: '1f1b7ad9-2fab-4763-a258-c75bb65c31f5', nombre: 'Dulceria el Eden', rol: 'LOC' },
  { id: 'dc2cc9b7-96ed-40f8-8644-204870f9eea0', nombre: 'Dulceria ruiz', rol: 'LOC' },
  { id: 'cd8bcef6-e059-426f-8259-a7ee769a7dcc', nombre: 'Mi dulce catrina', rol: 'LOC' },
  { id: 'b7ccfb30-b5c3-4a67-851d-72821d7838ca', nombre: 'Nuevo Ideal', rol: 'LOC' },
  { id: ENTIDAD_PENDIENTE_DE_ASIGNAR, nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' },
  { id: 'ae033b9a-4382-49c9-80be-3d8aa16189da', nombre: 'Rey Tiburon', rol: 'LOC' }
]

const PRODUCTOS = [
  { id: P250, nombre: 'Destilado Plata 250ml' },
  { id: P50, nombre: 'Destilado Plata 50ml' },
  { id: P750, nombre: 'Destilado Plata 750ml' },
  { id: '9f310b3c-9924-4b63-b08b-a50a88795347', nombre: 'Pasta-Guajillo-2kg' }
]

const STOCK = [
  { id_entidad: MATRIZ, id_producto: P750, producto: 'Destilado Plata 750ml', stock: '1.0000' },
  { id_entidad: MATRIZ, id_producto: P250, producto: 'Destilado Plata 250ml', stock: '208.0000' },
  { id_entidad: MATRIZ, id_producto: P50, producto: 'Destilado Plata 50ml', stock: '122.0000' }
]

// Las 31 ENTRADA_CONCESION vivas de produccion: [destino, producto, fecha].
const E: Array<[string, string, string]> = [
  ['0571273c-fa5f-4985-a3e5-5e8a6a66f380', P750, CARGA],
  ['08f06156-c6ba-40bd-ac7a-7981738f9358', P750, CARGA],
  ['08f06156-c6ba-40bd-ac7a-7981738f9358', P250, CARGA],
  ['08f06156-c6ba-40bd-ac7a-7981738f9358', P50, CARGA],
  ['0aaf30d4-cd0c-4f24-907e-e1678e29587e', P750, CARGA],
  ['0aaf30d4-cd0c-4f24-907e-e1678e29587e', P250, CARGA],
  [AEROPUERTO, P750, CARGA],
  [AEROPUERTO, P250, CARGA],
  [AEROPUERTO, P50, CARGA],
  ['9b6dc030-9ec0-4463-9c14-43ae4edea707', P750, CARGA],
  ['9b6dc030-9ec0-4463-9c14-43ae4edea707', P250, CARGA],
  ['9b6dc030-9ec0-4463-9c14-43ae4edea707', P50, CARGA],
  ['9f8cd8f6-6623-4f86-b92e-9eba500a8fb4', P750, CARGA],
  ['9f8cd8f6-6623-4f86-b92e-9eba500a8fb4', P250, CARGA],
  ['9f8cd8f6-6623-4f86-b92e-9eba500a8fb4', P50, CARGA],
  ['a9277d56-17ba-46e2-9a31-e8f77a7d907e', P750, CARGA],
  ['a9277d56-17ba-46e2-9a31-e8f77a7d907e', P250, CARGA],
  ['a9277d56-17ba-46e2-9a31-e8f77a7d907e', P50, CARGA],
  ['ae033b9a-4382-49c9-80be-3d8aa16189da', P750, CARGA],
  ['ae033b9a-4382-49c9-80be-3d8aa16189da', P250, CARGA],
  ['ae033b9a-4382-49c9-80be-3d8aa16189da', P50, CARGA],
  ['b7ccfb30-b5c3-4a67-851d-72821d7838ca', P750, CARGA],
  ['b7ccfb30-b5c3-4a67-851d-72821d7838ca', P250, CARGA],
  ['b7ccfb30-b5c3-4a67-851d-72821d7838ca', P50, CARGA],
  ['dc2cc9b7-96ed-40f8-8644-204870f9eea0', P250, CARGA],
  ['dc2cc9b7-96ed-40f8-8644-204870f9eea0', P50, CARGA],
  ['f0443423-60a0-4156-9bcd-52394ae274fe', P750, CARGA],
  ['f0443423-60a0-4156-9bcd-52394ae274fe', P50, CARGA],
  [AEROPUERTO, P750, '2026-11-05T03:29:32.559+00:00'],
  [AEROPUERTO, P250, '2026-11-05T03:29:32.559+00:00'],
  [AEROPUERTO, P50, '2026-11-05T03:29:32.559+00:00']
]
const ENTREGAS: EntregaPulso[] = E.map(([d, p, f]) => ({ id_entidad_destino: d, id_producto: p, fecha_movimiento: f, status: 'ACTIVO' }))

const pulso = () => armarPulso({ tickets: TICKETS, entidades: ENTIDADES, productos: PRODUCTOS, stock: STOCK, entregas: ENTREGAS, corte: CARGA }, AHORA)

test.describe('pulso · anclaje contra produccion (2026-11-08 20:46 MX)', () => {
  test('cobertura = el SELECT directo, al centesimo', () => {
    const c = pulso().cobertura
    expect(ENTREGAS).toHaveLength(31)
    expect(c.recortadaAlArranque).toBe(true)
    expect(c.dias).toBeCloseTo(11.8665, 3)
    const f = Object.fromEntries(c.filas.map((x) => [x.presentacion, x]))
    expect([f['750'].stock, f['750'].vendidas, f['750'].porSemana!.toFixed(2), f['750'].semanas!.toFixed(2), f['750'].reponer]).toEqual([1, 9, '5.31', '0.19', true])
    expect([f['250'].stock, f['250'].vendidas, f['250'].porSemana!.toFixed(2), f['250'].semanas!.toFixed(2), f['250'].reponer]).toEqual([208, 12, '7.08', '29.38', false])
    expect([f['50'].stock, f['50'].vendidas, f['50'].porSemana!.toFixed(2), f['50'].semanas!.toFixed(2), f['50'].reponer]).toEqual([122, 48, '28.31', '4.31', false])
  })

  test('dias sin surtir = el SELECT directo', () => {
    const s = pulso().sinSurtir
    expect(s.atrasados).toBe(0)
    const a12 = s.filas.filter((f) => f.dias === 12)
    expect(a12).toHaveLength(10)
    expect(a12.every((f) => f.fuente === 'entrega' && f.compras === 0 && f.desdeArranque)).toBe(true)
    const aero = s.filas.find((f) => f.id === AEROPUERTO)!
    expect([aero.dias, aero.fuente, aero.compras, aero.desdeArranque]).toEqual([4, 'ticket', 1, false])
    expect(s.filas).toHaveLength(11)
    expect(s.nunca.map((f) => f.nombre)).toEqual(['Dulceria el Eden', 'Luis Rodriguez', 'Mi dulce catrina'])
  })
})
