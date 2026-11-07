/**
 * PREGUNTAS AL ERP DESDE EL BOT (2026-11-07, Fase 2 de la paridad con la web).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio.
 *
 * - Lo puro (`lib/bot-pregunta.ts`): que pregunta es, periodo, cuenta, textos.
 * - El candado (`lib/bot-solo-lectura.ts`): ningun metodo que no sea GET/HEAD
 *   sale del cliente.
 * - La ruta (`/api/bot/pregunta`) contra un PostgREST falso: cifras de las
 *   filas, permisos de `lib/bot-permisos.ts`, y **solo GET** en la red.
 *
 * Sin red ni base: el `fetch` global se dobla.
 */

import { test, expect } from '@playwright/test'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { fechaLocal, sumarDias } from '@/lib/fechas'
import { medianocheMXaISO } from '@/lib/date-format'
import {
  clavesDeCuenta,
  cuentaNombrada,
  interpretarPregunta,
  periodoDe,
  resumenDeVentas,
  textoMovimientos,
  ticketsDelFolio,
  type CuentaDePregunta
} from '@/lib/bot-pregunta'
import { clienteDeSoloLectura, fetchDeSoloLectura } from '@/lib/bot-solo-lectura'
import type { MovimientoDinero } from '@/lib/v2/dinero'
import * as pregunta from '@/app/api/bot/pregunta/route'

const CUENTAS: CuentaDePregunta[] = [
  { id: 'c-fres', nombre: 'Cuenta Fresnillo' },
  { id: 'c-gil', nombre: 'Cuenta Gilberto' },
  { id: 'c-spin', nombre: 'Cuenta Spin' },
  { id: 'c-ef', nombre: 'Efectivo' },
  { id: 'c-tr', nombre: 'Transferencias' },
  { id: 'c-aero', nombre: 'Efectivo (Aeropuerto)' },
  { id: 'c-gf', nombre: 'Efectivo (Gilberto Franco)' }
]
const HOY_FIJO = '2026-11-07' // sabado

// ─── Lo puro ────────────────────────────────────────────────────────────────

test.describe('interpretarPregunta (pura)', () => {
  test('saldo de una cuenta por su nombre corto', () => {
    const p = interpretarPregunta('¿Cuánto hay en Spin?', CUENTAS, HOY_FIJO)
    expect(p).toEqual({ tipo: 'saldo_cuenta', cuenta: { id: 'c-spin', nombre: 'Cuenta Spin' } })
    expect(interpretarPregunta('saldo de efectivo', CUENTAS, HOY_FIJO)).toMatchObject({ tipo: 'saldo_cuenta', cuenta: { id: 'c-ef' } })
    expect(interpretarPregunta('cuanto tengo en gilberto', CUENTAS, HOY_FIJO)).toMatchObject({ cuenta: { id: 'c-gil' } })
  })

  test('la clave mas larga gana: "efectivo de aeropuerto" no es Efectivo', () => {
    expect(interpretarPregunta('cuanto hay en efectivo de aeropuerto', CUENTAS, HOY_FIJO)).toMatchObject({ cuenta: { id: 'c-aero' } })
    expect(clavesDeCuenta('Efectivo (Aeropuerto)')).toEqual(expect.arrayContaining(['efectivo aeropuerto', 'efectivo de aeropuerto']))
    expect(clavesDeCuenta('Efectivo (Aeropuerto)')).not.toContain('aeropuerto')
  })

  test('"cuanto debe Aeropuerto" NO es saldo de cuenta (es cartera, la contesta /consulta)', () => {
    expect(interpretarPregunta('cuanto debe Aeropuerto', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
  })

  test('stock no se lo roba: "cuantas botellas de 750 hay" y "cuanto hay de chile"', () => {
    expect(interpretarPregunta('¿cuántas botellas de 750 hay?', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
    expect(interpretarPregunta('cuanto hay de chile guajillo', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
  })

  test('saldos de todas las cuentas', () => {
    expect(interpretarPregunta('saldos', CUENTAS, HOY_FIJO)).toEqual({ tipo: 'saldos' })
    expect(interpretarPregunta('¿cuánto dinero hay?', CUENTAS, HOY_FIJO)).toEqual({ tipo: 'saldos' })
  })

  test('movimientos de una cuenta con periodo, y sin periodo = 7 dias dicho', () => {
    expect(interpretarPregunta('movimientos de Efectivo de ayer', CUENTAS, HOY_FIJO)).toEqual({
      tipo: 'movimientos_cuenta',
      cuenta: { id: 'c-ef', nombre: 'Efectivo' },
      periodo: { etiqueta: 'ayer (06/11/2026)', desde: '2026-11-06', hasta: '2026-11-06' },
      periodoDicho: true
    })
    expect(interpretarPregunta('que entro a spin', CUENTAS, HOY_FIJO)).toMatchObject({
      tipo: 'movimientos_cuenta',
      periodo: { desde: '2026-11-01', hasta: HOY_FIJO },
      periodoDicho: false
    })
    expect(interpretarPregunta('movimientos de ayer', CUENTAS, HOY_FIJO)).toMatchObject({ tipo: 'ninguna', motivo: 'falta_cuenta' })
  })

  test('ventas de un periodo; "ventas" a secas se queda en la consulta mensual', () => {
    expect(interpretarPregunta('ventas de la semana', CUENTAS, HOY_FIJO)).toEqual({
      tipo: 'ventas_periodo',
      periodo: { etiqueta: 'esta semana', desde: '2026-11-02', hasta: HOY_FIJO }
    })
    expect(interpretarPregunta('cuanto vendimos el mes pasado', CUENTAS, HOY_FIJO)).toMatchObject({
      periodo: { desde: '2026-10-01', hasta: '2026-10-31' }
    })
    expect(interpretarPregunta('ventas', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
  })

  test('detalle de ticket: palabra + folio de 8; sin la palabra no', () => {
    expect(interpretarPregunta('detalle del ticket 1a2b3c4d', CUENTAS, HOY_FIJO)).toEqual({ tipo: 'detalle_ticket', folio: '1A2B3C4D' })
    expect(interpretarPregunta('que trae el TCK-ABCD1234', CUENTAS, HOY_FIJO)).toEqual({ tipo: 'detalle_ticket', folio: 'ABCD1234' })
    expect(interpretarPregunta('12345678', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
  })

  test('lo desconocido no se adivina', () => {
    expect(interpretarPregunta('¿quién ganó el partido?', CUENTAS, HOY_FIJO)).toEqual({ tipo: 'ninguna', motivo: 'no_reconocida' })
    expect(interpretarPregunta('', CUENTAS, HOY_FIJO).tipo).toBe('ninguna')
  })

  test('cuenta ambigua: lo dice, no escoge', () => {
    const dos = [{ id: 'a', nombre: 'Cuenta Spin' }, { id: 'b', nombre: 'Spin' }]
    expect(cuentaNombrada('saldo de spin', dos)).toEqual({ ambiguas: dos })
    expect(interpretarPregunta('saldo de spin', dos, HOY_FIJO)).toMatchObject({ tipo: 'ninguna', motivo: 'cuenta_ambigua' })
  })

  test('periodos: semana pasada, antier, ultimos N dias, mes', () => {
    expect(periodoDe('la semana pasada', HOY_FIJO)).toMatchObject({ desde: '2026-10-26', hasta: '2026-11-01' })
    expect(periodoDe('antier', HOY_FIJO)).toMatchObject({ desde: '2026-11-05', hasta: '2026-11-05' })
    expect(periodoDe('ultimos 3 dias', HOY_FIJO)).toMatchObject({ desde: '2026-11-05', hasta: HOY_FIJO })
    expect(periodoDe('este mes', HOY_FIJO)).toMatchObject({ desde: '2026-11-01', hasta: HOY_FIJO })
    expect(periodoDe('nada', HOY_FIJO)).toBeNull()
  })

  test('movimientos con la regla de saldo_cuenta: anulado y ABONO_PENDIENTE no cuentan', () => {
    const base = { categoria: null, subcategoria: null, categoria_gasto: null, id_entidad_relacionada: null, usuario_creador: null }
    const movs: MovimientoDinero[] = [
      { ...base, id: '1', tipo_movimiento: 'INGRESO_VENTA', monto: 500, status: 'ACTIVO', descripcion: 'venta', fecha_movimiento: '2026-11-06T18:00:00Z', id_cuenta_origen: null, id_cuenta_destino: 'c-ef' },
      { ...base, id: '2', tipo_movimiento: 'GASTO_OPERATIVO', monto: 120, status: 'ACTIVO', descripcion: 'gasolina', fecha_movimiento: '2026-11-06T19:00:00Z', id_cuenta_origen: null, id_cuenta_destino: 'c-ef' },
      { ...base, id: '3', tipo_movimiento: 'GASTO_OPERATIVO', monto: 999, status: 'ANULADO', descripcion: 'anulado', fecha_movimiento: '2026-11-06T19:30:00Z', id_cuenta_origen: null, id_cuenta_destino: 'c-ef' },
      { ...base, id: '4', tipo_movimiento: 'ABONO_DEUDA', monto: 777, status: 'ACTIVO', categoria: 'ABONO_PENDIENTE', descripcion: 'pendiente', fecha_movimiento: '2026-11-06T20:00:00Z', id_cuenta_origen: null, id_cuenta_destino: 'c-ef' }
    ]
    const t = textoMovimientos({ id: 'c-ef', nombre: 'Efectivo' }, { etiqueta: 'ayer', desde: '2026-11-06', hasta: '2026-11-06' }, movs)
    expect(t).toContain('ENTRO: $500.00   SALIO: $120.00   NETO: $380.00   (2 movimientos)')
    expect(t).not.toContain('anulado')
    expect(t).not.toContain('pendiente')
  })

  test('ventas: solo ACTIVO, contado y concesion por separado (regla de v_ventas_por_mes)', () => {
    const r = resumenDeVentas([
      { id: 'a', fecha_transaccion: null, total_cobrado_real: 100, condicion_pago: 'CONTADO', status: 'ACTIVO', id_comprador: 'x' },
      { id: 'b', fecha_transaccion: null, total_cobrado_real: 300, condicion_pago: 'CONCESION', status: 'ACTIVO', id_comprador: 'y' },
      { id: 'c', fecha_transaccion: null, total_cobrado_real: 50, condicion_pago: 'CONTADO', status: 'ANULADO', id_comprador: 'x' }
    ])
    expect(r).toEqual({ tickets: 2, vendido: 400, contado: 100, concesion: 300, ticketsConcesion: 1, compradores: 2 })
    expect(ticketsDelFolio('ABCD1234', [{ id: 'abcd1234-0000' }, { id: 'abcd9999-0000' }])).toEqual([{ id: 'abcd1234-0000' }])
  })
})

// ─── El candado ─────────────────────────────────────────────────────────────

test.describe('fetchDeSoloLectura', () => {
  test('GET y HEAD salen; POST, PATCH, DELETE no llegan a la red', async () => {
    const salieron: string[] = []
    const base = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      salieron.push((init?.method ?? 'GET').toUpperCase())
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const f = fetchDeSoloLectura(base)
    for (const m of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT']) {
      const r = await f('http://x/rest/v1/t', { method: m })
      expect(r.status, m).toBe(m === 'GET' || m === 'HEAD' ? 200 : 405)
    }
    expect(salieron).toEqual(['GET', 'HEAD'])
  })

  test('el cliente de supabase con el candado: insert, update, delete y rpc por POST fallan sin salir', async () => {
    const env = { u: process.env.NEXT_PUBLIC_SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY }
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-key'
    try {
      const salieron: string[] = []
      const base = (async (u: RequestInfo | URL, init?: RequestInit) => {
        salieron.push(`${(init?.method ?? 'GET').toUpperCase()} ${String(u)}`)
        return new Response('3.5', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch
      const c = clienteDeSoloLectura(base)
      const ins = await c.from('finanzas_ledger').insert({ monto: 1 } as never)
      const upd = await c.from('finanzas_ledger').update({ monto: 1 } as never).eq('id', 'x')
      const del = await c.from('finanzas_ledger').delete().eq('id', 'x')
      const rpcPost = await c.rpc('saldo_cuenta', { p_id_cuenta: 'c' })
      for (const r of [ins, upd, del, rpcPost]) expect(r.error?.code).toBe('SOLO_LECTURA')
      expect(salieron).toEqual([])
      const rpcGet = await c.rpc('saldo_cuenta', { p_id_cuenta: 'c' }, { get: true })
      expect(rpcGet.data).toBe(3.5)
      expect(salieron).toHaveLength(1)
      expect(salieron[0]).toMatch(/^GET .*rpc\/saldo_cuenta\?p_id_cuenta=c/)
    } finally {
      if (env.u === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
      else process.env.NEXT_PUBLIC_SUPABASE_URL = env.u
      if (env.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
      else process.env.SUPABASE_SERVICE_ROLE_KEY = env.k
    }
  })
})

// ─── La ruta contra un PostgREST falso ──────────────────────────────────────

const TOKEN = 'p'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const LOCAL = 333
const GRUPO = -100555

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let saldos: Record<string, number> = {}
let peticiones: string[] = []

const HOY = fechaLocal(new Date())
const AYER = sumarDias(HOY, -1)
const HACE_10 = sumarDias(HOY, -10)
/** Mediodia de Mexico de un dia: cae en ese dia en cualquier zona. */
const mediodia = (d: string) => new Date(Date.parse(medianocheMXaISO(d) as string) + 12 * 3600 * 1000).toISOString()

function estadoInicial() {
  const mov = (id: string, tipo: string, monto: number, dia: string, destino: string, extra: Fila = {}) => ({
    id, tipo_movimiento: tipo, monto, status: 'ACTIVO', categoria: null, subcategoria: null, categoria_gasto: null,
    descripcion: `mov ${id}`, fecha_movimiento: mediodia(dia), id_cuenta_origen: null, id_cuenta_destino: destino,
    id_entidad_relacionada: null, usuario_creador: 'telegram:norman', ...extra
  })
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'CEO Admin', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
      { id: 'ent-aero', nombre: 'Aeropuerto', rol: 'LOC', id_padre: null, id_nodo_padre: null }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false },
      { telegram_id: LOCAL, etiqueta: 'aero', id_entidad: 'ent-aero', id_cuenta_destino: 'c-aero', activo: true, requiere_aprobacion: false }
    ],
    cuentas_financieras: [
      { id: 'c-ef', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-spin', id_entidad: 'ent-matriz', nombre: 'Cuenta Spin', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-aero', id_entidad: 'ent-aero', nombre: 'Efectivo (Aeropuerto)', tipo_fiscalidad: 'LIBRE' }
    ],
    finanzas_ledger: [
      mov('m1', 'INGRESO_VENTA', 500, AYER, 'c-ef'),
      mov('m2', 'GASTO_OPERATIVO', 120, AYER, 'c-ef'),
      mov('m3', 'GASTO_OPERATIVO', 999, AYER, 'c-ef', { status: 'ANULADO' }),
      mov('m4', 'INGRESO_VENTA', 70, HACE_10, 'c-ef'),
      mov('m5', 'INGRESO_VENTA', 40, AYER, 'c-spin')
    ],
    transacciones_tickets: [
      { id: 'abcd1234-1111-4111-8111-111111111111', fecha_transaccion: mediodia(HOY), total_cobrado_real: 650, condicion_pago: 'CONTADO', status: 'ACTIVO', id_comprador: 'ent-aero', id_vendedor: 'ent-matriz', usuario_creador: 'telegram:norman' },
      { id: 'ffff0000-1111-4111-8111-111111111111', fecha_transaccion: mediodia(HOY), total_cobrado_real: 1300, condicion_pago: 'CONCESION', status: 'ACTIVO', id_comprador: 'ent-aero', id_vendedor: 'ent-matriz', usuario_creador: null },
      { id: 'eeee0000-1111-4111-8111-111111111111', fecha_transaccion: mediodia(HOY), total_cobrado_real: 9999, condicion_pago: 'CONTADO', status: 'ANULADO', id_comprador: 'ent-aero', id_vendedor: 'ent-matriz', usuario_creador: null },
      { id: 'dddd0000-1111-4111-8111-111111111111', fecha_transaccion: mediodia(sumarDias(HOY, -40)), total_cobrado_real: 5000, condicion_pago: 'CONTADO', status: 'ACTIVO', id_comprador: 'ent-aero', id_vendedor: 'ent-matriz', usuario_creador: null }
    ],
    ticket_detalles: [
      { id: 'd1', id_ticket: 'abcd1234-1111-4111-8111-111111111111', id_producto: 'p-750', cantidad: 2, precio_unitario: 325, subtotal_linea: 650 }
    ],
    catalogo_productos: [{ id: 'p-750', nombre: 'Destilado 750 ml', tipo: 'TERMINADO' }]
  }
  saldos = { 'c-ef': 380, 'c-spin': 300, 'c-aero': 15 }
  peticiones = []
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = decodeURIComponent(expr.slice(i + 1)).replace(/^"|"$/g, '')
  const actual = fila[col]
  if (op === 'eq') return String(actual) === val
  if (op === 'gte') return String(actual) >= val
  if (op === 'lt') return actual !== null && actual !== undefined && String(actual) < val
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
  if (tabla === 'rpc/saldo_cuenta') {
    const id = u.searchParams.get('p_id_cuenta') ?? ''
    return json(id in saldos ? saldos[id] : null)
  }
  const filas = filtrar(tabla, u.searchParams)
  const objeto = (new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object')
  if (objeto) return filas.length === 1 ? json(filas[0]) : filas.length === 0 ? json(null) : json({ code: 'PGRST116' }, 406)
  return json(filas)
}

const fetchOriginal = globalThis.fetch

async function preguntar(texto: string, telegramId = NORMAN, chatId?: number) {
  const req = new Request('http://localhost/api/bot/pregunta', {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ telegram_id: telegramId, chat_id: chatId, texto })
  })
  const r = await pregunta.POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}

test.describe('/api/bot/pregunta (PostgREST falso)', () => {
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

  test('sin token: 401', async () => {
    const r = await pregunta.POST(new Request('http://localhost/api/bot/pregunta', { method: 'POST', body: '{}' }))
    expect(r.status).toBe(401)
  })

  test('"¿cuanto hay en Spin?" -> el numero de saldo_cuenta, por GET', async () => {
    const { status, j } = await preguntar('¿Cuánto hay en Spin?')
    expect(status).toBe(200)
    expect(j.reconocida).toBe(true)
    expect(String(j.texto)).toContain('Cuenta Spin: $300.00')
    expect(String(j.texto)).toContain('(de saldo_cuenta()')
    expect(peticiones).toContain('GET rpc/saldo_cuenta')
    soloGet()
  })

  test('"saldos" -> las cuentas de SU entidad, con total; no la de Aeropuerto', async () => {
    const { j } = await preguntar('saldos')
    expect(String(j.texto)).toContain('Efectivo: $380.00')
    expect(String(j.texto)).toContain('Cuenta Spin: $300.00')
    expect(String(j.texto)).toContain('TOTAL: $680.00')
    expect(String(j.texto)).not.toContain('Aeropuerto')
    soloGet()
  })

  test('"movimientos de Efectivo de ayer" -> solo ayer, solo esa cuenta, sin el anulado', async () => {
    const { j } = await preguntar('movimientos de Efectivo de ayer')
    const t = String(j.texto)
    expect(t).toContain('+$500.00')
    expect(t).toContain('-$120.00')
    expect(t).toContain('ENTRO: $500.00   SALIO: $120.00   NETO: $380.00   (2 movimientos)')
    expect(t).not.toContain('999')
    expect(t).not.toContain('$70.00')
    expect(t).not.toContain('$40.00')
    soloGet()
  })

  test('"ventas de hoy" -> tickets ACTIVO de hoy, contado y concesion', async () => {
    const { j } = await preguntar('ventas de hoy')
    const t = String(j.texto)
    expect(t).toContain('Vendido: $1,950.00 en 2 tickets, 1 comprador')
    expect(t).toContain('contado: $650.00')
    expect(t).toContain('concesion: $1,300.00 (1 ticket)')
    soloGet()
  })

  test('"detalle del ticket ABCD1234" -> renglones, nombres y total', async () => {
    const { j } = await preguntar('detalle del ticket ABCD1234')
    const t = String(j.texto)
    expect(t).toContain('TICKET ABCD1234')
    expect(t).toContain('Vende: CEO Admin   Compra: Aeropuerto')
    expect(t).toContain('2 x Destilado 750 ml a $325.00 = $650.00')
    expect(t).toContain('TOTAL COBRADO: $650.00')
    soloGet()
  })

  test('folio que no existe: lo dice', async () => {
    const { j } = await preguntar('ticket 99999999')
    expect(String(j.texto)).toContain('No encuentro ningun ticket con folio 99999999')
  })

  test('lo que no reconoce: reconocida false y "no la puedo contestar con certeza", sin cifras', async () => {
    const { status, j } = await preguntar('¿quién ganó el partido?')
    expect(status).toBe(200)
    expect(j.reconocida).toBe(false)
    expect(String(j.texto)).toContain('no la puedo contestar con certeza')
    expect(String(j.texto)).not.toMatch(/\$\d/)
  })

  test('un LOC no ve saldos de cuentas: 403 (bot-permisos: gastos es de la matriz)', async () => {
    const { status } = await preguntar('cuanto hay en efectivo de aeropuerto', LOCAL)
    expect(status).toBe(403)
    expect(peticiones).not.toContain('GET rpc/saldo_cuenta')
  })

  test('un LOC no ve ventas ni tickets: 403', async () => {
    expect((await preguntar('ventas de hoy', LOCAL)).status).toBe(403)
    expect((await preguntar('detalle del ticket ABCD1234', LOCAL)).status).toBe(403)
  })

  test('quien no esta dado de alta: 403', async () => {
    expect((await preguntar('saldos', 999999)).status).toBe(403)
  })

  test('en un grupo, la cifra va por privado', async () => {
    const { j } = await preguntar('cuanto hay en spin', NORMAN, GRUPO)
    expect(j.privado).toBe(true)
    const enPrivado = await preguntar('cuanto hay en spin', NORMAN, NORMAN)
    expect(enPrivado.j.privado).toBe(false)
  })
})
