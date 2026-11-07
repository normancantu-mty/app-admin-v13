/**
 * PREGUNTAS DE CARTERA E INVENTARIO DESDE EL BOT (2026-11-07, Fase 6).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio.
 *
 * - Lo puro (`lib/bot-pregunta-erp.ts` y su entrada en `interpretarPregunta`).
 * - La ruta (`/api/bot/pregunta`) contra un PostgREST falso: cifras de las
 *   filas (las mismas reglas que v_cartera / v_stock_por_cubeta /
 *   v_insumos_en_negativo), permisos, botones, y **solo GET** en la red.
 */

import { test, expect } from '@playwright/test'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { interpretarPregunta, LO_QUE_CONTESTO, type CuentaDePregunta } from '@/lib/bot-pregunta'
import {
  clienteNombrado,
  eventosDelCliente,
  productosNombrados,
  stockDeInsumos,
  textoBotellas,
  textoDeudaCliente,
  textoSeAcaba,
  type EntidadDePregunta,
  type NombresDelErp,
  type ProductoDePregunta
} from '@/lib/bot-pregunta-erp'
import type { FilaCarteraVista, FilaStockPorCubeta } from '@/lib/vistas'
import * as pregunta from '@/app/api/bot/pregunta/route'

const HOY = '2026-11-07'
const CUENTAS: CuentaDePregunta[] = [
  { id: 'c-ef', nombre: 'Efectivo' },
  { id: 'c-spin', nombre: 'Cuenta Spin' },
  { id: 'c-aero', nombre: 'Efectivo (Aeropuerto)' }
]
const ID = {
  matriz: '00000000-0000-4000-8000-000000000001',
  aero: '00000000-0000-4000-8000-000000000002',
  gil: '00000000-0000-4000-8000-000000000003',
  delirio: '00000000-0000-4000-8000-000000000004',
  martin: '00000000-0000-4000-8000-000000000005',
  gilr: '00000000-0000-4000-8000-000000000006'
}
const ENTIDADES: EntidadDePregunta[] = [
  { id: ID.matriz, nombre: 'CEO Admin', rol: 'ADMIN' },
  { id: ID.aero, nombre: 'Aeropuerto', rol: 'LOC' },
  { id: ID.gil, nombre: 'Gilberto Franco', rol: 'DST' },
  { id: ID.delirio, nombre: 'Delirio 85', rol: 'LOC' },
  { id: ID.martin, nombre: 'Martin Reyes', rol: 'DST' }
]
const PRODUCTOS: ProductoDePregunta[] = [
  { id: 'p-250', nombre: 'Destilado Plata 250ml', tipo: 'TERMINADO', unidad_medida: 'PIEZAS', ml_por_unidad: 250 },
  { id: 'p-50', nombre: 'Destilado Plata 50ml', tipo: 'TERMINADO', unidad_medida: 'PIEZAS', ml_por_unidad: 50 },
  { id: 'p-750', nombre: 'Destilado Plata 750ml', tipo: 'TERMINADO', unidad_medida: 'PIEZAS', ml_por_unidad: 750 },
  { id: 'p-pasta', nombre: 'Pasta-Guajillo-2kg', tipo: 'TERMINADO', unidad_medida: 'PIEZAS', ml_por_unidad: null },
  { id: 'i-chile', nombre: 'Chile Guajillo', tipo: 'INSUMO', unidad_medida: 'KILOGRAMOS' },
  { id: 'i-et750', nombre: 'Etiqueta 750', tipo: 'INSUMO', unidad_medida: 'PIEZAS' },
  { id: 'i-tapa', nombre: 'Tapa 50', tipo: 'INSUMO', unidad_medida: 'PIEZAS' }
]
const NOMBRES: NombresDelErp = { entidades: ENTIDADES, productos: PRODUCTOS }
const q = (texto: string) => interpretarPregunta(texto, CUENTAS, HOY, NOMBRES)

// ─── Lo puro ────────────────────────────────────────────────────────────────

test.describe('interpretarPregunta con nombres (Fase 6, pura)', () => {
  test('cuanto debe un cliente, con nombre exacto, parcial o por una palabra', () => {
    expect(q('¿Cuánto me debe Aeropuerto?')).toMatchObject({ tipo: 'deuda_cliente', cliente: { id: ID.aero } })
    expect(q('cuanto debe gilberto')).toMatchObject({ tipo: 'deuda_cliente', cliente: { id: ID.gil } })
    expect(q('cuanto nos debe el aero')).toMatchObject({ tipo: 'deuda_cliente', cliente: { id: ID.aero } })
    expect(q('deuda de delirio')).toMatchObject({ tipo: 'deuda_cliente', cliente: { id: ID.delirio } })
    expect(q('saldo de martin reyes')).toMatchObject({ tipo: 'deuda_cliente', cliente: { id: ID.martin } })
  })

  test('un nombre que no es cliente no se adivina; la matriz no es cliente', () => {
    expect(q('cuanto debe pedro')).toEqual({ tipo: 'ninguna', motivo: 'cliente_no_encontrado', dicho: 'pedro' })
    expect(clienteNombrado('cuanto debe ceo admin', ENTIDADES)).toBeNull()
  })

  test('nombre ambiguo: candidatos para los botones', () => {
    const dos = [...ENTIDADES, { id: ID.gilr, nombre: 'Gilberto Ruiz', rol: 'LOC' }]
    expect(interpretarPregunta('movimientos de gilberto', CUENTAS, HOY, { entidades: dos, productos: PRODUCTOS })).toMatchObject({
      tipo: 'ninguna',
      motivo: 'cliente_ambiguo',
      para: 'movimientos',
      candidatos: [{ id: ID.gil }, { id: ID.gilr }]
    })
  })

  test('cartera total: "quien me debe", "quien debe mas", "cuanto me deben en total"', () => {
    for (const t of ['quien me debe', 'quien debe mas', 'cuanto me deben en total', 'cartera', 'cuentas por cobrar']) {
      expect(q(t), t).toEqual({ tipo: 'cartera_total' })
    }
  })

  test('movimientos: de un cliente (N por defecto 10, o los que diga); de una cuenta sigue siendo de la cuenta', () => {
    expect(q('ultimos movimientos de delirio')).toMatchObject({ tipo: 'movimientos_cliente', cliente: { id: ID.delirio }, n: 10 })
    expect(q('ultimos 5 movimientos de aeropuerto')).toMatchObject({ tipo: 'movimientos_cliente', n: 5 })
    expect(q('historial de martin')).toMatchObject({ tipo: 'movimientos_cliente', cliente: { id: ID.martin } })
    expect(q('movimientos de efectivo de aeropuerto')).toMatchObject({ tipo: 'movimientos_cuenta', cuenta: { id: 'c-aero' } })
    expect(q('movimientos de ayer')).toMatchObject({ tipo: 'ninguna', motivo: 'falta_cuenta' })
  })

  test('lo de la Fase 2 no cambia con nombres', () => {
    expect(q('cuanto hay en spin')).toMatchObject({ tipo: 'saldo_cuenta', cuenta: { id: 'c-spin' } })
    expect(q('saldos')).toEqual({ tipo: 'saldos' })
    expect(q('¿cuánto dinero hay?')).toEqual({ tipo: 'saldos' })
    expect(q('ventas de la semana')).toMatchObject({ tipo: 'ventas_periodo' })
    expect(q('detalle del ticket 1a2b3c4d')).toEqual({ tipo: 'detalle_ticket', folio: '1A2B3C4D' })
  })

  test('botellas: por presentacion, por producto, por lugar, matriz', () => {
    expect(q('¿cuántas botellas hay?')).toEqual({ tipo: 'stock', productos: [], entidad: null, matriz: false })
    expect(q('cuantas botellas de 750 hay')).toMatchObject({ tipo: 'stock', productos: [{ id: 'p-750' }] })
    expect(q('cuantas piezas de 50 ml quedan en la matriz')).toMatchObject({ productos: [{ id: 'p-50' }], matriz: true })
    expect(q('stock de pasta')).toMatchObject({ productos: [{ id: 'p-pasta' }] })
    expect(q('cuantas botellas tiene gilberto')).toMatchObject({ tipo: 'stock', entidad: { id: ID.gil } })
    expect(productosNombrados('botellas de plata', PRODUCTOS).map((p) => p.id)).toEqual(['p-250', 'p-50', 'p-750'])
  })

  test('inventario total, insumos, lo que se acaba', () => {
    expect(q('inventario total')).toEqual({ tipo: 'inventario', soloInsumos: false })
    expect(q('¿qué hay en el inventario?')).toEqual({ tipo: 'inventario', soloInsumos: false })
    expect(q('cuantos insumos hay')).toEqual({ tipo: 'inventario', soloInsumos: true })
    expect(q('botellas vacias')).toEqual({ tipo: 'inventario', soloInsumos: true })
    expect(q('¿qué se está acabando?')).toEqual({ tipo: 'se_acaba' })
    expect(q('que hay que comprar')).toEqual({ tipo: 'se_acaba' })
  })

  test('lo desconocido sigue sin adivinarse; el texto da ejemplos', () => {
    expect(q('¿quién ganó el partido?')).toEqual({ tipo: 'ninguna', motivo: 'no_reconocida' })
    expect(LO_QUE_CONTESTO).toContain('cuanto debe Aeropuerto')
    expect(LO_QUE_CONTESTO).toContain('cuantas botellas de 750 hay')
    expect(LO_QUE_CONTESTO).toContain('que se esta acabando')
  })
})

test.describe('textos y reglas (puras)', () => {
  const filaCartera = (x: Partial<FilaCarteraVista>): FilaCarteraVista =>
    ({
      id_entidad: ID.aero, nombre: 'Aeropuerto', rol: 'LOC', recibidas: 0, salidas: 0, libro_dice: 0, generado: 15256,
      abonado: 5000, porcentaje_pagado: 0.32774, estimado_en_piso: 0, deuda: 10256, ultimo_abono: '2026-11-05T11:20:25Z',
      dias_sin_abono: 2, referencia_dias: 'ABONO', prioridad: 0, calculado_en: '2026-11-07T12:00:00Z', id_acreedor: null, ...x
    }) as FilaCarteraVista

  test('deuda de un cliente: la de v_cartera, % como fraccion x100', () => {
    const t = textoDeudaCliente(ENTIDADES[1], filaCartera({}))
    expect(t).toContain('Aeropuerto (LOC) debe $10,256.00 de concesion.')
    expect(t).toContain('Generado $15,256.00 · abonado $5,000.00 (32.8% pagado)')
    expect(textoDeudaCliente(ENTIDADES[1], null)).toContain('no aparece en la cartera')
    expect(textoDeudaCliente(ENTIDADES[1], null)).not.toMatch(/\$\d/)
    expect(textoDeudaCliente(ENTIDADES[1], filaCartera({ id_acreedor: ID.gil }))).toContain('con su distribuidor')
  })

  test('"lo que menos queda" ordena dentro de cada unidad, nunca gramos contra piezas (auditoria)', () => {
    const rolDe = new Map([[ID.matriz, 'ADMIN']])
    const t = textoSeAcaba(
      [],
      [{ id_entidad: ID.matriz, entidad: 'Matriz', id_producto: 'p-750', producto: 'Destilado 750', cubeta: 'PAGADO', stock: 30 }],
      [
        { id_entidad: ID.matriz, entidad: 'Matriz', id_producto: 'i-ad1', insumo: 'Aditivo 1', unidad_medida: 'GRAMOS', stock: 180 },
        { id_entidad: ID.matriz, entidad: 'Matriz', id_producto: 'i-ad2', insumo: 'Aditivo 2', unidad_medida: 'GRAMOS', stock: 90 },
        { id_entidad: ID.matriz, entidad: 'Matriz', id_producto: 'i-ch', insumo: 'Chile Guajillo', unidad_medida: 'KILOGRAMOS', stock: 5 },
        { id_entidad: ID.matriz, entidad: 'Matriz', id_producto: 'i-co', insumo: 'Corcho', unidad_medida: 'PIEZAS', stock: 900 }
      ],
      [],
      rolDe
    )
    const bloque = t.slice(t.indexOf('Lo que menos queda'))
    expect(bloque).toContain('por unidad')
    const lineas = bloque.split('\n').map((l) => l.trim())
    // Cada cosa bajo SU unidad, y dentro de la unidad de menor a mayor.
    const iG = lineas.indexOf('En g:')
    const iKg = lineas.indexOf('En kg:')
    const iPz = lineas.indexOf('En pzas:')
    expect([iG, iKg, iPz].every((i) => i >= 0), bloque).toBe(true)
    expect(lineas.slice(iG + 1, iG + 3)).toEqual(['Aditivo 2: 90 g', 'Aditivo 1: 180 g'])
    expect(lineas[iKg + 1]).toBe('Chile Guajillo: 5 kg')
    expect(lineas.slice(iPz + 1, iPz + 3)).toEqual(['Destilado 750: 30 pzas', 'Corcho: 900 pzas'])
  })

  test('movimientos del cliente con las reglas de v_cartera', () => {
    const ev = eventosDelCliente(
      ENTIDADES[2], // DST: suma su monto_base_ingreso
      [
        { id: 'fcb165bf-0000', fecha_transaccion: '2026-11-05T03:29:32Z', total_cobrado_real: 8256, monto_base_ingreso: 6000, condicion_pago: 'CONCESION', status: 'ACTIVO' },
        { id: 'aaaa0000-0000', fecha_transaccion: '2026-11-04T03:29:32Z', total_cobrado_real: 999, monto_base_ingreso: 999, condicion_pago: 'CONCESION', status: 'ANULADO' },
        { id: 'bbbb0000-0000', fecha_transaccion: '2026-11-03T03:29:32Z', total_cobrado_real: 650, monto_base_ingreso: 650, condicion_pago: 'CONTADO', status: null }
      ],
      [
        { id: 'f1', fecha_movimiento: '2026-11-05T11:20:25Z', tipo_movimiento: 'ABONO_DEUDA', monto: 5000, categoria: 'ABONO_REAL', status: 'ACTIVO' },
        { id: 'f2', fecha_movimiento: '2026-11-06T11:20:25Z', tipo_movimiento: 'ABONO_DEUDA', monto: 777, categoria: 'ABONO_PENDIENTE', status: 'ACTIVO' },
        { id: 'f3', fecha_movimiento: '2026-10-28T05:59:00Z', tipo_movimiento: 'CARGO_DEUDA', monto: 7000, categoria: 'ARRANQUE', status: 'ACTIVO' },
        { id: 'f4', fecha_movimiento: '2026-10-29T05:59:00Z', tipo_movimiento: 'ABONO_DEUDA', monto: 333, categoria: null, status: 'ACTIVO', es_entrega_efectivo: true }
      ],
      [
        { id: 'i1', fecha_movimiento: '2026-11-05T03:29:32Z', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 48, id_producto: 'p-50', id_entidad_origen: null, id_entidad_destino: ID.gil, status: 'ACTIVO' },
        { id: 'i2', fecha_movimiento: '2026-11-05T03:29:32Z', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 12, id_producto: 'p-250', id_entidad_origen: null, id_entidad_destino: ID.gil, status: 'ACTIVO' },
        { id: 'i3', fecha_movimiento: '2026-11-06T03:29:32Z', tipo_movimiento: 'DEVOLUCION_FISICA', cantidad: 2, id_producto: 'p-750', id_entidad_origen: ID.gil, id_entidad_destino: ID.matriz, status: 'ACTIVO' }
      ],
      new Map(PRODUCTOS.map((p) => [p.id, p.nombre]))
    )
    const textos = ev.map((e) => e.texto)
    expect(textos).toContain('Ticket FCB165BF en concesion: suma $6,000.00 a la deuda')
    expect(textos).toContain('Ticket BBBB0000 contado: $650.00 (no suma a la deuda)')
    expect(textos).toContain('Abono: resta $5,000.00')
    expect(textos).toContain('Abono pendiente de confirmar: $777.00 (todavia no resta)')
    expect(textos).toContain('Cargo (arranque): suma $7,000.00 a la deuda')
    expect(textos).toContain('Entrega en concesion: 60 piezas (48 Destilado Plata 50ml, 12 Destilado Plata 250ml)')
    expect(textos).toContain('Devolucion: 2 piezas (2 Destilado Plata 750ml)')
    expect(textos.join('\n')).not.toContain('999')
    expect(textos.join('\n')).not.toContain('333')
    expect(ev[0].fecha >= ev[ev.length - 1].fecha).toBe(true)
  })

  const STOCK: FilaStockPorCubeta[] = [
    { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'p-250', producto: 'Destilado Plata 250ml', cubeta: 'PAGADO', stock: 208 },
    { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'p-750', producto: 'Destilado Plata 750ml', cubeta: 'PAGADO', stock: 1 },
    { id_entidad: ID.aero, entidad: 'Aeropuerto', id_producto: 'p-750', producto: 'Destilado Plata 750ml', cubeta: 'CONSIGNADO', stock: 17 },
    { id_entidad: ID.aero, entidad: 'Aeropuerto', id_producto: 'p-250', producto: 'Destilado Plata 250ml', cubeta: 'CONSIGNADO', stock: 24 }
  ] as FilaStockPorCubeta[]
  const ROL = new Map(ENTIDADES.map((e) => [e.id, e.rol]))

  test('botellas: total, por producto y por lugar; filtro por presentacion; pasta sin existencia', () => {
    const todo = textoBotellas(STOCK, { tipo: 'stock', productos: [], entidad: null, matriz: false }, ROL)
    expect(todo).toContain('producto terminado: 250 piezas')
    expect(todo).toContain('Destilado Plata 250ml: 232 piezas')
    expect(todo).toContain('CEO Admin (matriz): 209 piezas')
    expect(todo).toContain('Aeropuerto: 41 piezas')
    const de750 = textoBotellas(STOCK, { tipo: 'stock', productos: [PRODUCTOS[2]], entidad: null, matriz: false }, ROL)
    expect(de750).toContain('Destilado Plata 750ml: 18 piezas')
    const matriz = textoBotellas(STOCK, { tipo: 'stock', productos: [], entidad: null, matriz: true }, ROL)
    expect(matriz).toContain('en la matriz: 209 piezas')
    expect(matriz).not.toContain('Aeropuerto')
    const pasta = textoBotellas(STOCK, { tipo: 'stock', productos: [PRODUCTOS[3]], entidad: null, matriz: false }, ROL)
    expect(pasta).toContain('Pasta-Guajillo-2kg: no hay existencia')
  })

  test('insumos: la regla de v_insumos_en_negativo sin el HAVING', () => {
    const r = stockDeInsumos(
      [
        { id_producto: 'i-chile', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 100, id_entidad_origen: null, id_entidad_destino: ID.matriz, status: 'ACTIVO' },
        { id_producto: 'i-chile', tipo_movimiento: 'TRASPASO', cantidad: 12.2664, id_entidad_origen: ID.matriz, id_entidad_destino: null, status: 'ACTIVO' },
        { id_producto: 'i-chile', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 50, id_entidad_origen: null, id_entidad_destino: ID.matriz, status: 'ANULADO' },
        { id_producto: 'i-chile', tipo_movimiento: 'AJUSTE_INVENTARIO', cantidad: 1, id_entidad_origen: null, id_entidad_destino: ID.matriz, status: 'APPROVED' },
        { id_producto: 'i-et750', tipo_movimiento: 'MERMA', cantidad: 3, id_entidad_origen: ID.matriz, id_entidad_destino: null, status: 'ACTIVO' },
        { id_producto: 'p-750', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 9, id_entidad_origen: null, id_entidad_destino: ID.matriz, status: 'ACTIVO' }
      ],
      PRODUCTOS,
      ENTIDADES
    )
    expect(r).toEqual([
      { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'i-chile', insumo: 'Chile Guajillo', unidad_medida: 'KILOGRAMOS', stock: 88.7336 },
      { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'i-et750', insumo: 'Etiqueta 750', unidad_medida: 'PIEZAS', stock: -3 }
    ])
  })
})

// ─── La ruta contra un PostgREST falso ──────────────────────────────────────

const TOKEN = 'e'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const LOCAL = 333
const TRABAJADOR = 444

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let peticiones: string[] = []

function estadoInicial() {
  tablas = {
    entidades: ENTIDADES.map((e) => ({ ...e, id_padre: null, id_nodo_padre: null })).concat([
      { id: 'ent-trab', nombre: 'Planta', rol: 'TRABAJADOR', id_padre: null, id_nodo_padre: null } as never
    ]),
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: ID.matriz, id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false },
      { telegram_id: LOCAL, etiqueta: 'aero', id_entidad: ID.aero, id_cuenta_destino: 'c-aero', activo: true, requiere_aprobacion: false },
      { telegram_id: TRABAJADOR, etiqueta: 'trab', id_entidad: 'ent-trab', id_cuenta_destino: null, activo: true, requiere_aprobacion: false }
    ],
    cuentas_financieras: [
      { id: 'c-ef', id_entidad: ID.matriz, nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-spin', id_entidad: ID.matriz, nombre: 'Cuenta Spin', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-aero', id_entidad: ID.aero, nombre: 'Efectivo (Aeropuerto)', tipo_fiscalidad: 'LIBRE' }
    ],
    catalogo_productos: PRODUCTOS.map((p) => ({ ...p })),
    v_cartera: [
      { id_entidad: ID.aero, nombre: 'Aeropuerto', rol: 'LOC', generado: 15256, abonado: 5000, porcentaje_pagado: 0.32774, deuda: 10256, ultimo_abono: '2026-11-05T11:20:25Z', dias_sin_abono: 2, prioridad: 20512, calculado_en: '2026-11-07T12:00:00Z', id_acreedor: null },
      { id_entidad: ID.martin, nombre: 'Martin Reyes', rol: 'DST', generado: 11327, abonado: 0, porcentaje_pagado: 0, deuda: 11327, ultimo_abono: null, dias_sin_abono: 10, prioridad: 113270, calculado_en: '2026-11-07T12:00:00Z', id_acreedor: null },
      { id_entidad: ID.delirio, nombre: 'Delirio 85', rol: 'LOC', generado: 7992, abonado: 0, porcentaje_pagado: 0, deuda: 7992, ultimo_abono: null, dias_sin_abono: 10, prioridad: 79920, calculado_en: '2026-11-07T12:00:00Z', id_acreedor: null }
    ],
    v_stock_por_cubeta: [
      { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'p-250', producto: 'Destilado Plata 250ml', cubeta: 'PAGADO', stock: 208 },
      { id_entidad: ID.matriz, entidad: 'CEO Admin', id_producto: 'p-750', producto: 'Destilado Plata 750ml', cubeta: 'PAGADO', stock: 1 },
      { id_entidad: ID.aero, entidad: 'Aeropuerto', id_producto: 'p-750', producto: 'Destilado Plata 750ml', cubeta: 'CONSIGNADO', stock: 17 }
    ],
    v_insumos_en_negativo: [],
    transacciones_tickets: [
      { id: 'fcb165bf-1111-4111-8111-111111111111', id_comprador: ID.aero, fecha_transaccion: '2026-11-05T03:29:32Z', total_cobrado_real: 8256, monto_base_ingreso: 8256, condicion_pago: 'CONCESION', status: 'ACTIVO' },
      { id: 'eeee0000-1111-4111-8111-111111111111', id_comprador: ID.aero, fecha_transaccion: '2026-11-04T03:29:32Z', total_cobrado_real: 9999, monto_base_ingreso: 9999, condicion_pago: 'CONCESION', status: 'ANULADO' }
    ],
    finanzas_ledger: [
      { id: 'f1', id_entidad_relacionada: ID.aero, fecha_movimiento: '2026-11-05T11:20:25Z', tipo_movimiento: 'ABONO_DEUDA', monto: 5000, categoria: 'ABONO_REAL', status: 'ACTIVO', es_entrega_efectivo: false },
      { id: 'f2', id_entidad_relacionada: ID.aero, fecha_movimiento: '2026-10-28T05:59:00Z', tipo_movimiento: 'CARGO_DEUDA', monto: 7000, categoria: 'ARRANQUE', status: 'ACTIVO', es_entrega_efectivo: false },
      { id: 'f3', id_entidad_relacionada: ID.aero, fecha_movimiento: '2026-10-29T05:59:00Z', tipo_movimiento: 'GASTO_OPERATIVO', monto: 4444, categoria: null, status: 'ACTIVO', es_entrega_efectivo: false }
    ],
    inventario_ledger: [
      { id: 'i1', fecha_movimiento: '2026-11-05T03:29:32Z', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 48, id_producto: 'p-50', id_entidad_origen: null, id_entidad_destino: ID.aero, status: 'ACTIVO' },
      { id: 'i2', fecha_movimiento: '2026-11-01T00:00:00Z', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 100, id_producto: 'i-chile', id_entidad_origen: null, id_entidad_destino: ID.matriz, status: 'ACTIVO' },
      { id: 'i3', fecha_movimiento: '2026-11-02T00:00:00Z', tipo_movimiento: 'TRASPASO', cantidad: 12.5, id_producto: 'i-chile', id_entidad_origen: ID.matriz, id_entidad_destino: null, status: 'ACTIVO' },
      { id: 'i4', fecha_movimiento: '2026-11-02T00:00:00Z', tipo_movimiento: 'MERMA', cantidad: 3, id_producto: 'i-et750', id_entidad_origen: ID.matriz, id_entidad_destino: null, status: 'ACTIVO' }
    ]
  }
  peticiones = []
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = decodeURIComponent(expr.slice(i + 1)).replace(/^"|"$/g, '')
  const actual = fila[col]
  if (op === 'eq') return String(actual) === val
  if (op === 'neq') return actual !== null && actual !== undefined && String(actual) !== val
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(actual))
  throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset'])

function filtrar(tabla: string, params: URLSearchParams): Fila[] {
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of params.entries()) {
    if (NO_FILTRAN.has(col)) continue
    if (col === 'or') {
      const partes = expr.replace(/^\(|\)$/g, '').split(',')
      filas = filas.filter((f) => partes.some((p) => cumple(f, p.slice(0, p.indexOf('.')), p.slice(p.indexOf('.') + 1))))
      continue
    }
    filas = filas.filter((f) => cumple(f, col, expr))
  }
  return filas
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json' } })
}

function responder(url: string, init: RequestInit | undefined): Response {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  peticiones.push(`${metodo} ${tabla}`)
  if (metodo !== 'GET' && metodo !== 'HEAD') return json({ message: 'el doble no escribe' }, 500)
  const filas = filtrar(tabla, u.searchParams)
  const objeto = (new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object')
  if (objeto) return filas.length === 1 ? json(filas[0]) : filas.length === 0 ? json(null) : json({ code: 'PGRST116' }, 406)
  return json(filas)
}

const fetchOriginal = globalThis.fetch

async function preguntar(cuerpo: Record<string, unknown>, telegramId = NORMAN) {
  const req = new Request('http://localhost/api/bot/pregunta', {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ telegram_id: telegramId, ...cuerpo })
  })
  const r = await pregunta.POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}
const texto = async (t: string, quien = NORMAN) => preguntar({ texto: t }, quien)

test.describe('/api/bot/pregunta Fase 6 (PostgREST falso)', () => {
  test.describe.configure({ mode: 'serial' })
  test.beforeAll(() => {
    for (const [k, v] of Object.entries(ENTORNO_FALSO)) {
      entornoOriginal[k] = process.env[k]
      process.env[k] = v
    }
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      responder(String(input instanceof Request ? input.url : input), init)) as typeof fetch
  })
  test.afterAll(() => {
    globalThis.fetch = fetchOriginal
    for (const [k, v] of Object.entries(entornoOriginal)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  test.beforeEach(() => estadoInicial())
  const soloGet = () => expect(peticiones.filter((p) => !p.startsWith('GET ')), peticiones.join('\n')).toEqual([])

  test('"cuanto debe aeropuerto" -> la deuda de v_cartera', async () => {
    const { status, j } = await texto('¿cuánto me debe aeropuerto?')
    expect(status).toBe(200)
    expect(j.reconocida).toBe(true)
    expect(j.tipo).toBe('deuda_cliente')
    expect(String(j.texto)).toContain('Aeropuerto (LOC) debe $10,256.00 de concesion.')
    expect(String(j.texto)).toContain('(de v_cartera')
    soloGet()
  })

  test('"ultimos movimientos de aeropuerto" -> ticket, abono, cargo y entrega; sin el anulado ni el gasto', async () => {
    const t = String((await texto('ultimos movimientos de aeropuerto')).j.texto)
    expect(t).toContain('Debe hoy: $10,256.00 (v_cartera)')
    expect(t).toContain('Ticket FCB165BF en concesion: suma $8,256.00 a la deuda')
    expect(t).toContain('Abono: resta $5,000.00')
    expect(t).toContain('Cargo (arranque): suma $7,000.00 a la deuda')
    expect(t).toContain('Entrega en concesion: 48 piezas (48 Destilado Plata 50ml)')
    expect(t).not.toContain('9,999')
    expect(t).not.toContain('4,444')
    // 8256 + 7000 - 5000 = 10256: los movimientos cuadran con la deuda de la vista.
    soloGet()
  })

  test('"quien me debe" -> cartera ordenada por deuda, total con la matriz', async () => {
    const t = String((await texto('quien me debe mas')).j.texto)
    expect(t).toContain('QUIEN DEBE — $29,575.00 de concesion')
    expect(t.indexOf('Martin Reyes')).toBeLessThan(t.indexOf('Aeropuerto'))
    expect(t.indexOf('Aeropuerto')).toBeLessThan(t.indexOf('Delirio 85'))
  })

  test('"cuantas botellas hay" y "de 750" -> v_stock_por_cubeta', async () => {
    const t = String((await texto('cuantas botellas hay')).j.texto)
    expect(t).toContain('producto terminado: 226 piezas')
    expect(t).toContain('CEO Admin (matriz): 209 piezas')
    expect(t).toContain('(de v_stock_por_cubeta')
    expect(String((await texto('cuantas botellas de 750 hay')).j.texto)).toContain('Destilado Plata 750ml: 18 piezas')
    soloGet()
  })

  test('"inventario total" -> terminado + insumos (con el negativo marcado y los sin movimiento)', async () => {
    const t = String((await texto('inventario total')).j.texto)
    expect(t).toContain('Producto terminado: 226 piezas (209 en la matriz, 17 en la red)')
    expect(t).toContain('Chile Guajillo: 87.5 kg')
    expect(t).toContain('Etiqueta 750: -3 pzas  ⚠️ negativo')
    expect(t).toContain('Sin un solo movimiento (no se sabe cuanto hay): Tapa 50')
    expect(t).toContain('Sin existencia en ningun lado: Destilado Plata 50ml, Pasta-Guajillo-2kg')
    soloGet()
  })

  test('"que se esta acabando" -> la vista de negativos + que no hay minimos', async () => {
    const t = String((await texto('que se esta acabando')).j.texto)
    expect(t).toContain('En negativo (v_insumos_en_negativo): ninguno.')
    expect(t).toContain('El ERP no tiene un minimo de reorden')
    expect(t).toContain('Destilado Plata 750ml: 1 pzas')
    expect(peticiones).toContain('GET v_insumos_en_negativo')
    soloGet()
  })

  test('nombre ambiguo -> opciones para botones; el boton vuelve con eleccion', async () => {
    tablas.entidades.push({ id: ID.gilr, nombre: 'Gilberto Ruiz', rol: 'LOC', id_padre: null, id_nodo_padre: null })
    const amb = await texto('cuanto debe gilberto')
    expect(amb.j.reconocida).toBe(false)
    expect(amb.j.motivo).toBe('cliente_ambiguo')
    expect(amb.j.para).toBe('deuda')
    expect(amb.j.opciones).toEqual([
      { id: ID.gil, nombre: 'Gilberto Franco' },
      { id: ID.gilr, nombre: 'Gilberto Ruiz' }
    ])
    const elegido = await preguntar({ eleccion: { para: 'deuda', id_entidad: ID.martin } })
    expect(elegido.j.tipo).toBe('deuda_cliente')
    expect(String(elegido.j.texto)).toContain('Martin Reyes (DST) debe $11,327.00')
    const malo = await preguntar({ eleccion: { para: 'deuda', id_entidad: ID.matriz } })
    expect(malo.status).toBe(422)
    soloGet()
  })

  test('un LOC: no se le contesta lo de todos; reconocida false "acotada" para que siga /consulta', async () => {
    for (const t of ['cuanto debe martin', 'cuantas botellas hay', 'inventario total']) {
      const r = await texto(t, LOCAL)
      expect(r.status, t).toBe(200)
      expect(r.j.reconocida, t).toBe(false)
      expect(r.j.motivo, t).toBe('acotada')
      expect(String(r.j.texto), t).not.toMatch(/\d{2}/)
    }
    expect(peticiones).not.toContain('GET v_cartera')
    expect(peticiones).not.toContain('GET v_stock_por_cubeta')
  })

  test('nombre ambiguo: a quien no ve todo NO se le ensenan los nombres (permiso antes que opciones)', async () => {
    tablas.entidades.push({ id: ID.gilr, nombre: 'Gilberto Ruiz', rol: 'LOC', id_padre: null, id_nodo_padre: null })
    const loc = await texto('cuanto debe gilberto', LOCAL)
    expect(loc.status).toBe(200)
    expect(loc.j.motivo).toBe('acotada')
    expect(loc.j.opciones).toBeUndefined()
    expect(JSON.stringify(loc.j)).not.toContain('Gilberto')
    const trab = await texto('ultimos movimientos de gilberto', TRABAJADOR)
    expect(trab.status).toBe(403)
    expect(JSON.stringify(trab.j)).not.toContain('Gilberto')
  })

  test('un TRABAJADOR: 403 (no tiene inventario ni deuda)', async () => {
    expect((await texto('cuantas botellas hay', TRABAJADOR)).status).toBe(403)
  })

  test('lo de la Fase 2 no lee nombres (no cambia su camino)', async () => {
    await texto('cuanto hay en spin')
    expect(peticiones).not.toContain('GET catalogo_productos')
  })
})
