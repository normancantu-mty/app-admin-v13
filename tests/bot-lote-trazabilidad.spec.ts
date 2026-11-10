/**
 * Fase 7B — UN LOTE DE PUNTA A PUNTA DESDE EL BOT, Y SU TRAZABILIDAD.
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).
 *
 * Se importan las rutas reales y se les habla como el bot, en orden:
 *   1. dia de produccion   lote/proponer + lote/confirmar      (chile 40 kg, aditivo 1 8 kg -> 8000 g, benzoato 200 g)
 *   2. fin de fermentacion lote/etapa/proponer + confirmar     (ayer, 90 h -> cabecera del lote)
 *   3. aditivo 2           lote/etapa/proponer + confirmar     (1.5 kg -> 1500 g, fecha de lote_etapas)
 *   4. destilacion         lote/etapa/proponer + confirmar     (3 garrafas: 20 kg al 43%, 15 kg al 8%, 10 kg al 30%)
 *   5. envasado            lote/proponer + lote/confirmar      (40 de 750, diario, SIN lote)
 *   6. trazabilidad        pregunta                            (la linea de tiempo entera)
 * y despues de cada paso se revisa QUE se escribio.
 *
 * El doble de PostgREST (`globalThis.fetch`, el de `bot-envasado-diario.spec.ts`)
 * ademas APLICA las tres funciones SQL a sus tablas, para que el paso 6 lea lo
 * que dejaron los pasos 1-5.
 *
 * Validez: mide los handlers importados y la forma en que llaman a la base, no
 * el Next vivo ni Postgres. Lo que hacen `registrar_en_lote`,
 * `registrar_etapa_lote` y `registrar_envasado_diario` dentro de Postgres NO se
 * mide aqui (el doble los imita en lo minimo: filas en sus tablas).
 */
import { test, expect } from '@playwright/test'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import * as loteP from '@/app/api/bot/lote/proponer/route'
import * as loteC from '@/app/api/bot/lote/confirmar/route'
import * as etapaP from '@/app/api/bot/lote/etapa/proponer/route'
import * as etapaC from '@/app/api/bot/lote/etapa/confirmar/route'
import * as pregunta from '@/app/api/bot/pregunta/route'
import { fechaLocal, fechaParaPersona } from '@/lib/fechas'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = {
  'lote/proponer': loteP,
  'lote/confirmar': loteC,
  'lote/etapa/proponer': etapaP,
  'lote/etapa/confirmar': etapaC,
  pregunta
}

const TOKEN = 'w'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}

const NORMAN = NORMAN_TELEGRAM_ID
const GIL = 333 // DST: la trazabilidad no le toca

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let rpcs: { nombre: string; args: Fila }[] = []
let contador = 0
const HOY = fechaLocal(new Date())
function haceDias(n: number): string {
  return fechaLocal(new Date(Date.now() - n * 86400000))
}
const INICIO = haceDias(5)
const AYER = haceDias(1)
const CODIGO = 'L-77-10.1'

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN' },
      { id: 'dst-a', nombre: 'Gil', rol: 'DST' }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: null },
      { telegram_id: GIL, etiqueta: 'gil', id_entidad: 'dst-a', id_cuenta_destino: 'c-g', activo: true, requiere_aprobacion: false, rol_bot: null }
    ],
    cuentas_financieras: [
      { id: 'c-n', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-g', id_entidad: 'dst-a', nombre: 'Caja Gil', tipo_fiscalidad: 'NO_FISCAL' }
    ],
    // Como en produccion: los dos aditivos en GRAMOS (Norman 2026-11-10: "mejor si los registre como gramos en el erp").
    catalogo_productos: [
      { id: 'chile-g', sku: 'chile-guajillo', nombre: 'Chile Guajillo', unidad_medida: 'KILOGRAMOS', tipo: 'INSUMO' },
      { id: 'ad1', sku: 'mosto-1', nombre: 'Aditivo 1', unidad_medida: 'GRAMOS', tipo: 'INSUMO' },
      { id: 'ad2', sku: 'aditivo-2', nombre: 'Aditivo 2', unidad_medida: 'GRAMOS', tipo: 'INSUMO' },
      { id: 'benz', sku: 'benzoato', nombre: 'Benzoato de sodio', unidad_medida: 'GRAMOS', tipo: 'INSUMO' },
      { id: 'corcho', sku: 'corcho', nombre: 'Corcho', unidad_medida: 'PIEZAS', tipo: 'INSUMO' },
      { id: 'bot-750', sku: 'dst-750', nombre: 'Destilado 750', unidad_medida: 'PIEZAS', tipo: 'TERMINADO', ml_por_unidad: 750 }
    ],
    recetas_produccion: [{ id_producto_terminado: 'bot-750', id_insumo: 'corcho', cantidad_requerida: 1 }],
    inventario_ledger: [
      { id: 'led-1', id_producto: 'corcho', tipo_movimiento: 'ENTRADA_COMPRA', cantidad: 500, id_entidad_origen: null, id_entidad_destino: 'ent-matriz', status: 'ACTIVO' }
    ],
    lotes: [],
    lote_entradas: [],
    lote_salidas: [],
    lote_envasado: [],
    lote_etapas: [],
    lote_recordatorios: [],
    temperatura_diaria: [
      { fecha: haceDias(4), fuente: 'open-meteo exterior', t_min: 8, t_max: 24, t_prom: 15 },
      { fecha: haceDias(3), fuente: 'open-meteo exterior', t_min: 6, t_max: 26, t_prom: 16 }
    ],
    v_lote_rendimiento: [],
    bot_borradores: []
  }
  escrituras = []
  rpcs = []
}

function valor(v: string): string {
  return decodeURIComponent(v).replace(/^"|"$/g, '')
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  if (col === 'or') {
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
  if (op === 'neq') return String(actual) !== valor(val)
  if (op === 'is') return val === 'null' ? actual === null || actual === undefined : String(actual) === val
  if (op === 'gte') return String(actual) >= valor(val)
  if (op === 'lte') return String(actual) <= valor(val)
  if (op === 'ilike') return String(actual).toLowerCase() === valor(val).replace(/\\(.)/g, '$1').toLowerCase()
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

/** Lo minimo de cada funcion SQL: sus filas en sus tablas. */
function aplicarRpc(nombre: string, a: Fila): unknown {
  const nueva = (tabla: string, f: Fila) => tablas[tabla].push({ id: `${tabla}-${++contador}`, ...f })
  if (nombre === 'registrar_en_lote') {
    for (const e of (a.p_entradas as Fila[]) ?? []) nueva('lote_entradas', { id_lote: a.p_id_lote, id_insumo: e.id_insumo, cantidad: e.cantidad })
    for (const t of (a.p_tandas as Fila[]) ?? []) {
      nueva('lote_salidas', { id_lote: a.p_id_lote, numero_tanda: t.numero_tanda, litros: t.litros, grado_alcohol: t.grado_alcohol ?? null, peso_kg: null })
    }
    return { filas_inventario: ((a.p_entradas as Fila[]) ?? []).length }
  }
  if (nombre === 'registrar_etapa_lote') {
    nueva('lote_etapas', { id_lote: a.p_id_lote, etapa: a.p_etapa, fecha: a.p_fecha, datos: a.p_datos, registrado_por: a.p_usuario })
    for (const e of (a.p_entradas as Fila[]) ?? []) nueva('lote_entradas', { id_lote: a.p_id_lote, id_insumo: e.id_insumo, cantidad: e.cantidad })
    for (const g of (a.p_garrafas as Fila[]) ?? []) {
      nueva('lote_salidas', {
        id_lote: a.p_id_lote, numero_tanda: g.numero, litros: g.litros ?? null, grado_alcohol: g.grado_alcohol, peso_kg: g.peso_kg, notas: g.notas ?? null
      })
    }
    return { id_etapa: 'e-x' }
  }
  if (nombre === 'registrar_envasado_diario') {
    for (const e of (a.p_envasado as Fila[]) ?? []) {
      nueva('lote_envasado', { id_lote: null, id_producto: e.id_producto, botellas: e.botellas, fecha: a.p_fecha })
    }
    return { envasado: ((a.p_envasado as Fila[]) ?? []).length, filas_inventario: 2 * ((a.p_envasado as Fila[]) ?? []).length }
  }
  throw new Error('rpc desconocida ' + nombre)
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
    return json(aplicarRpc(tabla.slice(4), args))
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
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
    } else if (metodo === 'DELETE') {
      const fuera = new Set(filtrar(tabla, u.searchParams))
      tablas[tabla] = (tablas[tabla] ?? []).filter((f) => !fuera.has(f))
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

/** proponer + confirmar; devuelve la respuesta del confirmar. Nada se escribe en proponer (salvo el borrador). */
async function proponerYConfirmar(proponer: string, confirmar: string, cuerpo: Record<string, unknown>) {
  const antes = escrituras.length
  const p = await llamar(proponer, { telegram_id: NORMAN, chat_id: NORMAN, ...cuerpo })
  expect(p.status, JSON.stringify(p.j)).toBe(200)
  expect(escrituras.slice(antes).every((e) => e.endsWith('bot_borradores')), escrituras.slice(antes).join(', ')).toBe(true)
  const c = await llamar(confirmar, { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
  expect(c.status, JSON.stringify(c.j)).toBe(200)
  return { p, c }
}

const delLote = (tabla: string) => tablas[tabla].filter((f) => f.id_lote === tablas.lotes[0]?.id)

test.describe('Fase 7B: un lote de punta a punta desde el bot', () => {
  test('produccion -> fin -> aditivo 2 -> destilacion (3 garrafas) -> envasado -> trazabilidad', async () => {
    estadoInicial()

    // ── 1. DIA DE PRODUCCION ────────────────────────────────────────────────
    const uno = await proponerYConfirmar('lote/proponer', 'lote/confirmar', {
      insumos: [
        { insumo: 'chile-guajillo', cantidad: 40, unidad: 'kg' },
        { insumo: 'mosto-1', cantidad: 8, unidad: 'kg' },
        { insumo: 'benzoato', cantidad: 200, unidad: 'g' }
      ],
      envasado: [],
      propuesta: { tandas: [], codigo_lote: CODIGO, fecha_inicio: INICIO, brix_chile: 12 }
    })
    expect(uno.c.j.codigo_lote).toBe(CODIGO)
    expect(tablas.lotes).toHaveLength(1)
    expect(tablas.lotes[0]).toMatchObject({ codigo_lote: CODIGO, fecha_inicio: INICIO, brix_chile: 12 })
    expect(tablas.lotes[0].fecha_fin_fermentacion ?? null).toBeNull()
    const r1 = rpcs.filter((r) => r.nombre === 'registrar_en_lote')
    expect(r1).toHaveLength(1)
    // 8 kg de aditivo 1 se escriben 8000 (el catalogo lo lleva en GRAMOS).
    expect(new Set((r1[0].args.p_entradas as Fila[]).map((e) => `${e.id_insumo}=${e.cantidad}`))).toEqual(
      new Set(['chile-g=40', 'ad1=8000', 'benz=200'])
    )

    // ── 2. FIN DE FERMENTACION (ayer, 90 h) ─────────────────────────────────
    const dos = await proponerYConfirmar('lote/etapa/proponer', 'lote/etapa/confirmar', {
      codigo_lote: CODIGO.toLowerCase(),
      etapa: 'fin_fermentacion',
      fecha: AYER,
      horas: 90
    })
    expect(String(dos.p.j.mensaje)).toContain('Fermento 4 dia(s)')
    expect(tablas.lotes[0]).toMatchObject({ fecha_fin_fermentacion: AYER, horas_fermentacion: 90 })
    expect(rpcs.filter((r) => r.nombre === 'registrar_etapa_lote')).toHaveLength(0) // va a la cabecera, no a lote_etapas
    expect(dos.c.j.fermentacion).toMatchObject({ desde: INICIO, hasta: AYER, horas: 90 })
    // Un segundo fin no pisa el primero.
    const otra = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: CODIGO, etapa: 'fin_fermentacion', horas: 10 })
    expect(otra.status).toBe(422)
    expect(String(otra.j.error)).toContain('ya tiene fin de fermentacion')
    expect(tablas.lotes[0].fecha_fin_fermentacion).toBe(AYER)

    // ── 3. ADITIVO 2 (1.5 kg -> 1500 g) ─────────────────────────────────────
    await proponerYConfirmar('lote/etapa/proponer', 'lote/etapa/confirmar', {
      codigo_lote: CODIGO,
      etapa: 'aditivo_2',
      cantidad: 1.5,
      unidad: 'kg',
      insumo_sku: 'aditivo-2'
    })
    const ad2 = delLote('lote_etapas').find((e) => e.etapa === 'aditivo_2')
    expect(ad2).toMatchObject({ fecha: HOY, datos: { cantidad: 1500, unidad: 'g' } })
    expect(delLote('lote_entradas').find((e) => e.id_insumo === 'ad2')?.cantidad).toBe(1500)

    // ── 4. DESTILACION: 3 garrafas ──────────────────────────────────────────
    await proponerYConfirmar('lote/etapa/proponer', 'lote/etapa/confirmar', {
      codigo_lote: CODIGO,
      etapa: 'destilacion',
      garrafas: [
        { litros: 22, peso_kg: 20, grado_alcohol: 43 },
        { litros: 16, peso_kg: 15, grado_alcohol: 8, notas: 'colas' },
        { litros: 11, peso_kg: 10, grado_alcohol: 30 }
      ]
    })
    expect(delLote('lote_salidas').map((s) => [s.numero_tanda, s.litros, s.peso_kg, s.grado_alcohol, s.notas])).toEqual([
      [1, 22, 20, 43, null],
      [2, 16, 15, 8, 'colas'],
      [3, 11, 10, 30, null]
    ])
    expect(delLote('lote_etapas').find((e) => e.etapa === 'destilacion')).toMatchObject({ fecha: HOY, datos: { garrafas: 3 } })

    // ── 5. ENVASADO DIARIO: SIN lote ────────────────────────────────────────
    await proponerYConfirmar('lote/proponer', 'lote/confirmar', { insumos: [], envasado: [{ formato: '750', botellas: 40 }], propuesta: {} })
    expect(tablas.lote_envasado).toEqual([expect.objectContaining({ id_lote: null, id_producto: 'bot-750', botellas: 40 })])

    // ── 6. TRAZABILIDAD ─────────────────────────────────────────────────────
    const t = await llamar('pregunta', { telegram_id: NORMAN, texto: `trazabilidad del lote ${CODIGO.toLowerCase()}` })
    expect(t.status, JSON.stringify(t.j)).toBe(200)
    expect(t.j).toMatchObject({ ok: true, reconocida: true, tipo: 'trazabilidad_lote' })
    const txt = String(t.j.texto)
    for (const linea of [
      `LOTE ${CODIGO} — trazabilidad`,
      'Etapa: destilado',
      `Fermento 4 dia(s) (90 h): del ${fechaParaPersona(INICIO)} al ${fechaParaPersona(AYER)}`,
      `${fechaParaPersona(INICIO)} — DIA DE PRODUCCION`,
      '   Chile Guajillo: 40 kg',
      '   Aditivo 1: 8000 g (8 kg)',
      '   Benzoato de sodio: 200 g',
      '   Brix del chile: 12',
      `${fechaParaPersona(AYER)} — FIN DE FERMENTACION`,
      `${fechaParaPersona(HOY)} — ADITIVO 2`,
      '   Aditivo 2: 1500 g (1.5 kg)',
      `${fechaParaPersona(HOY)} — DESTILACION: 3 garrafa(s)`,
      '   Garrafa 1: 22 L, 20 kg al 43%',
      '   Garrafa 2: 16 L, 15 kg al 8%',
      '   Garrafa 3: 11 L, 10 kg al 30%',
      '   Total: 45 kg',
      // 20x0.43 + 15x0.08 + 10x0.30 = 8.6 + 1.2 + 3 = 12.8
      '   Alcohol puro: ~12.8 kg (calculo: peso x grado',
      'Botellas ligadas al lote: 0',
      'El envasado diario no se liga a un lote'
    ]) {
      expect(txt, txt).toContain(linea)
    }
    // El orden: produccion < fin < aditivo 2 < destilacion.
    const pos = (s: string) => txt.indexOf(s)
    expect(pos('DIA DE PRODUCCION')).toBeLessThan(pos('FIN DE FERMENTACION'))
    expect(pos('FIN DE FERMENTACION')).toBeLessThan(pos('— ADITIVO 2'))
    expect(pos('— ADITIVO 2')).toBeLessThan(pos('DESTILACION'))
    // El aditivo 2 NO sale en el dia de produccion (su fecha es la de su etapa).
    expect(txt.slice(pos('DIA DE PRODUCCION'), pos('FIN DE FERMENTACION'))).not.toContain('Aditivo 2')

    // La pregunta no escribe nada.
    const n = escrituras.length
    await llamar('pregunta', { telegram_id: NORMAN, texto: `en que etapa va el lote ${CODIGO}` })
    await llamar('pregunta', { telegram_id: NORMAN, texto: 'lotes abiertos' })
    await llamar('pregunta', { telegram_id: NORMAN, texto: 'cuanto se produjo este mes' })
    expect(escrituras.length).toBe(n)
  })

  test('en que etapa / lotes abiertos / produccion del mes, contra lo escrito', async () => {
    estadoInicial()
    tablas.lotes = [
      { id: 'l-a', codigo_lote: 'L-01-11.1', fecha_inicio: haceDias(3), fecha_fin_fermentacion: null, horas_fermentacion: null },
      { id: 'l-b', codigo_lote: 'L-02-11.1', fecha_inicio: haceDias(6), fecha_fin_fermentacion: haceDias(1), horas_fermentacion: 100 },
      { id: 'l-c', codigo_lote: 'L-03-11.1', fecha_inicio: haceDias(9), fecha_fin_fermentacion: haceDias(4), horas_fermentacion: null }
    ]
    tablas.lote_etapas = [{ id_lote: 'l-c', etapa: 'destilacion', fecha: HOY, datos: { garrafas: 1 } }]
    tablas.lote_salidas = [{ id_lote: 'l-c', numero_tanda: 1, litros: null, grado_alcohol: 50, peso_kg: 18 }]
    tablas.lote_entradas = [{ id_lote: 'l-a', id_insumo: 'chile-g', cantidad: 30 }]

    const e = await llamar('pregunta', { telegram_id: NORMAN, texto: '¿En qué etapa va el lote L-02-11.1?' })
    expect(e.j).toMatchObject({ reconocida: true, tipo: 'etapa_lote' })
    expect(String(e.j.texto)).toContain('LOTE L-02-11.1: fermentacion terminada, falta destilar.')

    const a = await llamar('pregunta', { telegram_id: NORMAN, texto: 'que lotes hay abiertos' })
    expect(a.j).toMatchObject({ reconocida: true, tipo: 'lotes_abiertos' })
    const ta = String(a.j.texto)
    expect(ta).toContain('Lotes abiertos (sin destilar): 2')
    expect(ta).toContain('L-01-11.1')
    expect(ta).toContain('L-02-11.1')
    expect(ta).not.toContain('L-03-11.1')

    const p = await llamar('pregunta', { telegram_id: NORMAN, texto: 'cuanto se produjo este mes' })
    expect(p.j).toMatchObject({ reconocida: true, tipo: 'produccion_mes' })
    const tp = String(p.j.texto)
    // Lo que cae en el mes depende de la fecha de hoy; lo destilado HOY cae siempre.
    expect(tp).toContain('Lotes destilados: 1 (L-03-11.1)')
    expect(tp).toContain('Garrafas: 1, 18 kg')
    expect(tp).toContain('Alcohol puro: ~9 kg')

    const no = await llamar('pregunta', { telegram_id: NORMAN, texto: 'trazabilidad del lote L-99-12.9' })
    expect(String(no.j.texto)).toContain('No tengo el lote L-99-12.9')
    const sin = await llamar('pregunta', { telegram_id: NORMAN, texto: 'trazabilidad del lote' })
    expect(String(sin.j.texto)).toContain('De cual lote?')
  })

  test('un DST no ve la trazabilidad (cifra de la empresa): 403, sin leer lotes', async () => {
    estadoInicial()
    for (const texto of [`trazabilidad del lote ${CODIGO}`, `en que etapa va el lote ${CODIGO}`, 'lotes abiertos', 'cuanto se produjo este mes']) {
      const r = await llamar('pregunta', { telegram_id: GIL, texto })
      expect(r.status, texto).toBe(403)
    }
  })

  test('si la web anota el fin entre la propuesta y el Confirmar, el bot no lo pisa (409)', async () => {
    estadoInicial()
    tablas.lotes.push({ id: 'l-carrera', codigo_lote: CODIGO, fecha_inicio: INICIO, fecha_fin_fermentacion: null, horas_fermentacion: null })
    const a = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, chat_id: NORMAN, codigo_lote: CODIGO, etapa: 'fin_fermentacion', horas: 20 })
    expect(a.status, JSON.stringify(a.j)).toBe(200)
    // La web (guardarLoteAction) escribe el fin mientras el borrador espera.
    Object.assign(tablas.lotes[0], { fecha_fin_fermentacion: AYER, horas_fermentacion: 90 })
    const c = await llamar('lote/etapa/confirmar', { telegram_id: NORMAN, borrador_id: a.j.borrador_id, sello: a.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(409)
    expect(String(c.j.error)).toContain('ya tenia fin de fermentacion')
    expect(tablas.lotes[0]).toMatchObject({ fecha_fin_fermentacion: AYER, horas_fermentacion: 90 })
  })
})
