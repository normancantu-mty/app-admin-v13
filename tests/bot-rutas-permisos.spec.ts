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
import { sellarConversion, type PayloadConversion } from '@/lib/bot-conversion'
import { sellarAlta, type PayloadAlta } from '@/lib/bot-entidad'
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
import * as entregaP from '@/app/api/bot/entrega/proponer/route'
import * as entregaC from '@/app/api/bot/entrega/confirmar/route'
import { sellarEntrega, type PayloadEntrega } from '@/lib/bot-entrega'
import { CRISTIAN_TELEGRAM_ID, NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { sellarMiembro } from '@/lib/bot-miembro'
import * as catP from '@/app/api/bot/categoria/proponer/route'
import * as catC from '@/app/api/bot/categoria/confirmar/route'
import * as consultaR from '@/app/api/bot/consulta/route'
import * as botellasR from '@/app/api/bot/botellas/route'
import * as pulsoR from '@/app/api/bot/pulso/route'
import { validarAltaCategoria } from '@/lib/categorias-movimiento'

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
  'entrega/proponer': entregaP, 'entrega/confirmar': entregaC,
  'categoria/proponer': catP, 'categoria/confirmar': catC,
  consulta: consultaR,
  botellas: botellasR,
  pulso: pulsoR,
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
// Auditoria 2026-11-03 (hallazgo 1): Norman es SU telegram_id, no "ADMIN sin marca".
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222
const GIL = 333 // DST
const LOC = 444
const SOCIO = 555 // rol que la tabla no conoce
const DESCONOCIDO = 999 // sin alta
// Auditoria 2026-11-03 (hallazgo 7): un ADMIN SIN marca que NO es Norman. Con
// c2a04db escribia directo; ahora propone y espera. Se da de alta solo en las
// pruebas que lo usan (`conLuis`).
const LUIS = 666

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

  // 2026-11-03 (Norman: "...espera MI click"): el Aprobar es SOLO de Norman.
  // Antes (D106) Kevin tambien aprobaba; estas pruebas dicen lo nuevo.
  test('2026-11-03: Kevin NO aprueba el abono pendiente de un DST -> 403, 0 escrituras', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const r = await llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(deDinero()).toEqual([])
  })

  test('CONTROL: Norman aprueba el abono pendiente de un DST -> 1 escritura', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const r = await llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(deDinero()).toEqual(['PATCH finanzas_ledger'])
  })

  test('Norman aprueba el mismo abono DOS VECES A LA VEZ -> 1 sola escritura', async () => {
    estadoInicial()
    const b = abonoPendiente()
    const [a, k] = await Promise.all([
      llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, accion: 'aprobar' }),
      llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, accion: 'aprobar' })
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

  test('Gil con marca: su VA espera y el aviso le llega SOLO a Norman (2026-11-03)', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    const va = await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect([...(va.j.avisar_a as number[])].sort()).toEqual([NORMAN])
    expect(deDinero()).toEqual([])
  })

  test('Norman aprueba DOS VECES A LA VEZ lo que espera de Gil -> 1 sola cotizacion', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const [n, k] = await Promise.all([
      llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello }),
      llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    ])
    expect([n.status, k.status].sort(), JSON.stringify([n.j, k.j])).toEqual([200, 409])
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
    expect(b.estado).toBe('CONFIRMADO')
  })

  // FASE 11 (D107): el reclamo YA NO caduca. Un reclamo puesto en un borrador
  // que sigue en espera = alguien empezo a escribir y no termino de marcar: no
  // se sabe si escribio, asi que no se repite. Hasta la Fase 10 esta prueba
  // decia lo contrario ("a los 5 min el siguiente escribe"): eso es justo la
  // doble escritura que midio el auditor (AUD10 b-i, abajo).
  // Mutacion: volver a `.or(resuelto_en.is.null,resuelto_en.lt.<hace 2 min>)`.
  test('D107: reclamo huerfano de hace 5 min -> 409 trabado, no escribe', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    ;(b as Fila).resuelto_en = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status, JSON.stringify(n.j)).toBe(409)
    expect(n.j.trabado).toBe(true)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(0)
  })

  // Y lo que reemplaza a la caducidad: si la escritura falla ANTES de escribir,
  // la ruta suelta el reclamo ella misma. Mutacion: quitar `liberarReclamo` de
  // la rama de error de la cabecera -> el segundo Aprobar da 409 trabado.
  test('D107: la escritura fallo sin escribir -> la ruta suelta el reclamo y el siguiente Aprobar escribe 1', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/rest/v1/cotizaciones')) {
        return new Response(JSON.stringify({ message: 'timeout' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return f(input, init)
    }) as typeof fetch
    let n
    try {
      n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    } finally {
      globalThis.fetch = f
    }
    expect(n.status, JSON.stringify(n.j)).toBe(500)
    expect((b as Fila).resuelto_en ?? null).toBeNull()
    const k = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(k.status, JSON.stringify(k.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
    expect(b.estado).toBe('CONFIRMADO')
  })

  // La marca final se REVISA y el reclamo se queda: quien aprobo se entera.
  test('D107: la marca CONFIRMADO falla -> 200 con aviso_marca y el reclamo sigue puesto', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.includes('bot_borradores') && String(init?.body).includes('CONFIRMADO')) {
        return new Response(JSON.stringify({ message: 'timeout' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return f(input, init)
    }) as typeof fetch
    let n
    try {
      n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    } finally {
      globalThis.fetch = f
    }
    expect(n.status, JSON.stringify(n.j)).toBe(200)
    expect(String(n.j.aviso_marca ?? '')).toContain('No se va a repetir')
    expect(b.estado).toBe('ESPERA_APROBACION')
    expect((b as Fila).resuelto_en).toBeTruthy()
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

  test('2026-11-03: el clic de Kevin sobre lo de Gil NO escribe; el de Norman si, y el segundo ve que ya se resolvio', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotizacionDeGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const k = await llamar('cotizacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(k.status, JSON.stringify(k.j)).toBe(403)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(0)
    expect(b.estado).toBe('ESPERA_APROBACION')
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status, JSON.stringify(n.j)).toBe(200)
    const n2 = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n2.status).toBe(409)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
  })

  test('Rechazar (2026-11-03): Kevin NO rechaza lo de Gil; Norman si', async () => {
    estadoInicial({ gilConMarca: true })
    const { b } = cotizacionDeGil()
    b.estado = 'ESPERA_APROBACION'
    const k = await llamar('cancelar', { telegram_id: KEVIN, borrador_id: b.id })
    expect(k.status, JSON.stringify(k.j)).toBe(403)
    expect(b.estado).toBe('ESPERA_APROBACION')
    const r = await llamar('cancelar', { telegram_id: NORMAN, borrador_id: b.id })
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

// ─── 6. FASE 11 (D107/D108) — LAS PRUEBAS DEL AUDITOR DE LA FASE 10 ────────
// Copiadas de `Fresnillo/ERP_Fresnillo/DESDE_SOCIO_arnes_auditoria_fase9/aud10-extra.spec.ts`
// (mismo arnes, byte a byte). Vigilan tres guardas que el arnes no vigilaba:
// `puedeCancelar` (a5: LOC cancela lo de Gil -> 403), el dueno en
// `convertir/confirmar` (d) y `permitido` en `aprobacion/confirmar` (a1/a2).
// b-i es la doble escritura de D107: roja con la caducidad de 2 min.
// ════════════════ AUD10 — pruebas del auditor ════════════════

function abonoPend(dueno: number) {
  return borrador({
    telegram_id: dueno, estado: 'CONFIRMADO', sello: 'b'.repeat(64),
    payload: { tipo: 'abono', meta: { ids_pendientes: ['m-pend'], nombre_deudor: 'Casa Verde' } }
  })
}
function cotGil() {
  const cot: PayloadCotizacion = {
    id_vendedor: 'dst-a', id_comprador: 'loc-a1', nombre_prospecto: null, zona: 'LOCAL',
    vigencia_dias: 15, total: 960, notas: '', usuario_creador: 'telegram:gil',
    items: [{ id_producto: 'p1', cantidad: 2, precio_unitario: 480 }]
  }
  const sello = sellarCotizacion(cot)
  const b = borrador({ telegram_id: GIL, sello, payload: { tipo: 'cotizacion', cotizacion: cot, meta: {} } })
  return { b, sello }
}

test.describe('AUD10 maker-checker', () => {
  test('AUD10 a1: DST (Gil) aprueba abono pendiente ajeno -> 403, 0 escrituras', async () => {
    estadoInicial()
    const b = abonoPend(LOC)
    const r = await llamar('aprobacion/confirmar', { telegram_id: GIL, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status).toBe(403)
    expect(escrituras).toEqual([])
  })
  test('AUD10 a2: Kevin aprueba abono pendiente cuyo autor es Kevin -> 403', async () => {
    estadoInicial()
    const b = abonoPend(KEVIN)
    const r = await llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' })
    expect(r.status).toBe(403)
    expect(escrituras).toEqual([])
  })
  test('AUD10 a3: Norman aprueba lo suyo en ESPERA -> 403', async () => {
    estadoInicial()
    const AG: PayloadAgregar = { id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:norman', entradas: [], tandas: [], envasado: [] }
    const sello = sellarAgregar(AG)
    const b = borrador({ telegram_id: NORMAN, estado: 'ESPERA_APROBACION', sello, payload: { tipo: 'lote_agregar', agregar: AG } })
    const c = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(c.status, JSON.stringify(c.j)).toBe(403)
    const a = await llamar('aprobacion/confirmar', { telegram_id: NORMAN, borrador_id: abonoPend(NORMAN).id, accion: 'aprobar' })
    expect(a.status).toBe(403)
    expect(deDinero()).toEqual([])
  })
  test('AUD10 a4: Norman aprueba lo de Kevin (lote_agregar) -> escribe 1', async () => {
    estadoInicial()
    const AG: PayloadAgregar = { id_lote: 'lote-1', codigo_lote: 'L-1', usuario_creador: 'telegram:kevin', entradas: [], tandas: [], envasado: [] }
    const sello = sellarAgregar(AG)
    const b = borrador({ telegram_id: KEVIN, estado: 'ESPERA_APROBACION', sello, payload: { tipo: 'lote_agregar', agregar: AG } })
    const c = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(escrituras.filter((e) => e.includes('registrar_en_lote'))).toHaveLength(1)
  })
  test('AUD10 a5: DST y LOC aprueban cotizacion en espera de Gil -> 403; LOC cancela lo de Gil -> 403', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(b.estado).toBe('ESPERA_APROBACION')
    for (const id of [LOC, SOCIO]) {
      const r = await llamar('cotizacion/confirmar', { telegram_id: id, borrador_id: b.id, sello })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
    }
    const c = await llamar('cancelar', { telegram_id: LOC, borrador_id: b.id })
    expect(c.status, JSON.stringify(c.j)).toBe(403)
    const l = await llamar('aprobacion', { telegram_id: LOC, borrador_id: b.id })
    expect(l.status).toBe(403)
    expect(deDinero()).toEqual([])
  })
  test('AUD10 b-i: la escritura de Norman sale pero el CONFIRMADO falla; a los 3 min Kevin aprueba -> ¿doble?', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotGil()
    await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if ((init?.method ?? 'GET').toUpperCase() === 'PATCH' && url.includes('bot_borradores') && String(init?.body).includes('CONFIRMADO')) {
        return new Response(JSON.stringify({ message: 'timeout' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      return f(input, init)
    }) as typeof fetch
    let n
    try {
      n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    } finally {
      globalThis.fetch = f
    }
    console.log('AUD10 b-i Norman:', n.status, 'estado', b.estado, 'resuelto_en', (b as Fila).resuelto_en)
    ;(b as Fila).resuelto_en = new Date(Date.now() - 3 * 60 * 1000).toISOString()
    const k = await llamar('cotizacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    const posts = escrituras.filter((e) => e === 'POST cotizaciones').length
    console.log('AUD10 b-i Kevin:', k.status, 'POST cotizaciones =', posts)
    expect(posts).toBe(1)
  })
  test('AUD10 b-ii: borrador CONFIRMADO con reclamo viejo -> Aprobar no escribe', async () => {
    estadoInicial({ gilConMarca: true })
    const { b, sello } = cotGil()
    b.estado = 'CONFIRMADO'
    ;(b as Fila).resuelto_en = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const k = await llamar('cotizacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(k.status).toBe(409)
    expect(deDinero()).toEqual([])
  })
  test('AUD10 b-iii: dos aprobaciones del abono (bot + web simulada) concurrentes -> 1 PATCH que toca, 1 POST reservas', async () => {
    estadoInicial()
    tablas.cuentas_financieras.find((c) => c.id === 'c-norman')!.tipo_fiscalidad = 'FULL_TAX'
    const { resolverAprobacionDeAbono } = await import('@/lib/aprobacion-abonos')
    const { clienteDeServicio } = await import('@/lib/bot-servidor')
    const b = abonoPend(GIL)
    const sb = clienteDeServicio(new Request('http://localhost/'))
    const [x, y] = await Promise.all([
      llamar('aprobacion/confirmar', { telegram_id: KEVIN, borrador_id: b.id, accion: 'aprobar' }),
      resolverAprobacionDeAbono(sb, 'm-pend', 'APPROVE')
    ])
    console.log('AUD10 b-iii', x.status, JSON.stringify(y))
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toHaveLength(1)
  })
})

test.describe('AUD10 convertir y alta', () => {
  test('AUD10 d: Gil confirma una conversion SELLADA de la cotizacion de la matriz -> 403', async () => {
    estadoInicial()
    const hoy = new Date().toISOString().slice(0, 10)
    tablas.cotizaciones.push({ id: 'cot-matriz', folio: 'COT-9002', fecha: hoy, estado: 'VIGENTE', zona: 'LOCAL', total: 960, id_comprador: 'loc-a1', nombre_prospecto: null, vigente_hasta: '2026-12-31', id_vendedor: 'ent-matriz', id_ticket: null })
    const fila: PayloadConversion = {
      id_cotizacion: 'cot-matriz', folio: 'COT-9002', usuario_creador: 'telegram:gil',
      venta: { id_vendedor: 'dst-a', id_comprador: 'loc-a1', id_cuenta_destino: 'c-gil', condicion_pago: 'CONTADO', items: [{ id_producto: 'p1', cantidad: 2, precio_unitario: 480 }] as never, subtotal_catalogo: 960, total_cobrado_real: 960, usuario_creador: 'telegram:gil' }
    }
    const sello = sellarConversion(fila)
    const b = borrador({ telegram_id: GIL, sello, payload: { tipo: 'conversion', fila } })
    const r = await llamar('convertir/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(deDinero()).toEqual([])
  })
  function alta(etq: string): PayloadAlta {
    void etq
    return { nombre: 'Bar Nuevo', rol: 'LOC', zona: 'LOCAL', email: null, telefono: null, id_nodo_padre: null, comision_base: 0, comision_base_local: 0, comision_hijo_local: 0 } as unknown as PayloadAlta
  }
  test('AUD10 e: Kevin da VA a un alta -> ESPERA, 0 escrituras; DST/LOC confirmar -> 403', async () => {
    estadoInicial()
    const fila = alta('kevin')
    const sello = sellarAlta(fila)
    const b = borrador({ telegram_id: KEVIN, sello, payload: { tipo: 'alta_entidad', fila, meta: { id_entidad: 'x', nombrePadre: null, avisos: [] } } })
    const r = await llamar('entidad/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.espera_aprobacion).toBe(true)
    expect(deDinero()).toEqual([])
    for (const id of [GIL, LOC]) {
      const x = await llamar('entidad/confirmar', { telegram_id: id, borrador_id: b.id, sello })
      expect(x.status).toBe(403)
    }
  })
  test('AUD10 e2: Norman propone alta -> 200', async () => {
    estadoInicial()
    const r = await llamar('entidad/proponer', { telegram_id: NORMAN, propuesta: { nombre: 'Bar Nuevo', rol: 'LOC' } })
    console.log('AUD10 e2', r.status, JSON.stringify(r.j).slice(0, 160))
    expect(r.status).not.toBe(403)
  })
})

// ─── FASE 11 (D112) — LA ENTREGA DE EFECTIVO, DESDE LA RUTA ─────────────────
// Un DST solo registra la suya; su VA espera el Aprobar; el Aprobar escribe UNA
// fila marcada. Celda "No": el DST con la entrega de OTRO (al proponer y al
// confirmar un borrador sellado), LOC, un rol sin tabla y sin alta.
// Mutaciones (ver `_avance_fase11_2026-09-23.md`, D112):
//   · `decidirEntrega` sin "solo la suya" -> rojo (celdas del DST ajeno).
//   · confirmar sin `siempreEspera` -> rojo (el VA del DST escribiria).
//   · `filaDeEntrega` sin la marca -> rojo (la fila aprobada).
test.describe('D112 — entrega de efectivo, desde la ruta', () => {
  function entrega(opts: Partial<PayloadEntrega> = {}): PayloadEntrega {
    return {
      id_entidad: 'dst-a', monto: 1500, id_cuenta_origen: 'c-gil', id_cuenta_destino: 'c-norman',
      fecha_movimiento: '2026-09-24T18:00:00.000Z', usuario_creador: 'telegram:gil', nota: '', ...opts
    }
  }
  function borradorDeEntrega(autor: number, p: PayloadEntrega) {
    const sello = sellarEntrega(p)
    const b = borrador({ telegram_id: autor, sello, payload: { tipo: 'entrega_efectivo', entrega: p, meta: { nombre: 'Gil', rol: 'DST', nombre_cuenta_origen: 'Caja Gil', nombre_cuenta_destino: 'Efectivo' } } })
    return { b, sello }
  }

  test('celda No: Gil (DST) propone la entrega de OTRO DST -> 403, 0 escrituras', async () => {
    estadoInicial()
    tablas.cuentas_financieras.push({ id: 'c-otro', id_entidad: 'dst-b', nombre: 'Caja Otro', tipo_fiscalidad: 'NO_FISCAL' })
    for (const cuerpo of [{ id_entidad: 'dst-b' }, { entidad: 'Otro' }]) {
      const r = await llamar('entrega/proponer', { telegram_id: GIL, monto: 500, ...cuerpo })
      expect(r.status, JSON.stringify(r.j)).toBe(403)
    }
    expect(escrituras).toEqual([])
  })

  test('celda No: Gil confirma un borrador SELLADO con la entrega de otro -> 403, 0 dinero', async () => {
    estadoInicial()
    tablas.cuentas_financieras.push({ id: 'c-otro', id_entidad: 'dst-b', nombre: 'Caja Otro', tipo_fiscalidad: 'NO_FISCAL' })
    const { b, sello } = borradorDeEntrega(GIL, entrega({ id_entidad: 'dst-b', id_cuenta_origen: 'c-otro' }))
    const r = await llamar('entrega/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(deDinero()).toEqual([])
    expect(b.estado).toBe('PENDIENTE')
  })

  test('celda No: LOC, un rol sin tabla y sin alta -> 403 al proponer', async () => {
    for (const id of [LOC, SOCIO, DESCONOCIDO]) {
      estadoInicial()
      const r = await llamar('entrega/proponer', { telegram_id: id, monto: 500 })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
      expect(escrituras).toEqual([])
    }
  })

  test('Gil propone LA SUYA sin nombre -> 200, solo el borrador (nada de dinero)', async () => {
    estadoInicial()
    const r = await llamar('entrega/proponer', { telegram_id: GIL, monto: '1,500' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.id_entidad).toBe('dst-a')
    expect(deDinero()).toEqual([])
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila
    expect((b.payload as { entrega: PayloadEntrega }).entrega).toMatchObject({ id_entidad: 'dst-a', monto: 1500, id_cuenta_origen: 'c-gil', id_cuenta_destino: 'c-norman' })
  })

  test('el VA de Gil ESPERA (0 dinero); el Aprobar de Norman escribe UNA fila marcada; el de Kevin despues no escribe', async () => {
    estadoInicial()
    const { b, sello } = borradorDeEntrega(GIL, entrega())
    const va = await llamar('entrega/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(va.status, JSON.stringify(va.j)).toBe(200)
    expect(va.j.espera_aprobacion).toBe(true)
    expect(deDinero()).toEqual([])
    expect(b.estado).toBe('ESPERA_APROBACION')

    const lee = await llamar('aprobacion', { telegram_id: NORMAN, borrador_id: b.id })
    expect(lee.j.tipo).toBe('entrega_efectivo')

    const ok = await llamar('entrega/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toHaveLength(1)
    const fila = tablas.finanzas_ledger.at(-1) as Fila
    expect(fila).toMatchObject({
      tipo_movimiento: 'ABONO_DEUDA', es_entrega_efectivo: true, categoria: 'ABONO_REAL',
      id_entidad_relacionada: 'dst-a', id_ticket: null, monto: 1500, usuario_creador: 'telegram:gil'
    })
    expect(b.estado).toBe('CONFIRMADO')

    const otra = await llamar('entrega/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(otra.status).not.toBe(200)
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toHaveLength(1)
  })

  test('Gil NO aprueba su propia entrega -> 403', async () => {
    estadoInicial()
    const { b, sello } = borradorDeEntrega(GIL, entrega())
    await llamar('entrega/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    const r = await llamar('entrega/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).not.toBe(200)
    expect(deDinero()).toEqual([])
  })

  test('Kevin (con marca) propone la de Gil: su VA espera a Norman', async () => {
    estadoInicial()
    const { b, sello } = borradorDeEntrega(KEVIN, entrega({ usuario_creador: 'telegram:kevin' }))
    const va = await llamar('entrega/confirmar', { telegram_id: KEVIN, borrador_id: b.id, sello })
    expect(va.j.espera_aprobacion, JSON.stringify(va.j)).toBe(true)
    expect(va.j.avisar_a).toEqual([NORMAN])
    expect(deDinero()).toEqual([])
  })

  test('CONTROL: Norman propone la de Gil por nombre y su VA escribe directo, una fila', async () => {
    estadoInicial()
    const p = await llamar('entrega/proponer', { telegram_id: NORMAN, monto: 700, entidad: 'Gil' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila & { estado: string }
    b.estado ??= 'PENDIENTE' // el default de la columna; el doble no lo pone
    const r = await llamar('entrega/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello: p.j.sello })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toHaveLength(1)
    expect(tablas.finanzas_ledger.at(-1)).toMatchObject({ es_entrega_efectivo: true, monto: 700, usuario_creador: 'telegram:norman' })
  })
})

// --- 2026-11-03: UNA SOLA LISTA DE CATEGORIAS ---------------------------------
// Norman: "quiero poder agregar categorias y subcategorias desde el ERP". Lo que
// se agrega (pantalla v2 o bot) vive en `categorias_movimiento`; el clasificador
// de gastos del bot tiene que leer ESA lista. Antes leia `bot_categorias` y una
// subcategoria nueva no era elegible: esta prueba fallaba (medido en c2a04db).
test.describe('2026-11-03 - el gasto del bot clasifica contra categorias_movimiento', () => {
  function conLista() {
    estadoInicial()
    tablas.categorias_movimiento = [
      { id: 'cm-1', tipo: 'EGRESO', categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Gasolina', activa: true, orden: 28 },
      { id: 'cm-2', tipo: 'EGRESO', categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel', activa: true, orden: 70 },
      { id: 'cm-3', tipo: 'EGRESO', categoria: 'Servicios', subcategoria: 'Luz', activa: false, orden: 33 },
      { id: 'cm-4', tipo: 'INGRESO', categoria: 'Ventas', subcategoria: 'Venta directa', activa: true, orden: 56 }
    ]
  }
  // El PostgREST simulado no aplica el DEFAULT de la base (`estado =
  // 'PENDIENTE'`) a un borrador que crea `proponer`; aqui se emula.
  function conDefault(id: unknown) {
    const b = tablas.bot_borradores.find((x) => x.id === id) as Fila
    if (b && b.estado == null) b.estado = 'PENDIENTE'
    return b
  }

  test('una subcategoria NUEVA de categorias_movimiento es elegible y se escribe con su pareja', async () => {
    conLista()
    const p = await llamar('gasto/proponer', {
      telegram_id: NORMAN,
      propuesta: { monto: 300, descripcion: 'diesel camioneta', categoria: 'Log\u00edstica y env\u00edos / Diesel' }
    })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    expect(p.j.categorias).toContain('Log\u00edstica y env\u00edos / Diesel')
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    const fila = (b.payload as { fila: Fila }).fila
    expect(fila).toMatchObject({ categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel', tipo_movimiento: 'GASTO_OPERATIVO' })
    conDefault(p.j.borrador_id)
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(tablas.finanzas_ledger.at(-1)).toMatchObject({ categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel', monto: 300 })
    expect(escrituras.filter((e) => e === 'POST bot_categorias')).toEqual([])
  })

  test('sin acentos ni mayusculas, o solo la subcategoria (si es unica), tambien empata', async () => {
    conLista()
    for (const dicha of ['logistica y envios / diesel', 'Diesel']) {
      const p = await llamar('gasto/proponer', {
        telegram_id: NORMAN,
        propuesta: { monto: 120, descripcion: 'x', categoria: dicha }
      })
      const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
      expect((b.payload as { fila: Fila }).fila, dicha).toMatchObject({ categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel' })
    }
  })

  test('CONTROL: una inactiva, una de INGRESO o una inventada NO se eligen ni se crean', async () => {
    conLista()
    for (const dicha of ['Servicios / Luz', 'Ventas / Venta directa']) {
      const p = await llamar('gasto/proponer', { telegram_id: NORMAN, propuesta: { monto: 50, descripcion: 'x', categoria: dicha } })
      const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
      expect((b.payload as { fila: Fila }).fila.categoria, dicha).toBe('SIN_CATEGORIZAR')
    }
    const p = await llamar('gasto/proponer', {
      telegram_id: NORMAN,
      propuesta: { monto: 50, descripcion: 'x', categoria: null, categoria_nueva: 'Fumigacion' }
    })
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect((b.payload as { fila: Fila }).fila.categoria).toBe('SIN_CATEGORIZAR')
    expect(String(p.j.mensaje)).toContain('agrega la subcategoria')
    conDefault(p.j.borrador_id)
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST bot_categorias')).toEqual([])
  })

  test('la subcategoria se desactivo entre el VA y la escritura -> 409, no escribe ni crea', async () => {
    conLista()
    const p = await llamar('gasto/proponer', {
      telegram_id: NORMAN,
      propuesta: { monto: 300, descripcion: 'diesel', categoria: 'Log\u00edstica y env\u00edos / Diesel' }
    })
    tablas.categorias_movimiento.find((f) => f.id === 'cm-2')!.activa = false
    conDefault(p.j.borrador_id)
    const c = await llamar('gasto/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(409)
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger' || e === 'POST bot_categorias')).toEqual([])
  })

  test('CONTROL: sin categorias_movimiento (la base no contesta) el bot sigue con la lista de respaldo', async () => {
    estadoInicial()
    const p = await llamar('gasto/proponer', {
      telegram_id: NORMAN,
      propuesta: { monto: 300, descripcion: 'gasolina', categoria: 'Logistica_Envios' }
    })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect((b.payload as { fila: Fila }).fila.categoria).toBe('Logistica_Envios')
  })
})

// ─── AUDITORIA 2026-11-03 (hallazgo 7): LOS HANDLERS DE CATEGORIA Y CONSULTA ─
// Escrito el 2026-11-03 por el ejecutor del Socio. Las rutas de verdad con el
// PostgREST simulado: quien puede proponer/confirmar una categoria, que la
// unica escritura sale del clic de Norman, el 23505 y la rama de gastos.
test.describe('auditoria 2026-11-03 - categoria/{proponer,confirmar}, consulta gastos y la puerta', () => {
  function conLuis(opts: { kevinConMarca?: boolean; gilConMarca?: boolean } = {}) {
    estadoInicial(opts)
    tablas.bot_identidades.push({
      telegram_id: LUIS, etiqueta: 'luis', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-norman',
      activo: true, requiere_aprobacion: false, creado_en: '2026-04-01'
    })
    tablas.categorias_movimiento = [
      { id: 'cm-1', tipo: 'EGRESO', categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Gasolina', activa: true, orden: 28 },
      { id: 'cm-2', tipo: 'EGRESO', categoria: 'Servicios', subcategoria: 'Luz', activa: true, orden: 33 }
    ]
  }
  function conDefault(id: unknown) {
    const b = tablas.bot_borradores.find((x) => x.id === id) as Fila
    if (b && b.estado == null) b.estado = 'PENDIENTE'
    return b
  }
  const ALTA = { tipo: 'EGRESO', categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel' }
  const postsCategoria = () => escrituras.filter((e) => e === 'POST categorias_movimiento')

  test('categoria/proponer: DST, LOC, rol sin tabla y sin alta -> 403, 0 escrituras', async () => {
    conLuis()
    for (const id of [GIL, LOC, SOCIO, DESCONOCIDO]) {
      const r = await llamar('categoria/proponer', { telegram_id: id, ...ALTA })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
    }
    expect(escrituras).toEqual([])
  })

  test('categoria/confirmar: DST y LOC con un borrador sellado de Norman -> 403, 0 escrituras', async () => {
    conLuis()
    const p = await llamar('categoria/proponer', { telegram_id: NORMAN, ...ALTA })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    conDefault(p.j.borrador_id)
    escrituras = []
    for (const id of [GIL, LOC]) {
      const r = await llamar('categoria/confirmar', { telegram_id: id, borrador_id: p.j.borrador_id, sello: p.j.sello })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
    }
    expect(escrituras).toEqual([])
  })

  test('LUIS (ADMIN sin marca, no Norman) propone; su VA ESPERA y 0 categorias; el clic de Norman escribe 1', async () => {
    conLuis()
    const p = await llamar('categoria/proponer', { telegram_id: LUIS, ...ALTA })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    conDefault(p.j.borrador_id)
    const va = await llamar('categoria/confirmar', { telegram_id: LUIS, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(va.status, JSON.stringify(va.j)).toBe(200)
    expect(va.j.espera_aprobacion).toBe(true)
    expect(postsCategoria()).toEqual([])
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).toBe('ESPERA_APROBACION')
    // Kevin (con marca) no aprueba lo de Luis.
    const k = await llamar('categoria/confirmar', { telegram_id: KEVIN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(k.status, JSON.stringify(k.j)).toBe(403)
    expect(postsCategoria()).toEqual([])
    const n = await llamar('categoria/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(n.status, JSON.stringify(n.j)).toBe(200)
    expect(postsCategoria()).toHaveLength(1)
    expect(tablas.categorias_movimiento.at(-1)).toMatchObject({ categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel', activa: true })
  })

  test('CONTROL: el VA de Norman sobre lo suyo escribe directo, 1 categoria', async () => {
    conLuis()
    const p = await llamar('categoria/proponer', { telegram_id: NORMAN, ...ALTA })
    conDefault(p.j.borrador_id)
    const c = await llamar('categoria/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(postsCategoria()).toHaveLength(1)
  })

  test('23505 al escribir (otro la agrego antes) -> 409 "ya existe" y el reclamo se suelta', async () => {
    conLuis()
    const p = await llamar('categoria/proponer', { telegram_id: LUIS, ...ALTA })
    conDefault(p.j.borrador_id)
    await llamar('categoria/confirmar', { telegram_id: LUIS, borrador_id: p.j.borrador_id, sello: p.j.sello })
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && url.includes('/rest/v1/categorias_movimiento')) {
        return new Response(JSON.stringify({ code: '23505', message: 'duplicate key value', details: '', hint: '' }), {
          status: 409,
          headers: { 'content-type': 'application/json' }
        })
      }
      return f(input, init)
    }) as typeof fetch
    let n
    try {
      n = await llamar('categoria/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    } finally {
      globalThis.fetch = f
    }
    expect(n.status, JSON.stringify(n.j)).toBe(409)
    expect(String(n.j.error)).toContain('ya existe')
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).toBe('ESPERA_APROBACION')
    expect(b.resuelto_en ?? null).toBeNull()
    expect(tablas.categorias_movimiento).toHaveLength(2)
  })

  test('"Logistica_Envios" + "Diesel" cae en la categoria que ya existe, no en una duplicada', async () => {
    conLuis()
    const p = await llamar('categoria/proponer', { telegram_id: NORMAN, tipo: 'EGRESO', categoria: 'Logistica_Envios', subcategoria: 'Diesel' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    const pl = b.payload as { alta: { categoria: string }; meta: { categoria_nueva: boolean } }
    expect(pl.alta.categoria).toBe('Log\u00edstica y env\u00edos')
    expect(pl.meta.categoria_nueva).toBe(false)
  })

  test('regla fiscal tambien en la subcategoria: "Pago IVA" o "Pago"+"IVA x" -> 422 desde la ruta', async () => {
    conLuis()
    const filas = tablas.categorias_movimiento as never
    expect(validarAltaCategoria({ categoria: 'Log\u00edstica', subcategoria: 'Pago IVA' }, filas)).toMatchObject({ ok: false })
    expect(validarAltaCategoria({ categoria: 'Pago', subcategoria: 'IVA x' }, filas)).toMatchObject({ ok: false })
    expect(validarAltaCategoria({ categoria: 'Log\u00edstica', subcategoria: 'Pago_IEPS' }, filas)).toMatchObject({ ok: false })
    // CONTROL: una subcategoria normal pasa.
    expect(validarAltaCategoria({ categoria: 'Log\u00edstica', subcategoria: 'Diesel' }, filas)).toMatchObject({ ok: true })
    const r = await llamar('categoria/proponer', { telegram_id: NORMAN, tipo: 'EGRESO', categoria: 'Log\u00edstica', subcategoria: 'Pago IVA' })
    expect(r.status, JSON.stringify(r.j)).toBe(422)
    expect(tablas.bot_borradores).toEqual([])
  })

  test('consulta gastos: ADMIN ve el mes (por privado en grupo); DST y LOC -> 403', async () => {
    conLuis()
    const hoy = new Date().toISOString()
    tablas.finanzas_ledger.push(
      { id: 'g-1', fecha_movimiento: hoy, tipo_movimiento: 'GASTO_OPERATIVO', monto: 300, categoria: 'Log\u00edstica y env\u00edos', subcategoria: 'Diesel', descripcion: 'diesel', status: 'ACTIVO' },
      { id: 'g-2', fecha_movimiento: hoy, tipo_movimiento: 'GASTO_OPERATIVO', monto: 70, categoria: 'Servicios', subcategoria: 'Luz', descripcion: 'luz', status: 'ANULADO' }
    )
    const grupo = -100123
    const a = await llamar('consulta', { telegram_id: NORMAN, chat_id: grupo, consulta: 'gastos' })
    expect(a.status, JSON.stringify(a.j)).toBe(200)
    expect(a.j.ok).toBe(true)
    expect(a.j.privado).toBe(true)
    expect(String(a.j.texto)).toContain('Diesel')
    expect(String(a.j.texto)).not.toContain('Luz') // el anulado no cuenta
    const priv = await llamar('consulta', { telegram_id: KEVIN, chat_id: KEVIN, consulta: 'gastos' })
    expect(priv.status, JSON.stringify(priv.j)).toBe(200)
    expect(priv.j.privado).toBe(false) // ya es su privado
    for (const id of [GIL, LOC]) {
      const r = await llamar('consulta', { telegram_id: id, chat_id: grupo, consulta: 'gastos' })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
      expect(r.j.ok).toBeUndefined()
    }
    expect(escrituras).toEqual([])
  })

  test('consulta en grupo: precios tambien va por privado (hallazgo 5)', async () => {
    conLuis()
    const r = await llamar('consulta', { telegram_id: GIL, chat_id: -100123, consulta: 'precios' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.privado).toBe(true)
  })

  test('hallazgo 2: Gil (DST SIN marca) da VA a su cotizacion -> ESPERA, 0 cotizaciones; Norman aprueba -> 1', async () => {
    estadoInicial() // Gil sin marca: con c2a04db escribia directo
    const cot: PayloadCotizacion = {
      id_vendedor: 'dst-a', id_comprador: 'loc-a1', nombre_prospecto: null, zona: 'LOCAL',
      vigencia_dias: 15, total: 960, notas: '', usuario_creador: 'telegram:gil',
      items: [{ id_producto: 'p1', cantidad: 2, precio_unitario: 480 }]
    }
    const sello = sellarCotizacion(cot)
    const b = borrador({ telegram_id: GIL, sello, payload: { tipo: 'cotizacion', cotizacion: cot, meta: {} } })
    const va = await llamar('cotizacion/confirmar', { telegram_id: GIL, borrador_id: b.id, sello })
    expect(va.status, JSON.stringify(va.j)).toBe(200)
    expect(va.j.espera_aprobacion).toBe(true)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toEqual([])
    const n = await llamar('cotizacion/confirmar', { telegram_id: NORMAN, borrador_id: b.id, sello })
    expect(n.status, JSON.stringify(n.j)).toBe(200)
    expect(escrituras.filter((e) => e === 'POST cotizaciones')).toHaveLength(1)
  })

  test('hallazgo 1: el VA de LUIS sobre su gasto ESPERA; 0 filas en finanzas_ledger', async () => {
    conLuis()
    const p = await llamar('gasto/proponer', {
      telegram_id: LUIS,
      propuesta: { monto: 300, descripcion: 'gasolina', categoria: 'Log\u00edstica y env\u00edos / Gasolina' }
    })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    conDefault(p.j.borrador_id)
    const va = await llamar('gasto/confirmar', { telegram_id: LUIS, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(va.status, JSON.stringify(va.j)).toBe(200)
    expect(va.j.espera_aprobacion).toBe(true)
    expect(escrituras.filter((e) => e === 'POST finanzas_ledger')).toEqual([])
  })

  test('hallazgo 2: el alta de un miembro DST desde el bot nace con requiere_aprobacion = true', async () => {
    conLuis()
    const r = await llamar('miembro/proponer', { telegram_id: NORMAN, miembro_telegram_id: 777, texto: 'este es Pepe', id_entidad: 'dst-a' })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila
    const alta = (b.payload as { alta: { requiere_aprobacion: boolean; id_entidad: string } }).alta
    expect(alta.id_entidad).toBe('dst-a')
    expect(alta.requiere_aprobacion).toBe(true)
  })
})

// 2026-11-10 (Norman: "que desde matriz tambien cristian pueda"): Cristian
// registra con alta directa, pero no a la Matriz.
test.describe('2026-11-10 — Cristian registra, no a la Matriz', () => {
  function conCristian() {
    estadoInicial()
    tablas.bot_identidades.push({
      telegram_id: CRISTIAN_TELEGRAM_ID, etiqueta: 'cristian', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-norman',
      activo: true, requiere_aprobacion: true, creado_en: '2026-11-10'
    })
  }
  const altas = () => escrituras.filter((e) => e === 'POST bot_identidades')

  test('Cristian propone y confirma un DST -> 200, 1 alta con marca', async () => {
    conCristian()
    const p = await llamar('miembro/proponer', { telegram_id: CRISTIAN_TELEGRAM_ID, miembro_telegram_id: 777, texto: 'este es Pepe', id_entidad: 'dst-a' })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    // El PostgREST simulado no pone el default de `estado` (como en 1051 y 1148).
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id)
    if (b && b.estado == null) b.estado = 'PENDIENTE'
    const c = await llamar('miembro/confirmar', { telegram_id: CRISTIAN_TELEGRAM_ID, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(altas()).toHaveLength(1)
    const nueva = tablas.bot_identidades.find((f) => f.telegram_id === 777) as Fila
    expect(nueva.requiere_aprobacion).toBe(true)
    expect(nueva.creado_por).toBe('telegram:cristian')
  })

  test('Cristian a la Matriz por id -> 403, 0 escrituras', async () => {
    conCristian()
    const r = await llamar('miembro/proponer', { telegram_id: CRISTIAN_TELEGRAM_ID, miembro_telegram_id: 777, texto: 'este es Pepe', id_entidad: 'ent-matriz' })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('Cristian: los botones no traen la Matriz; los de Norman si', async () => {
    conCristian()
    const r = await llamar('miembro/proponer', { telegram_id: CRISTIAN_TELEGRAM_ID, miembro_telegram_id: 777, texto: 'este es Pepe' })
    expect(r.j.hay_que_elegir, JSON.stringify(r.j)).toBe(true)
    expect((r.j.opciones as { rol: string }[]).map((o) => o.rol)).not.toContain('ADMIN')
    const n = await llamar('miembro/proponer', { telegram_id: NORMAN, miembro_telegram_id: 777, texto: 'este es Pepe' })
    expect((n.j.opciones as { rol: string }[]).map((o) => o.rol)).toContain('ADMIN')
  })

  test('Cristian: un borrador sellado hacia la Matriz no se escribe -> 403, 0 altas', async () => {
    conCristian()
    const alta = {
      telegram_id: 777, etiqueta: 'pepe', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-norman',
      requiere_aprobacion: true, creado_por: 'telegram:cristian'
    }
    const sello = sellarMiembro(alta)
    const b = borrador({ telegram_id: CRISTIAN_TELEGRAM_ID, sello, payload: { tipo: 'alta_miembro', alta, meta: {} } })
    const r = await llamar('miembro/confirmar', { telegram_id: CRISTIAN_TELEGRAM_ID, borrador_id: b.id, sello })
    expect(r.status, JSON.stringify(r.j)).toBe(403)
    expect(altas()).toEqual([])
  })
})

// 2026-11-08 - /botellas: la ruta del bot, con la MISMA lectura que la tarjeta del panel.
test.describe('2026-11-08 - /botellas desde la ruta', () => {
  test('Norman en grupo -> 200 por privado, agrupado por cliente, sin anulados; DST y LOC -> 403; 0 escrituras', async () => {
    estadoInicial()
    const hace1min = new Date(Date.now() - 60 * 1000).toISOString()
    tablas.catalogo_productos = [
      { id: 'p750', nombre: 'Destilado Plata 750ml', tipo: 'TERMINADO' },
      { id: 'p50', nombre: 'Destilado Plata 50ml', tipo: 'TERMINADO' }
    ]
    tablas.transacciones_tickets = [
      {
        id: 'tk-1', fecha_transaccion: hace1min, status: 'ACTIVO', condicion_pago: 'CONCESION',
        id_comprador: 'loc-a1', id_vendedor: 'ent-matriz',
        ticket_detalles: [
          { id_producto: 'p750', cantidad: 8, subtotal_linea: 3840 },
          { id_producto: 'p50', cantidad: 48, subtotal_linea: 2688 }
        ]
      },
      {
        id: 'tk-2', fecha_transaccion: hace1min, status: 'ANULADO', condicion_pago: 'CONTADO',
        id_comprador: 'loc-a1', id_vendedor: 'ent-matriz',
        ticket_detalles: [{ id_producto: 'p750', cantidad: 500, subtotal_linea: 1 }]
      }
    ]
    const grupo = -100123
    const a = await llamar('botellas', { telegram_id: NORMAN, chat_id: grupo })
    expect(a.status, JSON.stringify(a.j)).toBe(200)
    expect(a.j.ok).toBe(true)
    expect(a.j.privado).toBe(true)
    const texto = String(a.j.texto)
    expect(texto).toContain('Casa Verde · LOC')
    expect(texto).toContain('mes 56 (antes 0, +56)')
    expect(texto).not.toContain('556') // el anulado no cuenta
    expect(texto).toContain('Sin botellas en las 4 ventanas (2): ')
    for (const id of [GIL, LOC]) {
      const r = await llamar('botellas', { telegram_id: id, chat_id: grupo })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
      expect(r.j.ok).toBeUndefined()
    }
    const d = await llamar('botellas', { telegram_id: DESCONOCIDO })
    expect(d.status).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('sin token -> 401, aunque el telegram_id sea el de Norman', async () => {
    estadoInicial()
    const sinToken: Record<string, string>[] = [{ 'content-type': 'application/json' }, { 'x-bot-token': 'y'.repeat(32), 'content-type': 'application/json' }]
    for (const headers of sinToken) {
      const req = new Request('http://localhost/api/bot/botellas', {
        method: 'POST',
        headers,
        body: JSON.stringify({ telegram_id: NORMAN })
      })
      const r = await RUTAS.botellas.POST(req)
      expect(r.status).toBe(401)
    }
    expect(escrituras).toEqual([])
  })
})

// 2026-11-08 - /pulso: la ruta del bot, con la MISMA lectura que la tarjeta "Pulso" del panel.
test.describe('2026-11-08 - /pulso desde la ruta', () => {
  test('Norman en grupo -> 200 por privado, cobertura y dias sin surtir; DST, LOC y desconocido -> 403; 0 escrituras', async () => {
    estadoInicial()
    const hace1min = new Date(Date.now() - 60 * 1000).toISOString()
    const hace30d = new Date(Date.now() - 30 * 86_400_000).toISOString()
    tablas.catalogo_productos = [
      { id: 'p750', nombre: 'Destilado Plata 750ml', tipo: 'TERMINADO' },
      { id: 'p50', nombre: 'Destilado Plata 50ml', tipo: 'TERMINADO' }
    ]
    tablas.transacciones_tickets = [
      {
        id: 'tk-1', fecha_transaccion: hace1min, status: 'ACTIVO', condicion_pago: 'CONCESION',
        id_comprador: 'loc-a1', id_vendedor: 'ent-matriz',
        ticket_detalles: [{ id_producto: 'p750', cantidad: 8, subtotal_linea: 3840 }]
      },
      {
        id: 'tk-2', fecha_transaccion: hace1min, status: 'ANULADO', condicion_pago: 'CONTADO',
        id_comprador: 'dst-b', id_vendedor: 'ent-matriz',
        ticket_detalles: [{ id_producto: 'p750', cantidad: 500, subtotal_linea: 1 }]
      }
    ]
    tablas.v_stock_por_cubeta = [
      { id_entidad: 'ent-matriz', id_producto: 'p750', producto: 'Destilado Plata 750ml', cubeta: 'PAGADO', stock: 2 },
      { id_entidad: 'ent-matriz', id_producto: 'p50', producto: 'Destilado Plata 50ml', cubeta: 'PAGADO', stock: 40 }
    ]
    tablas.inventario_ledger = [
      { id_entidad_destino: 'dst-a', id_producto: 'p750', fecha_movimiento: hace30d, status: 'ACTIVO', tipo_movimiento: 'ENTRADA_CONCESION' },
      { id_entidad_destino: 'dst-b', id_producto: 'p750', fecha_movimiento: hace1min, status: 'ACTIVO', tipo_movimiento: 'SALIDA_VENTA' }
    ]
    const grupo = -100123
    const a = await llamar('pulso', { telegram_id: NORMAN, chat_id: grupo })
    expect(a.status, JSON.stringify(a.j)).toBe(200)
    expect(a.j.ok).toBe(true)
    expect(a.j.privado).toBe(true)
    const texto = String(a.j.texto)
    // Sin SALDO_INICIAL: ventana de 28 dias -> 8 vendidas = 2/sem; 2 en matriz = 1 sem.
    expect(texto).toContain('750ml: 2 pzas · 2/sem · 1 sem  <- REPONER')
    expect(texto).toContain('50ml: 40 pzas · 0/sem · sin ventas en la ventana')
    expect(texto).not.toContain('500')
    expect(texto).toContain('! Gil · DST: 30 d (entrega sin ticket')
    expect(texto).toContain('  Casa Verde · LOC: 0 d (compra ')
    // dst-b: su ticket esta anulado y lo otro no es ENTRADA_CONCESION -> nunca surtido.
    expect(texto).toContain('Nunca surtidos (1): Otro')
    for (const id of [GIL, LOC]) {
      const r = await llamar('pulso', { telegram_id: id, chat_id: grupo })
      expect(r.status, `${id} ${JSON.stringify(r.j)}`).toBe(403)
      expect(r.j.ok).toBeUndefined()
    }
    const d = await llamar('pulso', { telegram_id: DESCONOCIDO })
    expect(d.status).toBe(403)
    // Norman por privado: 200 y no se marca para mandar por privado (ya lo es).
    const priv = await llamar('pulso', { telegram_id: NORMAN, chat_id: NORMAN })
    expect(priv.status).toBe(200)
    expect(priv.j.privado).toBe(false)
    expect(escrituras).toEqual([])
  })

  test('sin token -> 401, aunque el telegram_id sea el de Norman', async () => {
    estadoInicial()
    const sinToken: Record<string, string>[] = [{ 'content-type': 'application/json' }, { 'x-bot-token': 'y'.repeat(32), 'content-type': 'application/json' }]
    for (const headers of sinToken) {
      const req = new Request('http://localhost/api/bot/pulso', {
        method: 'POST',
        headers,
        body: JSON.stringify({ telegram_id: NORMAN })
      })
      const r = await RUTAS.pulso.POST(req)
      expect(r.status).toBe(401)
    }
    expect(escrituras).toEqual([])
  })
})
