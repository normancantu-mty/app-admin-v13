/**
 * ESTADO DE CUENTA EN IMAGEN (2026-11-23). Escrito por un ejecutor del Socio.
 *
 * - Lo puro (`lib/bot-estado-cuenta.ts`) con las filas reales de Rey Tiburon y
 *   Aeropuerto leidas por SELECT el 2026-11-23 (`tests/fixtures/estado_cuenta.json`).
 * - La ruta contra un PostgREST falso: permisos, ambiguos, y que solo salga GET.
 * - El contrato con el bot: lo que devuelve el servidor es EXACTAMENTE lo que
 *   `bot/fixtures/estado_cuenta_*.json` le da a `bot/probar_estado_cuenta.py`.
 *   Se regenera con `ESTADO_CUENTA_REGENERAR=1`.
 * - Con `ESTADO_CUENTA_DATOS=<ruta>` cuadra ademas a TODOS los clientes de ese
 *   volcado (que no vive en el repo: son datos del negocio).
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import {
  armarEstadoDeCuenta,
  quienEs,
  type DetalleDeEstado,
  type DineroDeEstado,
  type PiezasDeEstado,
  type TicketDeEstado
} from '@/lib/bot-estado-cuenta'
import type { EntidadDePregunta, ProductoDePregunta } from '@/lib/bot-pregunta-erp'
import type { FilaCarteraVista } from '@/lib/vistas'
import * as ruta from '@/app/api/bot/estado-cuenta/route'

interface Datos {
  entidades: EntidadDePregunta[]
  productos: ProductoDePregunta[]
  cartera: FilaCarteraVista[]
  tickets: (TicketDeEstado & { id_comprador: string })[]
  detalles: DetalleDeEstado[]
  dinero: (DineroDeEstado & { id_entidad_relacionada: string })[]
  piezas: PiezasDeEstado[]
}
const leer = (r: string) => JSON.parse(fs.readFileSync(r, 'utf8')) as Datos
const REALES = leer(path.join(__dirname, 'fixtures', 'estado_cuenta.json'))
const clonar = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

function armar(nombre: string, d: Datos = REALES, hoy = '2026-11-23') {
  const cliente = d.entidades.find((e) => e.nombre === nombre)!
  const fila = d.cartera.find((f) => f.id_entidad === cliente.id)!
  const acreedor = fila.id_acreedor ? d.entidades.find((e) => e.id === fila.id_acreedor)!.nombre : null
  return armarEstadoDeCuenta({
    cliente, fila, acreedor, hoy, productos: d.productos,
    tickets: d.tickets.filter((t) => t.id_comprador === cliente.id),
    detalles: d.detalles,
    dinero: d.dinero.filter((m) => m.id_entidad_relacionada === cliente.id),
    piezas: d.piezas.filter((p) => p.id_entidad_destino === cliente.id || p.id_entidad_origen === cliente.id)
  })
}
const ok = (r: ReturnType<typeof armar>) => {
  expect(r.cuadra).toBe(true)
  if (!r.cuadra) throw new Error(r.motivo)
  return r.estado
}

test.describe('estado de cuenta: lo puro', () => {
  test('Rey Tiburon: 3,568.00, 18 piezas (5/5/8), sin abonos, y nada de la venta hecha a mano', () => {
    const e = ok(armar('Rey Tiburon'))
    expect(e.saldo).toBe(3568)
    expect(e.movimientos).toHaveLength(1)
    const [m] = e.movimientos
    expect(m.fecha).toBe('27 oct 2026') // 05:59Z del 28 es el 27 en Mexico
    expect(m.concepto).toBe('Saldo inicial')
    expect(m.piezas.map((p) => [p.presentacion, p.cantidad, p.precio, p.importe])).toEqual([
      ['750 ml', 5, 480, 2400],
      ['250 ml', 5, 144, 720],
      ['50 ml', 8, 56, 448]
    ])
    expect(e.resumen).toEqual({ inicial: 3568, entregas: 0, otros_cargos: 0, abonos: 0, piezas: 18, saldo: 3568 })
    expect(e.notas).toEqual([])
    expect(JSON.stringify(e)).not.toContain('1200')
  })

  test('Aeropuerto: 18,416.00 con sus cuatro movimientos, en orden y con saldo corrido', () => {
    const e = ok(armar('Aeropuerto'))
    expect(e.movimientos.map((m) => [m.fecha, m.concepto, m.detalle, m.importe, m.saldo, m.total_piezas])).toEqual([
      ['27 oct 2026', 'Saldo inicial', 'Registrado en el sistema a esa fecha', 7000, 7000, 38],
      ['4 nov 2026', 'Entrega de mercancía', 'Folio FCB165BF', 8256, 15256, 68],
      ['5 nov 2026', 'Abono en efectivo', '', -5000, 10256, 0],
      ['23 nov 2026', 'Entrega de mercancía', 'Folio 07B702F5', 8160, 18416, 36]
    ])
    expect(e.resumen).toEqual({ inicial: 7000, entregas: 16416, otros_cargos: 0, abonos: 5000, piezas: 142, saldo: 18416 })
    expect(e.corte).toBe('23 de noviembre de 2026')
  })

  test('no cuadra con v_cartera por un centavo: no hay estado', () => {
    const d = clonar(REALES)
    d.cartera.find((f) => f.nombre === 'Rey Tiburon')!.deuda = 3568.01
    const r = armar('Rey Tiburon', d)
    expect(r.cuadra).toBe(false)
    if (!r.cuadra) expect([r.saldoCalculado, r.deudaCartera]).toEqual([3568, 3568.01])
  })

  test('no inventa: si el desglose no da el importe van las piezas SIN precio, y se dice', () => {
    const d = clonar(REALES)
    d.dinero.find((m) => m.monto === 3568)!.monto = 4000
    d.cartera.find((f) => f.nombre === 'Rey Tiburon')!.deuda = 4000
    const e = ok(armar('Rey Tiburon', d))
    expect(e.movimientos[0].piezas.map((p) => p.precio)).toEqual([null, null, null])
    expect(e.movimientos[0].total_piezas).toBe(18)
    expect(e.notas.join(' ')).toContain('Sin precio por pieza')
  })

  test('a un movimiento sin fecha o sin monto no se le inventa: no cuadra', () => {
    const sinFecha = clonar(REALES)
    sinFecha.dinero.find((m) => m.monto === 3568)!.fecha_movimiento = null
    expect(armar('Rey Tiburon', sinFecha).cuadra).toBe(false)
    const sinMonto = clonar(REALES)
    sinMonto.dinero.find((m) => m.monto === 3568)!.monto = null
    expect(armar('Rey Tiburon', sinMonto).cuadra).toBe(false)
  })

  test('anulados, entregas de efectivo y abonos pendientes no mueven el saldo; el pendiente se dice', () => {
    const d = clonar(REALES)
    const id = d.entidades.find((e) => e.nombre === 'Rey Tiburon')!.id
    const base = { id_entidad_relacionada: id, fecha_movimiento: '2026-11-20T18:00:00Z', tipo_movimiento: 'ABONO_DEUDA', metodo_pago: 'EFECTIVO' }
    d.dinero.push(
      { ...base, id: 'x1', monto: 100, categoria: 'ABONO_REAL', status: 'ANULADO', es_entrega_efectivo: false },
      { ...base, id: 'x2', monto: 200, categoria: 'ABONO_REAL', status: 'ACTIVO', es_entrega_efectivo: true },
      { ...base, id: 'x3', monto: 300, categoria: 'ABONO_PENDIENTE', status: 'ACTIVO', es_entrega_efectivo: false }
    )
    const e = ok(armar('Rey Tiburon', d))
    expect(e.movimientos).toHaveLength(1)
    expect(e.notas.join(' ')).toContain('Abono pendiente de confirmar: $300.00')
  })

  test('un ticket de contado no suma y se dice', () => {
    const d = clonar(REALES)
    const id = d.entidades.find((e) => e.nombre === 'Rey Tiburon')!.id
    d.tickets.push({ id: 'aaaaaaaa-0000-4000-8000-000000000000', id_comprador: id, fecha_transaccion: '2026-11-20T18:00:00Z', total_cobrado_real: 1200, monto_base_ingreso: 1200, condicion_pago: 'CONTADO', status: 'ACTIVO' })
    const e = ok(armar('Rey Tiburon', d))
    expect(e.saldo).toBe(3568)
    expect(e.notas.join(' ')).toContain('1 compra de contado')
  })

  test('a un DST le cuenta monto_base_ingreso, como v_cartera', () => {
    const d = clonar(REALES)
    const aero = d.entidades.find((e) => e.nombre === 'Aeropuerto')!
    aero.rol = 'DST'
    d.tickets.forEach((t) => (t.monto_base_ingreso = Number(t.total_cobrado_real) - 1))
    const f = d.cartera.find((x) => x.nombre === 'Aeropuerto')!
    f.deuda = 18416 - 2
    expect(ok(armar('Aeropuerto', d)).saldo).toBe(18414)
  })

  test('volcado completo (ESTADO_CUENTA_DATOS): todos cuadran con v_cartera', () => {
    const r = process.env.ESTADO_CUENTA_DATOS
    test.skip(!r, 'sin ESTADO_CUENTA_DATOS')
    const d = leer(r as string)
    const filas = d.cartera.map((f) => {
      const x = armar(f.nombre as string, d)
      return [f.nombre, x.cuadra, x.cuadra ? x.estado.saldo : null, Number(f.deuda)]
    })
    console.log(filas.map((x) => x.join(' | ')).join('\n'))
    expect(filas.length).toBeGreaterThan(0)
    for (const [n, cuadra, saldo, deuda] of filas) expect([n, cuadra, saldo]).toEqual([n, true, deuda])
  })
})

test.describe('estado de cuenta: de quien', () => {
  const ENT: EntidadDePregunta[] = [
    ...REALES.entidades,
    { id: 'd1', nombre: 'Dulceria el Eden', rol: 'LOC' },
    { id: 'd2', nombre: 'Dulceria ruiz', rol: 'LOC' },
    { id: 'g', nombre: 'Gilberto Franco', rol: 'DST' },
    { id: 'n', nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' },
    { id: 'm', nombre: 'CEO Admin', rol: 'ADMIN' }
  ]
  const CTAS = [
    { id: 'c1', nombre: 'Efectivo' },
    { id: 'c2', nombre: 'Efectivo (Aeropuerto)' },
    { id: 'c3', nombre: 'Cuenta Spin' },
    { id: 'c4', nombre: 'Cuenta Gilberto' },
    { id: 'c5', nombre: 'Cuenta Fresnillo' }
  ]
  const de = (t: string) => {
    const q = quienEs(t, ENT, CTAS)
    return q.tipo === 'cliente' ? q.cliente.nombre : q.tipo === 'ambiguo' ? `ambiguo: ${q.candidatos.map((c) => c.nombre).join(', ')}` : q.tipo
  }
  for (const [frase, esperado] of [
    ['Dame el ticket de los movimientos que se han hecho en el Rey Tiburón', 'Rey Tiburon'],
    ['mándame el estado de cuenta del Aeropuerto', 'Aeropuerto'],
    ['estado de cuenta rey tiburon', 'Rey Tiburon'],
    ['estado de cuenta de Gilberto Franco', 'Gilberto Franco'],
    ['estado de cuenta de Gilberto', 'ambiguo: Gilberto Franco'],
    ['estado de cuenta de la dulcería', 'ambiguo: Dulceria el Eden, Dulceria ruiz'],
    ['estado de cuenta de Spin', 'cuenta'],
    ['estado de cuenta de efectivo de aeropuerto', 'cuenta'],
    ['estado de cuenta fresnillo', 'cuenta'],
    ['estado de cuenta de Juan Perez', 'no_encontrado'],
    ['estado de cuenta', 'no_encontrado'],
    ['ticket de los movimientos pendiente', 'no_encontrado']
  ] as const) {
    test(`"${frase}" -> ${esperado}`, () => expect(de(frase)).toBe(esperado))
  }
})

// ─── La ruta contra un PostgREST falso ──────────────────────────────────────

const TOKEN = 'e'.repeat(32)
const ENTORNO: Record<string, string> = { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-key', BOT_API_TOKEN: TOKEN }
const entornoOriginal: Record<string, string | undefined> = {}
const fetchOriginal = globalThis.fetch
type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let peticiones: string[] = []
const LOCAL = 333
const GRUPO = -5589123471

function cumple(f: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = expr.slice(i + 1)
  const a = f[col]
  if (op === 'eq') return String(a) === val
  if (op === 'neq') return a !== null && a !== undefined && String(a) !== val
  if (op === 'is') return a === null || a === undefined
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(a))
  throw new Error(`el doble no entiende ${col}=${expr}`)
}

function responder(url: string, init?: RequestInit): Response {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  peticiones.push(`${metodo} ${tabla}`)
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of u.searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(col)) continue
    if (col === 'or') {
      const partes = expr.replace(/^\(|\)$/g, '').split(',')
      filas = filas.filter((f) => partes.some((p) => cumple(f, p.slice(0, p.indexOf('.')), p.slice(p.indexOf('.') + 1))))
    } else filas = filas.filter((f) => cumple(f, col, expr))
  }
  const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } })
  if ((new Headers(init?.headers).get('accept') ?? '').includes('vnd.pgrst.object')) return json(filas[0] ?? null)
  return json(filas)
}

async function pedir(cuerpo: Fila, quien: number = NORMAN_TELEGRAM_ID, token = TOKEN) {
  const r = await ruta.POST(
    new Request('http://localhost/api/bot/estado-cuenta', {
      method: 'POST',
      headers: { 'x-bot-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ telegram_id: quien, ...cuerpo })
    })
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, j: (await r.json()) as any }
}

test.describe('/api/bot/estado-cuenta (PostgREST falso)', () => {
  test.describe.configure({ mode: 'serial' })
  test.beforeAll(() => {
    for (const [k, v] of Object.entries(ENTORNO)) {
      entornoOriginal[k] = process.env[k]
      process.env[k] = v
    }
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => responder(String(i instanceof Request ? i.url : i), init)) as typeof fetch
  })
  test.afterAll(() => {
    globalThis.fetch = fetchOriginal
    for (const [k, v] of Object.entries(entornoOriginal)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  test.beforeEach(() => {
    const d = clonar(REALES)
    const aero = d.entidades.find((e) => e.nombre === 'Aeropuerto')!.id
    tablas = {
      entidades: [
        ...(d.entidades as unknown as Fila[]),
        { id: 'matriz', nombre: 'CEO Admin', rol: 'ADMIN' },
        { id: 'd1', nombre: 'Dulceria el Eden', rol: 'LOC' },
        { id: 'd2', nombre: 'Dulceria ruiz', rol: 'LOC' }
      ].map((e) => ({ ...e, id_padre: null, id_nodo_padre: null })),
      bot_identidades: [
        { telegram_id: NORMAN_TELEGRAM_ID, etiqueta: 'norman', id_entidad: 'matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false },
        { telegram_id: LOCAL, etiqueta: 'aero', id_entidad: aero, id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false }
      ],
      cuentas_financieras: [{ id: 'c-ef', id_entidad: 'matriz', nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' }, { id: 'c-spin', id_entidad: 'matriz', nombre: 'Cuenta Spin', tipo_fiscalidad: 'LIBRE' }],
      catalogo_productos: d.productos as unknown as Fila[],
      v_cartera: d.cartera as unknown as Fila[],
      transacciones_tickets: d.tickets as unknown as Fila[],
      ticket_detalles: d.detalles as unknown as Fila[],
      finanzas_ledger: d.dinero as unknown as Fila[],
      inventario_ledger: d.piezas as unknown as Fila[]
    }
    peticiones = []
  })
  test.afterEach(() => expect(peticiones.filter((p) => !p.startsWith('GET '))).toEqual([]))

  for (const [frase, nombre, archivo] of [
    ['Dame el ticket de los movimientos que se han hecho en el Rey Tiburón', 'Rey Tiburon', 'estado_cuenta_rey_tiburon.json'],
    ['Pásame el estado de cuenta del Aeropuerto', 'Aeropuerto', 'estado_cuenta_aeropuerto.json']
  ] as const) {
    test(`${nombre}: lo que sale de la ruta es el contrato del bot`, async () => {
      const { status, j } = await pedir({ texto: frase })
      expect(status).toBe(200)
      expect(j.reconocida).toBe(true)
      expect(j.privado).toBe(false)
      const cartera = REALES.cartera.find((f) => f.nombre === nombre)!
      expect(j.estado.saldo).toBe(Number(cartera.deuda))
      expect(j.estado.movimientos.at(-1).saldo).toBe(Number(cartera.deuda))
      // El corte es "hoy": se fija para que el fixture no caduque cada dia.
      const fijo = { ...j, estado: { ...j.estado, corte: '23 de noviembre de 2026' } }
      fijo.texto = String(j.texto).replace(j.estado.corte, '23 de noviembre de 2026')
      const r = path.join(__dirname, '..', 'bot', 'fixtures', archivo)
      if (process.env.ESTADO_CUENTA_REGENERAR) fs.writeFileSync(r, JSON.stringify(fijo, null, 1) + '\n')
      expect(fijo).toEqual(JSON.parse(fs.readFileSync(r, 'utf8')))
    })
  }

  test('en grupo el servidor sigue marcando privado (D96): el bot decide donde', async () => {
    expect((await pedir({ texto: 'estado de cuenta de aeropuerto', chat_id: GRUPO })).j.privado).toBe(true)
  })
  test('el boton (id_entidad) contesta sin volver a leer el texto', async () => {
    const id = REALES.entidades.find((e) => e.nombre === 'Rey Tiburon')!.id
    expect((await pedir({ id_entidad: id })).j.estado.cliente).toBe('Rey Tiburon')
    expect((await pedir({ id_entidad: 'matriz' })).status).toBe(422)
  })
  test('ambiguo: opciones y sin estado', async () => {
    const { j } = await pedir({ texto: 'estado de cuenta de la dulceria' })
    expect(j.opciones.map((o: { nombre: string }) => o.nombre)).toEqual(['Dulceria el Eden', 'Dulceria ruiz'])
    expect(j.estado).toBeUndefined()
  })
  test('no encontrado, sin cartera, no cuadra: texto y sin estado', async () => {
    for (const [t, motivo] of [['estado de cuenta de Juan Perez', 'cliente_no_encontrado'], ['estado de cuenta de Dulceria ruiz', 'sin_cartera']] as const) {
      const { j } = await pedir({ texto: t })
      expect([j.motivo, j.estado]).toEqual([motivo, undefined])
    }
    tablas.v_cartera = tablas.v_cartera.map((f) => ({ ...f, deuda: 4768 })) // los 1,200 de mas
    const { j } = await pedir({ texto: 'estado de cuenta del rey tiburon' })
    expect(j.motivo).toBe('no_cuadra')
    expect(j.estado).toBeUndefined()
    expect(j.texto).toContain('$3,568.00')
    expect(j.texto).toContain('$4,768.00')
  })
  test('una cuenta de dinero no es un cliente: reconocida false', async () => {
    expect((await pedir({ texto: 'estado de cuenta de Spin' })).j).toMatchObject({ ok: true, reconocida: false })
  })
  test('permisos: sin token 401, sin alta 403, un LOC no gana nada (reconocida false, sin leer la cartera)', async () => {
    expect((await pedir({ texto: 'estado de cuenta de aeropuerto' }, NORMAN_TELEGRAM_ID, 'x'.repeat(32))).status).toBe(401)
    expect((await pedir({ texto: 'estado de cuenta de aeropuerto' }, 987654)).status).toBe(403)
    peticiones = []
    const { j } = await pedir({ texto: 'estado de cuenta de aeropuerto' }, LOCAL)
    expect(j).toMatchObject({ reconocida: false, motivo: 'acotada' })
    expect(peticiones).not.toContain('GET v_cartera')
  })
})
