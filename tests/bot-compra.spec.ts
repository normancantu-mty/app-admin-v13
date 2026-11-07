/**
 * 2026-11-07 — LA COMPRA DE INSUMO DESDE EL BOT (paridad con la web).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).
 *
 * Tres capas:
 *  1. Lo puro de `lib/bot-compra.ts`: cantidad, insumo, decision compra/gasto,
 *     sello y el texto que lee la persona.
 *  2. El nucleo compartido `escribirCompraInsumos` (`lib/compra-insumos.ts`):
 *     las dos filas y la compensacion, con un PostgREST simulado.
 *  3. Las rutas `gasto/proponer` y `gasto/confirmar` importadas y habladas como
 *     el bot (mismo doble de `fetch` que `tests/bot-rutas-permisos.spec.ts`).
 *
 * Validez: mide el handler importado, no el Next vivo ni Postgres.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import {
  aUnidadDelInsumo,
  CIERRE_PROPUESTA,
  derivarCompra,
  escogerInsumo,
  leerCantidad,
  mensajeDeCompra,
  sellarCompra,
  selloCompraCoincide,
  type InsumoDeCompra,
  type PayloadCompra
} from '@/lib/bot-compra'
import { escribirCompraInsumos } from '@/lib/compra-insumos'
import { tipoDelPayload } from '@/lib/bot-pendiente'
import * as gastoP from '@/app/api/bot/gasto/proponer/route'
import * as gastoC from '@/app/api/bot/gasto/confirmar/route'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = { 'gasto/proponer': gastoP, 'gasto/confirmar': gastoC }

const INSUMOS: InsumoDeCompra[] = [
  { id: 'i-guaj', nombre: 'Chile Guajillo', unidad_medida: 'KILOGRAMOS' },
  { id: 'i-guajon', nombre: 'Chile Guajon', unidad_medida: 'KILOGRAMOS' },
  { id: 'i-b50', nombre: 'Botella 50ml Vacía', unidad_medida: 'PIEZAS' },
  { id: 'i-b250', nombre: 'Botella 250ml Vacía', unidad_medida: 'PIEZAS' },
  { id: 'i-b750', nombre: 'Botella 750ml Vacía', unidad_medida: 'PIEZAS' },
  { id: 'i-et750', nombre: 'Etiqueta 750', unidad_medida: 'PIEZAS' },
  { id: 'i-ad1', nombre: 'Aditivo 1', unidad_medida: 'KILOGRAMOS' },
  { id: 'i-ad2', nombre: 'Aditivo 2', unidad_medida: 'KILOGRAMOS' },
  { id: 'i-led', nombre: 'Luz LED', unidad_medida: 'PIEZAS' }
]

// ─── 1. LO PURO ─────────────────────────────────────────────────────────────

test.describe('bot-compra: la cantidad dicha', () => {
  test('lee numero y unidad; ignora medida, precio y el monto', () => {
    expect(leerCantidad('50 kg de chile')).toEqual({ valor: 50, unidad: 'kg', texto: '50 kg' })
    expect(leerCantidad('compre 50 kg de chile a 1200 desde spin', 1200)?.valor).toBe(50)
    expect(leerCantidad('500 botellas de 750')?.valor).toBe(500)
    expect(leerCantidad('botellas de 750')).toBeNull()
    expect(leerCantidad('chile 1200', 1200)).toBeNull()
    expect(leerCantidad('1.5 kilos de guajillo')).toEqual({ valor: 1.5, unidad: 'kg', texto: '1.5 kilos' })
    expect(leerCantidad('800 g de sorbato')?.unidad).toBe('g')
  })
  test('gana el numero que trae unidad: "aditivo 1, 5 kilos" son 5 kg', () => {
    expect(leerCantidad('aditivo 1, 5 kilos')?.valor).toBe(5)
  })
  test('convierte a la unidad del insumo, y lo que no se puede convertir se pregunta', () => {
    expect(aUnidadDelInsumo({ valor: 800, unidad: 'g', texto: '800 g' }, 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 0.8 })
    expect(aUnidadDelInsumo({ valor: 2, unidad: 'ton', texto: '2 ton' }, 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 2000 })
    expect(aUnidadDelInsumo({ valor: 3, unidad: 'kg', texto: '3 kg' }, 'PIEZAS').ok).toBe(false)
    expect(aUnidadDelInsumo({ valor: 2.5, unidad: null, texto: '2.5' }, 'PIEZAS').ok).toBe(false)
    expect(aUnidadDelInsumo({ valor: 200, unidad: null, texto: '200' }, 'PIEZAS')).toEqual({ ok: true, cantidad: 200 })
  })
})

test.describe('bot-compra: que insumo', () => {
  test('"chile" son dos: se pregunta; "chile guajillo" es uno', () => {
    const dos = escogerInsumo('50 kg de chile', INSUMOS)
    expect(dos.tipo).toBe('varios')
    expect(dos.tipo === 'varios' && dos.candidatos.map((i) => i.id)).toEqual(['i-guaj', 'i-guajon'])
    const uno = escogerInsumo('50 kg de chile guajillo', INSUMOS)
    expect(uno.tipo === 'uno' && uno.insumo.id).toBe('i-guaj')
  })
  test('la medida escoge la botella; el precio ("a 12") no es medida', () => {
    const a = escogerInsumo('500 botellas de 750', INSUMOS)
    expect(a.tipo === 'uno' && a.insumo.id).toBe('i-b750')
    const b = escogerInsumo('500 botellas de 750 a 12', INSUMOS)
    expect(b.tipo === 'uno' && b.insumo.id).toBe('i-b750')
  })
  test('nada que ver con un insumo: ninguno', () => {
    expect(escogerInsumo('gas de la planta', INSUMOS).tipo).toBe('ninguno')
  })
})

test.describe('bot-compra: compra o gasto', () => {
  const base = { categoria: 'Costo de producción', subcategoria: 'chile', monto: 1200, insumos: INSUMOS }
  test('categoria que no es de insumo: gasto, sin preguntar nada', () => {
    expect(derivarCompra({ ...base, categoria: 'Logística y envíos', descripcion: '50 kg de chile guajillo' })).toEqual({ modo: 'gasto', falta: null })
  })
  test('insumo y cantidad claros: compra', () => {
    const d = derivarCompra({ ...base, descripcion: '50 kg de chile guajillo' })
    expect(d.modo === 'compra' && [d.insumo.id, d.cantidad]).toEqual(['i-guaj', 50])
  })
  test('dos insumos posibles: gasto que pide escoger; con el boton, compra', () => {
    const d = derivarCompra({ ...base, descripcion: '50 kg de chile' })
    expect(d.modo === 'gasto' && d.falta).toBe('insumo')
    const e = derivarCompra({ ...base, descripcion: '50 kg de chile', idInsumoElegido: 'i-guajon' })
    expect(e.modo === 'compra' && e.insumo.id).toBe('i-guajon')
  })
  test('sin cantidad: gasto que pide el numero; con la respuesta, compra', () => {
    const d = derivarCompra({ ...base, descripcion: 'chile guajillo' })
    expect(d.modo === 'gasto' && d.falta).toBe('cantidad')
    const e = derivarCompra({ ...base, descripcion: 'chile guajillo', cantidadContestada: '50' })
    expect(e.modo === 'compra' && e.cantidad).toBe(50)
  })
  test('la cantidad del mensaje entero entra si el concepto no la trae', () => {
    const d = derivarCompra({ ...base, descripcion: 'chile guajillo', textoDicho: 'compre 50 kg de chile guajillo a 1200 desde spin' })
    expect(d.modo === 'compra' && d.cantidad).toBe(50)
  })
  test('sin insumo en el concepto, la subcategoria acota (Aditivo 1 no es cantidad 1)', () => {
    const d = derivarCompra({ ...base, subcategoria: 'Aditivo 1', descripcion: '5 kg de aditivo' })
    expect(d.modo === 'compra' && [d.insumo.id, d.cantidad]).toEqual(['i-ad1', 5])
  })
})

test.describe('bot-compra: sello y mensaje', () => {
  const compra: PayloadCompra = {
    id_insumo: 'i-guaj', cantidad: 50, costo_total: 1200, id_cuenta_origen: 'c-spin', id_entidad: 'ent-matriz',
    usuario_creador: 'telegram:norman', categoria: 'Costo de producción', subcategoria: 'chile',
    descripcion: '50 kg de chile guajillo', fecha_movimiento: '2026-11-07T18:00:00.000Z', notas: 'x'
  }
  test('el sello se rompe si cambia la cantidad', () => {
    const s = sellarCompra(compra)
    expect(selloCompraCoincide(compra, s)).toBe(true)
    expect(selloCompraCoincide({ ...compra, cantidad: 500 }, s)).toBe(false)
  })
  test('el mensaje trae insumo, cantidad, precio unitario y las lineas que el bot reescribe', () => {
    const m = mensajeDeCompra(compra, INSUMOS[0], { valor: 50, unidad: 'kg', texto: '50 kg' }, { nombreCuenta: 'Cuenta Spin', nombreEntidad: 'Matriz' }, [])
    expect(m).toContain('INSUMO:     Chile Guajillo')
    expect(m).toContain('CANTIDAD:   50 kg')
    expect(m).toContain('$24.00 por kg')
    expect(m).toContain('entra al inventario')
    // `bot_gastos.py` reescribe estas tres (`_LINEA_CUENTA`, `_PIE_DE_GASTO`, `_CIERRE`).
    expect(m).toMatch(/^CUENTA:[^\n]*Cuenta Spin/m)
    expect(m).toMatch(/^\(la cuenta no la elige el modelo[^\n]*$/m)
    expect(m.endsWith(CIERRE_PROPUESTA)).toBe(true)
  })
  test('el borrador de compra se rehidrata como gasto (se confirma por su ruta)', () => {
    expect(tipoDelPayload({ tipo: 'compra_insumo', compra })).toBe('gasto')
  })
  test('la pantalla de compra llama al MISMO nucleo que el bot', () => {
    const web = readFileSync(join(process.cwd(), 'app/actions/compras.ts'), 'utf8')
    expect(web).toContain('escribirCompraInsumos(')
    expect(web).not.toMatch(/from\('inventario_ledger'\)\s*\.insert/)
  })
})

// ─── EL POSTGREST SIMULADO ──────────────────────────────────────────────────

const TOKEN = 'z'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let fallaInsertEn = new Set<string>()
let contador = 0
// Lo que viajo en cada POST, tal cual (sin los defaults del doble): toEqual exacto.
let insertados: Record<string, Fila[]> = {}

function estadoInicial() {
  tablas = {
    entidades: [{ id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN', id_padre: null, id_nodo_padre: null }],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: false, creado_en: '2026-01-01' },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-ef', activo: true, requiere_aprobacion: true, creado_en: '2026-02-01' }
    ],
    cuentas_financieras: [
      { id: 'c-ef', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-spin', id_entidad: 'ent-matriz', nombre: 'Cuenta Spin', tipo_fiscalidad: 'NO_FISCAL' }
    ],
    categorias_movimiento: [
      { id: 'cm-1', tipo: 'EGRESO', categoria: 'Costo de producción', subcategoria: 'chile', activa: true, orden: 1 },
      { id: 'cm-2', tipo: 'EGRESO', categoria: 'Costo de producción', subcategoria: 'Botellas', activa: true, orden: 2 },
      { id: 'cm-3', tipo: 'EGRESO', categoria: 'Logística y envíos', subcategoria: 'Gasolina', activa: true, orden: 3 }
    ],
    catalogo_productos: INSUMOS.map((i) => ({ ...i, tipo: 'INSUMO' })).concat([
      { id: 'p-750', nombre: 'Destilado 750', unidad_medida: 'PIEZAS', tipo: 'PRODUCTO_TERMINADO' }
    ]),
    bot_borradores: [],
    bot_categorias: [],
    finanzas_ledger: [],
    inventario_ledger: [],
    avisos_captura: []
  }
  escrituras = []
  insertados = {}
  fallaInsertEn = new Set()
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

function json(cuerpo: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json', ...extra } })
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
    return json(null)
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = filtrar(tabla, u.searchParams)
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      if (fallaInsertEn.has(tabla)) return json({ code: '23514', message: `falla simulada en ${tabla}`, details: '', hint: '' }, 400)
      const defaults: Fila = tabla === 'bot_borradores' ? { estado: 'PENDIENTE', resuelto_en: null, id_registro: null, chat_id: null } : {}
      ;(insertados[tabla] ??= []).push(...(Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((c: Fila) => ({ ...c })))
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
  return json(filas, 200, { 'content-range': `0-${Math.max(filas.length - 1, 0)}/${filas.length}` })
}

const fetchOriginal = globalThis.fetch
test.beforeAll(() => {
  for (const [k, v] of Object.entries(ENTORNO_FALSO)) {
    entornoOriginal[k] = process.env[k]
    process.env[k] = v
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 0))
    return responder(String(input instanceof Request ? input.url : input), init)
  }) as typeof fetch
})
test.afterAll(() => {
  globalThis.fetch = fetchOriginal
  for (const [k, v] of Object.entries(entornoOriginal)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function llamar(ruta: string, cuerpo: Record<string, unknown>) {
  const req = new Request('http://localhost/api/bot/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await RUTAS[ruta].POST(req)
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
  return { status: r.status, j: j ?? {} }
}

const deLibros = () => escrituras.filter((e) => /inventario_ledger|finanzas_ledger/.test(e))
const CHILE = { monto: 1200, descripcion: '50 kg de chile guajillo', categoria: 'Costo de producción / chile' }

// ─── 2. EL NUCLEO COMPARTIDO ────────────────────────────────────────────────

test.describe('escribirCompraInsumos: lo mismo para la web y el bot', () => {
  const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
  const compra = { idInsumo: 'i-guaj', cantidad: 50, costoTotal: 1200, idCuentaOrigen: 'c-spin', idEntidad: 'ent-matriz', usuarioCreador: 'web@x' }

  test('escribe ENTRADA_COMPRA al almacen de la entidad y COMPRA_INSUMOS desde la cuenta', async () => {
    estadoInicial()
    const r = await escribirCompraInsumos(cliente(), compra)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    // toEqual EXACTO de lo que viajo: un campo de mas (notas, fecha...) pone esto rojo.
    expect(insertados.inventario_ledger).toEqual([
      { id_producto: 'i-guaj', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 50, id_entidad_destino: 'ent-matriz', usuario_creador: 'web@x', status: 'ACTIVO' }
    ])
    expect(insertados.finanzas_ledger).toEqual([
      { id_cuenta_origen: 'c-spin', tipo_movimiento: 'COMPRA_INSUMOS', categoria: 'Insumos', monto: 1200, usuario_creador: 'web@x', status: 'ACTIVO' }
    ])
  })
  test('si el gasto falla, la entrada se ANULA (no se borra) y no queda nada a medias', async () => {
    estadoInicial()
    fallaInsertEn.add('finanzas_ledger')
    const r = await escribirCompraInsumos(cliente(), compra)
    expect(r.ok).toBe(false)
    expect(tablas.inventario_ledger).toHaveLength(1)
    expect(tablas.inventario_ledger[0]).toMatchObject({ status: 'ANULADO' })
    expect(escrituras).not.toContain('DELETE inventario_ledger')
  })
  test('un producto que no es INSUMO o una cuenta ajena no escriben', async () => {
    estadoInicial()
    tablas.cuentas_financieras.push({ id: 'c-otra', id_entidad: 'dst-x', nombre: 'Ajena', tipo_fiscalidad: 'NO_FISCAL' })
    expect((await escribirCompraInsumos(cliente(), { ...compra, idInsumo: 'p-750' })).ok).toBe(false)
    expect((await escribirCompraInsumos(cliente(), { ...compra, idCuentaOrigen: 'c-otra' })).ok).toBe(false)
    expect(deLibros()).toEqual([])
  })
})

// ─── 3. LAS RUTAS DEL BOT ───────────────────────────────────────────────────

test.describe('gasto/proponer + gasto/confirmar: la compra completa', () => {
  test('"50 kg de chile guajillo a 1200": propone compra sin escribir; el VA escribe dinero Y almacen', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: CHILE, id_cuenta: 'c-spin' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(p.j.tipo).toBe('compra_insumo')
    expect(String(p.j.mensaje)).toContain('Chile Guajillo')
    expect(deLibros()).toEqual([])
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect((b.payload as Fila).tipo).toBe('compra_insumo')

    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    // Auditoria 2026-11-07: la categoria es 'Insumos', la de la web (Norman,
    // 2026-09-12: nombre unico). Antes viajaba 'Costo de produccion'.
    expect(insertados.inventario_ledger).toEqual([
      {
        id_producto: 'i-guaj', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 50, id_entidad_destino: 'ent-matriz',
        usuario_creador: 'telegram:norman', status: 'ACTIVO',
        notas: 'Compra dictada al bot: 50 kg de Chile Guajillo', fecha_movimiento: expect.any(String)
      }
    ])
    expect(insertados.finanzas_ledger).toEqual([
      {
        id_cuenta_origen: 'c-spin', tipo_movimiento: 'COMPRA_INSUMOS', categoria: 'Insumos', subcategoria: 'chile',
        monto: 1200, usuario_creador: 'telegram:norman', status: 'ACTIVO',
        descripcion: '50 kg de chile guajillo', fecha_movimiento: expect.any(String)
      }
    ])
    expect(tablas.finanzas_ledger[0].id_cuenta_destino ?? null).toBeNull()
    expect(b.estado).toBe('CONFIRMADO')
  })

  test('"chile" a secas: gasto con OJO y dos botones; escoger uno lo vuelve compra', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { ...CHILE, descripcion: '50 kg de chile' } })
    expect(p.j.tipo).toBe('gasto')
    expect(p.j.compra_falta).toBe('insumo')
    expect((p.j.compra_opciones as Fila[]).map((o) => o.id)).toEqual(['i-guaj', 'i-guajon'])
    expect(String(p.j.mensaje)).toContain('solo registra el DINERO')
    expect(String(p.j.mensaje).endsWith(CIERRE_PROPUESTA)).toBe(true)
    const q = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { ...CHILE, descripcion: '50 kg de chile', id_insumo: 'i-guajon' } })
    expect(q.j.tipo).toBe('compra_insumo')
  })

  test('sin cantidad: pide el numero UNA vez; con la respuesta, compra', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { ...CHILE, descripcion: 'chile guajillo' } })
    expect(p.j.compra_falta).toBe('cantidad')
    expect(String(p.j.mensaje)).toContain('cuantos kg de Chile Guajillo')
    const q = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { ...CHILE, descripcion: 'chile guajillo', cantidad_insumo: '50' } })
    expect(q.j.tipo).toBe('compra_insumo')
  })

  test('un gasto que no es de insumo sigue igual: GASTO_OPERATIVO, sin almacen', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { monto: 300, descripcion: 'gasolina', categoria: 'Logística y envíos / Gasolina' } })
    expect(p.j.tipo).toBe('gasto')
    expect(p.j.compra_falta ?? null).toBeNull()
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(tablas.inventario_ledger).toEqual([])
    expect(tablas.finanzas_ledger[0]).toMatchObject({ tipo_movimiento: 'GASTO_OPERATIVO' })
  })

  test('el VA de quien requiere aprobacion no escribe; el Aprobar de Norman escribe con la etiqueta del autor', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: KEVIN, propuesta: CHILE })
    expect(p.j.tipo).toBe('compra_insumo')
    const va = await llamar('gasto/confirmar', { telegram_id: KEVIN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect(deLibros()).toEqual([])
    const ok = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(tablas.inventario_ledger[0]).toMatchObject({ usuario_creador: 'telegram:kevin', cantidad: 50 })
  })

  test('si alguien toca la compra guardada, el sello la cancela y no se escribe nada', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: CHILE })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    ;((b.payload as Fila).compra as Fila).cantidad = 500
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(409)
    expect(b.estado).toBe('CANCELADO')
    expect(deLibros()).toEqual([])
  })

  test('si el gasto de la compra falla, la entrada se anula y el borrador no queda confirmado', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: CHILE })
    fallaInsertEn.add('finanzas_ledger')
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(500)
    expect(tablas.inventario_ledger[0]).toMatchObject({ status: 'ANULADO' })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).not.toBe('CONFIRMADO')
  })
})
