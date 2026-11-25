import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { registrarVenta, type OperadorDeVenta, type ProcesarVentaPOSPayload } from '@/lib/venta-servidor'
import { escribirSalidaCascada } from '@/lib/salida-cascada'
import { getStockEsperadoPorEntidad, getStockPorCubetaPorEntidad } from '@/lib/inventario-auditoria'
import { conceptoAbonoLocal } from '@/lib/abono-local'
import { procesarCorteInventarioAction } from '@/app/actions/auditoria'
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external'
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external'

/**
 * EL ERP AVISA, NO BLOQUEA, POR FALTA DE EXISTENCIA (2026-11-24).
 *
 * Corre `registrarVenta` y `escribirSalidaCascada` de verdad contra un doble de
 * PostgREST en memoria: nada sale a la red. Solo importa modulos que ya existian,
 * para que falle por lo que hace y no por un import.
 */

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escritos: { metodo: string; tabla: string; cuerpo: unknown }[] = []
let fallaEn: Record<string, number> = {}
/** Tablas que no contestan NUNCA: 'GET tabla' o 'POST tabla'. */
let cuelga = new Set<string>()

const ENTORNO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fake-key',
  SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key'
}
const entornoOriginal: Record<string, string | undefined> = {}

function mov(id_producto: string, cantidad: number, cubeta: string, destino: string | null, origen: string | null = null): Fila {
  const tipo = origen ? 'SALIDA_VENTA' : cubeta === 'CONSIGNADO' ? 'ENTRADA_CONCESION' : 'PRODUCCION'
  return { id_producto, cantidad, cubeta, id_entidad_destino: destino, id_entidad_origen: origen, tipo_movimiento: tipo, status: 'ACTIVO' }
}

function estado(ledger: Fila[]) {
  const ent = (id: string, nombre: string, rol: string, padre: string | null = null) => ({
    id, nombre, rol, zona: 'Zacatecas', id_padre: padre, id_nodo_padre: null,
    comision_base: 0.2, comision_base_local: 0.3, comision_hijo_local: 0.35, aplica_redondeo_costo: true
  })
  tablas = {
    entidades: [ent('adm', 'Matriz', 'ADMIN'), ent('dst', 'Distribuidor', 'DST'), ent('loc', 'Local', 'LOC', 'dst')],
    cuentas_financieras: [
      { id: 'c-adm', id_entidad: 'adm', nombre: 'Efectivo', tipo_fiscalidad: 'LIBRE' },
      { id: 'c-dst', id_entidad: 'dst', nombre: 'Efectivo dst', tipo_fiscalidad: 'LIBRE' }
    ],
    catalogo_productos: [
      { id: 'p750', sku: 'S750', nombre: 'Destilado 750ml', tipo: 'TERMINADO' },
      { id: 'p250', sku: 'S250', nombre: 'Destilado 250ml', tipo: 'TERMINADO' }
    ],
    listas_precios: [],
    finanzas_ledger: [],
    transacciones_tickets: [],
    inventario_ledger: ledger,
    avisos_captura: []
  }
  escritos = []
  fallaEn = {}
  cuelga = new Set()
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = decodeURIComponent(expr.slice(i + 1)).replace(/^"|"$/g, '')
  if (op === 'eq') return String(fila[col]) === val
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(fila[col]))
  return true
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

function responder(url: string, init?: RequestInit): Response | Promise<Response> {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  if (metodo !== 'GET' && metodo !== 'HEAD') {
    escritos.push({ metodo, tabla, cuerpo: init?.body ? JSON.parse(String(init.body)) : null })
    if (cuelga.has(`POST ${tabla}`)) return new Promise<Response>(() => {})
    if (fallaEn[tabla]) return json({ message: 'falla a proposito', code: 'X' }, fallaEn[tabla])
    if (tabla.startsWith('rpc/')) return json(null)
    if ((headers.get('accept') ?? '').includes('vnd.pgrst.object')) return json({ id: 'nuevo-1' }, 201)
    return (headers.get('prefer') ?? '').includes('return=representation') ? json([{ id: 'nuevo-1' }], 201) : new Response(null, { status: 201 })
  }
  if (cuelga.has(`GET ${tabla}`)) return new Promise<Response>(() => {})
  if (tabla === '/auth/v1/user') return json({ id: 'auth-adm', email: 'a@x', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' })
  const filas = filtrar(tabla, u.searchParams)
  if ((headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
    return filas.length === 1 ? json(filas[0]) : json({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }, 406)
  }
  return json(filas)
}

const fetchOriginal = globalThis.fetch
test.beforeAll(() => {
  for (const [k, v] of Object.entries(ENTORNO)) {
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

const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
const ADMIN: OperadorDeVenta = { email: 'a@x', idEntidad: 'adm', rol: 'ADMIN' }

function venta(items: [string, number][], extra: Partial<ProcesarVentaPOSPayload> = {}): ProcesarVentaPOSPayload {
  const total = items.reduce((s, [, c]) => s + c * 100, 0)
  return {
    idVendedor: 'adm',
    idComprador: null,
    idCuentaDestino: 'c-adm',
    condicion_pago: 'CONTADO',
    subtotalCatalogo: total,
    totalCobradoReal: total,
    montoBaseIngreso: 0,
    impuestoIvaCalculado: 0,
    impuestoIepsCalculado: 0,
    items: items.map(([id_producto, cantidad]) => ({ id_producto, cantidad, precio_unitario: 100, subtotal_linea: cantidad * 100 })),
    ...extra
  }
}

interface RpcVenta { p_ticket: { id: string } & Fila; p_inventario: Fila[]; p_finanzas: Fila[] }
const rpc = () => escritos.filter((e) => e.tabla === 'rpc/registrar_venta_atomica').map((e) => e.cuerpo as RpcVenta)
const avisos = (tipo: string) => escritos.filter((e) => e.tabla === 'avisos_captura').map((e) => e.cuerpo as Fila).filter((a) => a.tipo === tipo)
const movs = () => rpc()[0].p_inventario.map((f) => [f.tipo_movimiento, f.cubeta, f.cantidad, f.id_entidad_origen ?? f.id_entidad_destino])
const avisoDe = (r: unknown) => (r as { avisoStock?: string | null }).avisoStock

test.describe('la venta sin existencia entra, queda negativa y avisa', () => {
  test('hay 1 y pides 3: entra por las 3, avisa al capturar y deja W20 ligado al ticket', async () => {
    estado([mov('p750', 1, 'PAGADO', 'adm')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]]))
    expect(r.ok, r.error).toBe(true)
    // Ni entrada, ni ajuste, ni recorte: la salida y nada mas.
    expect(movs()).toEqual([['SALIDA_VENTA', 'PAGADO', 3, 'adm']])
    expect(avisoDe(r)).toContain('Destilado 750ml: hay 1, pides 3, quedará -2')
    expect(avisos('W20')).toHaveLength(1)
    expect(avisos('W20')[0]).toMatchObject({
      severidad: 'REVISAR',
      id_entidad: 'adm',
      tabla: 'transacciones_tickets',
      id_registro: r.ticketId,
      mensaje: avisoDe(r)
    })
    // El aviso va DESPUES de la venta.
    const orden = escritos.map((e) => e.tabla)
    expect(orden.indexOf('avisos_captura')).toBeGreaterThan(orden.indexOf('rpc/registrar_venta_atomica'))
  })

  test('con existencia justa no avisa nada (control)', async () => {
    estado([mov('p750', 3, 'PAGADO', 'adm')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]]))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r) ?? null).toBeNull()
    expect(avisos('W20')).toEqual([])
    expect(movs()).toEqual([['SALIDA_VENTA', 'PAGADO', 3, 'adm']])
  })

  test('un saldo que ya era negativo se dice como es, no como cero', async () => {
    estado([mov('p750', 2, 'PAGADO', null, 'adm')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 1]]))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('hay -2, pides 1, quedará -3')
  })

  test('dos piezas, falta una: solo se nombra la que falta', async () => {
    estado([mov('p750', 9, 'PAGADO', 'adm')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 1], ['p250', 2]]))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('Destilado 250ml: hay 0, pides 2, quedará -2')
    expect(avisoDe(r)).not.toContain('750ml')
  })

  test('el mismo producto en dos renglones se suma antes de comparar', async () => {
    estado([mov('p750', 3, 'PAGADO', 'adm')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 2], ['p750', 2]]))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('hay 3, pides 4, quedará -1')
    expect(movs()).toEqual([['SALIDA_VENTA', 'PAGADO', 4, 'adm']])
  })

  test('lo consignado se usa hasta donde hay y el faltante queda en PAGADO', async () => {
    estado([mov('p750', 1, 'PAGADO', 'dst'), mov('p750', 2, 'CONSIGNADO', 'dst')])
    const r = await registrarVenta(cliente(), { email: 'd@x', idEntidad: 'dst', rol: 'DST' }, venta([['p750', 5]], { idVendedor: 'dst', idCuentaDestino: 'c-dst' }))
    expect(r.ok, r.error).toBe(true)
    expect(movs()).toEqual([
      ['SALIDA_VENTA', 'PAGADO', 3, 'dst'],
      ['SALIDA_VENTA', 'CONSIGNADO', 2, 'dst']
    ])
    expect(avisos('W20')[0]).toMatchObject({ id_entidad: 'dst' })
  })

  test('concesion con faltante: sale y entra lo mismo; nada se inventa', async () => {
    estado([])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 4]], { condicion_pago: 'CONCESION', idComprador: 'dst' }))
    expect(r.ok, r.error).toBe(true)
    expect(movs()).toEqual([
      ['SALIDA_CONCESION', 'PAGADO', 4, 'adm'],
      ['ENTRADA_CONCESION', 'CONSIGNADO', 4, 'dst']
    ])
    expect(avisoDe(r)).toContain('en Matriz')
  })

  test('triangulacion sin consignado suficiente: entra y el faltante queda en CONSIGNADO del origen', async () => {
    estado([mov('p750', 9, 'PAGADO', 'dst'), mov('p750', 1, 'CONSIGNADO', 'dst')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]], { origenInventarioId: 'dst', idComprador: 'loc' }))
    expect(r.ok, r.error).toBe(true)
    expect(movs()).toEqual([
      ['SALIDA_VENTA', 'CONSIGNADO', 3, 'dst'],
      ['ENTRADA_COMPRA', 'PAGADO', 3, 'loc']
    ])
    expect(avisoDe(r)).toContain('hay 1, pides 3, quedará -2')
    expect(avisoDe(r)).toContain('en Distribuidor')
    expect(avisos('W20')[0]).toMatchObject({ id_entidad: 'dst' })
  })

  test('triangulacion con consignado pero con el total corto: avisa por el total', async () => {
    estado([mov('p750', 4, 'PAGADO', null, 'dst'), mov('p750', 5, 'CONSIGNADO', 'dst')])
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]], { origenInventarioId: 'dst', idComprador: 'loc' }))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('hay 1, pides 3, quedará -2')
  })

  test('si la venta NO entra (la base la rechaza), no hay aviso de una venta que no existe', async () => {
    estado([])
    fallaEn['rpc/registrar_venta_atomica'] = 400
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]]))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('falla a proposito')
    expect(avisos('W20')).toEqual([])
  })

  test('si la cola de avisos falla, la venta entra y quien captura ve el aviso', async () => {
    estado([])
    fallaEn['avisos_captura'] = 500
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]]))
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('quedará -3')
  })

  test('lo que NO es por existencia sigue frenando (control)', async () => {
    estado([])
    const otro = await registrarVenta(cliente(), { email: 'd@x', idEntidad: 'dst', rol: 'DST' }, venta([['p750', 1]]))
    expect(otro).toMatchObject({ ok: false, error: expect.stringContaining('No autorizado') })
    const padreAjeno = await registrarVenta(cliente(), ADMIN, venta([['p750', 1]], { origenInventarioId: 'dst', idComprador: 'dst' }))
    expect(padreAjeno).toMatchObject({ ok: false, error: expect.stringContaining('triangulaci') })
    expect(rpc()).toEqual([])
  })
})

test.describe('la salida (merma, devolucion) sin existencia entra y avisa', () => {
  const salida = { id_entidad: 'adm', id_producto: 'p750', tipo_movimiento: 'MERMA' as const, usuario_creador: 'web@x', cantidad_a_deducir: 3 }

  test('hay 1 y salen 3: UN insert, W20 sin puntero y el aviso de vuelta', async () => {
    estado([mov('p750', 1, 'PAGADO', 'adm')])
    const r = await escribirSalidaCascada(cliente(), salida)
    expect(r.success, JSON.stringify(r)).toBe(true)
    expect(escritos.map((e) => e.tabla)).toEqual(['inventario_ledger', 'avisos_captura'])
    expect(escritos[0].cuerpo).toMatchObject([{ tipo_movimiento: 'MERMA', cubeta: 'PAGADO', cantidad: 3 }])
    expect(avisoDe(r)).toContain('Destilado 750ml: hay 1, pides 3, quedará -2')
    expect(avisoDe(r)).toContain('en Matriz')
    expect(avisos('W20')[0]).toMatchObject({ id_entidad: 'adm', tabla: null, id_registro: null })
  })

  test('con los ids pedidos (el bot) tambien avisa', async () => {
    estado([])
    const r = await escribirSalidaCascada(cliente(), { ...salida, devolverIds: true })
    expect(r).toMatchObject({ success: true, ids: ['nuevo-1'] })
    expect(avisoDe(r)).toContain('hay 0, pides 3, quedará -3')
  })

  test('un saldo negativo no se cuenta como cero', async () => {
    estado([mov('p750', 2, 'PAGADO', null, 'adm')])
    const r = await escribirSalidaCascada(cliente(), salida)
    expect(avisoDe(r)).toContain('hay -2, pides 3, quedará -5')
  })

  test('con existencia no avisa (control); si el insert falla, no hay aviso', async () => {
    estado([mov('p750', 3, 'PAGADO', 'adm')])
    const r = await escribirSalidaCascada(cliente(), salida)
    expect(avisoDe(r) ?? null).toBeNull()
    expect(avisos('W20')).toEqual([])
    estado([])
    fallaEn['inventario_ledger'] = 400
    const malo = await escribirSalidaCascada(cliente(), salida)
    expect(malo.success).toBe(false)
    expect(avisos('W20')).toEqual([])
  })
})

test.describe('el negativo se ve', () => {
  test('el conteo fisico pide el libro con negativos; los demas siguen igual', async () => {
    estado([mov('p750', 2, 'PAGADO', null, 'loc'), mov('p250', 4, 'CONSIGNADO', 'loc')])
    const leer = getStockPorCubetaPorEntidad as (id: string, o?: { conNegativos?: boolean }) => ReturnType<typeof getStockPorCubetaPorEntidad>
    const con = await leer('loc', { conNegativos: true })
    expect(con.stockPagado.map((f) => [f.idProducto, f.stockEsperado])).toEqual([['p750', -2]])
    expect(con.stockConsignado.map((f) => [f.idProducto, f.stockEsperado])).toEqual([['p250', 4]])
    const sin = await leer('loc')
    expect(sin.stockPagado).toEqual([])
    const conteo = readFileSync(join(process.cwd(), 'app/actions/conteo.ts'), 'utf-8')
    expect(conteo.match(/getStockPorCubetaPorEntidad\(idEntidad, \{ conNegativos: true \}\)/g)).toHaveLength(2)
  })

  test('el corte no cobra dos veces: lo que espera es PAGADO + CONSIGNADO con su signo', async () => {
    // Vendio 2 de mas (PAGADO -2) y tiene 5 consignadas: en el anaquel espera 3, no 5.
    estado([mov('p750', 2, 'PAGADO', null, 'loc'), mov('p750', 5, 'CONSIGNADO', 'loc'), mov('p250', 1, 'PAGADO', null, 'loc')])
    const esperado = await getStockEsperadoPorEntidad('loc')
    expect(esperado.map((f) => [f.idProducto, f.stockEsperado])).toEqual([['p750', 3]])
    // Control: sin negativos, la suma de siempre.
    estado([mov('p750', 2, 'PAGADO', 'loc'), mov('p750', 5, 'CONSIGNADO', 'loc')])
    expect((await getStockEsperadoPorEntidad('loc')).map((f) => f.stockEsperado)).toEqual([7])
  })

  test('el inventario ya no tapa lo consignado negativo con un cero', () => {
    for (const ruta of ['app/dashboard/inventario/page.tsx', 'components/v2/inventario/InventarioVista.tsx']) {
      const fuente = readFileSync(join(process.cwd(), ruta), 'utf-8')
      expect(fuente, ruta).not.toContain('Math.max(0, stockFisicoConsignado)')
      expect(fuente, ruta).not.toContain('p.stock_consignado > 0')
      expect(fuente, ruta).not.toContain('Math.max(0, p.stock_actual)')
    }
  })
})

test.describe('el aviso llega a quien captura', () => {
  const leer = (ruta: string) => readFileSync(join(process.cwd(), ruta), 'utf-8')

  test('las dos pantallas de venta lo muestran despues de guardar y antes de irse al ticket', () => {
    expect(leer('app/actions/pos.ts')).toContain('avisoStock: resultado.avisoStock ?? null')
    for (const [ruta, salto] of [['app/pos/page.tsx', 'router.push(`/ticket/'], ['components/v2/venta/Venta.tsx', 'irTrasGuardar(']]) {
      const fuente = leer(ruta)
      const error = fuente.indexOf("alert(result.error || 'Error al procesar la venta')")
      const aviso = fuente.indexOf('if (result.avisoStock) alert(result.avisoStock)')
      expect(error, ruta).toBeGreaterThan(0)
      expect(aviso, ruta).toBeGreaterThan(error)
      expect(fuente.indexOf(salto, aviso), ruta).toBeGreaterThan(aviso)
    }
  })

  test('las dos pantallas de merma y la accion lo muestran', () => {
    expect(leer('app/actions/inventario.ts')).toContain('avisoStock: resultado.avisoStock ?? null')
    for (const ruta of ['app/dashboard/inventario/BotonReportarMerma.tsx', 'components/v2/inventario/BotonReportarMerma.tsx']) {
      expect(leer(ruta), ruta).toContain('alert(result.avisoStock ??')
    }
  })

  test('el bot: las tres rutas lo mandan y bot_gastos.py lo dice en sus cuatro salidas', () => {
    expect(leer('app/api/bot/venta/confirmar/route.ts')).toContain('{ aviso_stock: resultado.avisoStock }')
    expect(leer('app/api/bot/convertir/confirmar/route.ts').match(/\{ aviso_stock: resultado\.avisoStock \}/g)).toHaveLength(2)
    expect(leer('app/api/bot/merma/confirmar/route.ts')).toContain('{ aviso_stock: resultado.avisoStock }')
    expect(leer('bot/bot_gastos.py').match(/get\("aviso_stock"\)/g)).toHaveLength(4)
  })

  test('nadie vuelve a frenar por existencia en la venta ni en la salida', () => {
    for (const ruta of ['lib/venta-servidor.ts', 'lib/inventario-auditoria.ts', 'lib/salida-cascada.ts', 'app/api/bot/merma/proponer/route.ts']) {
      expect(leer(ruta), ruta).not.toMatch(/Stock (consignado )?insuficiente|no puedo sacar/)
    }
  })
})

/** Aplica a las tablas lo que la RPC acaba de recibir: asi se encadenan ventas. */
function aplicar() {
  const c = rpc().at(-1) as RpcVenta
  tablas.transacciones_tickets.push({ status: 'ACTIVO', ...c.p_ticket })
  tablas.inventario_ledger.push(...c.p_inventario)
  tablas.finanzas_ledger.push(...c.p_finanzas)
}

test.describe('v2 · una cola de avisos colgada no detiene ni duplica', () => {
  test('la venta contesta en ~1 s, con UNA sola escritura y el aviso para quien captura', async () => {
    estado([])
    cuelga.add('POST avisos_captura')
    const t = Date.now()
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 3]]))
    expect(Date.now() - t).toBeLessThan(3000)
    expect(r.ok, r.error).toBe(true)
    expect(avisoDe(r)).toContain('quedará -3')
    expect(rpc()).toHaveLength(1)
    expect(escritos.filter((e) => e.tabla === 'avisos_captura')).toHaveLength(1)
  })

  test('la salida contesta, con UN insert, por la web y por el bot', async () => {
    for (const devolverIds of [false, true]) {
      estado([])
      cuelga.add('POST avisos_captura')
      const t = Date.now()
      const r = await escribirSalidaCascada(cliente(), { id_entidad: 'adm', id_producto: 'p750', tipo_movimiento: 'MERMA', usuario_creador: 'w@x', cantidad_a_deducir: 3, devolverIds })
      expect(Date.now() - t).toBeLessThan(3000)
      expect(r.success, JSON.stringify(r)).toBe(true)
      expect(avisoDe(r)).toContain('Destilado 750ml: hay 0, pides 3, quedará -3')
      expect(escritos.filter((e) => e.tabla === 'inventario_ledger')).toHaveLength(1)
    }
  })

  test('la salida con los nombres colgados avisa con los ids y deja el W20', async () => {
    estado([])
    cuelga.add('GET catalogo_productos')
    const t = Date.now()
    const r = await escribirSalidaCascada(cliente(), { id_entidad: 'adm', id_producto: 'p750', tipo_movimiento: 'MERMA', usuario_creador: 'w@x', cantidad_a_deducir: 3 })
    expect(Date.now() - t).toBeLessThan(3000)
    expect(avisoDe(r)).toContain('p750: hay 0, pides 3, quedará -3')
    expect(avisos('W20')).toHaveLength(1)
  })
})

test.describe('v2 · en un local el negativo baja el proximo corte, y se dice', () => {
  const NOTA = 'Ese saldo baja lo que cobra el próximo corte del local.'

  test('la venta: en el local si, en la Matriz y el distribuidor no', async () => {
    for (const [id, dice] of [['loc', true], ['adm', false], ['dst', false]] as const) {
      estado([])
      tablas.cuentas_financieras.push({ id: 'c-loc', id_entidad: 'loc', nombre: 'Efectivo loc', tipo_fiscalidad: 'LIBRE' })
      const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 2]], { idVendedor: id, origenInventarioId: id, idCuentaDestino: `c-${id}` }))
      expect(r.ok, `${id}: ${r.error}`).toBe(true)
      expect(avisoDe(r)?.includes(NOTA), id).toBe(dice)
      expect(String(avisos('W20')[0].mensaje).includes(NOTA), id).toBe(dice)
    }
  })

  test('la salida: en el local si, en la Matriz y el distribuidor no', async () => {
    for (const [id, dice] of [['loc', true], ['adm', false], ['dst', false]] as const) {
      estado([])
      const r = await escribirSalidaCascada(cliente(), { id_entidad: id, id_producto: 'p750', tipo_movimiento: 'MERMA', usuario_creador: 'w@x', cantidad_a_deducir: 2 })
      expect(avisoDe(r)?.includes(NOTA), id).toBe(dice)
      expect(String(avisos('W20')[0].mensaje).includes(NOTA), id).toBe(dice)
    }
  })
})

test.describe('v2 · negativo y abono v3 juntos (la regla del abono no cambia)', () => {
  const DST: OperadorDeVenta = { email: 'd@x', idEntidad: 'dst', rol: 'DST' }
  const NOTA = /Este abono no se dio por falta de carga \(([^)]*)\): captura la carga primero\. Cargar después no abona esta entrega\./

  /** 202 por botella: lista 2,020 y neto 15% + 15% - 20%. La Matriz tiene 99. */
  function base() {
    estado([mov('p750', 99, 'PAGADO', 'adm'), mov('p250', 99, 'PAGADO', 'adm')])
    for (const e of tablas.entidades) Object.assign(e, { comision_base: 0.2, comision_base_local: 0.15, comision_hijo_local: 0.15 })
    tablas.listas_precios = ['p750', 'p250'].map((id) => ({ id_producto: id, zona: 'Zacatecas', precio_final: 2020 }))
  }
  async function carga(n: number) {
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', n]], { condicion_pago: 'CONCESION', idComprador: 'dst' }))
    expect(r.ok, r.error).toBe(true)
    aplicar()
  }
  async function surte(n: number) {
    const antes = escritos.length
    const r = await registrarVenta(cliente(), DST, venta([['p750', n]], { idVendedor: 'dst', idCuentaDestino: 'c-dst', condicion_pago: 'CONCESION', idComprador: 'loc' }))
    expect(r.ok, r.error).toBe(true)
    aplicar()
    const w20 = escritos.slice(antes).filter((e) => e.tabla === 'avisos_captura').map((e) => e.cuerpo as Fila).filter((a) => a.tipo === 'W20').map((a) => a.mensaje)
    return { aviso: avisoDe(r) ?? '', w20, fila: rpc().at(-1)!.p_finanzas.find((f) => f.categoria === 'COMISION_LOCAL') }
  }
  const abonado = () => -tablas.finanzas_ledger.filter((f) => f.categoria === 'COMISION_LOCAL').reduce((s, f) => s + Number(f.monto), 0)

  test('carga 3, surte 5, carga 5, surte 3: abona 1,212 y lo dice; cargando primero, 1,616 y callado', async () => {
    base()
    await carga(3)
    const primero = await surte(5)
    expect(primero.aviso).toContain('hay 3, pides 5, quedará -2')
    expect(primero.aviso.match(NOTA)?.[1]).toBe('2x Destilado 750ml')
    expect(primero.w20).toEqual([primero.aviso])
    expect(conceptoAbonoLocal(String(primero.fila?.categoria_gasto))).toMatch(NOTA)
    expect(String(primero.fila?.categoria_gasto)).toMatch(/^Abono por surtir a .+ - Ticket #/)
    expect(String(primero.fila?.categoria_gasto).split(String.fromCharCode(10)).length).toBeGreaterThan(2)
    expect(primero.fila).toMatchObject({ monto: -606, subcategoria: '{"p750":3}' })
    await carga(5)
    const segundo = await surte(3)
    expect(segundo.aviso).toBe('')
    expect(String(segundo.fila?.categoria_gasto)).not.toMatch(NOTA)
    expect(abonado()).toBe(1212)
    expect(avisos('W19')).toEqual([])
    // Control: la misma mercancia, con la carga capturada antes.
    base()
    await carga(3)
    await carga(5)
    const a = await surte(5)
    const b = await surte(3)
    expect([a.aviso, b.aviso]).toEqual(['', ''])
    expect(String(a.fila?.categoria_gasto) + String(b.fila?.categoria_gasto)).not.toContain('falta de carga')
    expect(abonado()).toBe(1616)
  })

  test('surte 4 y luego carga 4: abona 0 y lo dice; cargando primero, 808 y callado', async () => {
    base()
    const r = await surte(4)
    expect(r.aviso.match(NOTA)?.[1]).toBe('4x Destilado 750ml')
    expect(r.w20).toEqual([r.aviso])
    expect(conceptoAbonoLocal(String(r.fila?.categoria_gasto))).toMatch(NOTA)
    expect(Number(r.fila?.monto)).toBe(0)
    await carga(4)
    expect(abonado() === 0).toBe(true)
    expect(avisos('W19')).toEqual([])
    base()
    await carga(4)
    const c = await surte(4)
    expect(c.aviso).toBe('')
    expect(String(c.fila?.categoria_gasto)).not.toContain('falta de carga')
    expect(abonado()).toBe(808)
  })

  test('con el saldo ya negativo la segunda entrega tampoco se abona, y dice solo las suyas', async () => {
    base()
    await surte(4)
    const r = await surte(3)
    expect(r.aviso).toContain('hay -4, pides 3, quedará -7')
    expect(r.aviso.match(NOTA)?.[1]).toBe('3x Destilado 750ml')
    expect(abonado() === 0).toBe(true)
  })

  test('existencia hay y cargo no: no se abona, pero no es falta de carga capturada aqui', async () => {
    base()
    tablas.inventario_ledger.push(mov('p750', 5, 'CONSIGNADO', 'dst'))
    const r = await surte(5)
    expect(Number(r.fila?.monto)).toBe(0)
    expect(r.aviso).toBe('')
    expect(String(r.fila?.categoria_gasto)).not.toContain('falta de carga')
  })

  test('faltan 2 y ninguna traia cargo: la nota cuenta solo las 2 que faltaban', async () => {
    base()
    tablas.inventario_ledger.push(mov('p750', 3, 'CONSIGNADO', 'dst'))
    const r = await surte(5)
    expect(r.aviso.match(NOTA)?.[1]).toBe('2x Destilado 750ml')
  })

  test('falta existencia pero todo trae cargo: se abona completo y no hay nota', async () => {
    base()
    await carga(5)
    // Una salida de antes de la primera carga baja la existencia, no el derecho al abono.
    tablas.inventario_ledger.push({ ...mov('p750', 2, 'PAGADO', null, 'dst'), fecha_movimiento: '2020-01-01T00:00:00Z' })
    const r = await surte(5)
    expect(r.aviso).toContain('hay 3, pides 5, quedará -2')
    expect(r.aviso).not.toMatch(NOTA)
    expect(r.fila).toMatchObject({ monto: -1010 })
  })

  test('una venta de la Matriz con faltante no habla de abonos (control)', async () => {
    base()
    const r = await registrarVenta(cliente(), ADMIN, venta([['p750', 100]], { condicion_pago: 'CONCESION', idComprador: 'dst' }))
    expect(avisoDe(r)).toContain('quedará -1')
    expect(avisoDe(r)).not.toContain('abono')
  })
})

test.describe('v2 · el corte de verdad con un saldo negativo', () => {
  /** Corre la accion del servidor completa, con sesion de la Matriz, sin Next alrededor. */
  async function corte(ledger: Fila[]) {
    estado(ledger)
    Object.assign(tablas.entidades[0], { auth_id: 'auth-adm', email: 'a@x' })
    tablas.accesos = []
    tablas.listas_precios = [{ id_producto: 'p750', zona: 'Zacatecas', precio_final: 100 }]
    const vence = Math.floor(Date.now() / 1000) + 9999
    const sesion = JSON.stringify({ access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 9999, expires_at: vence, user: { id: 'auth-adm' } })
    const galletas = { get: (n: string) => (n === 'sb-127-auth-token' ? { name: n, value: sesion } : undefined), getAll: () => [] }
    const trabajo = { route: '/prueba', page: '/prueba/page', incrementalCache: {} }
    const peticion = { type: 'request', phase: 'action', cookies: galletas, userspaceMutableCookies: galletas, mutableCookies: galletas, headers: new Headers() }
    // Next guarda la peticion en dos almacenes; aqui se los da la prueba, y se los quita.
    const [a, b] = [workAsyncStorage, workUnitAsyncStorage] as unknown as { getStore: () => unknown }[]
    const [deA, deB] = [a.getStore, b.getStore]
    a.getStore = () => trabajo
    b.getStore = () => peticion
    try {
      return await procesarCorteInventarioAction({ idEntidad: 'loc', conteosFisicos: [{ idProducto: 'p750', fisico: 0 }], idCuentaDestino: 'c-adm' })
    } finally {
      a.getStore = deA
      b.getStore = deB
    }
  }
  const filasDe = (tabla: string) => escritos.filter((e) => e.tabla === tabla).flatMap((e) => e.cuerpo as Fila[])
  const cobrado = () => ({
    piezas: filasDe('inventario_ledger').map((f) => [f.tipo_movimiento, f.cubeta, f.cantidad, f.id_entidad_origen]),
    pesos: filasDe('finanzas_ledger').filter((f) => f.tipo_movimiento === 'ABONO_DEUDA').map((f) => f.monto)
  })

  test('vendio 8 con 6, le llegan 5, anaquel en 0: cobra 3, no 5', async () => {
    const r = await corte([
      mov('p750', 6, 'CONSIGNADO', 'loc'),
      mov('p750', 6, 'CONSIGNADO', null, 'loc'),
      mov('p750', 2, 'PAGADO', null, 'loc'),
      mov('p750', 5, 'CONSIGNADO', 'loc')
    ])
    expect(r.ok, r.error).toBe(true)
    expect(cobrado()).toEqual({ piezas: [['SALIDA_VENTA', 'CONSIGNADO', 3, 'loc']], pesos: [210] })
  })

  test('sin negativo cobra las 5 (control)', async () => {
    const r = await corte([mov('p750', 5, 'CONSIGNADO', 'loc')])
    expect(r.ok, r.error).toBe(true)
    expect(cobrado()).toEqual({ piezas: [['SALIDA_VENTA', 'CONSIGNADO', 5, 'loc']], pesos: [350] })
  })

  test('si el negativo se come todo, no hay nada que cobrar y el corte cierra', async () => {
    const r = await corte([mov('p750', 6, 'PAGADO', null, 'loc'), mov('p750', 5, 'CONSIGNADO', 'loc')])
    expect(r.ok, r.error).toBe(true)
    expect(cobrado()).toEqual({ piezas: [], pesos: [] })
  })
})
