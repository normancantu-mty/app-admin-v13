/**
 * REGALOS (2026-11-20). Escrito el 2026-11-20 por un ejecutor del Socio.
 *
 * 1. Lo puro (`lib/regalos.ts`): reparto que AVISA y no bloquea, filas para la
 *    RPC, cartera (persona, mes, presentacion; sin dinero) y lectura del dictado.
 * 2. `registrarRegalo` (`lib/regalos-servidor.ts`) contra un PostgREST falso:
 *    lo que viaja a la RPC `registrar_regalo`, con y sin existencia.
 * 3. Las rutas del bot `regalo/proponer` + `regalo/confirmar`: VA, aprobacion,
 *    sello, permiso.
 * 4. Cableado: la accion web, el panel, el bot de Python y la migracion.
 *
 * Sin red ni base: el `fetch` global se dobla (mismo doble que bot-merma.spec).
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { tipoDelPayload } from '@/lib/bot-pendiente'
import {
  armarCartera,
  armarFilasRegalo,
  completarRegalo,
  faltaColumnaRegalo,
  fechaMenosDias,
  hablaDeRegalo,
  leerConsultaRegalos,
  leerRegalo,
  numeroDictado,
  normalizarQuien,
  repartoRegalo,
  textoContador,
  validarSolicitudRegalo,
  type LineaCartera,
  type ProductoRegalo
} from '@/lib/regalos'
import { hoyMx, registrarRegalo } from '@/lib/regalos-servidor'
import * as regaloP from '@/app/api/bot/regalo/proponer/route'
import * as regaloC from '@/app/api/bot/regalo/confirmar/route'

const PRODUCTOS: ProductoRegalo[] = [
  { id: 'p-250', nombre: 'Destilado Plata 250ml', ml_por_unidad: 250, costo_unitario: 0 },
  { id: 'p-50', nombre: 'Destilado Plata 50ml', ml_por_unidad: 50, costo_unitario: 0 },
  { id: 'p-750', nombre: 'Destilado Plata 750ml', ml_por_unidad: 750, costo_unitario: 120 },
  { id: 'p-pasta', nombre: 'Pasta-Guajillo-2kg', ml_por_unidad: null, costo_unitario: 0 }
]

// ─── 1. Lo puro ─────────────────────────────────────────────────────────────

test.describe('regalos (pura): reparto', () => {
  test('alcanza: PAGADO primero, luego CONSIGNADO, sin faltante', () => {
    expect(repartoRegalo(5, { pagado: 3, consignado: 4 })).toEqual({ dePagado: 3, deConsignado: 2, faltante: 0 })
    expect(repartoRegalo(2, { pagado: 3, consignado: 4 })).toEqual({ dePagado: 2, deConsignado: 0, faltante: 0 })
  })

  test('no alcanza: NO bloquea; agota CONSIGNADO y el resto sale de PAGADO (queda negativo)', () => {
    expect(repartoRegalo(8, { pagado: 3, consignado: 4 })).toEqual({ dePagado: 4, deConsignado: 4, faltante: 1 })
    expect(repartoRegalo(5, { pagado: 0, consignado: 0 })).toEqual({ dePagado: 5, deConsignado: 0, faltante: 5 })
    // Un stock ya negativo se trata como 0.
    expect(repartoRegalo(2, { pagado: -3, consignado: 1 })).toEqual({ dePagado: 1, deConsignado: 1, faltante: 1 })
  })

  test('las filas: una por cubeta, con costo del catalogo y la nota; el aviso solo si falta', () => {
    const stocks = new Map([
      ['p-750', { pagado: 3, consignado: 4 }],
      ['p-50', { pagado: 10, consignado: 0 }]
    ])
    const r = armarFilasRegalo(
      [
        { id_producto: 'p-750', cantidad: 5 },
        { id_producto: 'p-750', cantidad: 3 },
        { id_producto: 'p-50', cantidad: 2 }
      ],
      PRODUCTOS,
      stocks,
      'Regalo de Kevin: evento X'
    )
    expect(r.filas).toEqual([
      { id_producto: 'p-750', cubeta: 'PAGADO', cantidad: 4, costo_unitario_movimiento: 120, notas: 'Regalo de Kevin: evento X' },
      { id_producto: 'p-750', cubeta: 'CONSIGNADO', cantidad: 4, costo_unitario_movimiento: 120, notas: 'Regalo de Kevin: evento X' },
      { id_producto: 'p-50', cubeta: 'PAGADO', cantidad: 2, costo_unitario_movimiento: 0, notas: 'Regalo de Kevin: evento X' }
    ])
    expect(r.avisos).toHaveLength(1)
    expect(r.avisos[0]).toContain('Destilado Plata 750ml: hay 7 y salen 8; la existencia queda en -1')
  })

  test('si la existencia YA era negativa, el aviso dice la real (no la recortada a 0)', () => {
    const { filas, avisos } = armarFilasRegalo(
      [{ id_producto: 'p-750', cantidad: 5 }], PRODUCTOS, new Map([['p-750', { pagado: -4, consignado: 0 }]]), 'n'
    )
    expect(filas).toEqual([{ id_producto: 'p-750', cubeta: 'PAGADO', cantidad: 5, costo_unitario_movimiento: 120, notas: 'n' }])
    expect(avisos[0]).toContain('hay -4 y salen 5; la existencia queda en -9')
  })

  test('validacion: lo que impide guardar (la existencia NO es una de esas cosas)', () => {
    const ok = { fecha: '2026-11-20', quien_regalo: 'Kevin', motivo: 'Evento X', lineas: [{ id_producto: 'p-750', cantidad: 5 }] }
    expect(validarSolicitudRegalo(ok)).toBeNull()
    expect(validarSolicitudRegalo({ ...ok, fecha: '20/11/2026' })).toContain('fecha')
    expect(validarSolicitudRegalo({ ...ok, quien_regalo: '  ' })).toContain('quien')
    expect(validarSolicitudRegalo({ ...ok, motivo: 'x' })).toContain('motivo')
    expect(validarSolicitudRegalo({ ...ok, lineas: [] })).toContain('pieza')
    expect(validarSolicitudRegalo({ ...ok, lineas: [{ id_producto: 'p-750', cantidad: 1.5 }] })).toContain('enteras')
    expect(validarSolicitudRegalo({ ...ok, lineas: [{ id_producto: 'p-750', cantidad: -2 }] })).toContain('enteras')
  })

  test('quien: los tres de siempre se normalizan; otro nombre queda libre', () => {
    expect(normalizarQuien('kevin')).toBe('Kevin')
    expect(normalizarQuien(' GILBERTO ')).toBe('Gilberto')
    expect(normalizarQuien('Juan  Pérez')).toBe('Juan Pérez')
    expect(normalizarQuien('')).toBe('')
  })
})

test.describe('regalos (pura): cartera', () => {
  const l = (o: Partial<LineaCartera>): LineaCartera => ({
    id_regalo: 'r1', fecha: '2026-11-20', quien_regalo: 'Kevin', motivo: 'Evento X', usuario_creador: 'a@x',
    id_producto: 'p-750', producto: 'Destilado Plata 750ml', ml_por_unidad: 750,
    piezas: 5, ...o
  })
  const lineas: LineaCartera[] = [
    l({}),
    l({ id_producto: 'p-250', producto: 'Destilado Plata 250ml', ml_por_unidad: 250, piezas: 5 }),
    l({ id_producto: 'p-50', producto: 'Destilado Plata 50ml', ml_por_unidad: 50, piezas: 2 }),
    l({ id_regalo: 'r2', fecha: '2026-10-03', quien_regalo: 'gilberto', motivo: 'Boda', piezas: 2 }),
    l({ id_regalo: 'r3', fecha: '2026-11-02', quien_regalo: 'Norman', motivo: 'Cata', id_producto: 'p-pasta', producto: 'Pasta', ml_por_unidad: null, piezas: 1 })
  ]

  test('totales por persona, en piezas por presentacion (sin dinero)', () => {
    const c = armarCartera(lineas)
    expect(c.presentaciones.map((p) => p.id_producto)).toEqual(['p-750', 'p-250', 'p-50', 'p-pasta'])
    const kevin = c.porPersona.find((g) => g.clave === 'Kevin')!
    expect(kevin.piezasPorProducto).toEqual({ 'p-750': 5, 'p-250': 5, 'p-50': 2 })
    expect(kevin.piezas).toBe(12)
    expect(Object.keys(kevin).sort()).toEqual(['clave', 'piezas', 'piezasPorProducto'])
    // "gilberto" en minusculas se junta con Gilberto.
    expect(c.porPersona.find((g) => g.clave === 'Gilberto')).toMatchObject({ piezas: 2 })
    expect(c.porPersona.find((g) => g.clave === 'Norman')).toMatchObject({ piezas: 1 })
    expect(c.porPersona.map((g) => g.clave)).toEqual(['Kevin', 'Gilberto', 'Norman'])
  })

  test('por mes (el mas reciente primero), total y registros con su motivo', () => {
    const c = armarCartera(lineas)
    expect(c.porMes.map((g) => [g.clave, g.piezas])).toEqual([
      ['2026-11', 13],
      ['2026-10', 2]
    ])
    expect(c.total).toMatchObject({ piezas: 15 })
    expect(c.registros.map((r) => [r.id_regalo, r.fecha, r.quien_regalo, r.motivo, r.piezas])).toEqual([
      ['r1', '2026-11-20', 'Kevin', 'Evento X', 12],
      ['r3', '2026-11-02', 'Norman', 'Cata', 1],
      ['r2', '2026-10-03', 'Gilberto', 'Boda', 2]
    ])
  })

  test('sin regalos: cartera vacia, sin reventar', () => {
    const c = armarCartera([])
    expect(c).toMatchObject({ porPersona: [], porMes: [], registros: [], total: { piezas: 0 } })
  })
})

test.describe('regalos (pura): lo que se dicta', () => {
  test('el dictado de Norman, tal cual', () => {
    expect(leerRegalo('Kevin regaló 5 grandes, 5 chicas y 2 minis, motivo: evento X', PRODUCTOS, 'norman')).toEqual({
      ok: true,
      quien: 'Kevin',
      motivo: 'evento X',
      diasAtras: 0,
      piezas: [
        { producto: PRODUCTOS[2], cantidad: 5 },
        { producto: PRODUCTOS[0], cantidad: 5 },
        { producto: PRODUCTOS[1], cantidad: 2 }
      ]
    })
  })

  test('variantes: "regale" es quien dicta; numeros en letra y en ml; motivo sin la palabra', () => {
    expect(leerRegalo('regalé dos de 750 en la boda de Juan', PRODUCTOS, 'norman')).toMatchObject({
      ok: true, quien: 'Norman', motivo: 'la boda de Juan', piezas: [{ producto: { id: 'p-750' }, cantidad: 2 }]
    })
    expect(leerRegalo('Gilberto le regaló 3 botellas grandes para la expo de Zacatecas', PRODUCTOS, 'kevin')).toMatchObject({
      ok: true, quien: 'Gilberto', motivo: 'la expo de Zacatecas', piezas: [{ producto: { id: 'p-750' }, cantidad: 3 }]
    })
    // 2026-11-25: lista cerrada. Juan Pérez no está: no se guarda, se pregunta.
    expect(leerRegalo('Juan Pérez regaló 4 minis, motivo: degustación 2 de dic', PRODUCTOS, 'norman')).toMatchObject({
      ok: false, falta: 'quien', quien: '', duda: { dicho: 'Juan Pérez', motivo: 'desconocido' }, motivo: 'degustación 2 de dic', piezas: [{ producto: { id: 'p-50' }, cantidad: 4 }]
    })
  })

  test('falta algo: se dice UNA cosa; un tamano inexistente no se adivina', () => {
    expect(leerRegalo('Kevin regaló 5 grandes', PRODUCTOS, 'norman')).toMatchObject({ ok: false, falta: 'motivo', quien: 'Kevin' })
    expect(leerRegalo('se regalaron 5 grandes, motivo: evento', PRODUCTOS, 'norman')).toMatchObject({ ok: false, falta: 'quien' })
    expect(leerRegalo('Kevin regaló 3 de 500, motivo: evento', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'tamano', dicho: '500' })
    expect(leerRegalo('me regalaron un día libre', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'piezas' })
  })

  test('numeros en letra de 13 a 100, sin perder piezas en silencio (auditoria 2026-11-20)', () => {
    expect([numeroDictado('trece'), numeroDictado('dieciseis'), numeroDictado('veinticuatro'), numeroDictado('treinta y dos'), numeroDictado('cien'), numeroDictado('13')]).toEqual([13, 16, 24, 32, 100, 13])
    expect(numeroDictado('treinta y doce')).toBeNaN()
    expect(leerRegalo('Kevin regaló trece grandes y 2 minis, motivo: expo', PRODUCTOS, 'norman')).toMatchObject({
      ok: true, piezas: [{ producto: { id: 'p-750' }, cantidad: 13 }, { producto: { id: 'p-50' }, cantidad: 2 }]
    })
    expect(leerRegalo('Kevin regaló veinticuatro minis, motivo: expo', PRODUCTOS, 'norman')).toMatchObject({
      ok: true, piezas: [{ producto: { id: 'p-50' }, cantidad: 24 }]
    })
    expect(leerRegalo('Kevin regaló treinta y dos minis, motivo: expo', PRODUCTOS, 'norman')).toMatchObject({
      ok: true, piezas: [{ producto: { id: 'p-50' }, cantidad: 32 }]
    })
  })

  test('"regalo" como sustantivo NO es un regalo: la venta y la merma siguen su camino', () => {
    expect(leerRegalo('vendí 3 grandes de regalo de navidad a Juan', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'no_es_regalo' })
    expect(leerRegalo('se me cayó una grande que iba de regalo', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'no_es_regalo' })
    expect(leerRegalo('compré 2 grandes para los regalos', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'no_es_regalo' })
    // y el verbo con pronombre femenino si es regalo
    expect(leerRegalo('Kevin las regaló, 2 chicas, motivo: cata', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Kevin' })
  })

  test('dos personas en un mensaje: se pide uno por mensaje en vez de cargarle todo al primero', () => {
    expect(leerRegalo('Kevin regaló 2 grandes y Gilberto regaló 3 chicas, motivo: expo', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'uno_por_mensaje' })
    expect(leerRegalo('Kevin y Gilberto regalaron 3 chicas, motivo: expo', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'uno_por_mensaje' }) // 2026-11-25: uno de la lista por regalo
  })

  test('"a una chica" es una persona, no una pieza', () => {
    expect(leerRegalo('Kevin regaló 2 grandes a una chica en la expo', PRODUCTOS, 'norman')).toMatchObject({
      ok: true, piezas: [{ producto: { id: 'p-750' }, cantidad: 2 }]
    })
  })

  test('"ayer"/"antier": la fecha se recorre; sin eso, hoy', () => {
    expect(leerRegalo('ayer Kevin regaló 2 grandes, motivo: boda', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Kevin', diasAtras: 1 })
    expect(leerRegalo('antier regalé 1 mini, motivo: cata', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Norman', diasAtras: 2 })
    expect(fechaMenosDias('2026-03-01', 1)).toBe('2026-02-28')
    expect(fechaMenosDias('2026-11-20', 0)).toBe('2026-11-20')
  })

  test('el patron de regalo', () => {
    for (const t of ['Kevin regaló 5 grandes', 'regale 2', 'obsequiamos 3 minis', 'REGALO de 2 de 750']) expect(hablaDeRegalo(t), t).toBe(true)
    for (const t of ['vendi 2 de 750', 'se rompieron 2 de 750', 'gasolina 300']) expect(hablaDeRegalo(t), t).toBe(false)
  })

  test('el borrador regalo se rehidrata con su tipo', () => {
    expect(tipoDelPayload({ tipo: 'regalo', regalo: {} })).toBe('regalo')
  })
})

// ─── El PostgREST falso ─────────────────────────────────────────────────────

const TOKEN = 'r'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222
const LOCAL = 333

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let contador = 0
/** Cada llamada a la RPC `registrar_regalo`, con su cuerpo tal cual. */
let rpcs: { p_regalo: Fila; p_inventario: Fila[] }[] = []
let rpcFalla: string | null = null

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'CEO Admin', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
      { id: 'ent-aero', nombre: 'Aeropuerto', rol: 'LOC', id_padre: null, id_nodo_padre: null }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false, creado_en: '2026-01-01' },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: true, creado_en: '2026-02-01' },
      { telegram_id: LOCAL, etiqueta: 'aero', id_entidad: 'ent-aero', id_cuenta_destino: 'c-aero', activo: true, requiere_aprobacion: false, creado_en: '2026-03-01' }
    ],
    cuentas_financieras: [
      { id: 'c-ef', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-aero', id_entidad: 'ent-aero', nombre: 'Efectivo (Aeropuerto)', tipo_fiscalidad: 'LIBRE' }
    ],
    catalogo_productos: PRODUCTOS.map((p) => ({ ...p, tipo: 'TERMINADO' })).concat([
      { id: 'i-chile', nombre: 'Chile seco', tipo: 'INSUMO', ml_por_unidad: null, costo_unitario: 10 }
    ]),
    inventario_ledger: [
      { id: 'inv-a', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 3, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-b', id_producto: 'p-750', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 4, cubeta: 'CONSIGNADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-c', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 99, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ANULADO' },
      { id: 'inv-d', id_producto: 'p-250', tipo_movimiento: 'PRODUCCION', cantidad: 20, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-e', id_producto: 'p-50', tipo_movimiento: 'PRODUCCION', cantidad: 20, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-f', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 50, cubeta: 'PAGADO', id_entidad_destino: 'ent-aero', id_entidad_origen: null, status: 'ACTIVO' }
    ],
    bot_borradores: [],
    avisos_captura: []
  }
  escrituras = []
  rpcs = []
  rpcFalla = null
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = decodeURIComponent(expr.slice(i + 1)).replace(/^"|"$/g, '')
  const actual = fila[col]
  if (op === 'eq') return String(actual) === val
  if (op === 'neq') return String(actual) !== val
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'gte') return String(actual) >= val
  if (op === 'lt') return actual !== null && actual !== undefined && String(actual) < val
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(actual))
  throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

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

/** El doble de `registrar_regalo`: guarda el cuerpo y escribe las filas MERMA como lo haria la RPC. */
function rpcRegistrarRegalo(cuerpo: { p_regalo: Fila; p_inventario: Fila[] }): Response {
  rpcs.push(JSON.parse(JSON.stringify(cuerpo)))
  if (rpcFalla) return json({ code: '23514', message: rpcFalla, details: '', hint: '' }, 400)
  const id = `reg-${++contador}`
  for (const f of cuerpo.p_inventario) {
    tablas.inventario_ledger.push({
      id: `inv-${++contador}`, ...f, tipo_movimiento: 'MERMA', id_entidad_origen: cuerpo.p_regalo.id_entidad_origen,
      id_entidad_destino: null, status: 'ACTIVO', id_regalo: id
    })
  }
  return json(id)
}

function responder(url: string, init: RequestInit | undefined): Response {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const objeto = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const representacion = (headers.get('prefer') ?? '').includes('return=representation')
  let filas: Fila[] = []
  if (tabla.startsWith('rpc/')) {
    escrituras.push(`POST ${tabla}`)
    if (tabla === 'rpc/registrar_regalo') return rpcRegistrarRegalo(JSON.parse(String(init?.body)))
    return json(null)
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = filtrar(tabla, u.searchParams)
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      const defaults: Fila = tabla === 'bot_borradores' ? { estado: 'PENDIENTE', resuelto_en: null, id_registro: null, chat_id: null } : { status: 'ACTIVO' }
      const nuevas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((c: Fila) => ({ id: `${tabla}-${++contador}`, ...defaults, ...c }))
      ;(tablas[tabla] ??= []).push(...nuevas)
      filas = nuevas
    } else if (metodo === 'PATCH') {
      filas = filtrar(tabla, u.searchParams)
      for (const f of filas) Object.assign(f, cuerpo)
    }
    if (!representacion && !objeto) return new Response(null, { status: 204 })
  }
  if (objeto) {
    if (filas.length === 0 && (headers.get('accept') ?? '').includes('nulls=stripped')) return json(null)
    if (filas.length !== 1) return json({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }, 406)
    return json(filas[0])
  }
  return json(filas)
}

const fetchOriginal = globalThis.fetch
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

const regalosEnLedger = () => tablas.inventario_ledger.filter((f) => f.id_regalo)

// ─── 2. registrarRegalo: lo que viaja a la RPC ──────────────────────────────

test.describe('registrarRegalo (web y bot) contra el PostgREST falso', () => {
  const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
  const solicitud = {
    fecha: '2026-11-20',
    quien_regalo: 'kevin',
    motivo: '  Evento   X ',
    lineas: [
      { id_producto: 'p-750', cantidad: 5 },
      { id_producto: 'p-250', cantidad: 5 },
      { id_producto: 'p-50', cantidad: 2 }
    ]
  }

  test('con existencia: UNA llamada a la RPC con encabezado y filas exactas; el stock baja', async () => {
    estadoInicial()
    const r = await registrarRegalo(cliente(), solicitud, 'ent-matriz', 'web@x')
    expect(r).toMatchObject({ ok: true, filas: 4, avisos: [] })
    expect(escrituras).toEqual(['POST rpc/registrar_regalo'])
    const nota = 'Regalo de Kevin: Evento X'
    expect(rpcs).toEqual([
      {
        p_regalo: { fecha: '2026-11-20', quien_regalo: 'Kevin', motivo: 'Evento X', id_entidad_origen: 'ent-matriz', usuario_creador: 'web@x' },
        p_inventario: [
          { id_producto: 'p-750', cubeta: 'PAGADO', cantidad: 3, costo_unitario_movimiento: 120, notas: nota },
          { id_producto: 'p-750', cubeta: 'CONSIGNADO', cantidad: 2, costo_unitario_movimiento: 120, notas: nota },
          { id_producto: 'p-250', cubeta: 'PAGADO', cantidad: 5, costo_unitario_movimiento: 0, notas: nota },
          { id_producto: 'p-50', cubeta: 'PAGADO', cantidad: 2, costo_unitario_movimiento: 0, notas: nota }
        ]
      }
    ])
    expect(regalosEnLedger()).toHaveLength(4)
  })

  test('SIN existencia: guarda igual (no bloquea) y regresa el aviso', async () => {
    estadoInicial()
    const r = await registrarRegalo(cliente(), { ...solicitud, lineas: [{ id_producto: 'p-750', cantidad: 10 }] }, 'ent-matriz', 'web@x')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.avisos.join(' ')).toContain('hay 7 y salen 10; la existencia queda en -3')
    expect(rpcs[0].p_inventario).toEqual([
      expect.objectContaining({ cubeta: 'PAGADO', cantidad: 6 }),
      expect.objectContaining({ cubeta: 'CONSIGNADO', cantidad: 4 })
    ])
  })

  test('invalida o producto que no es TERMINADO: no llama a la RPC', async () => {
    estadoInicial()
    expect(await registrarRegalo(cliente(), { ...solicitud, motivo: '' }, 'ent-matriz', 'web@x')).toMatchObject({ ok: false })
    expect(await registrarRegalo(cliente(), { ...solicitud, lineas: [{ id_producto: 'i-chile', cantidad: 1 }] }, 'ent-matriz', 'web@x')).toMatchObject({
      ok: false, error: expect.stringContaining('producto terminado')
    })
    expect(rpcs).toEqual([])
  })

  test('si la base rechaza, se dice y no se finge exito', async () => {
    estadoInicial()
    rpcFalla = 'Solo ADMIN o EMPLEADO_ADMIN registran regalos'
    expect(await registrarRegalo(cliente(), solicitud, 'ent-matriz', 'web@x')).toEqual({
      ok: false, error: 'No se guardo: Solo ADMIN o EMPLEADO_ADMIN registran regalos'
    })
  })
})

// ─── 3. Las rutas del bot ───────────────────────────────────────────────────

async function llamar(ruta: 'proponer' | 'confirmar', cuerpo: Record<string, unknown>) {
  const req = new Request('http://localhost/api/bot/regalo/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await (ruta === 'proponer' ? regaloP : regaloC).POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}

test.describe('regalo/proponer + regalo/confirmar', () => {
  const DICTADO = 'Kevin regaló 5 grandes, 5 chicas y 2 minis, motivo: evento X'

  test('el dictado de Norman: propone sin escribir; el VA escribe por la RPC', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: DICTADO })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const m = String(p.j.mensaje)
    expect(m).toContain('QUIEN:      Kevin')
    expect(m).toContain('12 piezas')
    expect(m).toContain('5 piezas de Destilado Plata 750ml')
    expect(m).toContain('MOTIVO:     evento X')
    expect(m).not.toContain('AVISO')
    expect(rpcs).toEqual([])
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Kevin', motivo: 'evento X', id_entidad_origen: 'ent-matriz', usuario_creador: 'telegram:norman' })
    expect(rpcs[0].p_inventario.reduce((a, f) => a + Number(f.cantidad), 0)).toBe(12)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).toBe('CONFIRMADO')
  })

  test('mas de lo que hay: la propuesta AVISA y el VA escribe igual', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'Gilberto regaló 9 grandes, motivo: expo' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(String(p.j.mensaje)).toContain('AVISO: Destilado Plata 750ml: hay 7 y salen 9')
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(String(c.j.mensaje)).toContain('AVISO')
    expect(rpcs).toHaveLength(1)
  })

  test('sin motivo: UNA pregunta; sin piezas: no_es_regalo; nada se guarda', async () => {
    estadoInicial()
    const a = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló 5 grandes' })
    expect(String(a.j.pregunta)).toContain('motivo')
    const b = await llamar('proponer', { telegram_id: NORMAN, texto: 'me regalaron un día libre' })
    expect(b.j.no_es_regalo).toBe(true)
    expect((await llamar('proponer', { telegram_id: NORMAN, texto: 'vendi 2 de 750' })).j.no_es_regalo).toBe(true)
    expect(escrituras).toEqual([])
  })

  test('el VA de Kevin espera; el Aprobar de Norman escribe con la etiqueta de Kevin', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: KEVIN, texto: 'regalé 2 minis en la cata de Fresnillo' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(String(p.j.mensaje)).toContain('QUIEN:      Kevin')
    const va = await llamar('confirmar', { telegram_id: KEVIN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect(rpcs).toEqual([])
    const ok = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Kevin', usuario_creador: 'telegram:kevin', motivo: 'la cata de Fresnillo' })
  })

  test('"ayer Kevin regalo..." guarda con la fecha de ayer; "iba de regalo" no es regalo', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'ayer Kevin regaló 1 grande, motivo: boda' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs[0].p_regalo).toMatchObject({ fecha: fechaMenosDias(hoyMx(), 1) })
    const n = await llamar('proponer', { telegram_id: NORMAN, texto: 'se me cayó una grande que iba de regalo' })
    expect(n.j.no_es_regalo).toBe(true)
    const d = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló 2 grandes y Gilberto regaló 3 chicas, motivo: expo' })
    expect(String(d.j.pregunta)).toContain('un regalo por mensaje')
  })

  test('un LOC no registra regalos por aqui: 403', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: LOCAL, texto: DICTADO })
    expect(p.status).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('si alguien toca el regalo guardado, el sello lo cancela y no se escribe nada', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: DICTADO })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    ;(((b.payload as Fila).regalo as Fila).lineas as Fila[])[0].cantidad = 50
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(409)
    expect(b.estado).toBe('CANCELADO')
    expect(rpcs).toEqual([])
  })

  test('un sello distinto del que se enseno: 409 y nada se escribe', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: DICTADO })
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: 'f'.repeat(64) })
    expect(c.status).toBe(409)
    expect(rpcs).toEqual([])
  })
})

// ─── 3b. Pedido de Norman del 2026-11-23: sin costo, contador por persona ───

test.describe('regalos 2026-11-23: el mensaje real del grupo, sin costo y con contador', () => {
  // bitacora de produccion, mensaje 803 del grupo, 2026-11-23 12:56 MX. El bot contesto
  // "¿Cuánto costó la botella que regalaste?" (mensajes 804 y 806).
  const REAL = 'Regalo una grande de norman en conferencia de IA'

  test('se lee completo: quien, pieza y razon', () => {
    expect(leerRegalo(REAL, PRODUCTOS, 'norman')).toMatchObject({
      ok: true, quien: 'Norman', motivo: 'conferencia de IA', piezas: [{ producto: { id: 'p-750' }, cantidad: 1 }]
    })
    // Dictado por otra persona, sigue siendo de Norman.
    expect(leerRegalo(REAL, PRODUCTOS, 'kevin')).toMatchObject({ ok: true, quien: 'Norman' })
  })

  test('formas cortas: "regalo Kevin 2 grandes en X", "regalo de Luis: 3 minis…", "registra un regalo…", sin nombre = quien dicta', () => {
    expect(leerRegalo('regalo Kevin 2 grandes en la feria', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Kevin', motivo: 'la feria', piezas: [{ cantidad: 2 }] })
    expect(leerRegalo('Regalo de Luis: 3 minis para una cata', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Luis', motivo: 'una cata' })
    expect(leerRegalo('registra un regalo de Gilberto, 1 chica, motivo: cliente nuevo', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Gilberto', motivo: 'cliente nuevo' })
    expect(leerRegalo('Regalos Kevin 2 grandes y 1 mini en la expo', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Kevin', motivo: 'la expo' })
    expect(leerRegalo('Regalo 2 minis en la expo', PRODUCTOS, 'luis')).toMatchObject({ ok: true, quien: 'Luis', motivo: 'la expo' })
    // "la boda de Kevin" es la razon, no quien regalo.
    expect(leerRegalo('regalé 2 grandes en la boda de Kevin', PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Norman', motivo: 'la boda de Kevin' })
    // Con acento es tercera persona sin nombre: se pregunta quien.
    expect(leerRegalo('Regaló 2 grandes en la expo', PRODUCTOS, 'norman')).toMatchObject({ ok: false, falta: 'quien' })
  })

  test('dos personas (o venta y regalo) en un mensaje: uno por mensaje, no se le carga todo a una', () => {
    for (const t of [
      'Regalos: Norman 1 grande en conferencia de IA, Kevin 2 grandes en feria',
      'Regalo una grande de norman y 2 chicas de kevin en la feria',
      'Regalo 2 grandes de norman y kevin en la feria',
      'Vendi 2 grandes y regale 1 chica en la feria'
    ]) expect(leerRegalo(t, PRODUCTOS, 'norman'), t).toEqual({ ok: false, falta: 'uno_por_mensaje' })
  })

  test('una botella sin tamano: pregunta cual; y con la respuesta se completa', () => {
    expect(leerRegalo('Kevin regaló una botella en la expo', PRODUCTOS, 'norman')).toEqual({ ok: false, falta: 'piezas' })
    expect(completarRegalo('Kevin regaló una botella en la expo', 'piezas', 'grande')).toBe('Kevin regaló una grande en la expo')
    expect(completarRegalo('Kevin regaló botellas en la expo', 'piezas', '2 minis')).toBe('Kevin regaló 2 minis en la expo')
    expect(leerRegalo(completarRegalo('Kevin regaló 5 grandes', 'motivo', 'boda de Juan'), PRODUCTOS, 'norman')).toMatchObject({ ok: true, motivo: 'boda de Juan' })
    expect(leerRegalo(completarRegalo('Kevin regaló 5 grandes', 'motivo', 'Solo registralo'), PRODUCTOS, 'norman')).toMatchObject({ ok: true, motivo: 'sin motivo dicho' })
    expect(leerRegalo(completarRegalo('se regalaron 5 grandes, motivo: evento', 'quien', 'fue Kevin'), PRODUCTOS, 'norman')).toMatchObject({ ok: true, quien: 'Kevin', motivo: 'evento' })
    // sin botella de por medio sigue sin ser un regalo de producto (puede ser un gasto)
    expect(leerRegalo('regalo para la esposa de Gilberto 500', PRODUCTOS, 'norman').ok).toBe(false)
  })

  test('que es consulta y que es registro', () => {
    for (const [t, q] of [
      ['regalos', ''], ['Regalos?', ''], ['contador de regalos', ''], ['cuántos regalos lleva Kevin', 'Kevin'], ['¿Cuántos regalos lleva Kevin?', 'Kevin'],
      ['regalos de Norman', 'Norman'], ['cuantas botellas ha regalado Gilberto', 'Gilberto'], ['mis regalos', 'Luis'], ['cuantos regalos llevo', 'Luis'],
      ['cuantas grandes hemos regalado', ''], ['pásame los regalos', '']
    ] as const) expect(leerConsultaRegalos(t, 'luis', []), t).toEqual({ quien: q })
    expect(leerConsultaRegalos('cuantos regalos lleva juan perez', 'luis', ['Juan Pérez'])).toEqual({ quien: 'Juan Pérez' })
    for (const t of [REAL, 'Kevin regaló 5 grandes, motivo: x', 'regalos Kevin 2 grandes en la expo', 'vendí 3 grandes de regalo', 'cuanto vendimos', 'me regalaron un dia libre', 'regalo para la esposa de Gilberto 500'])
      expect(leerConsultaRegalos(t, 'luis', []), t).toBeNull()
  })

  test('el contador: suma por persona, por presentacion y total, con cada razon; ni un peso', () => {
    const l = (o: Partial<LineaCartera>): LineaCartera => ({
      id_regalo: 'r1', fecha: '2026-11-23', quien_regalo: 'Kevin', motivo: 'Feria', usuario_creador: null,
      id_producto: 'p-750', producto: 'Destilado Plata 750ml', ml_por_unidad: 750, piezas: 2, ...o
    })
    const c = armarCartera([
      l({}), l({ id_producto: 'p-50', producto: 'Destilado Plata 50ml', ml_por_unidad: 50, piezas: 3 }),
      l({ id_regalo: 'r2', fecha: '2026-11-22', motivo: 'Boda', piezas: 1 }),
      l({ id_regalo: 'r3', quien_regalo: 'norman', motivo: 'conferencia de IA', piezas: 1 })
    ])
    const todo = textoContador(c, '')
    expect(todo).toContain('Kevin: 6 botellas (3 de 750ml, 3 de 50ml)')
    expect(todo).toContain('Norman: 1 botella (1 de 750ml)')
    expect(todo).toContain('TOTAL: 7 botellas (4 de 750ml, 3 de 50ml)')
    const k = textoContador(c, 'Kevin')
    expect(k).toContain('Kevin: 6 botellas')
    expect(k).toContain('2026-11-23: 2 de 750ml, 3 de 50ml. Feria')
    expect(k).toContain('2026-11-22: 1 de 750ml. Boda')
    expect(k).not.toContain('conferencia')
    expect(textoContador(c, 'Luis')).toContain('Luis: 0 botellas')
    expect(textoContador(armarCartera([]), '')).toContain('Todavia no hay regalos')
    for (const t of [todo, k]) expect(t).not.toMatch(/\$|costo|precio|monto/i)
  })

  test('por la ruta: el mensaje real propone SIN preguntar costo, el VA baja una grande y contesta el contador', async () => {
    estadoInicial()
    tablas.v_regalo_lineas = [
      { id_regalo: 'r0', fecha: '2026-11-20', quien_regalo: 'Norman', motivo: 'Feria', usuario_creador: null, id_producto: 'p-750', producto: 'Destilado Plata 750ml', ml_por_unidad: 750, piezas: 2 }
    ]
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: REAL })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(p.j.ok).toBe(true)
    expect(p.j.pregunta).toBeUndefined()
    expect(String(p.j.mensaje)).not.toMatch(/\$|cu[aá]nto|cost[oó]|precio|monto/i)
    expect(String(p.j.mensaje)).toContain('QUIEN:      Norman')
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Norman', motivo: 'conferencia de IA' })
    expect(rpcs[0].p_inventario).toMatchObject([{ id_producto: 'p-750', cantidad: 1 }])
    expect(String(c.j.mensaje)).toContain('Norman: 2 botellas (2 de 750ml)') // lo que ya hay en la vista
    const q = await llamar('proponer', { telegram_id: NORMAN, texto: 'cuántos regalos lleva Norman' })
    expect(q.j).toMatchObject({ ok: true, consulta: true })
    expect(String(q.j.texto)).toContain('2026-11-20: 2 de 750ml. Feria')
    expect((await llamar('proponer', { telegram_id: LOCAL, texto: 'regalos' })).status).toBe(403)
  })

  test('por la ruta: falta la razon -> pregunta; la respuesta en `completa` propone', async () => {
    estadoInicial()
    const a = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló 5 grandes' })
    expect(a.j).toMatchObject({ ok: false, falta: 'motivo' })
    const b = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló 5 grandes', completa: { falta: 'motivo', dicho: 'boda de Juan' } })
    expect(b.j.ok, JSON.stringify(b.j)).toBe(true)
    expect(String(b.j.mensaje)).toContain('MOTIVO:     boda de Juan')
    const bot = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló una botella en la expo' })
    expect(bot.j).toMatchObject({ ok: false, falta: 'piezas' })
  })

  test('la pagina y la vista no valuan: sin costo en ninguna parte', () => {
    expect(leer('app', 'panel', 'regalos', 'page.tsx')).not.toMatch(/mxn|A costo|a costo|g\.costo|piezasSinCosto/)
    const sql = leer('supabase', 'migrations', '20261120120000_regalos.sql')
    const vista = sql.slice(sql.indexOf('CREATE OR REPLACE VIEW public.v_regalo_lineas'))
    expect(vista).not.toMatch(/costo/i)
  })
})

// ─── 4. Cableado ────────────────────────────────────────────────────────────

const leer = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')

test.describe('regalos: cableado', () => {
  test('la accion web: sesion + rol de captura, campo por campo, entidad de la matriz (no del cliente)', () => {
    const f = leer('app', 'actions', 'regalos.ts')
    expect(f).toContain("'use server'")
    expect(f).toContain('puedeCapturarMatriz(usuario.rol)')
    expect(f).toContain('idMatriz(supabase)')
    expect(f).toContain('registrarRegalo(supabase, s, matriz.id, usuario.email)')
    expect(f).not.toContain('...solicitud')
  })

  test('el panel enlaza la pagina y la pagina usa la puerta de la matriz', () => {
    const panel = leer('app', 'panel', '_panel', 'PanelMando.tsx')
    expect(panel).toContain('`${RUTA_BASE}/regalos`')
    const pagina = leer('app', 'panel', 'regalos', 'page.tsx')
    expect(pagina).toContain('await exigirMatrizV2()')
    expect(pagina).toContain('puedeCapturarMatriz(usuario.rol)')
  })

  test('un regalo no cuenta como merma en los KPI, y se etiqueta "Regalo"', () => {
    expect(leer('lib', 'v2', 'nodo.ts')).toContain(".is('id_regalo', null)")
    expect(leer('components', 'v2', 'inventario', 'InventarioVista.tsx')).toContain("mov.tipo_movimiento === 'MERMA' && !mov.id_regalo")
    expect(leer('components', 'v2', 'inventario', 'MovimientosInventario.tsx')).toContain("mov.id_regalo ? 'Regalo'")
  })

  test('si el codigo sale ANTES que la migracion, las pantallas viejas reintentan sin id_regalo (no quedan en 0)', () => {
    expect(faltaColumnaRegalo({ message: 'column inventario_ledger.id_regalo does not exist' })).toBe(true)
    expect(faltaColumnaRegalo(new Error('getInventarioLedger: column inventario_ledger.id_regalo does not exist'))).toBe(true)
    expect(faltaColumnaRegalo({ message: 'permission denied for table inventario_ledger' })).toBe(false)
    expect(faltaColumnaRegalo(null)).toBe(false)
    for (const ruta of [['components', 'v2', 'inventario', 'InventarioVista.tsx'], ['lib', 'v2', 'nodo.ts'], ['components', 'v2', 'actividad', 'Feed.tsx']]) {
      expect(leer(...ruta), ruta.join('/')).toContain('faltaColumnaRegalo(')
    }
    expect(leer('components', 'v2', 'inventario', 'InventarioVista.tsx')).toContain("COLUMNAS_LEDGER.replace('id_regalo,', '')")
  })

  test('el panel del operador (EMPLEADO_ADMIN) tambien enlaza Regalos', () => {
    expect(leer('app', 'panel', '_panel', 'PanelOperador.tsx')).toContain('`${RUTA_BASE}/regalos`')
  })

  test('el bot de Python: patron igual al del servidor, ruta de confirmar y rama del VA', () => {
    const py = leer('bot', 'bot_gastos.py')
    expect(py).toContain('"regalo": "/api/bot/regalo/confirmar"')
    expect(py).toContain('_PATRON_REGALO = re.compile(r"\\b(regal\\w*|obsequi\\w*)\\b")')
    expect(py).toContain('if dato.get("tipo") == "regalo":\n        await _confirmar_regalo(update, chat)')
    expect(py.indexOf('_habla_de_regalo(texto) and await _proponer_regalo')).toBeLessThan(py.indexOf('_habla_de_merma(texto) and await _proponer_merma'))
    expect(py).not.toContain(String.fromCharCode(8))
  })

  test('la migracion: tabla, columna con CHECK de MERMA, RPC con el rol, vista solo ACTIVO', () => {
    const sql = leer('supabase', 'migrations', '20261120120000_regalos.sql')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.regalos/i)
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS id_regalo uuid/i)
    expect(sql).toContain("tipo_movimiento = 'MERMA'")
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.registrar_regalo/i)
    expect(sql).toContain("'ADMIN', 'EMPLEADO_ADMIN'")
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_regalo_lineas/i)
    expect(sql).toContain("status = 'ACTIVO'")
  })
})
