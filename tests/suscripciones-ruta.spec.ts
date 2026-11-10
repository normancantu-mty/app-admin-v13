/**
 * Suscripciones (2026-11-09) — `app/api/bot/suscripciones/route.ts`, medida en
 * el handler importado con PostgREST simulado por `globalThis.fetch` (patron de
 * `tests/bot-rutas-permisos.spec.ts`; simulador propio porque aquel no tiene
 * llave primaria compuesta ni `lte`).
 *
 * El simulador tiene ESTADO y la llave primaria (id_suscripcion, mes) de
 * `suscripcion_meses`: un INSERT que choca devuelve 23505, como Postgres. Con
 * eso se mide lo que una funcion pura no mide: que la pregunta se reclama UNA
 * vez, que "Ya se pago" escribe UN egreso aunque se apriete dos veces, que solo
 * Norman escribe, y que un egreso anulado devuelve el mes a pendiente.
 *
 * Validez: mide el handler, no el Next vivo ni el Postgres real (RLS, CHECK y la
 * PK reales los pone la migracion, que no se aplico aqui).
 */
import { test, expect } from '@playwright/test'
import * as ruta from '@/app/api/bot/suscripciones/route'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { horaEnMX, HORA_DE_PREGUNTA, mesActual, mesAnterior, nombreDeMes } from '@/lib/suscripciones'
import { hoyEnMX } from '@/lib/date-format'

const TOKEN = 'x'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222
const GIL = 333
const MES = mesActual(new Date())
const MES_ANT = mesAnterior(MES)
const HACE = (horas: number) => new Date(Date.now() - horas * 3600000).toISOString()
const YA_TOCA = horaEnMX(new Date()) >= HORA_DE_PREGUNTA

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let contador = 0

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN' },
      { id: 'dst-a', nombre: 'Gil', rol: 'DST' }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-personal', activo: true, requiere_aprobacion: false },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-personal', activo: true, requiere_aprobacion: true },
      { telegram_id: GIL, etiqueta: 'gil', id_entidad: 'dst-a', id_cuenta_destino: 'c-gil', activo: true, requiere_aprobacion: false }
    ],
    cuentas_financieras: [
      { id: 'c-personal', id_entidad: 'ent-matriz', nombre: 'Cuenta personal', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-spin', id_entidad: 'ent-matriz', nombre: 'Spin', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-fiscal', id_entidad: 'ent-matriz', nombre: 'Fresnillo fiscal', tipo_fiscalidad: 'FULL_TAX' },
      { id: 'c-gil', id_entidad: 'dst-a', nombre: 'Caja Gil', tipo_fiscalidad: 'NO_FISCAL' }
    ],
    categorias_movimiento: [
      { tipo: 'EGRESO', categoria: 'Servicios', subcategoria: 'Luz', activa: true, orden: 1 },
      { tipo: 'EGRESO', categoria: 'Suscripciones', subcategoria: 'IA', activa: true, orden: 65 },
      { tipo: 'EGRESO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', activa: true, orden: 67 }
    ],
    bot_categorias: [],
    suscripciones: [
      // dia 1: ya toco este mes, sea el dia que sea.
      { id: 1, nombre: 'ManyChat', monto: 480, moneda: 'MXN', dia_cobro: 1, id_cuenta: 'c-spin', subcategoria: 'Marketing y mensajería', activa: true, notas: null },
      { id: 2, nombre: 'Claude Max', monto: 200, moneda: 'USD', dia_cobro: 1, id_cuenta: null, subcategoria: 'IA', activa: true, notas: null },
      { id: 3, nombre: 'Vieja', monto: 99, moneda: 'MXN', dia_cobro: 1, id_cuenta: 'c-fiscal', subcategoria: 'IA', activa: false, notas: null }
    ],
    suscripcion_meses: [],
    finanzas_ledger: []
  }
  escrituras = []
}

const PK: Record<string, string[]> = { suscripcion_meses: ['id_suscripcion', 'mes'] }

function cumple(fila: Fila, col: string, expr: string): boolean {
  const neg = expr.startsWith('not.')
  const e = neg ? expr.slice(4) : expr
  const i = e.indexOf('.')
  const op = e.slice(0, i)
  const val = e.slice(i + 1).replace(/^"|"$/g, '')
  const actual = fila[col]
  let r: boolean
  if (op === 'eq') r = String(actual) === val
  else if (op === 'neq') r = String(actual) !== val
  else if (op === 'is') r = val === 'null' ? actual === null || actual === undefined : String(actual) === val
  else if (op === 'lte') r = actual !== null && actual !== undefined && String(actual) <= val
  else if (op === 'gte') r = actual !== null && actual !== undefined && String(actual) >= val
  else if (op === 'lt') r = actual !== null && actual !== undefined && String(actual) < val
  else if (op === 'ilike') {
    const re = new RegExp('^' + val.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
    r = actual !== null && actual !== undefined && re.test(String(actual))
  }
  else if (op === 'in') r = val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, '')).includes(String(actual))
  else throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
  return neg ? !r : r
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])
function filtrar(tabla: string, params: URLSearchParams): Fila[] {
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of params.entries()) {
    if (NO_FILTRAN.has(col)) continue
    filas = filas.filter((f) => cumple(f, col, expr))
  }
  return filas
}

function json(cuerpo: unknown, status = 200, extra: Record<string, string> = {}) {
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
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = filtrar(tabla, u.searchParams).map((f) => ({ ...f }))
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      const pk = PK[tabla]
      const nuevas: Fila[] = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]).map((c: Fila) => (pk ? { ...c } : { id: `${tabla}-${++contador}`, ...c }))
      if (pk) {
        for (const n of nuevas) {
          if ((tablas[tabla] ?? []).some((f) => pk.every((k) => String(f[k]) === String(n[k])))) {
            escrituras.pop()
            return json({ code: '23505', message: 'duplicate key value violates unique constraint', details: '', hint: '' }, 409)
          }
        }
      }
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
test.beforeEach(() => estadoInicial())

async function llamar(cuerpo: Record<string, unknown>, token = TOKEN) {
  const req = new Request('http://localhost/api/bot/suscripciones', {
    method: 'POST',
    headers: { 'x-bot-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo)
  })
  const r = await ruta.POST(req)
  return { status: r.status, j: ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown> }
}
const ledger = () => tablas.finanzas_ledger
const fila = (id: number) => tablas.suscripcion_meses.find((f) => f.id_suscripcion === id && f.mes === MES)

test.describe('suscripciones · la ruta del bot', () => {
  test('sin token: 401', async () => {
    expect((await llamar({ accion: 'leer' }, 'y'.repeat(32))).status).toBe(401)
  })

  test('leer: las activas cuyo dia ya llego (desde las 9), nunca la inactiva; a Norman', async () => {
    const r = await llamar({ accion: 'leer' })
    expect(r.status).toBe(200)
    expect(r.j.para).toBe(NORMAN)
    const ids = (r.j.preguntas as { id_suscripcion: number; tipo: string }[]).map((p) => p.id_suscripcion)
    expect(ids.sort()).toEqual(horaEnMX(new Date()) >= HORA_DE_PREGUNTA ? [1, 2] : [])
    expect(escrituras).toEqual([])
  })

  test('reclamar: la pregunta del mes se gana UNA vez (dos latidos cruzados, o un reinicio)', async () => {
    const [a, b] = await Promise.all([
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'nueva' }),
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'nueva' })
    ])
    expect([a.j.reclamado, b.j.reclamado].sort()).toEqual([false, true])
    // Tras reiniciar, el bot vuelve a leer: la fila ya existe y no se ofrece.
    const r = await llamar({ accion: 'leer' })
    expect((r.j.preguntas as { id_suscripcion: number }[]).map((p) => p.id_suscripcion)).not.toContain(1)
    const otra = await llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'nueva' })
    expect(otra.j.reclamado).toBe(false)
  })

  test('soltar (Telegram fallo): queda pospuesta para YA y el reintento se gana una vez', async () => {
    await llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'nueva' })
    await llamar({ accion: 'soltar', id_suscripcion: 1, mes: MES })
    expect(fila(1)?.estado).toBe('POSPUESTA')
    await new Promise((r) => setTimeout(r, 5))
    const [a, b] = await Promise.all([
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'reintento' }),
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'reintento' })
    ])
    expect([a.j.reclamado, b.j.reclamado].sort()).toEqual([false, true])
  })

  test('solo Norman escribe: Kevin (ADMIN con marca) y Gil (DST) -> 403 y nada escrito', async () => {
    for (const quien of [KEVIN, GIL]) {
      for (const accion of ['pagar', 'posponer', 'baja', 'proponer_pago']) {
        const r = await llamar({ accion, telegram_id: quien, id_suscripcion: 1, mes: MES })
        expect(r.status, `${quien} ${accion}`).toBe(403)
      }
    }
    expect(escrituras).toEqual([])
  })

  test('pagar: UN egreso en Suscripciones con el monto del catalogo, de la cuenta del catalogo; el segundo -> 409', async () => {
    const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(r.status).toBe(200)
    expect(ledger()).toHaveLength(1)
    expect(ledger()[0]).toMatchObject({
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Suscripciones',
      subcategoria: 'Marketing y mensajería',
      monto: 480,
      id_cuenta_destino: 'c-spin',
      usuario_creador: 'telegram:norman',
      status: 'ACTIVO',
      categoria_gasto: null
    })
    expect(fila(1)).toMatchObject({ estado: 'PAGADA', id_movimiento: ledger()[0].id, monto_pagado: 480 })
    const otra = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(otra.status).toBe(409)
    expect(ledger()).toHaveLength(1)
  })

  test('pagar: dos toques a la vez -> UN egreso', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })))
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409])
    expect(ledger()).toHaveLength(1)
  })

  test('pagar: monto corregido; USD sin pesos -> se piden; USD con pesos -> egreso en pesos', async () => {
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES, monto: 520.5 })
    expect(ledger()[0].monto).toBe(520.5)
    const sin = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 2, mes: MES })
    expect([sin.status, sin.j.pide_pesos]).toEqual([400, true])
    expect(ledger()).toHaveLength(1)
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 2, mes: MES, monto: 3812.4 })
    expect(ledger()[1]).toMatchObject({ monto: 3812.4, categoria: 'Suscripciones', subcategoria: 'IA', id_cuenta_destino: 'c-personal' })
  })

  test('pagar: un egreso ANULADO devuelve el mes a pendiente y se puede volver a registrar', async () => {
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    ledger()[0].status = 'ANULADO'
    const lista = await llamar({ accion: 'listar', telegram_id: NORMAN })
    expect(String(lista.j.texto)).toContain('ManyChat: $480.00 · dia 1 · PENDIENTE')
    const otra = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(otra.status).toBe(200)
    expect(ledger().filter((m) => m.status === 'ACTIVO')).toHaveLength(1)
  })

  test('pagar: sin la categoria en el catalogo (migracion sin aplicar) -> 409 y nada escrito', async () => {
    tablas.categorias_movimiento = tablas.categorias_movimiento.filter((c) => c.categoria !== 'Suscripciones')
    const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(r.status).toBe(409)
    expect(escrituras).toEqual([])
  })

  test('pagar: si el egreso no entra, el reclamo del mes se deshace', async () => {
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.includes('/finanzas_ledger') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
        return json({ code: 'XX000', message: 'boom', details: '', hint: '' }, 500)
      }
      return f(input, init)
    }) as typeof fetch
    try {
      const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
      expect(r.status).toBe(500)
    } finally {
      globalThis.fetch = f
    }
    expect(ledger()).toHaveLength(0)
    expect(fila(1)).toBeUndefined()
  })

  test('cuenta fiscal en el catalogo: no se usa, sale de la cuenta del bot y se avisa', async () => {
    tablas.suscripciones[2].activa = true
    const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 3, mes: MES })
    expect(r.status).toBe(200)
    expect(ledger()[0].id_cuenta_destino).toBe('c-personal')
    expect(String(r.j.texto)).toContain('no la puede usar el bot')
  })

  test('posponer: POSPUESTA a 3 dias; no pisa un mes ya pagado', async () => {
    const r = await llamar({ accion: 'posponer', telegram_id: NORMAN, id_suscripcion: 2, mes: MES })
    expect(r.status).toBe(200)
    const dias = (new Date(String(fila(2)?.volver_a_preguntar)).getTime() - Date.now()) / 86400000
    expect(fila(2)?.estado).toBe('POSPUESTA')
    expect(dias).toBeGreaterThan(2.99)
    expect(dias).toBeLessThan(3.01)
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    const p = await llamar({ accion: 'posponer', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(p.status).toBe(409)
    expect(fila(1)?.estado).toBe('PAGADA')
  })

  test('baja: la suscripcion queda inactiva y ya no se pregunta; un mes pagado se queda pagado', async () => {
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    const r = await llamar({ accion: 'baja', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(r.status).toBe(200)
    expect(tablas.suscripciones[0].activa).toBe(false)
    expect(fila(1)?.estado).toBe('PAGADA')
    await llamar({ accion: 'baja', telegram_id: NORMAN, id_suscripcion: 2, mes: MES })
    expect(fila(2)?.estado).toBe('BAJA')
    const l = await llamar({ accion: 'leer' })
    expect(l.j.preguntas).toEqual([])
    // Se dio de baja, no se borro.
    expect(tablas.suscripciones).toHaveLength(3)
  })

  test('listar: total en MXN, USD aparte sin tipo de cambio inventado; botones solo para Norman; Gil 403', async () => {
    const n = await llamar({ accion: 'listar', telegram_id: NORMAN })
    expect(n.status).toBe(200)
    const t = String(n.j.texto)
    expect(t).toContain('Total mensual (activas): $480.00 MXN')
    expect(t).toContain('+ USD 200.00 aparte')
    expect(t).not.toContain('≈')
    expect(t).not.toContain('Vieja')
    expect((n.j.pendientes as { id: number }[]).map((p) => p.id).sort()).toEqual([1, 2])
    // Con un cobro en pesos de Claude Max, aparece el aproximado marcado.
    await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 2, mes: MES, monto: 3812.4 })
    const t2 = String((await llamar({ accion: 'listar', telegram_id: NORMAN })).j.texto)
    expect(t2).toContain('⚠️ ≈ $4,292.40 MXN')
    const k = await llamar({ accion: 'listar', telegram_id: KEVIN })
    expect([k.status, k.j.pendientes]).toEqual([200, []])
    expect((await llamar({ accion: 'listar', telegram_id: GIL })).status).toBe(403)
    // En grupo, por privado.
    const g = await llamar({ accion: 'listar', telegram_id: NORMAN, chat_id: -100123 })
    expect(g.j.privado).toBe(true)
  })

  test('sin las tablas (migracion sin aplicar): el latido no truena', async () => {
    delete tablas.suscripciones
    delete tablas.suscripcion_meses
    const f = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (/\/suscripcion(es|_meses)/.test(url)) {
        return json({ code: 'PGRST205', message: "Could not find the table 'public.suscripciones' in the schema cache", details: '', hint: '' }, 404)
      }
      return f(input, init)
    }) as typeof fetch
    try {
      const r = await llamar({ accion: 'leer' })
      expect([r.status, r.j.preguntas, r.j.sin_tablas]).toEqual([200, [], true])
    } finally {
      globalThis.fetch = f
    }
  })

  test('mes futuro: no', async () => {
    const [y, m] = hoyEnMX(new Date()).split('-').map(Number)
    const futuro = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
    const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: futuro })
    expect(r.status).toBe(400)
  })

  // ─── RONDA 2 (auditoria 2026-11-09) ───────────────────────────────────────

  test('R2-1. "Todavia no" del mes anterior: el latido lo vuelve a preguntar con SU mes y /suscripciones lo muestra', async () => {
    tablas.suscripcion_meses.push(
      { id_suscripcion: 1, mes: MES_ANT, estado: 'POSPUESTA', preguntada_en: HACE(100), volver_a_preguntar: HACE(1), motivo_pospuesta: 'TODAVIA_NO', id_movimiento: null, monto_pagado: null, id_mensaje: 10, reenvios: 0 },
      { id_suscripcion: 2, mes: MES_ANT, estado: 'PAGADA', preguntada_en: HACE(100), volver_a_preguntar: null, id_movimiento: 'm-oct', monto_pagado: 3800, id_mensaje: 11, reenvios: 0 }
    )
    tablas.finanzas_ledger.push({ id: 'm-oct', status: 'ACTIVO', categoria: 'Suscripciones', subcategoria: 'IA', descripcion: 'Suscripción Claude Max', monto: 3800, fecha_movimiento: HACE(100), tipo_movimiento: 'GASTO_OPERATIVO' })
    const r = await llamar({ accion: 'leer' })
    const pre = r.j.preguntas as { id_suscripcion: number; mes: string; tipo: string; texto: string }[]
    const viejas = pre.filter((p) => p.mes === MES_ANT).map((p) => `${p.id_suscripcion}:${p.tipo}`)
    expect(viejas).toEqual(YA_TOCA ? ['1:reintento'] : [])
    const c = await llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES_ANT, tipo: 'reintento' })
    expect(c.j.reclamado).toBe(true)
    const l = await llamar({ accion: 'listar', telegram_id: NORMAN })
    expect(String(l.j.texto)).toContain(`• ManyChat (${nombreDeMes(MES_ANT)})`)
    expect(String(l.j.texto)).not.toContain(`Claude Max (${nombreDeMes(MES_ANT)})`)
    expect((l.j.pendientes as { id: number; mes: string }[]).filter((p) => p.mes === MES_ANT).map((p) => p.id)).toEqual([1])
    // Y se puede pagar ese mes desde el boton.
    const pg = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES_ANT })
    expect(pg.status).toBe(200)
    expect(tablas.suscripcion_meses.find((f) => f.id_suscripcion === 1 && f.mes === MES_ANT)?.estado).toBe('PAGADA')
  })

  test('R2-2. PREGUNTADA sin id de mensaje de hace 7 h (bot muerto entre reclamo y envio): se reenvia UNA vez', async () => {
    tablas.suscripcion_meses.push(
      { id_suscripcion: 1, mes: MES, estado: 'PREGUNTADA', preguntada_en: HACE(7), volver_a_preguntar: null, id_movimiento: null, monto_pagado: null, id_mensaje: null, reenvios: 0 },
      { id_suscripcion: 2, mes: MES, estado: 'PREGUNTADA', preguntada_en: HACE(7), volver_a_preguntar: null, id_movimiento: null, monto_pagado: null, id_mensaje: 55, reenvios: 0 }
    )
    const r = await llamar({ accion: 'leer' })
    const pre = r.j.preguntas as { id_suscripcion: number; tipo: string; texto: string }[]
    expect(pre.map((p) => `${p.id_suscripcion}:${p.tipo}`)).toEqual(YA_TOCA ? ['1:reenvio'] : [])
    if (YA_TOCA) expect(pre[0].texto).not.toContain('todavia no')
    const [a, b] = await Promise.all([
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'reenvio' }),
      llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'reenvio' })
    ])
    expect([a.j.reclamado, b.j.reclamado].sort()).toEqual([false, true])
    // Aunque vuelva a morir y pasen otras 6 h: ya no (una vez).
    fila(1)!.preguntada_en = HACE(13)
    expect(((await llamar({ accion: 'leer' })).j.preguntas as unknown[]).length).toBe(0)
    expect((await llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'reenvio' })).j.reclamado).toBe(false)
    // `entregado` guarda el id del mensaje que si salio.
    await llamar({ accion: 'entregado', id_suscripcion: 1, mes: MES, id_mensaje: 9001 })
    expect(fila(1)?.id_mensaje).toBe(9001)
  })

  test('R2-3. el reintento dice "todavia no" solo si Norman lo dijo; si fallo Telegram, no', async () => {
    await llamar({ accion: 'reclamar', id_suscripcion: 1, mes: MES, tipo: 'nueva' })
    await llamar({ accion: 'soltar', id_suscripcion: 1, mes: MES })
    expect(fila(1)?.motivo_pospuesta).toBe('ENVIO_FALLIDO')
    await llamar({ accion: 'posponer', telegram_id: NORMAN, id_suscripcion: 2, mes: MES })
    expect(fila(2)?.motivo_pospuesta).toBe('TODAVIA_NO')
    fila(2)!.volver_a_preguntar = HACE(1)
    await new Promise((r) => setTimeout(r, 5))
    const pre = (await llamar({ accion: 'leer' })).j.preguntas as { id_suscripcion: number; texto: string }[]
    const t = (id: number) => pre.find((p) => p.id_suscripcion === id)?.texto ?? ''
    expect(pre.length).toBe(YA_TOCA ? 2 : 0)
    if (YA_TOCA) {
      expect(t(1)).not.toContain('todavia no')
      expect(t(1)).toContain('no te llego')
      expect(t(2)).toContain('todavia no')
    }
  })

  test('R2-5. "Ya se pago" con un egreso de Suscripciones del mes que ya la menciona: se ofrece ligarlo, y ligar no escribe otro', async () => {
    const ahora = new Date().toISOString()
    tablas.finanzas_ledger.push(
      { id: 'm-web', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: 'pago manychat del mes', monto: 480, fecha_movimiento: ahora },
      // CONTROLES: anulado, otra subcategoria, otro mes, no la menciona.
      { id: 'm-anulado', status: 'ANULADO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: 'ManyChat', monto: 480, fecha_movimiento: ahora },
      { id: 'm-otra-sub', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'IA', descripcion: 'ManyChat', monto: 480, fecha_movimiento: ahora },
      { id: 'm-otro-mes', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: 'ManyChat', monto: 480, fecha_movimiento: '2020-01-15T18:00:00.000Z' },
      { id: 'm-ajeno', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: 'Canva', monto: 300, fecha_movimiento: ahora }
    )
    const p = await llamar({ accion: 'proponer_pago', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(p.status).toBe(200)
    expect(((p.j.candidatos ?? []) as { id: string }[]).map((c) => c.id)).toEqual(['m-web'])
    // "Registrar" sin decir "es otro": no escribe; devuelve el candidato.
    const sin = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect([sin.status, sin.j.duplicado_posible]).toEqual([409, true])
    expect(ledger()).toHaveLength(5)
    // Ligar un id que NO es candidato: no.
    const mal = await llamar({ accion: 'ligar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES, id_movimiento: 'm-ajeno' })
    expect(mal.status).toBe(409)
    // "Es este: ligarlo": PAGADA con ese id, sin egreso nuevo.
    const l = await llamar({ accion: 'ligar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES, id_movimiento: 'm-web' })
    expect(l.status).toBe(200)
    expect(ledger()).toHaveLength(5)
    expect(fila(1)).toMatchObject({ estado: 'PAGADA', id_movimiento: 'm-web', monto_pagado: 480 })
    expect((await llamar({ accion: 'proponer_pago', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })).j.ya_pagada).toBe(true)
  })

  test('R2-5. "No, registrar otro": forzar_nuevo escribe aunque haya candidato; un egreso ya ligado a otro mes no es candidato', async () => {
    const ahora = new Date().toISOString()
    tablas.finanzas_ledger.push(
      { id: 'm-web', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: 'ManyChat', monto: 480, fecha_movimiento: ahora },
      { id: 'm-del-ant', status: 'ACTIVO', tipo_movimiento: 'GASTO_OPERATIVO', categoria: 'Suscripciones', subcategoria: 'Marketing y mensajería', descripcion: `Suscripción ManyChat (${MES_ANT})`, monto: 480, fecha_movimiento: ahora }
    )
    tablas.suscripcion_meses.push({ id_suscripcion: 1, mes: MES_ANT, estado: 'PAGADA', id_movimiento: 'm-del-ant', monto_pagado: 480, preguntada_en: HACE(100), volver_a_preguntar: null, id_mensaje: 1, reenvios: 0 })
    const p = await llamar({ accion: 'proponer_pago', telegram_id: NORMAN, id_suscripcion: 1, mes: MES })
    expect(((p.j.candidatos ?? []) as { id: string }[]).map((c) => c.id)).toEqual(['m-web'])
    const ignorar = await llamar({ accion: 'proponer_pago', telegram_id: NORMAN, id_suscripcion: 1, mes: MES, ignorar_candidatos: true })
    expect([ignorar.j.candidatos, ignorar.j.monto]).toEqual([[], 480])
    const r = await llamar({ accion: 'pagar', telegram_id: NORMAN, id_suscripcion: 1, mes: MES, forzar_nuevo: true })
    expect(r.status).toBe(200)
    expect(ledger()).toHaveLength(3)
  })
})
