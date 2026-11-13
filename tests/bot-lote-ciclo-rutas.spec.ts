/**
 * Lote v2 — LAS RUTAS DEL CICLO, MEDIDAS EN EL HANDLER.
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * Se importa cada `route.ts` nuevo y se le habla como el bot, con un PostgREST
 * simulado por `globalThis.fetch` (mismo enfoque que
 * `tests/bot-rutas-permisos.spec.ts`; este doble ademas entiende `ilike`, `lte`
 * y el upsert con `on_conflict` + `ignore-duplicates`, que es lo que hace que un
 * recordatorio se reclame UNA vez).
 *
 * Validez: mide el handler importado, no el Next vivo ni Postgres. La
 * atomicidad real del reclamo (ON CONFLICT DO NOTHING) se mide aparte, contra
 * Postgres efimero: `scripts/probar_migracion_efimera.py` + `supabase/pruebas/lote_v2_comprobar.sql`.
 */
import { test, expect } from '@playwright/test'
import { NORMAN_TELEGRAM_ID } from '@/lib/bot-permisos'
import * as etapaP from '@/app/api/bot/lote/etapa/proponer/route'
import * as etapaC from '@/app/api/bot/lote/etapa/confirmar/route'
import * as ciclo from '@/app/api/bot/lote/ciclo/route'
import { fechaLocal } from '@/lib/fechas'
import { MENSAJE_ADITIVO_2_NO_ES_ETAPA, sellarEtapa, type PayloadEtapa } from '@/lib/bot-lote-ciclo'

type Ruta = { POST: (r: Request) => Promise<Response> }
const RUTAS: Record<string, Ruta> = { 'lote/etapa/proponer': etapaP, 'lote/etapa/confirmar': etapaC, 'lote/ciclo': ciclo }

const TOKEN = 'y'.repeat(32)
const ENTORNO_FALSO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}
const entornoOriginal: Record<string, string | undefined> = {}

// Auditoria 2026-11-03 (hallazgo 1): Norman es ADMIN sin marca Y su telegram_id.
const NORMAN = NORMAN_TELEGRAM_ID
const KEVIN = 222
const GIL = 333 // DST: los lotes no le tocan
const PEDRO = 666 // TRABAJADOR
const BOTCITO = 777 // ADMIN con rol de bot: no recibe recordatorios

type Fila = Record<string, unknown>
let tablas: Record<string, Fila[]> = {}
let escrituras: string[] = []
let rpcs: { nombre: string; args: Fila }[] = []
let contador = 0
const HOY = fechaLocal(new Date())

function haceDias(n: number): string {
  return fechaLocal(new Date(Date.now() - n * 86400000))
}

function estadoInicial() {
  tablas = {
    entidades: [
      { id: 'ent-matriz', nombre: 'Matriz', rol: 'ADMIN' },
      { id: 'dst-a', nombre: 'Gil', rol: 'DST' }
    ],
    bot_identidades: [
      { telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: null },
      { telegram_id: KEVIN, etiqueta: 'kevin', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: true, rol_bot: null },
      { telegram_id: GIL, etiqueta: 'gil', id_entidad: 'dst-a', id_cuenta_destino: 'c-g', activo: true, requiere_aprobacion: false, rol_bot: null },
      { telegram_id: PEDRO, etiqueta: 'pedro', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: 'TRABAJADOR' },
      { telegram_id: BOTCITO, etiqueta: 'botcito', id_entidad: 'ent-matriz', id_cuenta_destino: 'c-n', activo: true, requiere_aprobacion: false, rol_bot: 'OTRO' }
    ],
    cuentas_financieras: [
      { id: 'c-n', id_entidad: 'ent-matriz', nombre: 'Efectivo', tipo_fiscalidad: 'NO_FISCAL' },
      { id: 'c-g', id_entidad: 'dst-a', nombre: 'Caja Gil', tipo_fiscalidad: 'NO_FISCAL' }
    ],
    catalogo_productos: [
      { id: 'ins-az', sku: 'ing-az', nombre: 'Ingrediente Az', unidad_medida: 'KILOGRAMOS', tipo: 'INSUMO' },
      { id: 'ins-al', sku: 'ing-al', nombre: 'Ingrediente Al', unidad_medida: 'KILOGRAMOS', tipo: 'INSUMO' },
      // Fase 7A: como en produccion desde el 2026-11-07.
      { id: 'ins-ad2', sku: 'aditivo-2', nombre: 'Aditivo 2', unidad_medida: 'GRAMOS', tipo: 'INSUMO' }
    ],
    lotes: [
      { id: 'lote-1', codigo_lote: 'L-15-10.1', fecha_inicio: haceDias(4), creado_en: haceDias(4) + 'T15:00:00Z' },
      { id: 'lote-viejo', codigo_lote: 'L-01-01.1', fecha_inicio: '2025-01-01', creado_en: '2025-01-01T15:00:00Z' }
    ],
    bot_borradores: [
      // El borrador que ABRIO el lote (Pedro) y uno de etapa de Norman con el mismo id_registro.
      { id: 'b-abrio', telegram_id: PEDRO, estado: 'CONFIRMADO', id_registro: 'lote-1', payload: { tipo: 'lote' }, sello: 's' },
      { id: 'b-etapa-vieja', telegram_id: NORMAN, estado: 'CONFIRMADO', id_registro: 'lote-1', payload: { tipo: 'lote_etapa' }, sello: 's' }
    ],
    lote_etapas: [],
    lote_recordatorios: [],
    temperatura_diaria: [
      { fecha: haceDias(4), fuente: 'open-meteo exterior', t_min: 8, t_max: 24, t_prom: 15 },
      { fecha: haceDias(3), fuente: 'open-meteo exterior', t_min: 6, t_max: 26, t_prom: 16 },
      { fecha: haceDias(10), fuente: 'open-meteo exterior', t_min: -5, t_max: 40, t_prom: 10 }
    ]
  }
  escrituras = []
  rpcs = []
}

function valor(v: string): string {
  return decodeURIComponent(v).replace(/^"|"$/g, '')
}

function cumple(fila: Fila, col: string, expr: string): boolean {
  const i = expr.indexOf('.')
  const op = expr.slice(0, i)
  const val = expr.slice(i + 1)
  const actual = fila[col]
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
  const prefer = headers.get('prefer') ?? ''
  const representacion = prefer.includes('return=representation')
  let filas: Fila[] = []

  if (tabla.startsWith('rpc/')) {
    const args = init?.body ? JSON.parse(String(init.body)) : {}
    rpcs.push({ nombre: tabla.slice(4), args })
    escrituras.push(`POST ${tabla}`)
    return json({ id_etapa: 'e-x', entradas: (args.p_entradas ?? []).length, garrafas: (args.p_garrafas ?? []).length })
  }
  if (metodo === 'GET' || metodo === 'HEAD') {
    filas = incrustar(tabla, filtrar(tabla, u.searchParams), u.searchParams.get('select') ?? '')
  } else {
    escrituras.push(`${metodo} ${tabla}`)
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : null
    if (metodo === 'POST') {
      const conflicto = (u.searchParams.get('on_conflict') ?? '').split(',').filter(Boolean)
      const ignorar = prefer.includes('resolution=ignore-duplicates')
      const fundir = prefer.includes('resolution=merge-duplicates')
      const nuevas: Fila[] = []
      for (const c of (Array.isArray(cuerpo) ? cuerpo : [cuerpo]) as Fila[]) {
        const previa = conflicto.length
          ? (tablas[tabla] ?? []).find((f) => conflicto.every((k) => String(f[k]) === String(c[k])))
          : undefined
        if (previa) {
          if (ignorar) continue
          if (fundir || !ignorar) Object.assign(previa, c)
          nuevas.push(previa)
          continue
        }
        // Los defaults de la base que las rutas dan por hechos.
        const defaults: Fila = tabla === 'bot_borradores' ? { estado: 'PENDIENTE', resuelto_en: null, id_registro: null }
          : tabla === 'lote_recordatorios' ? { intentos: 1, entregado_en: null } : {}
        const fila = { id: `${tabla}-${++contador}`, ...defaults, ...c }
        ;(tablas[tabla] ??= []).push(fila)
        nuevas.push(fila)
      }
      filas = nuevas
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

const GARRAFAS = [
  { litros: 20, peso_kg: 18.5, grado_alcohol: 52 },
  { litros: 19, peso_kg: 17, grado_alcohol: 48, notas: 'turbia' },
  { litros: 11, peso_kg: 10, grado_alcohol: 30 }
]

test.describe('etapas: proponer no escribe el lote; confirmar pasa por la puerta', () => {
  // 2026-11-13 (Cris): el aditivo 2 es un INSUMO del inventario, no una etapa
  // del lote. Antes la etapa volvia a sumar la cantidad en lote_entradas (doble).
  test('aditivo 2 ya NO es etapa: proponer -> 422 con el aviso, 0 escrituras (ing-al y aditivo-2)', async () => {
    for (const sku of ['ing-al', 'aditivo-2']) {
      estadoInicial()
      const r = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'aditivo_2', cantidad: 1.5, unidad: 'kg', insumo_sku: sku })
      expect(r.status, JSON.stringify(r.j)).toBe(422)
      expect(r.j.error).toBe(MENSAJE_ADITIVO_2_NO_ES_ETAPA)
      expect(escrituras).toEqual([])
    }
  })

  test('aditivo 2: un borrador VIEJO (anterior a la decision) no se escribe al confirmar -> 409, CANCELADO, sin rpc', async () => {
    estadoInicial()
    const p = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id) as Fila & { sello: string; payload: { etapa: PayloadEtapa } }
    const viejo: PayloadEtapa = { ...b.payload.etapa, etapa: 'aditivo_2', garrafas: [], entradas: [{ id_insumo: 'ins-ad2', cantidad: 1500 }], unidad_entrada: 'g' }
    b.payload = { ...b.payload, etapa: viejo }
    b.sello = sellarEtapa(viejo)
    const c = await llamar('lote/etapa/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: b.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(409)
    expect(c.j.error).toBe(MENSAJE_ADITIVO_2_NO_ES_ETAPA)
    expect(rpcs).toEqual([])
    expect(tablas.bot_borradores.find((x) => x.id === p.j.borrador_id)?.estado).toBe('CANCELADO')
  })

  test('Fase 7A: cantidad sin unidad -> 422, sin borrador', async () => {
    estadoInicial()
    const r = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'aditivo_2', cantidad: 4, insumo_sku: 'aditivo-2' })
    expect(r.status).toBe(422)
    expect(escrituras).toEqual([])
  })

  test('un SKU que no existe no inventa insumo -> 422', async () => {
    estadoInicial()
    const r = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'aditivo_2', cantidad: 2.5, unidad: 'kg', insumo_sku: 'azucar' })
    expect(r.status).toBe(422)
  })

  test('DST (Gil) no registra etapas -> 403, 0 escrituras', async () => {
    estadoInicial()
    const r = await llamar('lote/etapa/proponer', { telegram_id: GIL, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    expect(r.status).toBe(403)
    expect(escrituras).toEqual([])
  })

  test('TRABAJADOR: la destilacion confirmada ESPERA el Aprobar; no llama registrar_etapa_lote', async () => {
    estadoInicial()
    const p = await llamar('lote/etapa/proponer', { telegram_id: PEDRO, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    expect(p.status, JSON.stringify(p.j)).toBe(200)
    const c = await llamar('lote/etapa/confirmar', { telegram_id: PEDRO, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs).toEqual([])
    const b = tablas.bot_borradores.find((x) => x.id === p.j.borrador_id)
    expect(b?.estado).toBe('ESPERA_APROBACION')
  })

  test('Norman: destilacion -> UNA llamada a registrar_etapa_lote con 3 garrafas, y el resumen de fermentacion', async () => {
    estadoInicial()
    const p = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    const c = await llamar('lote/etapa/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: p.j.sello })
    expect(c.status, JSON.stringify(c.j)).toBe(200)
    expect(rpcs.length).toBe(1)
    expect(rpcs[0].nombre).toBe('registrar_etapa_lote')
    expect(rpcs[0].args.p_garrafas).toEqual([
      { numero: 1, litros: 20, peso_kg: 18.5, grado_alcohol: 52 },
      { numero: 2, litros: 19, peso_kg: 17, grado_alcohol: 48, notas: 'turbia' },
      { numero: 3, litros: 11, peso_kg: 10, grado_alcohol: 30 }
    ])
    // El dia de hace 10 dias queda FUERA del periodo (antes de la produccion).
    expect(String(c.j.mensaje)).toContain('Fermentacion: 4 dias')
    expect(String(c.j.mensaje)).toContain('min 6, max 26, promedio 15.5')
    expect(String(c.j.mensaje)).toContain('2 dias con dato')
  })

  test('sello cambiado -> 409 sin escribir', async () => {
    estadoInicial()
    const p = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    const c = await llamar('lote/etapa/confirmar', { telegram_id: NORMAN, borrador_id: p.j.borrador_id, sello: 'f'.repeat(64) })
    expect(c.status).toBe(409)
    expect(rpcs).toEqual([])
  })

  test('etapa ya registrada -> 409 al proponer', async () => {
    estadoInicial()
    tablas.lote_etapas.push({ id: 'e1', id_lote: 'lote-1', etapa: 'destilacion' })
    const r = await llamar('lote/etapa/proponer', { telegram_id: NORMAN, codigo_lote: 'L-15-10.1', etapa: 'destilacion', garrafas: GARRAFAS })
    expect(r.status).toBe(409)
  })
})

test.describe('ciclo: leer, reclamar una vez, temperatura, muestra', () => {
  test('leer: lote de la ventana con quien lo ABRIO (no quien hizo una etapa) y ADMIN sin rol de bot', async () => {
    estadoInicial()
    const r = await llamar('lote/ciclo', { accion: 'leer', ventana_dias: 30 })
    expect(r.status, JSON.stringify(r.j)).toBe(200)
    const lotes = r.j.lotes as Fila[]
    expect(lotes.map((l) => l.codigo_lote)).toEqual(['L-15-10.1'])
    expect(lotes[0].abrio_telegram_id).toBe(PEDRO)
    expect((r.j.admins as number[]).sort()).toEqual([NORMAN, KEVIN].sort())
    expect(r.j.codigos).toEqual(['L-15-10.1', 'L-01-01.1'])
    expect(r.j.hoy).toBe(HOY)
    expect(escrituras).toEqual([])
  })

  test('reclamar: el primero gana, el segundo no (estado en la base, no en RAM)', async () => {
    estadoInicial()
    const a = await llamar('lote/ciclo', { accion: 'reclamar', id_lote: 'lote-1', tipo: 'aditivo_2' })
    const b = await llamar('lote/ciclo', { accion: 'reclamar', id_lote: 'lote-1', tipo: 'aditivo_2' })
    expect(a.j.reclamado).toBe(true)
    expect(b.j.reclamado).toBe(false)
    expect(tablas.lote_recordatorios.length).toBe(1)
    const malo = await llamar('lote/ciclo', { accion: 'reclamar', id_lote: 'lote-1', tipo: 'otro' })
    expect(malo.status).toBe(400)
  })

  test('ronda 2: reintentar es compare-and-swap sobre intentos; entregado lo cierra; tope', async () => {
    estadoInicial()
    await llamar('lote/ciclo', { accion: 'reclamar', id_lote: 'lote-1', tipo: 'aditivo_2' })
    const fila = () => tablas.lote_recordatorios.find((f) => f.id_lote === 'lote-1' && f.tipo === 'aditivo_2')!
    expect([fila().intentos, fila().entregado_en]).toEqual([1, null])
    const a = await llamar('lote/ciclo', { accion: 'reintentar', id_lote: 'lote-1', tipo: 'aditivo_2', intentos: 1 })
    const b = await llamar('lote/ciclo', { accion: 'reintentar', id_lote: 'lote-1', tipo: 'aditivo_2', intentos: 1 })
    expect([a.j.reclamado, b.j.reclamado]).toEqual([true, false])
    expect(fila().intentos).toBe(2)
    const e = await llamar('lote/ciclo', { accion: 'entregado', id_lote: 'lote-1', tipo: 'aditivo_2' })
    expect(e.status, JSON.stringify(e.j)).toBe(200)
    expect(fila().entregado_en).not.toBeNull()
    const c = await llamar('lote/ciclo', { accion: 'reintentar', id_lote: 'lote-1', tipo: 'aditivo_2', intentos: 2 })
    expect(c.j.reclamado).toBe(false)
    const tope = await llamar('lote/ciclo', { accion: 'reintentar', id_lote: 'lote-1', tipo: 'aditivo_2', intentos: 10 })
    expect(tope.j.reclamado).toBe(false)
    const malo = await llamar('lote/ciclo', { accion: 'entregado', id_lote: 'lote-1', tipo: 'otro' })
    expect(malo.status).toBe(400)
    const leido = await llamar('lote/ciclo', { accion: 'leer', ventana_dias: 30 })
    const r = ((leido.j.lotes as { id: string; recordatorios: Fila[] }[]).find((l) => l.id === 'lote-1')?.recordatorios ?? [])[0]
    expect(r && 'intentos' in r && 'entregado_en' in r).toBe(true)
  })

  test('temperatura: guarda dias validos; rechaza min > max y fuentes inventadas', async () => {
    estadoInicial()
    const ok = await llamar('lote/ciclo', { accion: 'temperatura', dias: [{ fecha: HOY, fuente: 'open-meteo exterior', t_min: 7, t_max: 25, t_prom: 16, latitud: 23.17, longitud: -102.87 }] })
    expect(ok.status, JSON.stringify(ok.j)).toBe(200)
    expect(tablas.temperatura_diaria.some((d) => d.fecha === HOY && d.t_prom === 16)).toBe(true)
    const mal = await llamar('lote/ciclo', { accion: 'temperatura', dias: [{ fecha: HOY, fuente: 'open-meteo exterior', t_min: 30, t_max: 10, t_prom: 20 }] })
    expect(mal.status).toBe(400)
    const fuente = await llamar('lote/ciclo', { accion: 'temperatura', dias: [{ fecha: HOY, fuente: 'cuarto', t_min: 1, t_max: 2, t_prom: 1.5 }] })
    expect(fuente.status).toBe(400)
  })

  // Auditoria 2026-11-03 (hallazgo 6): el boton "muestra guardada" escribe sin
  // borrador ni puerta; ahora solo con el clic de Norman. Antes Pedro la anotaba.
  test('muestra: solo Norman la anota, una vez; Pedro, Kevin y el DST -> 403 sin escribir', async () => {
    estadoInicial()
    for (const id of [PEDRO, KEVIN, GIL]) {
      const x = await llamar('lote/ciclo', { accion: 'muestra', telegram_id: id, id_lote: 'lote-1' })
      expect(x.status, `${id} ${JSON.stringify(x.j)}`).toBe(403)
    }
    expect(tablas.lote_etapas.filter((e) => e.etapa === 'muestra')).toHaveLength(0)
    const a = await llamar('lote/ciclo', { accion: 'muestra', telegram_id: NORMAN, id_lote: 'lote-1' })
    const b = await llamar('lote/ciclo', { accion: 'muestra', telegram_id: NORMAN, id_lote: 'lote-1' })
    expect(a.j.nueva, JSON.stringify(a.j)).toBe(true)
    expect(b.j.nueva).toBe(false)
    const filas = tablas.lote_etapas.filter((e) => e.etapa === 'muestra')
    expect(filas.length).toBe(1)
    expect(filas[0].registrado_por).toBe('telegram:norman')
    expect(filas[0].telegram_id).toBe(NORMAN)
  })
})
