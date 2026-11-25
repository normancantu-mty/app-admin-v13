/**
 * REGALOS: QUIEN (lista cerrada), DE DONDE SALE (siempre la matriz) e HISTORIAL.
 * Escrito el 2026-11-25 por el ejecutor del Socio. Los nombres de entidades son
 * de prueba. El doble de PostgREST es el mismo de `regalos.spec.ts`.
 */

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import * as R from '@/lib/regalos'
import type { LineaCartera, ProductoRegalo } from '@/lib/regalos'
import { sellarRegalo, type PayloadRegalo } from '@/lib/bot-regalo'
import { leerCartera, registrarRegalo } from '@/lib/regalos-servidor'
import * as regaloP from '@/app/api/bot/regalo/proponer/route'
import * as regaloC from '@/app/api/bot/regalo/confirmar/route'

const PRODUCTOS: ProductoRegalo[] = [
  { id: 'p-750', nombre: 'Destilado Plata 750ml', ml_por_unidad: 750, costo_unitario: 120 },
  { id: 'p-250', nombre: 'Destilado Plata 250ml', ml_por_unidad: 250, costo_unitario: 0 },
  { id: 'p-50', nombre: 'Destilado Plata 50ml', ml_por_unidad: 50, costo_unitario: 0 }
]
const QUIENES = [
  ...(['Norman', 'Kevin', 'Cristian', 'Gilberto', 'Luis'] as const).map((nombre) => ({ nombre, tipo: 'equipo' as const })),
  { nombre: 'Casa Verde', tipo: 'local' as const },
  { nombre: 'Al son del Mezcal', tipo: 'local' as const },
  { nombre: 'Aeropuerto', tipo: 'local' as const },
  { nombre: 'Gilberto Franco', tipo: 'distribuidor' as const },
  { nombre: 'David Alfa', tipo: 'distribuidor' as const },
  { nombre: 'David Beta', tipo: 'distribuidor' as const }
]
const leer = (t: string, dicta = 'norman') => R.leerRegalo(t, PRODUCTOS, dicta, QUIENES)

// ─── 1. Nombres fuera de la lista: se pregunta, no se le carga a quien dicta ─

test.describe('regalos: un nombre que no esta en la lista', () => {
  for (const [t, dicho] of [
    ['Regalo una grande de Fany en la feria', 'Fany'],
    ['regalo una grande de fany en la feria', 'fany'],
    ['Regalo una grande de Juan Perez en la expo', 'Juan Perez'],
    ['Regalo una grande de mi compadre en la feria', 'mi compadre'],
    ['Regalo una grande de Fany, motivo: feria', 'Fany'],
    ['Regalo de Fany: 2 grandes en la feria', 'Fany'],
    ['regalo Fany 2 grandes en la feria', 'Fany'],
    ['Regalo una grande, Fany', 'Fany'],
    // Suelto, en minuscula y sin "de" (el defecto original del encargo E).
    ['regalo una grande fany', 'fany'],
    ['regalo una grande fany en la feria', 'fany'],
    ['regale una grande FANY en la feria', 'FANY'],
    ['regalo 2 grandes de parte de Fany en la feria', 'Fany'],
    ['Fany regaló una grande en la feria', 'Fany'],
    ['ayer fany regalo una grande en la feria', 'fany'],
    ['Juan Pérez regaló una grande en la feria', 'Juan Pérez'],
    ['Regalo una grande de Kevin Robledo en la cena', 'Kevin Robledo'],
    ['Luis Pérez regaló una grande en la cena', 'Luis Pérez'],
    ['Regalo una grande de casa berde en la feria', 'casa berde']
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: false, falta: 'quien', quien: '', piezas: [{ producto: { id: 'p-750' } }], duda: { dicho, motivo: 'desconocido' } })
    })
  }

  test('dos personas, una fuera de la lista: uno por mensaje', () => {
    for (const t of ['Regalo una grande de Norman y Fany en la feria', 'Kevin y Fany regalaron 3 chicas, motivo: expo', 'Regalo una grande en la boda, Fany 2 chicas en la feria'])
      expect(leer(t), t).toEqual({ ok: false, falta: 'uno_por_mensaje' })
  })

  test('quien dicta tampoco se inventa: si no esta en la lista, se pregunta', () => {
    expect(leer('regalé una grande en la feria', 'fany')).toMatchObject({ ok: false, falta: 'quien' })
  })
})

// ─── 2. Los que si ──────────────────────────────────────────────────────────

test.describe('regalos: equipo, distribuidores y locales, en las dos formas', () => {
  for (const [t, quien, motivo] of [
    ['Regalo una grande de Cris en la feria', 'Cristian', 'la feria'],
    ['cris regalo una grande en la feria', 'Cristian', 'la feria'],
    ['Casa Verde regaló 2 grandes en la feria', 'Casa Verde', 'la feria'],
    ['CASA VERDE regalo 2 grandes en la feria', 'Casa Verde', 'la feria'],
    ['al son regalo 2 minis en la feria', 'Al son del Mezcal', 'la feria'],
    ['regalo 2 grandes de parte de casa verde en la feria', 'Casa Verde', 'la feria'],
    ['david beta regaló 2 minis en la expo', 'David Beta', 'la expo']
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: true, quien, motivo })
    })
  }
})

test.describe('regalos: empates, se pregunta', () => {
  const opciones = (t: string) => {
    const r = leer(t) as unknown as { duda?: { motivo: string; opciones: { nombre: string }[] } }
    return [r.duda?.motivo, ...(r.duda?.opciones ?? []).map((o) => o.nombre)]
  }
  test('Gilberto a secas: ¿la persona o Gilberto Franco?', () => {
    for (const t of ['Regalo una grande de Gilberto en la feria', 'Gilberto regaló una grande en la feria', 'gilberto regalo una grande en la feria'])
      expect(opciones(t), t).toEqual(['ambiguo', 'Gilberto', 'Gilberto Franco'])
  })
  test('David a secas', () => {
    expect(opciones('David regaló 2 minis en la feria')).toEqual(['ambiguo', 'David Alfa', 'David Beta'])
  })
  test('"Gilberto del equipo" y "Gilberto (equipo)" desempatan; Gilberto dictando es el', () => {
    for (const t of ['Gilberto del equipo regaló una grande en la feria', 'Regalo una grande de Gilberto (equipo) en la feria'])
      expect(leer(t), t).toMatchObject({ ok: true, quien: 'Gilberto', motivo: 'la feria' })
    expect(leer('regalé una grande en la feria', 'gilberto')).toMatchObject({ ok: true, quien: 'Gilberto' })
  })
  test('sin la entidad, Gilberto a secas no se pregunta', () => {
    expect(R.leerRegalo('Gilberto regaló una grande en la feria', PRODUCTOS, 'norman', QUIENES.filter((q) => q.nombre !== 'Gilberto Franco'))).toMatchObject({ ok: true, quien: 'Gilberto' })
  })
  test('el mensaje dice uno y nombra a otro: se pregunta', () => {
    expect(opciones('regalé una grande de Kevin en la cena')).toEqual(['cual', 'Kevin', 'Norman'])
    expect(opciones('Regalo una grande a Juan de Kevin')).toEqual(['cual', 'Kevin', 'Norman'])
  })
})

// ─── 3. De quien es / a quien se le dio ─────────────────────────────────────

test.describe('regalos: de quien es NO es a quien se le dio', () => {
  for (const [t, quien, motivo] of [
    ['Norman regaló 3 grandes a Casa Verde', 'Norman', 'a Casa Verde'],
    ['Norman regaló 3 grandes para Casa Verde', 'Norman', 'para Casa Verde'],
    ['Norman le regaló a Casa Verde 3 grandes', 'Norman', 'a Casa Verde'],
    ['regalo a Kevin una grande en la feria', 'Norman', 'la feria (a Kevin)'],
    ['Norman regaló 3 grandes a Casa Verde, motivo: apertura', 'Norman', 'apertura (a Casa Verde)'],
    ['Norman regaló 3 grandes para Casa Verde, motivo: apertura', 'Norman', 'apertura (para Casa Verde)'],
    ['regalé 3 grandes a Casa Verde por su apertura', 'Norman', 'a Casa Verde por su apertura'],
    ['Regalo 3 grandes para Casa Verde', 'Norman', 'para Casa Verde'],
    ['Regalo 3 grandes de Kevin a Casa Verde', 'Kevin', 'a Casa Verde'],
    ['Casa Verde regaló una grande a Gilberto Franco', 'Casa Verde', 'a Gilberto Franco']
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: true, quien, motivo })
    })
  }
})

// Norman, 2026-11-25: «Regalo una grande de/para Casa Verde» = se le dio a Casa Verde; regala quien dicta.
test.describe('regalos: "de <local>" en una orden es a quien se le dio', () => {
  for (const [t, destino, motivo] of [
    ['Regalo una grande de Casa Verde, motivo: apertura', 'Casa Verde', 'apertura'],
    ['regalo una grande de casa verde en la feria', 'Casa Verde', 'la feria'],
    ['Regalo una grande de al son en la feria', 'Al son del Mezcal', 'la feria'],
    ['Regalo una grande del local Casa Verde en la feria', 'Casa Verde', 'la feria'],
    ['Regalo de Casa Verde: 2 grandes en la feria', 'Casa Verde', 'la feria'],
    ['Regalo 3 grandes de Casa Verde, motivo: apertura', 'Casa Verde', 'apertura']
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: true, quien: 'Norman', motivo, destino: { nombre: destino } })
    })
  }
  // Un DISTRIBUIDOR es una persona: "de Gilberto Franco" puede ser quien lo dio o a quien se le dio. Estos dos
  // salian con destino Gilberto Franco sin preguntar; Norman solo dijo que "de <LOCAL>" es destino. Se pregunta.
  for (const t of ['Regalo una grande de Gilberto Franco en la feria', 'Regalo una grande de Franco en la feria']) {
    test(`${t}: distribuidor, se pregunta`, () => {
      const l = leer(t)
      expect(l).toMatchObject({ ok: false, falta: 'quien', quien: '', motivo: 'la feria', duda: { motivo: 'rol', opciones: [{ nombre: 'Gilberto Franco' }] } })
      expect(l).not.toHaveProperty('destino')
    })
  }
})

// ─── 4. Lo que ya se leia bien no cambia ────────────────────────────────────

test.describe('regalos: "de algo" que no es una persona', () => {
  for (const t of [
    'regalé una grande en la boda de Kevin', 'Regalo una grande de 750 en la feria', 'Regalo 2 grandes de plata en la feria',
    'regalé una grande de regalo a una chica en la cena', 'Regalo 2 grandes de muestra', 'Regalo 2 grandes para la expo de Zacatecas',
    'regalo dos grandes de muestra en la feria', 'regalé una grande de navidad', 'regalé una grande de la casa', 'Regalo una grande a un cliente de Kevin',
    'Regalé una grande en el aeropuerto', 'yo regalé 2 minis en la feria'
  ]) {
    test(t, () => {
      expect(leer(t)).toMatchObject({ ok: true, quien: 'Norman' })
    })
  }
})

test.describe('regalos: la respuesta a "¿quien fue?"', () => {
  const con = (t: string, d: string) => leer(R.completarRegalo(t, 'quien', d))
  test('reemplaza al que no se reconocio y conserva el dia', () => {
    expect(con('ayer fany regaló una grande en la feria', 'casa verde')).toMatchObject({ ok: true, quien: 'Casa Verde', diasAtras: 1, motivo: 'la feria' })
    expect(con('Juan Pérez regaló una grande en la feria', 'yo')).toMatchObject({ ok: true, quien: 'Norman' })
    expect(con('Gilberto regaló una grande en la feria', 'Gilberto (equipo)')).toMatchObject({ ok: true, quien: 'Gilberto' })
    expect(con('Gilberto regaló una grande en la feria', 'Gilberto Franco')).toMatchObject({ ok: true, quien: 'Gilberto Franco' })
    expect(con('regalé una grande de Kevin en la cena', 'Kevin')).toMatchObject({ ok: true, quien: 'Kevin', motivo: 'la cena' })
  })
  test('otro nombre fuera de la lista se vuelve a preguntar', () => {
    expect(con('Fany regaló una grande en la feria', 'Maria')).toMatchObject({ ok: false, falta: 'quien', duda: { dicho: 'Maria' } })
  })
})

// ─── 5. El doble ────────────────────────────────────────────────────────────

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

async function llamar(ruta: 'proponer' | 'confirmar', cuerpo: Record<string, unknown>) {
  const req = new Request('http://localhost/api/bot/regalo/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await (ruta === 'proponer' ? regaloP : regaloC).POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}

function conRed() {
  estadoInicial()
  tablas.entidades.push(
    { id: 'ent-casa', nombre: 'Casa Verde', rol: 'LOC', id_padre: null, id_nodo_padre: null },
    { id: 'ent-gf', nombre: 'Gilberto Franco', rol: 'DST', id_padre: null, id_nodo_padre: null },
    { id: 'ent-socio', nombre: 'Zutano', rol: 'SOCIO', id_padre: null, id_nodo_padre: null },
    { id: '11111111-1111-1111-1111-111111111111', nombre: 'Pendiente de asignar', rol: 'LOC', id_padre: null, id_nodo_padre: null }
  )
  tablas.inventario_ledger.push(
    { id: 'inv-casa', id_producto: 'p-750', tipo_movimiento: 'ENTRADA_CONCESION', cantidad: 8, cubeta: 'CONSIGNADO', id_entidad_destino: 'ent-casa', id_entidad_origen: null, status: 'ACTIVO' }
  )
}
const deCasa = () => tablas.inventario_ledger.filter((f) => f.id_entidad_origen === 'ent-casa' || f.id_entidad_destino === 'ent-casa')
const cliente = () => createClient('http://127.0.0.1:9', 'fake-key', { auth: { persistSession: false } }) as never
const solicitud = { fecha: '2026-11-25', quien_regalo: 'casa verde', motivo: 'Apertura', lineas: [{ id_producto: 'p-750', cantidad: 2 }] }

// ─── 6. Siempre sale de la matriz ───────────────────────────────────────────

test.describe('regalos: siempre salen de la matriz', () => {
  test('cualquier otro origen se rechaza y no se escribe nada', async () => {
    for (const origen of ['ent-casa', 'ent-gf', 'ent-aero', '']) {
      conRed()
      expect(await registrarRegalo(cliente(), { ...solicitud, quien_regalo: 'Norman' }, origen, 'web@x'), origen).toEqual({ ok: false, error: 'Los regalos salen solo de la matriz.' })
      expect(rpcs).toEqual([])
    }
  })

  test('de la cuenta de un local: origen matriz y lo CONSIGNADO de ese local no cambia', async () => {
    conRed()
    const antes = JSON.stringify(deCasa())
    expect(await registrarRegalo(cliente(), solicitud, 'ent-matriz', 'web@x')).toMatchObject({ ok: true })
    expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Casa Verde', id_entidad_origen: 'ent-matriz' })
    expect(tablas.inventario_ledger.filter((f) => f.id_regalo).map((f) => f.id_entidad_origen)).toEqual(['ent-matriz'])
    expect(JSON.stringify(deCasa())).toBe(antes)
  })

  test('bot: un borrador con otro origen, aunque traiga su sello bueno, no se escribe', async () => {
    conRed()
    const p = await llamar('proponer', { telegram_id: NORMAN, texto: 'Kevin regaló 2 grandes, motivo: expo' })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    const regalo = (b.payload as Fila).regalo as PayloadRegalo
    regalo.id_entidad = 'ent-casa'
    b.sello = sellarRegalo(regalo)
    const c = await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: b.sello })
    expect(c.status).toBe(409)
    expect(rpcs).toEqual([])
  })
})

// ─── 7. El servidor y las rutas ─────────────────────────────────────────────

test.describe('regalos: la lista cerrada en el servidor y en el bot', () => {
  test('escribir: solo nombres de la lista, y con su nombre completo', async () => {
    for (const quien_regalo of ['Fany', 'Juan Pérez', 'Zutano', 'Pendiente de asignar', 'CEO Admin', 'casa']) {
      conRed()
      const r = await registrarRegalo(cliente(), { ...solicitud, quien_regalo }, 'ent-matriz', 'web@x')
      expect(r, quien_regalo).toMatchObject({ ok: false, error: expect.stringContaining('No reconozco a') })
      expect(rpcs).toEqual([])
    }
    conRed()
    expect(await registrarRegalo(cliente(), { ...solicitud, quien_regalo: 'cris' }, 'ent-matriz', 'web@x')).toMatchObject({ ok: true })
    expect(rpcs[0].p_regalo.quien_regalo).toBe('Cristian')
  })

  test('bot: nombre fuera de la lista -> pregunta; nada se guarda; la respuesta propone', async () => {
    conRed()
    const texto = 'Regalo una grande de Fany en la feria'
    const a = await llamar('proponer', { telegram_id: NORMAN, texto })
    expect(a.j).toMatchObject({ ok: false, falta: 'quien' })
    expect(String(a.j.pregunta)).toContain('No reconozco a "Fany"')
    expect(escrituras).toEqual([])
    const b = await llamar('proponer', { telegram_id: NORMAN, texto, completa: { falta: 'quien', dicho: 'Kevin' } })
    expect(b.j.ok, JSON.stringify(b.j)).toBe(true)
    expect(String(b.j.mensaje)).toContain('QUIEN:      Kevin')
  })

  test('bot: parecido y empate se ofrecen', async () => {
    conRed()
    expect(String((await llamar('proponer', { telegram_id: NORMAN, texto: 'Regalo una grande de casa berde en la feria' })).j.pregunta)).toContain('¿Quisiste decir Casa Verde (local)?')
    expect(String((await llamar('proponer', { telegram_id: NORMAN, texto: 'Gilberto regaló una grande, motivo: feria' })).j.pregunta)).toContain('Gilberto (equipo) o Gilberto Franco (distribuidor)')
  })

  test('bot: de un local -> la propuesta dice que sale de la matriz, y el VA lo escribe de la matriz', async () => {
    conRed()
    const antes = JSON.stringify(deCasa())
    const p = await llamar('proponer', { telegram_id: KEVIN, texto: 'Casa Verde regaló una grande en la feria' })
    expect(String(p.j.mensaje)).toContain('QUIEN:      Casa Verde (local)')
    expect(String(p.j.mensaje)).toContain('sale de la matriz, no de lo que tiene Casa Verde')
    await llamar('confirmar', { telegram_id: KEVIN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    await llamar('confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    // La cuenta es de Casa Verde; quien lo capturo es Kevin.
    expect(rpcs[0].p_regalo).toMatchObject({ quien_regalo: 'Casa Verde', usuario_creador: 'telegram:kevin', id_entidad_origen: 'ent-matriz' })
    expect(JSON.stringify(deCasa())).toBe(antes)
  })
})

// ─── 8. Historial ───────────────────────────────────────────────────────────

test.describe('regalos: historial con fecha, hora y quien lo capturo', () => {
  const l = (o: Partial<LineaCartera>): LineaCartera => ({
    id_regalo: 'r1', fecha: '2026-11-24', quien_regalo: 'Norman', motivo: 'conferencia de IA', usuario_creador: 'telegram:kevin',
    id_producto: 'p-750', producto: 'Destilado Plata 750ml', ml_por_unidad: 750, piezas: 1, creado_en: '2026-11-25T03:05:40.12+00:00', ...o
  })

  test('la hora de captura se ve en hora de Mexico (y cambia de dia cuando toca)', () => {
    expect(R.horaCapturaMx('2026-11-25T03:05:40.12+00:00')).toBe('2026-11-24 21:05')
    expect(R.horaCapturaMx(null)).toBe('')
    expect(R.capturoTexto('telegram:kevin')).toBe('Kevin (Telegram)')
    expect(R.capturoTexto('a@b.mx')).toBe('a@b.mx')
  })

  test('el bot lo contesta, por persona y en general', () => {
    const c = R.armarCartera([l({})])
    const renglon = '2026-11-24: 1 de 750ml. conferencia de IA [lo capturó Kevin (Telegram), 2026-11-24 21:05]'
    expect(R.textoContador(c, 'Norman')).toContain(renglon)
    expect(R.textoContador(c, '')).toContain(renglon.replace(':', ' Norman:'))
    expect(R.leerConsultaRegalos('historial de regalos', 'norman', [])).toEqual({ quien: '' })
    expect(R.leerConsultaRegalos('cuantos regalos lleva gilberto franco', 'norman', ['Gilberto Franco'])).toEqual({ quien: 'Gilberto Franco' })
  })

  test('el regalo que ya estaba se lee de la vista con su hora, y sigue siendo de Norman', async () => {
    conRed()
    tablas.v_regalo_lineas = [l({ usuario_creador: 'a@b.mx' }) as unknown as Fila]
    const c = await leerCartera(cliente())
    expect(c.registros).toMatchObject([{ quien_regalo: 'Norman', usuario_creador: 'a@b.mx', creado_en: '2026-11-25T03:05:40.12+00:00', piezas: 1 }])
    const q = await llamar('proponer', { telegram_id: NORMAN, texto: 'regalos de Norman' })
    expect(String(q.j.texto)).toContain('[lo capturó a@b.mx, 2026-11-24 21:05]')
    const v = await llamar('proponer', { telegram_id: NORMAN, texto: 'cuantos regalos lleva casa verde' })
    expect(String(v.j.texto)).toContain('Casa Verde: 0 botellas')
  })

  test('cableado: la pagina ensena hora y captura; el formulario es lista, sin texto libre', () => {
    const ver = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8')
    const pagina = ver('app', 'panel', 'regalos', 'page.tsx')
    expect(pagina).toContain('horaCapturaMx(r.creado_en)')
    expect(pagina).toContain('capturoTexto(r.usuario_creador)')
    expect(pagina).toContain('quienes={quienes}')
    const form = ver('components', 'v2', 'regalos', 'FormRegalo.tsx')
    expect(form).not.toContain('OTRO')
    expect(form).toContain('<optgroup')
    expect(form).toContain('Sale de la matriz')
    expect(ver('lib', 'regalos-servidor.ts')).toContain('creado_en')
  })
})
