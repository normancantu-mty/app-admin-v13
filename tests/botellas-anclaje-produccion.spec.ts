import { test, expect } from '@playwright/test'

import { armarBotellasPorCliente, periodosDe, SIN_CLIENTE } from '../lib/botellas-cliente'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '../lib/avisos'

/**
 * ANCLAJE CONTRA PRODUCCION de "botellas por cliente". Escrito el 2026-11-08
 * por un ejecutor del Socio.
 *
 * Las filas de abajo son las que `leerBotellasPorCliente` habria leido de
 * produccion el 2026-11-08 a las 20:08 MX (SELECT de solo lectura, mismas
 * columnas). Los numeros esperados NO salieron de esta funcion: salieron de un
 * SELECT directo e independiente en SQL (filtro `status='ACTIVO'`, nombre de
 * producto `~* '\d+\s*ml'`, `subtotal_linea > 0`, fecha llevada a
 * `America/Mexico_City`, semana = `date_trunc('week', ...)`):
 *
 *   Aeropuerto (LOC): noviembre 68 = 750ml 8 + 250ml 12 + 50ml 48 (concesion);
 *                     semana 02/11-08/11 68; octubre 0; semana anterior 0.
 *   Sin cliente:      noviembre 1 (750ml, contado); semana 1.
 *   Total noviembre:  69.
 *
 * Si esta prueba se pone roja, la funcion dejo de reproducir el SQL.
 */

const MATRIZ = 'e0000000-0000-0000-0000-000000000001'
const AEROPUERTO = '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd'
const P750 = 'c1000000-0000-0000-0000-000000000001'
const P250 = 'c1000000-0000-0000-0000-000000000003'
const P50 = 'c1000000-0000-0000-0000-000000000004'

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
  { id: AEROPUERTO, nombre: 'Aeropuerto', rol: 'LOC' },
  { id: '0aaf30d4-cd0c-4f24-907e-e1678e29587e', nombre: 'Al son del Mezcal', rol: 'LOC' },
  { id: 'a9277d56-17ba-46e2-9a31-e8f77a7d907e', nombre: 'Ale Ortega Expressate', rol: 'DST' },
  { id: '0571273c-fa5f-4985-a3e5-5e8a6a66f380', nombre: 'Casa Verde', rol: 'LOC' },
  { id: MATRIZ, nombre: 'CEO Admin', rol: 'ADMIN' },
  { id: 'f0443423-60a0-4156-9bcd-52394ae274fe', nombre: 'David Flores', rol: 'DST' },
  { id: '08f06156-c6ba-40bd-ac7a-7981738f9358', nombre: 'Delirio 85', rol: 'LOC' },
  { id: '1f1b7ad9-2fab-4763-a258-c75bb65c31f5', nombre: 'Dulceria el Eden', rol: 'LOC' },
  { id: 'dc2cc9b7-96ed-40f8-8644-204870f9eea0', nombre: 'Dulceria ruiz', rol: 'LOC' },
  { id: '9f8cd8f6-6623-4f86-b92e-9eba500a8fb4', nombre: 'Gilberto Franco', rol: 'DST' },
  { id: 'be763698-bfa4-4a57-994a-7280199caca9', nombre: 'Luis Rodriguez', rol: 'DST' },
  { id: '9b6dc030-9ec0-4463-9c14-43ae4edea707', nombre: 'Martin Reyes', rol: 'DST' },
  { id: 'cd8bcef6-e059-426f-8259-a7ee769a7dcc', nombre: 'Mi dulce catrina', rol: 'LOC' },
  { id: 'b7ccfb30-b5c3-4a67-851d-72821d7838ca', nombre: 'Nuevo Ideal', rol: 'LOC' },
  { id: '11111111-1111-1111-1111-111111111111', nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' },
  { id: 'ae033b9a-4382-49c9-80be-3d8aa16189da', nombre: 'Rey Tiburon', rol: 'LOC' }
]

const PRODUCTOS = [
  { id: '9f310b3c-9924-4b63-b08b-a50a88795347', nombre: 'Pasta-Guajillo-2kg' },
  { id: P50, nombre: 'Destilado Plata 50ml' },
  { id: P250, nombre: 'Destilado Plata 250ml' },
  { id: P750, nombre: 'Destilado Plata 750ml' }
]

/** 2026-11-08 20:08:20 MX, el `now()` del SELECT de anclaje. */
const AHORA = new Date('2026-11-09T02:08:20Z')

test('anclaje: la funcion reproduce el SELECT directo de produccion del 2026-11-08', () => {
  const d = armarBotellasPorCliente(TICKETS, ENTIDADES, PRODUCTOS, periodosDe(AHORA))
  const aero = d.filas.find((f) => f.clave === AEROPUERTO)!
  const sin = d.filas.find((f) => f.clave === SIN_CLIENTE)!

  expect(d.periodos.semana.desdeDia).toBe('2026-11-02') // = date_trunc('week') del SQL
  expect(aero.periodos.mes.botellas).toBe(68)
  expect(aero.periodos.mes.porPresentacion).toEqual({ '750': 8, '250': 12, '50': 48 })
  expect(aero.periodos.mes.concesion).toBe(68)
  expect(aero.periodos.semana.botellas).toBe(68)
  expect(aero.periodos.mesAnterior.botellas).toBe(0)
  expect(aero.periodos.semanaAnterior.botellas).toBe(0)
  expect(sin.periodos.mes.botellas).toBe(1)
  expect(sin.periodos.semana.botellas).toBe(1)
  expect(d.totalMatriz.mes).toBe(69)
  expect(d.totalMatriz.semana).toBe(69)
  expect(d.totalMatriz.mesAnterior).toBe(0)
  // 5 DST + 9 LOC reales = 14 clientes (13 sin botellas) + "sin cliente" = 15 filas.
  // El centinela PENDIENTE DE ASIGNAR (rol LOC en la base) no tiene fila propia.
  expect(d.filas[0].clave).toBe(AEROPUERTO)
  expect(d.filas[d.filas.length - 1].clave).toBe(SIN_CLIENTE)
  expect(d.filas.some((f) => f.clave === ENTIDAD_PENDIENTE_DE_ASIGNAR)).toBe(false)
  expect(d.filas.length).toBe(15)
})
