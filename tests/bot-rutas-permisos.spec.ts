/**
 * FASE 10 (D103) — LA TABLA DE PERMISOS, MEDIDA EN EL HANDLER.
 *
 * `tests/bot-fase9-permisos.spec.ts` prueba las funciones puras. Lo que se le
 * escapo a la Fase 9 no vivia en ellas: vivia en el ORDEN de las ramas dentro de
 * las rutas (`lote_agregar` salia antes de la espera; `anular` no consultaba la
 * tabla). Esto solo se ve ejercitando el handler, asi que aqui se importa cada
 * `route.ts` y se le habla como el bot, con PostgREST simulado por
 * `globalThis.fetch` (base: el arnes del auditor,
 * `DESDE_SOCIO_arnes_auditoria_fase9/aud-rutas.spec.ts`).
 *
 * El simulador tiene ESTADO: filtra (`eq`, `in`, `is`, `gte`), un UPDATE
 * condicionado devuelve solo las filas que toco, y cada escritura queda en un
 * registro. Con eso se miden tres cosas que una funcion pura no mide: cuantas
 * escrituras salieron, en que orden, y que pasa si dos aprobadores aprietan a
 * la vez.
 *
 * Mutaciones corridas (ver `_avance_fase10_2026-09-23.md`), cada una pone roja
 * al menos una prueba de aqui:
 *   · `permisoDeAccion` -> 'si' siempre: cada celda "No" deja de dar 403.
 *   · D101: quitar la espera de `confirmarAgregar` (lote/confirmar).
 *   · D102: quitar el permiso de gasto de `anular/proponer` y de `anular/confirmar`.
 *   · D106: quitar "distinto del autor" de `puedeAprobar` y de `decidirPuerta`.
 *   · D106: quitar `reclamarAprobacion` (dos aprobadores escriben dos veces).
 *   · D106: quitar el conteo de filas de `resolverAprobacionDeAbono`.
 *
 * Validez: esto mide el handler importado, no el Next vivo; el PostgREST es
 * simulado y solo reproduce lo que estas rutas piden.
 */
import { test, expect } from '@playwright/test'
import { sellarAgregar, type PayloadAgregar } from '@/lib/bot-envasado'
import { sellarAnulacion, type PayloadAnulacion } from '@/lib/bot-anulacion'
import { sellarCotizacion, type PayloadCotizacion } from '@/lib/bot-cotizacion'
import { CATEGORIA_ABONO_PENDIENTE } from '@/lib/finance-utils'
import * as gastoP from '@/app/api/bot/gasto/proponer/route'
import * as gastoC from '@/app/api/bot/gasto/confirmar/route'
import * as ventaP from '@/app/api/bot/venta/proponer/route'
import * as ventaC from '@/app/api/bot/venta/confirmar/route'
import * as abonoP from '@/app/api/bot/abono/proponer/route'
import * as abonoC from '@/app/api/bot/abono/confirmar/route'
import * as cotP from '@/app/api/bot/cotizacion/proponer/route'
import * as cotC from '@/app/api/bot/cotizacion/confirmar/route'
import * as loteP from '@/app/api/bot/lote/proponer/route'
import * as loteC from '@/app/api/bot/lote/confirmar/route'
import * as invP from '@/app/api/bot/inventario/proponer/route'
import * as invC from '@/app/api/bot/inventario/confirmar/route'
import * as convP from '@/app/api/bot/convertir/proponer/route'
import * as convC from '@/app/api/bot/convertir/confirmar/route'
import * as entP from '@/app/api/bot/entidad/proponer/route'
import * as entC from '@/app/api/bot/entidad/confirmar/route'
import * as miemP from '@/app/api/bot/miembro/proponer/route'
import * as miemC from '@/app/api/bot/miembro/confirmar/route'
import * as anuP from '@/app/api/bot/anular/proponer/route'
import * as anuC from '@/app/api/bot/anular/confirmar/route'
import * as aprL from '@/app/api/bot/aprobacion/route'
import * as aprC from '@/app/api/bot/aprobacion/confirmar/route'
import * as cancelar from '@/app/api/bot/cancelar/route'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = {
  'gasto/proponer': gastoP, 'gasto/confirmar': gastoC,
  'venta/proponer': ventaP, 'venta/confirmar': ventaC,
  'abono/proponer': abonoP, 'abono/confirmar': abonoC,
  'cotizacion/proponer': cotP, 'cotizacion/confirmar': cotC,
  'lote/proponer': loteP, 'lote/confirmar': loteC,
  'inventario/proponer': invP, 'inventario/confirmar': invC,
  'convertir/proponer': convP, 'convertir/confirmar': convC,
  'entidad/proponer': entP, 'entidad/confirmar': entC,
  'miembro/proponer': miemP, 'miembro/confirmar': miemC,
  'anular/proponer': anuP, 'anular/confirmar': anuC,
  aprobacion: aprL, 'aprobacion/confirmar': aprC,
  cancelar
}

const TOKEN = 'x'.repeat(32)
// El entorno falso se pone y se QUITA con el doble de `fetch` (abajo). Un
// worker de Playwright se reusa entre proyectos: puesto al cargar el modulo, la
// URL falsa (puerto 9) llegaba a las pruebas contra la base -> "fetch failed /
// bad port" en 31 de [equivalencia] (Fase 10, medido; solas: 37/37 verdes).
// Las rutas leen el entorno al atender, no al importarse.
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}

// ─── LAS PERSONAS ───────────────────────────────────────────────────────────
const NORMAN = 111
const KEVIN = 222
const GIL = 333 // DST
const LOC = 444
const SOCIO = 555 // rol que la tabla no conoce
const DESCONOCIDO = 999 // sin alta

// ─── EL POSTGREST SIMULADO, CON ESTADO ──────────────────────────────────────
type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let contador = 0

function estadoInicial(opts: { kevinConMarca?: boolean; gilConMarca?: boolean } = {}) {
  const ahora = new Date().toISOString()
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
      { id: 'dst-a', nombre: 'Gil', rol: 'DST', id_padre: null, id_nodo_padre: null },
      { id: 'loc-a1', nombre: 'Casa Verde', rol: 'LOC', id_padre: 'dst-a', id_nodo_padre: null },
      { id: 'dst-b', nombre: 'Otro', rol: 'DST', id_padre: null, id_nodo_padre: null },
      { id: 'ent-socio', nombre: 'Socio', rol: 'SOCIO', id_padre: null, id_nodo_padre: null }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-norman', activo: true, requiere_aprobacion: false, creado_en: '2026-01-01' },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-norman', activo: true, requiere_aprobacion: opts.kevinConMarca ?? true, creado_en: '2026-02-01' },
      { telegram_id: GIL, etiqueta: 'gil', id_entidad: 'dst-a', id_cuenta_destino: 'c-gil', activo: true, requiere_aprobacion: opts.gilConMarca ?? false, creado_en: '2026-03-01' },
      { telegram_id: LOC, etiqueta: 'casa_verde', id_entidad: 'loc-a1', id_cuenta_destino: 'c-loc', activo: true, requiere_aprobacion: false, creado_en: '2026-03-01' },
      { telegram_id: SOCIO, etiqueta: 'socio', id_entidad: 'ent-socio', id_cuenta_destino: 'c-socio', activo: true, requiere_aprobacion: false, creado_en: '2026-03-01' }
    ],
    cuentas_financieras: [
      { id: 'c-norman', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-gil', id_entidad: 'dst-a', nombre: 'Caja Gil', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-loc', id_entidad: 'loc-a1', nombre: 'Caja Local', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-socio', id_entidad: 'ent-socio', nombre: 'Caja Socio', tipo_fiscalidad: 'NO_FISCAL' }
    ],
    bot_borradores: [],
    bot_categorias: [],
    finanzas_ledger: [
      // Un abono que Gil capturo hace un rato: lo suyo, dentro de la ventana.
      { id: 'm-gil', fecha_movimiento: ahora, tipo_movimiento: 'ABONO_DEUDA', monto: 500, categoria: 'ABONO_REAL', descripcion: 'abono', id_ticket: null, usuario_creador: 'telegram:gil', status: 'ACTIVO', id_entidad_relacionada: 'loc-a1', id_cuenta_destino: 'c-norman' },
      // Lo suyo de LOC y de SOCIO: sin esto, su recaptura daria 403 por "no es
      // tuyo" y la prueba no ejerceria la tabla (medido con la mutacion M1).
      { id: 'm-loc', fecha_movimiento: ahora, tipo_movimiento: 'ABONO_DEUDA', monto: 50, categoria: 'ABONO_REAL', descripcion: 'abono', id_ticket: null, usuario_creador: 'telegram:casa_verde', status: 'ACTIVO', id_entidad_relacionada: 'loc-a1', id_cuenta_destino: 'c-loc' },
      { id: 'm-socio', fecha_movimiento: ahora, tipo_movimiento: 'ABONO_DEUDA', monto: 50, categoria: 'ABONO_REAL', descripcion: 'abono', id_ticket: null, usuario_creador: 'telegram:socio', status: 'ACTIVO', id_entidad_relacionada: 'ent-socio', id_cuenta_destino: 'c-socio' },
      // Un gasto de Norman.
      { id: 'm-norman', fecha_movimiento: ahora, tipo_movimiento: 'GASTO_OPERATIVO', monto: 100, categoria: 'Gasolina', descripcion: 'gasolina', id_ticket: null, usuario_creador: 'telegram:norman', status: 'ACTIVO', id_entidad_relacionada: null, id_cuenta_destino: 'c-norman' },
      // El abono PENDIENTE de Gil que espera Aprobar (D97).
      { id: 'm-pend', fecha_movimiento: ahora, tipo_movimiento: 'ABONO_DEUDA', monto: 300, categoria: CATEGORIA_ABONO_PENDIENTE, descripcion: 'abono', id_ticket: null, usuario_creador: 'telegram:gil', status: 'ACTIVO', id_entidad_relacionada: 'loc-a1', id_cuenta_destino: 'c-norman' }
    ],
    inventario_ledger: [],
    v_lote_rendimiento: [],
    cotizaciones: [],
    cotizacion_detalles: []
  }
  escrituras = []
}

function valorDeFiltro(v: string): string {
  return v.replace(/^"|"$/g, '')
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = expr.slice(i + 1)
  const actual = fila[col]
  if (op === 'eq') return String(actual) === valorDeFiltro(val)
  if (op === 'neq') return String(actual) !== valorDeFiltro(val)
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'gte') return String(actual) >= valorDeFiltro(val)
  if (op === 'lt') return actual !== null && actual !== undefined && String(actual) < valorDeFiltro(val)
  if (op === 'in') {
    const lista = val.replace(/^\(|\)$/g, '').split(',').map(valorDeFiltro)
    return lista.includes(String(actual))
  }
  // Un filtro que el doble no entiende NO se deja pasar: dejarlo pasar es como
  // un `or` sin probar paso inadvertido (E-367). order/limit/etc. ya se saltan
  // en `NO_FILTRAN`.
  throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function filtrar(tabla: string, params: URLSearchParams): Fila[] {
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of params.entries()) {
    if (NO_FILTRAN.has(col)) continue
    // `or=(a.is.null,a.lt.X)`: cumple si cumple alguna. Sin esto, `cumple` lo
    // dejaba pasar todo (op desconocida -> true) y el reclamo no se probaba.
    if (col === 'or') {
      const partes = expr.replace(/^\(|\)$/g, '').split(',')
      filas = filas.filter((f) =>
        partes.some((p) => {
          const k = p.indexOf('.')
          return cumple(f, p.slice(0, k), p.slice(k + 1))
        })
      )
      continue
    }
    filas = filas.filter((f) => cumple(f, col, expr))
  }
  return filas
}

/** `entidades!inner(rol)` y `cuentas_financieras!inner(nombre)`, los dos que se usan. */
function incrustar(tabla: string, filas: Fila[], select: string): Fila[] {
  if (tabla !== 'bot_identidades') return filas
  let salida = filas.map((f) => ({ ...f }))
  if (select.includes('entidades!inner')) {
    salida = salida
      .map((f) => ({ ...f, entidades: tablas.entidades.find((e) => e.id === f.id_entidad) ?? null }))
      .filter((f) => f.entidades)
  }
  if (select.includes('cuentas_financieras!inner')) {
    salida = salida
      .map((f) => ({ ...f, cuentas_financieras: tablas.cuentas_financieras.find((c) => c.id === f.id_cuenta_destino) ?? null }))
      .filter((f) => f.cuentas_financieras)
  }
  return salida
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
    return new Response(JSON.stringify({ filas_inventario: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = incrustar(tabla, filtrar(tabla, u.searchParams), u.searchParams.get('select') ?? '')
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      const nuevas = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((c: Fila) => ({
        id: `${tabla}-${++contador}`,
        folio: `COT-${contador}`,
        vigente_hasta: '2026-10-08',
        ...c
      }))
      ;(tablas[tabla] ??= []).push(...nuevas)
      filas = nuevas
    } else if (metodo === 'PATCH') {
      filas = filtrar(tabla, u.searchParams)
      for (const f of filas) Object.assign(f, cuerpo)
    } else if (metodo === 'DELETE') {
      filas = filtrar(tabla, u.searchParams)
      tablas[tabla] = (tablas[tabla] ?? []).filter((f) => !filas.includes(f))
    }
    if (!representacion && !objeto) return new Response(null, { status: 204 })
  }
  if (objeto) {
    if (filas.length !== 1) {
      return new Response(JSON.stringify({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }), {
        status: 406,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response(JSON.stringify(filas[0]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify(filas), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(filas.length - 1, 0)}/${filas.length}` }
  })
}

// El doble se pone y se QUITA. Un worker de Playwright corre varios archivos en
// el mismo proceso: puesto al cargar el modulo y sin devolverlo, el siguiente
// archivo del worker (las pruebas contra la base) heredaba el doble y fallaba
// con "fetch failed" (medido en la Fase 10: 32 rojas en [equivalencia], 37/37
// verdes corriendolas solas).
const fetchOriginal = globalThis.fetch
test.beforeAll(() => {
  for (const [k, v] of Object.entries(ENTORNO_FALSO)) {
    entornoOriginal[k] = process.env[k]
    process.env[k] = v
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Un respiro: sin el, dos handlers en paralelo nunca se intercalan.
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

function borrador(fila: Fila) {
  const b = { id: `b-${++contador}`, estado: 'PENDIENTE', chat_id: null, resuelto_en: null, ...fila }
  tablas.bot_borradores.push(b)
  return b as unknown as Fila & { id: string; sello: string; estado: string }
}

const deDinero = () => escrituras.filter((e) => !e.endsWith('bot_borradores'))

// ─── 1. CADA CELDA "NO" DE LA TABLA, DESDE LA RUTA ──────────────────────────
// [quien, accion, ruta, cuerpo]. Accion = la columna de la tabla de la Fase 9
// (con las decisiones de la Fase 10: convertir de un DST ya es 'si').
const MOV_PROPIO: Record<number, string> = { [GIL]: 'm-gil', [LOC]: 'm-loc', [SOCIO]: 'm-socio' }
const MIN = (id: number) => ({ telegram_id: id, propuesta: {} })
const VA = (id: number) => ({ telegram_id: id, borrador_id: 'b-no-existe', sello: 'a'.repeat(64) })
const RUTAS_DE: Record<string, [string, (id: number) => Record<string, unknown>][]> = {
  venta: [['venta/proponer', MIN], ['venta/confirmar', VA]],
  abono: [['abono/proponer', MIN], ['abono/confirmar', VA]],
  cotizacion: [['cotizacion/proponer', MIN], ['cotizacion/confirmar', VA]],
  gasto: [
    ['gasto/proponer', (id) => ({ telegram_id: id, propuesta: { monto: 100, descripcion: 'gasolina', categoria: 'Gasolina' } })],
    ['gasto/confirmar', VA],
    ['anular/proponer', (id) => ({ telegram_id: id, tabla: 'finanzas', id_movimiento: MOV_PROPIO[id] ?? 'm-norman', modo: 'recapturar', recaptura: { monto: 100, descripcion: 'gasolina', categoria: 'Gasolina' } })]
  ],
  lote: [['lote/proponer', MIN], ['lote/confirmar', VA]],
  entrada_insumo: [['inventario/proponer', MIN], ['inventario/confirmar', VA]],
  convertir: [['convertir/proponer', (id) => ({ telegram_id: id })], ['convertir/confirmar', VA]],
  entidad: [['entidad/proponer', (id) => ({ telegram_id: id, propuesta: { nombre: 'Bar Nuevo', rol: 'LOC' } })], ['entidad/confirmar', VA]],
  registrar: [
    ['miembro/proponer', (id) => ({ telegram_id: id, miembro_telegram_id: 777, texto: 'este es Pepe' })],
    ['miembro/confirmar', VA]
  ]
}
const CELDAS_NO: [string, number, string][] = [
  // DST
  ['DST', GIL, 'gasto'], ['DST', GIL, 'lote'], ['DST', GIL, 'entrada_insumo'], ['DST', GIL, 'entidad'], ['DST', GIL, 'registrar'],
  // LOC: nada
  ...(['venta', 'abono', 'cotizacion', 'gasto', 'lote', 'entrada_insumo', 'convertir', 'entidad', 'registrar'] as const).map(
    (a) => ['LOC', LOC, a] as [string, number, string]
  ),
  // Kevin: registrar
  ['Kevin', KEVIN, 'registrar'],
  // Un rol que la tabla no conoce: nada
  ...(['venta', 'gasto', 'cotizacion'] as const).map((a) => ['SOCIO', SOCIO, a] as [string, number, string]),
  // Sin alta: nada
  ...(['venta', 'gasto', 'cotizacion', 'entidad'] as const).map((a) => ['desconocido', DESCONOCIDO, a] as [string, number, string])
]

test.describe('D103 — cada celda "No" de la tabla da 403 desde la ruta, sin escribir', () => {
  for (const [nombre, id, accion] of CELDAS_NO) {
    for (const [ruta, cuerpo] of RUTAS_DE[accion]) {
      test(`${nombre} x ${accion} en ${ruta} -> 403`, async () => {
        estadoInicial()
        const r = await llamar(ruta, cuerpo(id))
        expect(r.status, JSON.stringify(r.j)).toBe(403)
        expect(escrituras).toEqual([])
      })
    }
  }

  test('anular/confirmar: la recaptura de un DST sellada y valida -> 403, 0 escrituras', async () => {
    for (const [id, etiqueta, mov] of [[GIL, 'gil', 'm-gil'], [LOC, 'casa_verde', 'm-loc']] as const) {
      estadoInicial()
      const fila: PayloadAnulacion = {
        modo: 'recapturar', tabla: 'finanzas', id_movimiento: mov, id_ticket: null,
        usuario_creador: `telegram:${etiqueta}`,
        recaptura: { monto: 100 } as unknown as PayloadAnulacion['recaptura'],
        descripcion_nueva: null
      }
      const sello = sellarAnulacion(fila)
      const b = borrador({ telegram_id: id, sello, payload: { tipo: 'anulacion', fila, meta: {} } })
      const r = await llamar('anular/confirmar', { telegram_id: id, borrador_id: b.id, sello })
      expect(r.status, JSON.stringify(r.j)).toBe(403)
      expect(escrituras).toEqual([])
    }
  })
})

// ─── 2. D102 — ANULAR PASA POR LA TABLA ─────────────────────────────────────
test.describe('D102 — recapturar pide el permiso del gasto; anular puro, como hoy', () => {
  const RECAPTURA = { monto: 100, descripcion: 'gasolina', categoria: 'Gasolina' }

  test('CONTROL: Norman recaptura su gasto -> 200 (borrador, nada de dinero)', async () => {
    estadoInicial()
    const r = await llamar('anular/proponer', { telegram_id: NORMAN, tabla: 'finanzas', id_movimiento: 'm-norman', modo: 'recapturar', recaptura: RECAPTURA })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(deDinero()).toEqual([])
  })

  test('CONTROL: LOC anula lo suyo, como hoy (anular puro no pasa por la tabla) -> 200', async () => {
    estadoInicial()
    const r = await llamar('anular/proponer', { telegram_id: LOC, tabla: 'finanzas', id_movimiento: 'm-loc', modo: 'anular' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
  })

  test('CONTROL: un DST anula lo suyo, como hoy -> 200', async () => {
    estadoInicial()
    const r = await llamar('anular/proponer', { telegram_id: GIL, tabla: 'finanzas', id_movimiento: 'm-gil', modo: 'anular' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
  })

  test('DST y LOC recapturando -> 403', async () => {
    for (const id of [GIL, LOC]) {
      estadoInicial()
      const r = await llamar('anular/proponer', { telegram_id: id, tabla: 'finanzas', id_movimiento: MOV_PROPIO[id], modo: 'recapturar', recaptura: RECAPTURA })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
      expect(escrituras).toEqual([])
    }
  })
})

// ─── 3. D101 — lote_agregar ESPERA el Aprobar de Norman ─────────────────────
test.describe('D101 — agregar a un lote con el VA de Kevin no escribe', () => {
  const AGREGAR: PayloadAgregar = {
    id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:kevin',
    entradas: [], tandas: [], envasado: []
  }

  test('Kevin VA -> ESPERA_APROBACION, 0 registrar_en_lote; Aprobar de Norman -> 1', async () => {
    estadoInicial()
    const sello = sellarAgregar(AGREGAR)
    const b = borrador({ telegram_id: KEVIN, sello, payload: { tipo: 'lote_agregar', agregar: AGREGAR } })

    const va = await llamar('lote/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(va.status, JSON.stringify(va.j)).toBe(200)
    expect(va.j.espera_aprobacion).toBe(true)
    expect(va.j.avisar_a).toEqual([NORMAN])
    expect(escrituras.filter((e) => e.includes('registrar_en_lote'))).toHaveLength(0)
    expect(b.estado).toBe('ESPERA_APROBACION')

    const ok = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(ok.j.ok).toBe(true)
    expect(escrituras.filter((e) => e.includes('registrar_en_lote'))).toHaveLength(1)
    expect(b.estado).toBe('CONFIRMADO')
  })

  test('CONTROL: el VA de Norman sobre lo suyo escribe directo', async () => {
    estadoInicial()
    const mio = { ...AGREGAR, usuario_creador: 'telegram:norman' }
    const sello = sellarAgregar(mio)
    const b = borrador({ telegram_id: NORMAN, sello, payload: { tipo: 'lote_agregar', agregar: mio } })
    const r = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(escrituras.filter((e) => e.includes('registrar_en_lote'))).toHaveLength(1)
  })
})

// ─── 4. D106 — NORMAN Y KEVIN APRUEBAN; NADIE APRUEBA LO SUYO ───────────────
test.describe('D106 — maker-checker en el handler', () => {
  function abonoPendiente() {
    return borrador({
      telegram_id: GIL,
      estado: 'CONFIRMADO',
      sello: 'b'.repeat(64),
      payload: { tipo: 'abono', meta: { ids_pendientes: ['m-pend'], nombre_deudor: 'Casa Verde' } }
    })
  }

  test('Kevin aprueba el abono pendiente de un DST -> 1 escritura', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const r = await llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(deDinero()).toEqual(['PATCH finanzas_ledger'])
    expect(String(r.j.mensaje)).toContain('por Kevin')
  })

  test('Norman y Kevin aprueban el mismo abono A LA VEZ -> 1 sola escritura', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const [a, k] = await Promise.all([
      llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, accion: 'aprobar' }),
      llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' })
    ])
    expect([a.status, k.status].sort()).toEqual([200, 409])
    const patchesQueTocaron = tablas.finanzas_ledger.filter((f) => f.id === 'm-pend' && f.categoria === 'ABONO_REAL')
    expect(patchesQueTocaron).toHaveLength(1)
    // Con una cuenta FULL_TAX el segundo escribiria reservas otra vez; aqui la
    // senal es la respuesta: el segundo dice "ya fue procesado".
    const segundo = a.status === 409 ? a : k
    expect(segundo.j.ya_procesado).toBe(true)
  })

  test('Norman y Kevin aprueban A LA VEZ el abono en cuenta FULL_TAX -> reservas una sola vez', async () => {
    estadoInicial()
    tablas.cuentas_financieras.find((c) => c.id === 'c-norman')!.tipo_fiscalidad = 'FULL_TAX'
    const b = abonoPendiente()
    await Promise.all([
      llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, accion: 'aprobar' }),
      llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' })
    ])
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toHaveLength(1)
  })

  test('Kevin aprueba lo suyo -> 403 (con marca)', async () => {
    estadoInicial()
    const AG: PayloadAgregar = { id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:kevin', entradas: [], tandas: [], envasado: [] }
    const sello = sellarAgregar(AG)
    const b = borrador({ telegram_id: KEVIN, estado: 'ESPERA_APROBACION', sello, payload: { tipo: 'lote_agregar', agregar: AG } })
    const l = await llamar('aprobacion', { telegram_id: KEVIN, borrador_id: b.id })
    expect(l.status, JSON.stringify(l.j)).toBe(403)
    const c = await llamar('lote/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(c.status, JSON.stringify(c.j)).toBe(403)
    expect(deDinero()).toEqual([])
  })

  test('Kevin aprueba lo suyo -> 403 AUNQUE ya no tenga marca (solo "distinto del autor" lo para)', async () => {
    // El caso que aisla la regla: Kevin propuso con marca (espera) y despues le
    // quitaron la marca. La regla de "lo de Kevin, Norman" ya no aplica; lo
    // unico que queda de pie es "nadie aprueba lo suyo".
    estadoInicial({ kevinConMarca: false })
    const AG: PayloadAgregar = { id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:kevin', entradas: [], tandas: [], envasado: [] }
    const sello = sellarAgregar(AG)
    const b = borrador({ telegram_id: KEVIN, estado: 'ESPERA_APROBACION', sello, payload: { tipo: 'lote_agregar', agregar: AG } })
    const l = await llamar('aprobacion', { telegram_id: KEVIN, borrador_id: b.id })
    expect(l.status, JSON.stringify(l.j)).toBe(403)
    const c = await llamar('lote/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(c.status, JSON.stringify(c.j)).toBe(403)
    expect(deDinero()).toEqual([])
  })

  test('un DST no aprueba el abono pendiente de nadie -> 403', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const r = await llamar('aprobacion/confirmar', { telegram_id: LOC, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('Kevin NO aprueba lo que propone Kevin; el aviso le llega solo a Norman', async () => {
    estadoInicial()
    const AG: PayloadAgregar = { id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:kevin', entradas: [], tandas: [], envasado: [] }
    const sello = sellarAgregar(AG)
    const b = borrador({ telegram_id: KEVIN, sello, payload: { tipo: 'lote_agregar', agregar: AG } })
    const va = await llamar('lote/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(va.j.avisar_a).toEqual([NORMAN])
  })

  // Lo que espera de un TERCERO con marca (un DST con `requiere_aprobacion`):
  // lo aprueban Norman o Kevin, el primero gana. La carrera de verdad.
  function cotizacionDeGil() {
    const cot: PayloadCotizacion = {
      id_vendedor: 'dst-a', id_comprador: 'loc-a1', nombre_prospecto: null, zona: 'LOCAL',
      vigencia_dias: 15, total: 960, notas: '', usuario_creador: 'telegram:gil',
      items: [{ id_producto: 'p1', cantidad: 2, precio_unitario: 480 }]
    }
    const sello = sellarCotizacion(cot)
    const b = borrador({ telegram_id: GIL, sello, payload: { tipo: 'cotizacion', cotizacion: cot, meta: {} } })
    return { b, sello }
  }

  test('Gil con marca: su VA espera y el aviso les llega a Norman y a Kevin', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    const va = await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect([...(va.j.avisar_a as number[])].sort()).toEqual([NORMAN, KEVIN])
    expect(deDinero()).toEqual([])
  })

  test('Norman y Kevin aprueban A LA VEZ lo que espera de Gil -> 1 sola cotizacion', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const [n, k] = await Promise.all([
      llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello }),
      llamar('cotizacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    ])
    expect([n.status, k.status].sort(), JSON.stringify([n.j, k.j])).toEqual([200, 409])
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
    expect(b.estado).toBe('CONFIRMADO')
  })

  // El reclamo caduca: si la escritura del primero fallo, el borrador no queda
  // bloqueado para siempre. Mutacion: volver a `.is('resuelto_en', null)`.
  test('reclamo huerfano (hace 5 min, la escritura fallo) -> el siguiente Aprobar escribe', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    ;(b as Fila).resuelto_en = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status, JSON.stringify(n.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
  })

  test('CONTROL: reclamo de hace 10 s (otro esta escribiendo) -> 409 y no escribe', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    ;(b as Fila).resuelto_en = new Date(Date.now() - 10 * 1000).toISOString()
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status, JSON.stringify(n.j)).toBe(409)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(0)
  })

  test('CONTROL: uno solo aprueba lo de Gil -> 1 cotizacion, y el segundo (despues) ve que ya se resolvio', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const k = await llamar('cotizacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(k.status, JSON.stringify(k.j)).toBe(200)
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status).toBe(409)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
  })

  test('Rechazar: Kevin rechaza lo de Gil (si); lo de Kevin, Kevin no lo "rechaza como aprobador"', async () => {
    estadoInicial({ gilConMarca: true })
    const { b } = cotizacionDeGil()
    b.estado = 'ESPERA_APROBACION'
    const r = await llamar('cancelar', { telegram_id: KEVIN, borrador_id: b.id })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.rechazado).toBe(true)
  })
})

// ─── 5. D106 — CONVERTIR: UN DST SOLO LAS SUYAS ─────────────────────────────
test.describe('D106 — un DST convierte solo SUS cotizaciones', () => {
  function cotizaciones() {
    const hoy = new Date().toISOString().slice(0, 10)
    tablas.cotizaciones.push(
      { id: 'cot-gil', folio: 'COT-9001', fecha: hoy, estado: 'VIGENTE', zona: 'LOCAL', total: 960, id_comprador: 'loc-a1', nombre_prospecto: null, vigente_hasta: '2026-12-31', id_vendedor: 'dst-a', id_ticket: null },
      { id: 'cot-matriz', folio: 'COT-9002', fecha: hoy, estado: 'VIGENTE', zona: 'LOCAL', total: 960, id_comprador: 'loc-a1', nombre_prospecto: null, vigente_hasta: '2026-12-31', id_vendedor: 'ent-matriz', id_ticket: null }
    )
  }

  test('la lista de un DST trae solo las suyas', async () => {
    estadoInicial()
    cotizaciones()
    const r = await llamar('convertir/proponer', { telegram_id: GIL })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    const ids = (r.j.opciones as { id: string }[]).map((o) => o.id)
    expect(ids).toEqual(['cot-gil'])
  })

  test('la cotizacion de otro -> 403', async () => {
    estadoInicial()
    cotizaciones()
    const r = await llamar('convertir/proponer', { telegram_id: GIL, id_cotizacion: 'cot-matriz' })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('CONTROL: Norman ve las dos', async () => {
    estadoInicial()
    cotizaciones()
    const r = await llamar('convertir/proponer', { telegram_id: NORMAN })
    const ids = (r.j.opciones as { id: string }[]).map((o) => o.id).sort()
    expect(ids).toEqual(['cot-gil', 'cot-matriz'])
  })
})
