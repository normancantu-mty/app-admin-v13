/**
 * MERMA DESDE EL BOT (2026-11-07, Fase 3 de la paridad con la web).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio.
 *
 * 1. Lo puro (`lib/bot-merma.ts`): producto por su ficha distintiva, cantidad,
 *    patron de merma, plan de la cascada.
 * 2. El nucleo compartido (`lib/salida-cascada.ts`): lo mismo que escribia
 *    `registrarSalidaCascada` de la web — PAGADO primero, luego CONSIGNADO, y
 *    nada si no alcanza. Y la accion de la web lo llama (no tiene copia propia).
 * 3. Las rutas `merma/proponer` + `merma/confirmar` contra un PostgREST falso.
 *
 * Sin red ni base: el `fetch` global se dobla.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { fichasDistintivas, hablaDeMerma, leerMerma, planDeCascada, type ProductoDeMerma } from '@/lib/bot-merma'
import { escribirSalidaCascada } from '@/lib/salida-cascada'
import { tipoDelPayload } from '@/lib/bot-pendiente'
import * as mermaP from '@/app/api/bot/merma/proponer/route'
import * as mermaC from '@/app/api/bot/merma/confirmar/route'

const PRODUCTOS: ProductoDeMerma[] = [
  { id: 'p-250', nombre: 'Destilado Plata 250ml' },
  { id: 'p-50', nombre: 'Destilado Plata 50ml' },
  { id: 'p-750', nombre: 'Destilado Plata 750ml' },
  { id: 'p-pasta', nombre: 'Pasta-Guajillo-2kg' }
]

// ─── 1. Lo puro ─────────────────────────────────────────────────────────────

test.describe('bot-merma (pura)', () => {
  test('cada producto se distingue por lo que solo el tiene', () => {
    const d = fichasDistintivas(PRODUCTOS)
    expect(d.get('p-750')).toEqual(['750'])
    expect(d.get('p-pasta')).toEqual(expect.arrayContaining(['pasta', 'guajillo']))
    expect(d.get('p-pasta')).not.toContain('2')
  })

  test('"se rompieron 2 botellas de 750" -> 2 de Destilado 750 (el 2 no es la pasta de 2kg)', () => {
    expect(leerMerma('se rompieron 2 botellas de 750', PRODUCTOS)).toEqual({ ok: true, producto: PRODUCTOS[2], cantidad: 2 })
    expect(leerMerma('se me cayo una de 250', PRODUCTOS)).toMatchObject({ ok: true, producto: { id: 'p-250' }, cantidad: 1 })
    expect(leerMerma('merma de 3 pastas de guajillo', PRODUCTOS)).toMatchObject({ ok: true, producto: { id: 'p-pasta' }, cantidad: 3 })
  })

  test('falta o sobra algo: no se adivina', () => {
    expect(leerMerma('se rompio una de 750 y otra de 250', PRODUCTOS)).toMatchObject({ ok: false, falta: 'producto' })
    expect(leerMerma('se rompieron botellas de 750', PRODUCTOS)).toMatchObject({ ok: false, falta: 'cantidad' })
    expect(leerMerma('se rompieron 2 o 3 de 750', PRODUCTOS)).toMatchObject({ ok: false, falta: 'cantidad' })
    expect(leerMerma('se rompio la llanta, 300 del taller', PRODUCTOS)).toEqual({ ok: false, falta: 'producto', opciones: [] })
  })

  test('el patron de merma', () => {
    for (const t of ['merma de 2 de 750', 'Se rompió una de 750', 'se nos cayeron 3', 'llegaron 2 rotas', 'una quebrada']) {
      expect(hablaDeMerma(t), t).toBe(true)
    }
    for (const t of ['vendi 2 de 750 a aeropuerto', 'cuanto hay en spin', 'gasolina 300']) {
      expect(hablaDeMerma(t), t).toBe(false)
    }
  })

  test('el plan de la cascada: PAGADO primero, CONSIGNADO despues', () => {
    expect(planDeCascada(5, 3, 10)).toEqual({ dePagado: 3, deConsignado: 2, alcanza: true })
    expect(planDeCascada(5, 1, 1)).toMatchObject({ alcanza: false })
  })

  test('el borrador merma se rehidrata con su tipo', () => {
    expect(tipoDelPayload({ tipo: 'merma', merma: {} })).toBe('merma')
  })
})

// ─── El PostgREST falso ─────────────────────────────────────────────────────

const TOKEN = 'm'.repeat(32)
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

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
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
    catalogo_productos: PRODUCTOS.map((p) => ({ ...p, tipo: 'TERMINADO' })).concat([{ id: 'i-chile', nombre: 'Chile 750 seco', tipo: 'INSUMO' }]),
    inventario_ledger: [
      { id: 'inv-a', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 3, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-b', id_producto: 'p-750', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 4, cubeta: 'CONSIGNADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ACTIVO' },
      { id: 'inv-c', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 99, cubeta: 'PAGADO', id_entidad_destino: 'ent-matriz', id_entidad_origen: null, status: 'ANULADO' },
      { id: 'inv-d', id_producto: 'p-750', tipo_movimiento: 'PRODUCCION', cantidad: 50, cubeta: 'PAGADO', id_entidad_destino: 'ent-aero', id_entidad_origen: null, status: 'ACTIVO' }
    ],
    bot_borradores: [],
    avisos_captura: []
  }
  escrituras = []
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

const mermas = () => tablas.inventario_ledger.filter((f) => f.tipo_movimiento === 'MERMA')

// ─── 2. El nucleo compartido ────────────────────────────────────────────────

test.describe('escribirSalidaCascada: lo mismo para la web y el bot', () => {
  const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
  const salida = { id_entidad: 'ent-matriz', id_producto: 'p-750', tipo_movimiento: 'MERMA' as const, usuario_creador: 'web@x' }

  test('5 de merma con 3 pagadas y 4 consignadas: 3 de PAGADO y 2 de CONSIGNADO (lo anulado y lo de otra entidad no cuentan)', async () => {
    estadoInicial()
    const r = await escribirSalidaCascada(cliente(), { ...salida, cantidad_a_deducir: 5 })
    expect(r.success, JSON.stringify(r)).toBe(true)
    expect(mermas()).toEqual([
      expect.objectContaining({ cubeta: 'PAGADO', cantidad: 3, id_entidad_origen: 'ent-matriz', usuario_creador: 'web@x' }),
      expect.objectContaining({ cubeta: 'CONSIGNADO', cantidad: 2, id_entidad_origen: 'ent-matriz' })
    ])
    // La web no manda notas: sus filas salen igual que antes, sin la columna.
    expect(mermas()[0]).not.toHaveProperty('notas')
  })

  test('si no alcanza (8 de 7), no escribe nada', async () => {
    estadoInicial()
    const r = await escribirSalidaCascada(cliente(), { ...salida, cantidad_a_deducir: 8 })
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('Stock insuficiente') })
    expect(escrituras).toEqual([])
  })

  test('validaciones de siempre: cantidad <= 0 y tipo raro no escriben', async () => {
    estadoInicial()
    expect((await escribirSalidaCascada(cliente(), { ...salida, cantidad_a_deducir: 0 })).success).toBe(false)
    expect((await escribirSalidaCascada(cliente(), { ...salida, cantidad_a_deducir: 1, tipo_movimiento: 'TRASPASO' as never })).success).toBe(false)
    expect(escrituras).toEqual([])
  })

  test('la accion de la web llama al nucleo y ya no trae su propia cascada', () => {
    const fuente = readFileSync(join(process.cwd(), 'app', 'actions', 'inventario.ts'), 'utf8')
    const cuerpo = fuente.slice(fuente.indexOf('export async function registrarSalidaCascada'), fuente.indexOf('export async function registrarLogisticaInversaAction'))
    expect(cuerpo).toContain('escribirSalidaCascada(supabase')
    expect(cuerpo).not.toContain('calcularDeduccionCascada')
    expect(cuerpo).not.toContain(".from('inventario_ledger')")
  })
})

// ─── 3. Las rutas del bot ───────────────────────────────────────────────────

async function llamar(ruta: 'proponer' | 'confirmar', cuerpo: Record<string, unknown>) {
  const req = new Request('http://localhost/api/bot/merma/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await (ruta === 'proponer' ? mermaP : mermaC).POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}

test.describe('merma/proponer + merma/confirmar', () => {
  test('"se rompieron 2 botellas de 750": propone sin escribir; el VA escribe MERMA con la etiqueta y la nota', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'se rompieron 2 botellas de 750' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(String(p.j.mensaje)).toContain('Destilado Plata 750ml')
    expect(String(p.j.mensaje)).toContain('2 piezas de lo PAGADO')
    expect(mermas()).toEqual([])
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(mermas()).toEqual([
      expect.objectContaining({
        id_producto: 'p-750', cubeta: 'PAGADO', cantidad: 2, id_entidad_origen: 'ent-matriz',
        usuario_creador: 'telegram:norman', notas: 'Merma dictada al bot: se rompieron 2 botellas de 750'
      })
    ])
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).toBe('CONFIRMADO')
  })

  test('"se rompio la llanta": no_es_merma, nada se guarda', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'se rompio la llanta, 300 del taller' })
    expect(p.j.no_es_merma).toBe(true)
    expect(escrituras).toEqual([])
    expect((await llamar('proponer', { telegram_id: NORMAN, texto: 'vendi 2 de 750' })).j.no_es_merma).toBe(true)
  })

  test('sin cantidad o con dos productos: UNA pregunta, nada se guarda', async () => {
    estadoInicial()
    const a = await llamar('proponer', { telegram_id: NORMAN, texto: 'se rompieron botellas de 750' })
    expect(String(a.j.pregunta)).toContain('cuantas piezas')
    const b = await llamar('proponer', { telegram_id: NORMAN, texto: 'se rompio una de 750 y una de 250' })
    expect(String(b.j.pregunta)).toContain('que producto')
    expect(escrituras).toEqual([])
  })

  test('mas de lo que hay (8 de 7): lo dice al proponer y no guarda borrador', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'merma de 8 de 750' })
    expect(String(p.j.pregunta)).toContain('solo tiene 7 piezas')
    expect(tablas.bot_borradores).toEqual([])
  })

  test('si entre la propuesta y el VA ya no alcanza, no escribe y el borrador no queda confirmado', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'merma de 6 de 750' })
    tablas.inventario_ledger.push({ id: 'inv-x', id_producto: 'p-750', tipo_movimiento: 'SALIDA_VENTA', cantidad: 3, cubeta: 'PAGADO', id_entidad_destino: null, id_entidad_origen: 'ent-matriz', status: 'ACTIVO' })
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(409)
    expect(mermas()).toEqual([])
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).not.toBe('CONFIRMADO')
  })

  test('el VA de Kevin espera; el Aprobar de Norman escribe con la etiqueta de Kevin', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: KEVIN, texto: 'se cayo una de 750' })
    const va = await llamar('confirmar', { telegram_id: KEVIN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect(mermas()).toEqual([])
    const ok = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(mermas()[0]).toMatchObject({ usuario_creador: 'telegram:kevin', cantidad: 1 })
  })

  test('un LOC no registra merma por aqui: 403', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: LOCAL, texto: 'se rompieron 2 de 750' })
    expect(p.status).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('si alguien toca la merma guardada, el sello la cancela y no se escribe nada', async () => {
    estadoInicial()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'se rompieron 2 de 750' })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    ;((b.payload as Fila).merma as Fila).cantidad = 7
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(409)
    expect(b.estado).toBe('CANCELADO')
    expect(mermas()).toEqual([])
  })
})
