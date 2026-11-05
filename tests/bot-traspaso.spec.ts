/**
 * 2026-11-05 — TRASPASO ENTRE CUENTAS: el lado del servidor.
 *
 * El handler real, con PostgREST simulado por `globalThis.fetch` (mismo molde que
 * `tests/bot-rutas-permisos.spec.ts`). Este doble agrega dos cosas que aquel no
 * tiene y que aqui son el punto: la LLAVE PRIMARIA de `finanzas_ledger` (un insert
 * con un id repetido da 23505 y no escribe NINGUNA fila, igual que un statement de
 * PostgREST) y `saldo_cuenta`, calculado de las filas ACTIVO.
 *
 * Validez: mide el handler importado, no el Next vivo; el SQL de `saldo_cuenta` y
 * el 23505 real no corren aqui.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createClient } from '@supabase/supabase-js'
import * as traspasoP from '@/app/api/bot/traspaso/proponer/route'
import * as traspasoC from '@/app/api/bot/traspaso/confirmar/route'
import * as gastoC from '@/app/api/bot/gasto/confirmar/route'
import * as anuP from '@/app/api/bot/anular/proponer/route'
import * as anuC from '@/app/api/bot/anular/confirmar/route'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import { anularFinanzas } from '@/lib/anulacion-servidor'
import { clienteDeEnsayo } from '@/lib/bot-ensayo'
import { tipoDelPayload } from '@/lib/bot-pendiente'
import { esEgresoDelPeriodo } from '@/lib/dashboard-utils'
import {
  filasDeTraspaso,
  normalizarTraspaso,
  puedeTraspasar,
  sellarTraspaso,
  MENSAJE_SOLO_NORMAN,
  type FilaTraspaso
} from '@/lib/bot-traspaso'
import {
  esMarcaDeTraspaso,
  juzgarPareja,
  marcaDeTraspaso,
  MENSAJE_PAREJA_INCOMPLETA,
  MENSAJE_SIN_MARCA
} from '@/lib/traspaso-pareja'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = {
  'traspaso/proponer': traspasoP,
  'traspaso/confirmar': traspasoC,
  'gasto/confirmar': gastoC,
  'anular/proponer': anuP,
  'anular/confirmar': anuC
}

const TOKEN = 'x'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}

const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222 // ADMIN que no es Norman
const GIL = 333 // DST

const GILBERTO = 'c-gilberto'
const SPIN = 'c-spin'
const EFECTIVO = 'c-efectivo'
const TRANSFERENCIAS = 'c-transferencias'
const FISCAL = 'c-fresnillo'
const AJENA = 'c-gil'

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let rpcs: string[] = []
let contador = 0
/** Hace fallar el insert o el update del ledger, o que el update no toque filas. */
let fallas: { insertLedger?: boolean; updateLedgerCero?: boolean; saldo?: boolean } = {}

const SALDO_BASE: Record<string, number> = {
  [EFECTIVO]: 5000,
  [SPIN]: 300,
  [GILBERTO]: 0,
  [TRANSFERENCIAS]: 599
}

function estadoInicial() {
  const ahora = new Date().toISOString()
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN', id_padre: null, id_nodo_padre: null },
      { id: 'dst-a', nombre: 'Gil', rol: 'DST', id_padre: null, id_nodo_padre: null }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: EFECTIVO, activo: true, requiere_aprobacion: false, creado_en: '2026-01-01' },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: EFECTIVO, activo: true, requiere_aprobacion: false, creado_en: '2026-02-01' },
      { telegram_id: GIL, etiqueta: 'gil', id_entidad: 'dst-a', id_cuenta_destino: AJENA, activo: true, requiere_aprobacion: false, creado_en: '2026-03-01' }
    ],
    cuentas_financieras: [
      { id: EFECTIVO, id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL', solo_egresos: false },
      { id: SPIN, id_entidad: 'ent-matriz', nombre: 'Cuenta Spin', tipo_fiscalidad: 'NO_FISCAL', solo_egresos: false },
      { id: GILBERTO, id_entidad: 'ent-matriz', nombre: 'Cuenta Gilberto', tipo_fiscalidad: 'NO_FISCAL', solo_egresos: true },
      { id: TRANSFERENCIAS, id_entidad: 'ent-matriz', nombre: 'Transferencias', tipo_fiscalidad: 'NO_FISCAL', solo_egresos: false },
      { id: FISCAL, id_entidad: 'ent-matriz', nombre: 'Cuenta Fresnillo', tipo_fiscalidad: 'FULL_TAX', solo_egresos: false },
      { id: AJENA, id_entidad: 'dst-a', nombre: 'Caja Gil', tipo_fiscalidad: 'NO_FISCAL', solo_egresos: false }
    ],
    bot_borradores: [],
    bot_categorias: [],
    finanzas_ledger: [
      { id: 'm-gasto', fecha_movimiento: ahora, tipo_movimiento: 'GASTO_OPERATIVO', monto: 100, categoria: 'Gasolina', subcategoria: null, descripcion: 'gasolina', id_ticket: null, usuario_creador: 'telegram:norman', status: 'ACTIVO', id_entidad_relacionada: null, id_cuenta_destino: 'c-otra' }
    ],
    inventario_ledger: []
  }
  escrituras = []
  rpcs = []
  fallas = {}
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
  if (op === 'in') {
    return val.replace(/^\(|\)$/g, '').split(',').map(valorDeFiltro).includes(String(actual))
  }
  throw new Error(`el doble de PostgREST no entiende el filtro ${col}=${expr}`)
}

const NO_FILTRAN = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

function filtrar(tabla: string, params: URLSearchParams): Fila[] {
  let filas = tablas[tabla] ?? []
  for (const [col, expr] of params.entries()) {
    if (NO_FILTRAN.has(col)) continue
    filas = filas.filter((f) => cumple(f, col, expr))
  }
  const limite = params.get('limit')
  return limite ? filas.slice(0, Number(limite)) : filas
}

/** `saldo_cuenta`: la cuenta afectada vive en `id_cuenta_destino` en las dos patas. */
function saldoDe(cuenta: string): number {
  let saldo = SALDO_BASE[cuenta] ?? 0
  for (const f of tablas.finanzas_ledger) {
    if (f.status !== 'ACTIVO' || f.id_cuenta_destino !== cuenta) continue
    if (f.tipo_movimiento === 'INGRESO_TRASPASO') saldo += Number(f.monto)
    if (f.tipo_movimiento === 'EGRESO_TRASPASO') saldo -= Number(f.monto)
  }
  return saldo
}

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json', 'content-range': '0-0/1' }
  })

function responder(url: string, init: RequestInit | undefined): Response {
  const u = new URL(url)
  const tabla = u.pathname.replace('/rest/v1/', '')
  const metodo = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const objeto = (headers.get('accept') ?? '').includes('vnd.pgrst.object')
  const representacion = (headers.get('prefer') ?? '').includes('return=representation')
  const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
  let filas: Fila[] = []

  if (tabla.startsWith('rpc/')) {
    const nombre = tabla.replace('rpc/', '')
    rpcs.push(nombre)
    if (nombre !== 'saldo_cuenta') throw new Error(`rpc inesperada: ${nombre}`)
    if (fallas.saldo) return json({ code: 'XX000', message: 'caida' }, 500)
    return json(saldoDe(String(cuerpo.p_id_cuenta)))
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = filtrar(tabla, u.searchParams)
  } else if (metodo === 'POST') {
    const lote = (Array.isArray(cuerpo) ? cuerpo : [cuerpo]) as Fila[]
    if (tabla === 'finanzas_ledger') {
      if (fallas.insertLedger) return json({ code: 'XX000', message: 'caida' }, 500)
      // Un statement: si una fila choca, no entra NINGUNA.
      const ids = lote.map((c) => c.id).filter(Boolean)
      const repetido =
        new Set(ids).size !== ids.length || tablas.finanzas_ledger.some((f) => ids.includes(f.id))
      if (repetido) {
        return json({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)
      }
    }
    escrituras.push(`POST ${tabla}:${lote.length}`)
    const nuevas = lote.map((c) => ({
      id: `${tabla}-${++contador}`,
      estado: 'PENDIENTE',
      chat_id: null,
      ...c
    }))
    ;(tablas[tabla] ??= []).push(...nuevas)
    filas = nuevas
    if (!representacion && !objeto) return new Response(null, { status: 201 })
  } else if (metodo === 'PATCH') {
    escrituras.push(`PATCH ${tabla}`)
    filas = tabla === 'finanzas_ledger' && fallas.updateLedgerCero ? [] : filtrar(tabla, u.searchParams)
    for (const f of filas) Object.assign(f, cuerpo)
    if (!representacion && !objeto) return new Response(null, { status: 204 })
  } else {
    throw new Error(`metodo inesperado: ${metodo} ${tabla}`)
  }
  if (objeto) {
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
test.beforeEach(() => estadoInicial())

async function llamar(ruta: string, cuerpo: Record<string, unknown>, extra: Record<string, string> = {}) {
  const req = new Request('http://localhost/api/bot/' + ruta, {
    method: 'POST',
    headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(cuerpo)
  })
  const r = await RUTAS[ruta].POST(req)
  const j = (await r.json().catch(() => null)) as Record<string, unknown> | null
  return { status: r.status, j: j ?? {} }
}

const proponer = (propuesta: Record<string, unknown>, quien = NORMAN) =>
  llamar('traspaso/proponer', { telegram_id: quien, propuesta })

async function propuestaViva(propuesta: Record<string, unknown> = { monto: 25000, origen_id: GILBERTO, destino_id: SPIN }) {
  const p = await proponer(propuesta)
  expect(p.status).toBe(200)
  return { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello }
}

const patas = () =>
  tablas.finanzas_ledger.filter((f) => String(f.tipo_movimiento).endsWith('_TRASPASO'))
const delBorrador = (id: unknown) => tablas.bot_borradores.find((b) => b.id === id) as Fila

function clienteSimulado() {
  return createClient('http://127.0.0.1:9', 'fake-key', {
    auth: { persistSession: false, autoRefreshToken: false }
  }) as never
}

/** Dos patas ya escritas, con la liga. Devuelve sus ids. */
async function traspasoEscrito(monto = 1000) {
  const va = await propuestaViva({ monto, origen_id: EFECTIVO, destino_id: SPIN })
  const c = await llamar('traspaso/confirmar', va)
  expect(c.status).toBe(200)
  const [egreso, ingreso] = c.j.ids as string[]
  return { egreso, ingreso }
}

function filaPara(propuesta: Record<string, unknown>): FilaTraspaso {
  const n = normalizarTraspaso(
    propuesta,
    [
      { id: EFECTIVO, nombre: 'Efectivo', solo_egresos: false },
      { id: SPIN, nombre: 'Cuenta Spin', solo_egresos: false }
    ],
    'norman'
  )
  if (!n.ok) throw new Error(n.error)
  return n.fila
}

// ─── 1. LA PROPUESTA ────────────────────────────────────────────────────────

test.describe('proponer', () => {
  test('la frase real: origen, destino, monto y los dos saldos antes y despues', async () => {
    const r = await proponer({ monto: 25000, origen_id: GILBERTO, destino_id: SPIN })
    expect(r.status).toBe(200)
    const m = String(r.j.mensaje)
    expect(m).toContain('MONTO:      $25,000.00')
    expect(m).toContain('DE:         Cuenta Gilberto')
    expect(m).toContain('A:          Cuenta Spin')
    expect(m).toContain('Cuenta Gilberto: $0.00 -> -$25,000.00')
    expect(m).toContain('Cuenta Spin: $300.00 -> $25,300.00')
  })

  test('proponer no escribe en el ledger', async () => {
    await proponer({ monto: 25000, origen_id: GILBERTO, destino_id: SPIN })
    expect(patas()).toEqual([])
    expect(escrituras.filter((e) => e.includes('finanzas_ledger'))).toEqual([])
    expect(escrituras).toContain('POST bot_borradores:1')
  })

  test('origen negativo: avisa claro y NO bloquea', async () => {
    const r = await proponer({ monto: 25000, origen_id: GILBERTO, destino_id: SPIN })
    expect(String(r.j.mensaje)).toContain('Cuenta Gilberto queda en NEGATIVO (-$25,000.00)')
    expect(r.j.borrador_id).toBeTruthy()
  })

  test('saldo que alcanza: sin aviso de negativo', async () => {
    const r = await proponer({ monto: 5000, origen_id: EFECTIVO, destino_id: SPIN })
    expect(String(r.j.mensaje)).not.toContain('NEGATIVO')
  })

  test('sacar de Transferencias avisa que no es una conversion', async () => {
    const r = await proponer({ monto: 100, origen_id: TRANSFERENCIAS, destino_id: EFECTIVO })
    expect(String(r.j.mensaje)).toContain('NO es una conversion de transferencias')
  })

  test('meter a Transferencias avisa que sube lo pendiente de convertir', async () => {
    const r = await proponer({ monto: 100, origen_id: EFECTIVO, destino_id: TRANSFERENCIAS })
    expect(String(r.j.mensaje)).toContain('sube lo pendiente de convertir')
    expect(String(r.j.mensaje)).not.toContain('NO es una conversion de transferencias')
  })

  test('sin Transferencias de por medio no hay aviso de conversion', async () => {
    const r = await proponer({ monto: 100, origen_id: EFECTIVO, destino_id: SPIN })
    expect(String(r.j.mensaje)).not.toContain('OJO')
  })

  const RECHAZOS: [string, Record<string, unknown>, RegExp][] = [
    ['monto cero', { monto: 0, origen_id: EFECTIVO, destino_id: SPIN }, /mayor a cero/],
    ['monto negativo', { monto: -5, origen_id: EFECTIVO, destino_id: SPIN }, /mayor a cero/],
    ['monto que no es numero', { monto: 'mucho', origen_id: EFECTIVO, destino_id: SPIN }, /mayor a cero/],
    ['monto fuera de escala', { monto: 1e12, origen_id: EFECTIVO, destino_id: SPIN }, /fuera de escala/],
    ['origen igual a destino', { monto: 10, origen_id: SPIN, destino_id: SPIN }, /misma cuenta/],
    ['destino solo egresos', { monto: 10, origen_id: SPIN, destino_id: GILBERTO }, /solo registra salidas/],
    ['sin origen', { monto: 10, destino_id: SPIN }, /De cual cuenta sale/],
    ['sin destino', { monto: 10, origen_id: SPIN }, /A cual cuenta entra/],
    ['cuenta inventada', { monto: 10, origen_id: 'no-existe', destino_id: SPIN }, /no la puedo mover/],
    ['cuenta de otra entidad', { monto: 10, origen_id: SPIN, destino_id: AJENA }, /no la puedo mover/],
    ['cuenta fiscal', { monto: 10, origen_id: FISCAL, destino_id: SPIN }, /no la puedo mover/]
  ]
  for (const [nombre, propuesta, esperado] of RECHAZOS) {
    test(`rechaza con mensaje util: ${nombre}`, async () => {
      const r = await proponer(propuesta)
      expect(r.status).toBe(422)
      expect(String(r.j.error)).toMatch(esperado)
      expect(tablas.bot_borradores).toEqual([])
    })
  }

  test('sin saldo legible no propone a ciegas', async () => {
    fallas.saldo = true
    const r = await proponer({ monto: 10, origen_id: EFECTIVO, destino_id: SPIN })
    expect(r.status).toBe(500)
    expect(tablas.bot_borradores).toEqual([])
  })
})

// ─── 2. EL PERMISO ──────────────────────────────────────────────────────────

test.describe('permiso: solo Norman', () => {
  test('un ADMIN que no es Norman no propone', async () => {
    const r = await proponer({ monto: 10, origen_id: EFECTIVO, destino_id: SPIN }, KEVIN)
    expect(r.status).toBe(403)
    expect(r.j.error).toBe(MENSAJE_SOLO_NORMAN)
  })

  test('un DST no propone, ni con sus propias cuentas', async () => {
    const r = await proponer({ monto: 10, origen_id: AJENA, destino_id: SPIN }, GIL)
    expect(r.status).toBe(403)
    expect(tablas.bot_borradores).toEqual([])
  })

  test('alguien sin alta no propone', async () => {
    expect((await proponer({ monto: 10, origen_id: EFECTIVO, destino_id: SPIN }, 999)).status).toBe(403)
  })

  test('un ADMIN que no es Norman tampoco confirma el borrador de Norman', async () => {
    const va = await propuestaViva()
    const r = await llamar('traspaso/confirmar', { ...va, telegram_id: KEVIN })
    expect(r.status).toBe(403)
    expect(patas()).toEqual([])
  })

  test('Norman con la marca de aprobacion puesta tampoco escribe directo', () => {
    const base = { telegramId: NORMAN, rolEntidad: 'ADMIN', requiereAprobacion: false }
    expect(puedeTraspasar(base)).toBe(true)
    expect(puedeTraspasar({ ...base, requiereAprobacion: true })).toBe(false)
    expect(puedeTraspasar({ ...base, rolEntidad: 'TRABAJADOR' })).toBe(false)
    expect(puedeTraspasar({ ...base, telegramId: KEVIN })).toBe(false)
  })

  test('sin token no entra', async () => {
    const req = new Request('http://localhost/api/bot/traspaso/confirmar', { method: 'POST', body: '{}' })
    expect((await traspasoC.POST(req)).status).toBe(401)
    expect((await traspasoP.POST(req.clone())).status).toBe(401)
  })
})

// ─── 3. CONFIRMAR ───────────────────────────────────────────────────────────

test.describe('confirmar', () => {
  test('la frase real: dos filas, en UN solo insert, con autor real y aviso final', async () => {
    const va = await propuestaViva()
    const r = await llamar('traspaso/confirmar', va)
    expect(r.status).toBe(200)
    expect(r.j.filas_escritas).toBe(2)
    expect(escrituras.filter((e) => e.includes('finanzas_ledger'))).toEqual(['POST finanzas_ledger:2'])
    const [egreso, ingreso] = patas()
    expect(egreso.tipo_movimiento).toBe('EGRESO_TRASPASO')
    expect(egreso.id_cuenta_destino).toBe(GILBERTO)
    expect(ingreso.tipo_movimiento).toBe('INGRESO_TRASPASO')
    expect(ingreso.id_cuenta_destino).toBe(SPIN)
    for (const f of [egreso, ingreso]) {
      expect(f.monto).toBe(25000)
      expect(f.usuario_creador).toBe('telegram:norman')
      expect(f.status).toBe('ACTIVO')
      expect(f.categoria).toBe('TRANSFERENCIA')
    }
    expect(r.j.mensaje).toBe(
      'Listo. Pasó $25,000.00 de Cuenta Gilberto a Cuenta Spin. Saldos: Cuenta Gilberto -$25,000.00, Cuenta Spin $25,300.00.'
    )
    expect(delBorrador(va.borrador_id).estado).toBe('CONFIRMADO')
  })

  test('las dos patas comparten una marca que las liga', async () => {
    await llamar('traspaso/confirmar', await propuestaViva())
    const [a, b] = patas()
    expect(esMarcaDeTraspaso(a.subcategoria)).toBe(true)
    expect(a.subcategoria).toBe(b.subcategoria)
  })

  test('dinero conservado: la suma de los dos saldos no cambia', async () => {
    const antes = saldoDe(EFECTIVO) + saldoDe(SPIN)
    await llamar('traspaso/confirmar', await propuestaViva({ monto: 1234.56, origen_id: EFECTIVO, destino_id: SPIN }))
    expect(saldoDe(EFECTIVO) + saldoDe(SPIN)).toBeCloseTo(antes, 2)
    expect(saldoDe(EFECTIVO)).toBeCloseTo(5000 - 1234.56, 2)
  })

  test('doble clic secuencial: el segundo no aplica nada y lo dice', async () => {
    const va = await propuestaViva()
    await llamar('traspaso/confirmar', va)
    const r = await llamar('traspaso/confirmar', va)
    expect(r.status).toBe(200)
    expect(r.j.ya_estaba).toBe(true)
    expect(r.j.filas_escritas).toBe(0)
    expect(patas()).toHaveLength(2)
  })

  test('doble clic simultaneo: la llave primaria deja pasar uno solo', async () => {
    const va = await propuestaViva()
    const [a, b] = await Promise.all([llamar('traspaso/confirmar', va), llamar('traspaso/confirmar', va)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.j.filas_escritas, b.j.filas_escritas].sort()).toEqual([0, 2])
    expect(patas()).toHaveLength(2)
    expect(saldoDe(SPIN)).toBe(25300)
  })

  test('reintento tras perder la marca del borrador: 23505, ya_estaba, sin duplicar', async () => {
    const va = await propuestaViva()
    await llamar('traspaso/confirmar', va)
    delBorrador(va.borrador_id).estado = 'PENDIENTE' // el marcarConfirmado se perdio
    const r = await llamar('traspaso/confirmar', va)
    expect(r.j.ya_estaba).toBe(true)
    expect(patas()).toHaveLength(2)
    expect(delBorrador(va.borrador_id).estado).toBe('CONFIRMADO')
  })

  test('si el insert falla no queda nada, el borrador sigue vivo y el reintento escribe', async () => {
    const va = await propuestaViva()
    fallas.insertLedger = true
    const malo = await llamar('traspaso/confirmar', va)
    expect(malo.status).toBe(500)
    expect(String(malo.j.error)).toContain('No quedo nada a medias')
    expect(patas()).toEqual([])
    expect(delBorrador(va.borrador_id).estado).toBe('PENDIENTE')
    fallas.insertLedger = false
    expect((await llamar('traspaso/confirmar', va)).j.filas_escritas).toBe(2)
  })

  test('sin saldos legibles al final, escribe y lo dice', async () => {
    const va = await propuestaViva()
    fallas.saldo = true
    const r = await llamar('traspaso/confirmar', va)
    expect(r.j.filas_escritas).toBe(2)
    expect(String(r.j.mensaje)).toContain('No pude releer los saldos')
  })

  test('sello recibido falso: no escribe', async () => {
    const va = await propuestaViva()
    const r = await llamar('traspaso/confirmar', { ...va, sello: 'a'.repeat(64) })
    expect(r.status).toBe(409)
    expect(patas()).toEqual([])
  })

  test('payload alterado en la base: rompe el sello, cancela y no escribe', async () => {
    const va = await propuestaViva()
    const b = delBorrador(va.borrador_id)
    ;(b.payload as { fila: FilaTraspaso }).fila.monto = 1
    const r = await llamar('traspaso/confirmar', va)
    expect(r.status).toBe(409)
    expect(delBorrador(va.borrador_id).estado).toBe('CANCELADO')
    expect(patas()).toEqual([])
  })

  test('un borrador cancelado no se escribe', async () => {
    const va = await propuestaViva()
    delBorrador(va.borrador_id).estado = 'CANCELADO'
    expect((await llamar('traspaso/confirmar', va)).status).toBeGreaterThanOrEqual(400)
    expect(patas()).toEqual([])
  })

  test('la cuenta destino se volvio solo-egresos entre proponer y confirmar: no escribe', async () => {
    const va = await propuestaViva()
    tablas.cuentas_financieras.find((c) => c.id === SPIN)!.solo_egresos = true
    expect((await llamar('traspaso/confirmar', va)).status).toBe(409)
    expect(patas()).toEqual([])
  })

  test('el VA de gasto no se traga un borrador de traspaso', async () => {
    const va = await propuestaViva()
    const r = await llamar('gasto/confirmar', va)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(tablas.finanzas_ledger).toHaveLength(1)
  })

  test('el VA de traspaso no se traga un borrador de otra cosa', async () => {
    tablas.bot_borradores.push({ id: 'b-gasto', telegram_id: NORMAN, sello: 's', estado: 'PENDIENTE', chat_id: null, payload: { monto: 5 } })
    const r = await llamar('traspaso/confirmar', { telegram_id: NORMAN, borrador_id: 'b-gasto', sello: 's' })
    expect(r.status).toBe(409)
    expect(patas()).toEqual([])
  })
})

// ─── 4. ANULAR: LAS DOS PATAS JUNTAS ────────────────────────────────────────

async function anularPorElBot(idMovimiento: string, quien = NORMAN) {
  const p = await llamar('anular/proponer', { telegram_id: quien, tabla: 'finanzas', id_movimiento: idMovimiento, modo: 'anular' })
  if (p.status !== 200) return { propuesta: p, confirmacion: null }
  const confirmacion = await llamar('anular/confirmar', { telegram_id: quien, borrador_id: p.j.borrador_id, sello: p.j.sello })
  return { propuesta: p, confirmacion }
}

test.describe('anular', () => {
  for (const pata of ['egreso', 'ingreso'] as const) {
    test(`por el bot, desde la pata de ${pata}: caen las dos y los saldos vuelven`, async () => {
      const ids = await traspasoEscrito()
      expect(saldoDe(EFECTIVO)).toBe(4000)
      const { propuesta, confirmacion } = await anularPorElBot(ids[pata])
      expect(String(propuesta.j.mensaje)).toContain('anulo las DOS filas juntas')
      expect(confirmacion?.status).toBe(200)
      expect(patas().map((f) => f.status)).toEqual(['ANULADO', 'ANULADO'])
      expect(saldoDe(EFECTIVO)).toBe(5000)
      expect(saldoDe(SPIN)).toBe(300)
    })
  }

  test('por la web (`anularFinanzas`), desde una sola pata: caen las dos', async () => {
    const { ingreso } = await traspasoEscrito()
    await anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, ingreso)
    expect(patas().map((f) => f.status)).toEqual(['ANULADO', 'ANULADO'])
  })

  test('la segunda anulacion no hace nada', async () => {
    const { egreso } = await traspasoEscrito()
    await anularPorElBot(egreso)
    const antes = escrituras.filter((e) => e === 'PATCH finanzas_ledger').length
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, egreso)
    ).rejects.toThrow(/ya está anulado/)
    expect(escrituras.filter((e) => e === 'PATCH finanzas_ledger').length).toBe(antes)
  })

  test('pata sin marca (conversiones, viejas): se bloquea y no toca nada', async () => {
    tablas.finanzas_ledger.push({ id: 'vieja', fecha_movimiento: new Date().toISOString(), tipo_movimiento: 'EGRESO_TRASPASO', monto: 50, categoria: 'TRANSFERENCIA', subcategoria: null, descripcion: 'x', id_ticket: null, usuario_creador: 'telegram:norman', status: 'ACTIVO', id_entidad_relacionada: null, id_cuenta_destino: EFECTIVO })
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, 'vieja')
    ).rejects.toThrow(MENSAJE_SIN_MARCA)
    expect(tablas.finanzas_ledger.find((f) => f.id === 'vieja')?.status).toBe('ACTIVO')
  })

  test('la otra pata ya no esta activa: se bloquea, no anula media pareja', async () => {
    const { egreso, ingreso } = await traspasoEscrito()
    tablas.finanzas_ledger.find((f) => f.id === ingreso)!.status = 'ANULADO'
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, egreso)
    ).rejects.toThrow(MENSAJE_PAREJA_INCOMPLETA)
    expect(tablas.finanzas_ledger.find((f) => f.id === egreso)?.status).toBe('ACTIVO')
  })

  test('falta la otra pata: se bloquea', async () => {
    const { egreso, ingreso } = await traspasoEscrito()
    tablas.finanzas_ledger = tablas.finanzas_ledger.filter((f) => f.id !== ingreso)
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, egreso)
    ).rejects.toThrow(MENSAJE_PAREJA_INCOMPLETA)
  })

  test('el update que no toca las dos filas es un error, no un exito callado', async () => {
    const { egreso } = await traspasoEscrito()
    fallas.updateLedgerCero = true
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, egreso)
    ).rejects.toThrow()
  })

  test('el SOCIO no anula', async () => {
    const { egreso } = await traspasoEscrito()
    await expect(
      anularFinanzas(clienteSimulado(), { idEntidad: 'ent-socio', email: 's@x', rol: 'SOCIO' }, egreso)
    ).rejects.toThrow(/Solo lectura/)
    expect(patas().map((f) => f.status)).toEqual(['ACTIVO', 'ACTIVO'])
  })

  test('regresion: un gasto normal se sigue anulando solo', async () => {
    const ids = await traspasoEscrito()
    await anularFinanzas(clienteSimulado(), { idEntidad: 'ent-matriz', email: 'n@x', rol: 'ADMIN' }, 'm-gasto')
    expect(tablas.finanzas_ledger.find((f) => f.id === 'm-gasto')?.status).toBe('ANULADO')
    expect(tablas.finanzas_ledger.find((f) => f.id === ids.egreso)?.status).toBe('ACTIVO')
  })

  test('la lista del bot lo ofrece una sola vez: la salida, no la entrada', async () => {
    const { egreso, ingreso } = await traspasoEscrito()
    const r = await llamar('anular/proponer', { telegram_id: NORMAN })
    const ids = (r.j.opciones as { id: string }[]).map((m) => m.id)
    expect(ids).toContain(egreso)
    expect(ids).not.toContain(ingreso)
  })

  test('recapturar un traspaso se niega: se anula completo y se vuelve a dictar', async () => {
    const { egreso } = await traspasoEscrito()
    const r = await llamar('anular/proponer', {
      telegram_id: NORMAN,
      tabla: 'finanzas',
      id_movimiento: egreso,
      modo: 'recapturar',
      recaptura: { monto: 5, descripcion: 'x', categoria: 'Gasolina' }
    })
    expect(r.status).toBe(422)
    expect(String(r.j.error)).toContain('no se reescribe como gasto')
  })
})

// ─── 5. LAS PIEZAS PURAS ────────────────────────────────────────────────────

test.describe('piezas', () => {
  test('juzgarPareja: exactamente una salida y una entrada, iguales y activas', () => {
    const e = { id: 'e', tipo_movimiento: 'EGRESO_TRASPASO', monto: 10, status: 'ACTIVO' }
    const i = { id: 'i', tipo_movimiento: 'INGRESO_TRASPASO', monto: '10.00', status: 'ACTIVO' }
    expect(juzgarPareja([i, e])).toEqual({ ok: true, ids: ['e', 'i'] })
    expect(juzgarPareja([e]).ok).toBe(false)
    expect(juzgarPareja([e, i, { ...e, id: 'e2' }]).ok).toBe(false)
    expect(juzgarPareja([e, { ...e, id: 'e2' }]).ok).toBe(false)
    expect(juzgarPareja([e, { ...i, monto: 11 }]).ok).toBe(false)
    expect(juzgarPareja([e, { ...i, status: 'ANULADO' }]).ok).toBe(false)
  })

  test('la marca solo vale con su prefijo y su uuid', () => {
    expect(esMarcaDeTraspaso(marcaDeTraspaso('abc'))).toBe(true)
    expect(esMarcaDeTraspaso('traspaso:')).toBe(false)
    expect(esMarcaDeTraspaso('Gasolina')).toBe(false)
    expect(esMarcaDeTraspaso(null)).toBe(false)
  })

  test('el sello amarra monto, cuentas e ids', () => {
    const f = filaPara({ monto: 10, origen_id: EFECTIVO, destino_id: SPIN })
    const base = sellarTraspaso(f)
    expect(sellarTraspaso({ ...f, monto: 11 })).not.toBe(base)
    expect(sellarTraspaso({ ...f, id_cuenta_destino: 'otra' })).not.toBe(base)
    expect(sellarTraspaso({ ...f, id_egreso: 'otro' })).not.toBe(base)
  })

  test('las filas salen de la propuesta en la forma que `saldo_cuenta` lee', () => {
    const f = filaPara({ monto: 10, origen_id: EFECTIVO, destino_id: SPIN })
    const [salida, entrada] = filasDeTraspaso(f)
    expect(salida).toMatchObject({ id: f.id_egreso, tipo_movimiento: 'EGRESO_TRASPASO', id_cuenta_destino: EFECTIVO })
    expect(entrada).toMatchObject({ id: f.id_ingreso, tipo_movimiento: 'INGRESO_TRASPASO', id_cuenta_destino: SPIN })
    expect(salida).not.toHaveProperty('id_cuenta_origen')
  })

  test('tras un reinicio el pendiente sigue siendo un traspaso', () => {
    expect(tipoDelPayload({ tipo: 'traspaso', fila: {}, meta: {} })).toBe('traspaso')
  })

  test('ensayo: `saldo_cuenta` pasa; cualquier otra rpc sigue negada', async () => {
    const llamadas: string[] = []
    const real = {
      rpc: async (n: string) => {
        llamadas.push(n)
        return { data: 7, error: null }
      },
      from: () => ({})
    }
    const c = clienteDeEnsayo(real)
    expect((await c.rpc('saldo_cuenta')).data).toBe(7)
    await Promise.resolve(c.rpc('convertir_transferencias'))
    expect(llamadas).toEqual(['saldo_cuenta'])
  })

  test('ensayo de punta a punta: propone con saldos reales y no escribe', async () => {
    const r = await llamar(
      'traspaso/proponer',
      { telegram_id: NORMAN, propuesta: { monto: 10, origen_id: EFECTIVO, destino_id: SPIN } },
      { 'x-bot-ensayo': '1' }
    )
    expect(r.status).toBe(200)
    expect(String(r.j.mensaje)).toContain('Efectivo: $5,000.00 -> $4,990.00')
    expect(rpcs).toEqual(['saldo_cuenta', 'saldo_cuenta'])
    expect(escrituras).toEqual([])
  })

  test('un traspaso no cuenta como gasto del periodo (la vista dice que si)', () => {
    expect(esEgresoDelPeriodo({ es_egreso_admin: true, tipo_movimiento: 'EGRESO_TRASPASO' })).toBe(false)
    expect(esEgresoDelPeriodo({ es_egreso_admin: true, tipo_movimiento: 'GASTO_OPERATIVO' })).toBe(true)
    expect(esEgresoDelPeriodo({ es_egreso_admin: false, tipo_movimiento: 'GASTO_OPERATIVO' })).toBe(false)
    const src = readFileSync(join(process.cwd(), 'lib/dashboard-utils.ts'), 'utf-8')
    const conjunto = src.slice(src.indexOf('const TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS'), src.indexOf('])', src.indexOf('const TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS')))
    expect(conjunto).toContain('EGRESO_TRASPASO')
    expect(conjunto).toContain('INGRESO_TRASPASO')
  })

  test('la web liga sus dos patas con la misma marca', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/finanzas/nuevo/route.ts'), 'utf-8')
    expect(src).toContain('const marca = marcaDeTraspaso(randomUUID())')
    expect(src.match(/subcategoria: marca,/g)).toHaveLength(2)
  })
})
