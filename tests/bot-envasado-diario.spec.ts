/**
 * Lote v2, ronda 5 (B) — EL ENVASADO DIARIO, SIN LOTE, MEDIDO EN EL HANDLER.
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * Decision de Norman (2026-10-19): el envasado de botellas es diario e
 * independiente del lote. Un envasado nunca abre ni pide un lote; si dicen un
 * codigo L-, se registra igual, sin vinculo, y el codigo va a la nota.
 *
 * Se importa `lote/proponer` y `lote/confirmar` y se les habla como el bot, con
 * un PostgREST simulado por `globalThis.fetch` (el mismo enfoque que
 * `tests/bot-lote-ciclo-rutas.spec.ts`; este doble ademas entiende `not.is.null`
 * y el `or=(...)` del stock del empaque).
 *
 * Validez: mide el handler importado, no el Next vivo ni Postgres. Lo que hace
 * `registrar_envasado_diario` en la base (id_lote NULL, inventario +/-, el
 * candado de empaque) se mide contra Postgres efimero:
 * `scripts/probar_migracion_efimera.py` + `supabase/pruebas/lote_v2_comprobar.sql` (13-15).
 */
import { test, expect } from '@playwright/test'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import * as proponer from '@/app/api/bot/lote/proponer/route'
import * as confirmar from '@/app/api/bot/lote/confirmar/route'
import { tipoDelPayload } from '@/lib/bot-pendiente'
import {
  normalizarEnvasadoDiario,
  notaDelEnvasado,
  sellarEnvasadoDiario,
  selloEnvasadoDiarioCoincide
} from '@/lib/bot-envasado-diario'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = { 'lote/proponer': proponer, 'lote/confirmar': confirmar }

const TOKEN = 'z'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}

// Auditoria 2026-11-03 (hallazgo 1): Norman es ADMIN sin marca Y su telegram_id.
const NORMAN = NORMAN_TELEGRAM_ID
const PEDRO = 666 // TRABAJADOR: espera el Aprobar

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let lecturas: string[] = []
let rpcs: { nombre: string; args: Fila }[] = []
let rpcFalla: string | null = null
let contador = 0

function estadoInicial(corchos = 100) {
  tablas = {
    entidades: [{ id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN' }],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: null },
      { telegram_id: PEDRO, etiqueta: 'pedro', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: 'TRABAJADOR' }
    ],
    cuentas_financieras: [{ id: 'c-n', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL' }],
    catalogo_productos: [
      { id: 'ins-az', sku: 'ing-az', nombre: 'Ingrediente Az', unidad_medida: 'KILOGRAMOS', tipo: 'INSUMO' },
      { id: 'chile-g', sku: 'chile-guajillo', nombre: 'Chile Guajillo', unidad_medida: 'KILOGRAMOS', tipo: 'INSUMO' },
      { id: 'ad1', sku: 'mosto-1', nombre: 'Aditivo 1', unidad_medida: 'GRAMOS', tipo: 'INSUMO' },
      { id: 'corcho', sku: 'corcho', nombre: 'Corcho', unidad_medida: 'PIEZAS', tipo: 'INSUMO' },
      { id: 'bot-750', sku: 'dst-750', nombre: 'Destilado 750', unidad_medida: 'PIEZAS', tipo: 'TERMINADO', ml_por_unidad: 750 }
    ],
    recetas_produccion: [{ id_producto_terminado: 'bot-750', id_insumo: 'corcho', cantidad_requerida: 1 }],
    inventario_ledger: [
      { id: 'led-1', id_producto: 'corcho', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: corchos, id_entidad_origen: null, id_entidad_destino: 'ent-matriz', status: 'ACTIVO' }
    ],
    lotes: [{ id: 'lote-1', codigo_lote: 'L-12-10.1', fecha_inicio: '2026-10-12', creado_en: '2026-10-12T15:00:00Z' }],
    bot_borradores: []
  }
  escrituras = []
  lecturas = []
  rpcs = []
  rpcFalla = null
}

function valor(v: string): string {
  return decodeURIComponent(v).replace(/^"|"$/g, '')
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  if (col === 'or') {
    // or=(a.eq.x,b.eq.y)
    return expr
      .replace(/^\(|\)$/g, '')
      .split(',')
      .some((parte) => {
        const i = parte.indexOf('.')
        return cumple(fila, parte.slice(0, i), parte.slice(i + 1))
      })
  }
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = expr.slice(i + 1)
  const actual = fila[col]
  if (op === 'not') return !cumple(fila, col, val)
  if (op === 'eq') return String(actual) === valor(val)
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'gte') return String(actual) >= valor(val)
  if (op === 'lte') return String(actual) <= valor(val)
  if (op === 'ilike') return String(actual).toLowerCase() === valor(val).toLowerCase()
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').map(valor).includes(String(actual))
  throw new Error(`el doble no entiende el filtro ${col}=${expr}`)
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

function incrustar(tabla: string, filas: Fila[], select: string): Fila[] {
  if (tabla !== 'bot_identidades' || !select.includes('entidades!inner')) return filas
  return filas
    .map((f) => ({ ...f, entidades: tablas.entidades.find((e) => e.id === f.id_entidad) ?? null }))
    .filter((f) => f.entidades)
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
    const args = init?.body ? JSON.parse(String(init.body)) : {}
    rpcs.push({ nombre: tabla.slice(4), args })
    escrituras.push(`POST ${tabla}`)
    if (rpcFalla) return json({ code: 'P0001', message: rpcFalla, details: '', hint: '' }, 400)
    return json({ envasado: (args.p_envasado ?? []).length, filas_inventario: 2 * (args.p_envasado ?? []).length })
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    lecturas.push(tabla)
    filas = incrustar(tabla, filtrar(tabla, u.searchParams), u.searchParams.get('select') ?? '')
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      for (const c of (Array.isArray(cuerpo) ? cuerpo : [cuerpo]) as Fila[]) {
        const defaults: Fila = tabla === 'bot_borradores' ? { estado: 'PENDIENTE', resuelto_en: null, id_registro: null } : {}
        const fila = { id: `${tabla}-${++contador}`, ...defaults, ...c }
        ;(tablas[tabla] ??= []).push(fila)
        filas.push(fila)
      }
    } else if (metodo === 'PATCH') {
      filas = filtrar(tabla, u.searchParams)
      for (const f of filas) Object.assign(f, cuerpo)
    }
    if (!representacion && !objeto) return new Response(null, { status: 204 })
  }
  if (objeto) {
    if (filas.length !== 1) return json({ code: 'PGRST116', message: 'no rows', details: '', hint: '' }, 406)
    return json(filas[0])
  }
  return new Response(JSON.stringify(filas), {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(filas.length - 1, 0)}/${filas.length}` }
  })
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

const ENVASADO = [{ formato: '750', botellas: 40 }]

test.describe('envasado diario (ronda 5, B): nunca abre ni pide un lote', () => {
  test('envasado con codigo L- dicho: borrador envasado_diario, el codigo a la nota, sin tocar lotes', async () => {
    estadoInicial()
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN,
      chat_id: NORMAN,
      insumos: [],
      envasado: ENVASADO,
      propuesta: { codigo_lote: 'l-12-10.1' }
    })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.envasado_diario).toBe(true)
    expect(r.j.codigo_lote).toBeNull()
    expect(r.j.ofrecer_abrir_lote).toBeUndefined()
    // Solo se escribe el borrador (y se cancelan los pendientes): nada de lotes.
    expect(escrituras.every((e) => e.endsWith('bot_borradores'))).toBe(true)
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila & {
      payload: { tipo: string; envasado_diario: { envasado: Fila[]; nota: string } }
    }
    expect(b.payload.tipo).toBe('envasado_diario')
    expect(b.payload.envasado_diario.envasado).toEqual([{ id_producto: 'bot-750', botellas: 40 }])
    expect(b.payload.envasado_diario.nota).toBe('codigo dicho: L-12-10.1 (el envasado no se liga al lote)')
    expect(String(r.j.mensaje)).toContain('sin lote')
    expect(String(r.j.mensaje)).toContain('Nota: codigo dicho: L-12-10.1')
  })

  test('envasado SIN codigo y SIN lotes en la base: igual se propone (no se ofrece abrir lote)', async () => {
    estadoInicial()
    tablas.lotes = []
    const r = await llamar('lote/proponer', { telegram_id: NORMAN, chat_id: NORMAN, insumos: [], envasado: ENVASADO, propuesta: {} })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    expect(r.j.envasado_diario).toBe(true)
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila & { payload: { envasado_diario: { nota: string } } }
    expect(b.payload.envasado_diario.nota).toBe('')
  })

  test('envasado + datos del lote en el mismo mensaje: 422 que pide separarlos, 0 escrituras', async () => {
    estadoInicial()
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN,
      chat_id: NORMAN,
      insumos: [{ insumo: 'chile-guajillo', cantidad: 40 }],
      envasado: ENVASADO,
      propuesta: {}
    })
    expect(r.status).toBe(422)
    expect(String(r.j.error)).toContain('El envasado va aparte')
    expect(escrituras).toEqual([])
  })

  test('falta empaque (D92): no sale borrador', async () => {
    estadoInicial(10)
    const r = await llamar('lote/proponer', { telegram_id: NORMAN, chat_id: NORMAN, insumos: [], envasado: ENVASADO, propuesta: {} })
    // Mismo contrato que el envasado de siempre: 200 con falta_empaque (el bot
    // ofrece registrar la entrada del empaque), sin borrador.
    expect([r.status, r.j.ok, r.j.falta_empaque]).toEqual([200, false, true])
    expect(tablas.bot_borradores.filter((b) => (b.payload as Fila)?.tipo === 'envasado_diario')).toEqual([])
  })

  test('confirmar: llama registrar_envasado_diario (no registrar_en_lote) y marca el borrador', async () => {
    estadoInicial()
    const p = await llamar('lote/proponer', {
      telegram_id: NORMAN, chat_id: NORMAN, insumos: [], envasado: ENVASADO, propuesta: { codigo_lote: 'L-12-10.1' }
    })
    expect(p.status).toBe(200)
    escrituras = []
    const c = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs.map((x) => x.nombre)).toEqual(['registrar_envasado_diario'])
    expect(rpcs[0].args.p_envasado).toEqual([{ id_producto: 'bot-750', botellas: 40 }])
    expect(String(rpcs[0].args.p_nota)).toContain('L-12-10.1')
    // Ronda 6 (auditoria r5, 2): dice el dia y el formato, no 'Quedo el lote'.
    expect(String(c.j.mensaje)).toMatch(/^Listo\. Envasado del \d{2}\/\d{2}\/\d{4}: 40 de 750 ml \(sin lote\)/)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila
    expect(b.estado).toBe('CONFIRMADO')
  })

  test('confirmar con FALTA_EMPAQUE de la base: 409 y el borrador no queda confirmado', async () => {
    estadoInicial()
    const p = await llamar('lote/proponer', { telegram_id: NORMAN, chat_id: NORMAN, insumos: [], envasado: ENVASADO, propuesta: {} })
    rpcFalla = 'FALTA_EMPAQUE: Corcho (ocupas 40, hay 0)'
    const c = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status).toBe(409)
    expect((tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila).estado).not.toBe('CONFIRMADO')
  })

  test('sello alterado: 409, no escribe', async () => {
    estadoInicial()
    const p = await llamar('lote/proponer', { telegram_id: NORMAN, chat_id: NORMAN, insumos: [], envasado: ENVASADO, propuesta: {} })
    const c = await llamar('lote/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: 'f'.repeat(64) })
    expect(c.status).toBe(409)
    expect(rpcs).toEqual([])
  })

  test('TRABAJADOR (Pedro): confirmar NO escribe, espera el Aprobar', async () => {
    estadoInicial()
    const p = await llamar('lote/proponer', { telegram_id: PEDRO, chat_id: PEDRO, insumos: [], envasado: ENVASADO, propuesta: {} })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const c = await llamar('lote/confirmar', { telegram_id: PEDRO, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.j.espera_aprobacion, JSON.stringify(c.j)).toBe(true)
    expect(rpcs).toEqual([])
  })
})

test.describe('Fase 7: el dia de produccion con el aditivo 1 en GRAMOS', () => {
  // Norman 2026-11-07: "no quiero la equivalencia, quiero que sean 180 gramos".
  // La plantilla pregunta el aditivo 1 EN GRAMOS y lo manda con unidad 'g'.
  test('la plantilla manda 8 g de aditivo 1 -> el borrador lleva 8 (g), no 8000; el chile en kg queda igual', async () => {
    estadoInicial()
    tablas.lotes = []
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN,
      chat_id: NORMAN,
      insumos: [
        { insumo: 'chile-guajillo', cantidad: 40, unidad: 'kg' },
        { insumo: 'mosto-1', cantidad: 8, unidad: 'g' }
      ],
      envasado: [],
      propuesta: { codigo_lote: 'L-07-11.1' }
    })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila & { payload: { lote: { entradas: Fila[] } } }
    expect(b.payload.lote.entradas).toEqual([
      { id_insumo: 'chile-g', cantidad: 40 },
      { id_insumo: 'ad1', cantidad: 8 }
    ])
  })

  test('solo si lo DIJERON en kilos ("8 kg de aditivo", la plantilla lo pasa a 8000 g) el borrador lleva 8000', async () => {
    estadoInicial()
    tablas.lotes = []
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN, chat_id: NORMAN, insumos: [{ insumo: 'mosto-1', cantidad: 8, unidad: 'kg' }], envasado: [], propuesta: { codigo_lote: 'L-07-11.1' }
    })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila & { payload: { lote: { entradas: Fila[] } } }
    expect(b.payload.lote.entradas).toEqual([{ id_insumo: 'ad1', cantidad: 8000 }])
  })

  test('sin unidad (camino del modelo) la cantidad va tal cual en la unidad del catalogo', async () => {
    estadoInicial()
    tablas.lotes = []
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN, chat_id: NORMAN, insumos: [{ insumo: 'mosto-1', cantidad: 8 }], envasado: [], propuesta: { codigo_lote: 'L-07-11.1' }
    })
    const b = tablas.bot_borradores.find((x) => x.id === r.j.borrador_id) as Fila & { payload: { lote: { entradas: Fila[] } } }
    expect(b.payload.lote.entradas).toEqual([{ id_insumo: 'ad1', cantidad: 8 }])
  })

  test('kilos de algo que se lleva en piezas: 422, no se convierte ni se escribe', async () => {
    estadoInicial()
    tablas.lotes = []
    const r = await llamar('lote/proponer', {
      telegram_id: NORMAN, chat_id: NORMAN, insumos: [{ insumo: 'corcho', cantidad: 2, unidad: 'kg' }], envasado: [], propuesta: { codigo_lote: 'L-07-11.1' }
    })
    expect(r.status).toBe(422)
    expect(String(r.j.error)).toContain('No lo convierto')
    expect(escrituras).toEqual([])
  })
})

test.describe('envasado diario: lo puro', () => {
  test('el pendiente de un envasado_diario es de tipo lote (se confirma por /lote/confirmar)', () => {
    expect(tipoDelPayload({ tipo: 'envasado_diario' })).toBe('lote')
  })

  test('nota del codigo dicho; sin codigo, vacia', () => {
    expect(notaDelEnvasado(' l-12-10.1 ')).toBe('codigo dicho: L-12-10.1 (el envasado no se liga al lote)')
    expect(notaDelEnvasado(null)).toBe('')
  })

  test('normalizar: suma el formato repetido y rechaza botellas no enteras', () => {
    const f = { id: 'bot-750', sku: 'dst-750', nombre: 'Destilado 750', ml_por_unidad: 750 }
    const r = normalizarEnvasadoDiario(
      [{ formato: f, botellas: 10 }, { formato: f, botellas: 5 }],
      { etiqueta: 'norman', ahora: new Date('2026-10-19T18:00:00Z') }
    )
    expect(r.ok && r.payload.envasado).toEqual([{ id_producto: 'bot-750', botellas: 15 }])
    expect(normalizarEnvasadoDiario([{ formato: f, botellas: 2.5 }], { etiqueta: 'n', ahora: new Date() }).ok).toBe(false)
  })

  test('el sello cubre la nota: cambiarla rompe el sello', () => {
    const p = { fecha: '2026-10-19', usuario_creador: 'telegram:norman', envasado: [{ id_producto: 'x', botellas: 1 }], nota: '' }
    const s = sellarEnvasadoDiario(p)
    expect(selloEnvasadoDiarioCoincide(p, s)).toBe(true)
    expect(selloEnvasadoDiarioCoincide({ ...p, nota: 'codigo dicho: L-1' }, s)).toBe(false)
  })
})
