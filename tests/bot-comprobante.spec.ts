/**
 * 2026-11-03 -- LA RUTA QUE GUARDA LA FOTO DEL TICKET, MEDIDA EN EL HANDLER.
 * Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).
 *
 * Se importa el `route.ts` y se le habla como el bot, con PostgREST y Storage
 * simulados por `globalThis.fetch`, como `tests/bot-rutas-permisos.spec.ts`.
 * Lo que tumba estas pruebas: quitar el chequeo del movimiento (la foto nacería
 * sin gasto), aceptar mas de 200 KB, o no comprobar el sha256.
 *
 * Validez: mide el handler importado, no el bucket real.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { POST } from '@/app/api/bot/comprobante/subir/route'
import {
  BUCKET_COMPROBANTES,
  TOPE_BYTES,
  filaDeComprobante,
  rutaDeComprobante,
  validarSubida
} from '@/lib/bot-comprobante'

const TOKEN = 'x'.repeat(32)
const NORMAN = 6571822622
const DESCONOCIDO = 999
const ID_MOV = 'dddddddd-1111-4222-8333-444444444444'
const BORRADOR = '11111111-2222-4333-8444-555555555555'
const ENTORNO: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  BOT_API_TOKEN: TOKEN
}

function jpeg(tamano = 64): Buffer {
  const b = Buffer.alloc(tamano, 7)
  b[0] = 0xff
  b[1] = 0xd8
  b[2] = 0xff
  return b
}

function cuerpo(extra: Record<string, unknown> = {}, imagen: Buffer = jpeg()) {
  return {
    telegram_id: NORMAN,
    id_movimiento: ID_MOV,
    borrador_id: BORRADOR,
    mime: 'image/jpeg',
    ancho: 900,
    alto: 1200,
    sha256: createHash('sha256').update(imagen).digest('hex'),
    imagen_b64: imagen.toString('base64'),
    ticket: {
      monto: 500,
      factura: {
        rfc_emisor: 'GCH120515AB3',
        razon_social: 'GASOLINERA EL CHILE SA DE CV',
        folio: 'A-48213',
        fecha: '2026-11-02',
        hora: '18:47',
        subtotal: 431.03,
        iva: 68.97,
        total: 500,
        forma_pago: 'Tarjeta',
        url_facturacion: 'https://facturacion.gaschile.mx',
        leyenda_facturacion: null
      }
    },
    ...extra
  }
}

interface Llamada {
  metodo: string
  ruta: string
  cuerpo: unknown
  cabeceras: Headers
}
let llamadas: Llamada[] = []
let fallaStorage = false
let fallaFila = false
let hayMovimiento = true
const original = globalThis.fetch
const entornoOriginal: Record<string, string | undefined> = {}

function respuesta(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'content-range': '0-0/1' }
  })
}

test.beforeEach(() => {
  llamadas = []
  fallaStorage = false
  fallaFila = false
  hayMovimiento = true
  for (const [k, v] of Object.entries(ENTORNO)) {
    entornoOriginal[k] = process.env[k]
    process.env[k] = v
  }
  globalThis.fetch = (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(entrada instanceof Request ? entrada.url : String(entrada))
    const metodo = (init?.method ?? 'GET').toUpperCase()
    const cabeceras = new Headers(init?.headers)
    llamadas.push({ metodo, ruta: url.pathname + url.search, cuerpo: init?.body, cabeceras })
    const uno = (cabeceras.get('accept') ?? '').includes('vnd.pgrst.object')
    const filas = (f: unknown[]) => respuesta(uno ? (f[0] ?? null) : f)

    if (url.pathname === '/rest/v1/bot_identidades') {
      const registrado = url.searchParams.get('telegram_id') === 'eq.' + NORMAN
      return filas(registrado ? [{
        telegram_id: NORMAN, etiqueta: 'norman', id_entidad: 'ent', id_cuenta_destino: 'c',
        activo: true, requiere_aprobacion: false
      }] : [])
    }
    if (url.pathname === '/rest/v1/entidades') return filas([{ nombre: 'Matriz', rol: 'ADMIN' }])
    if (url.pathname === '/rest/v1/cuentas_financieras') return filas([])
    if (url.pathname === '/rest/v1/finanzas_ledger') {
      return filas(hayMovimiento ? [{ id: ID_MOV }] : [])
    }
    if (url.pathname.startsWith('/storage/v1/object/')) {
      return fallaStorage
        ? respuesta({ statusCode: '500', error: 'caido', message: 'caido' }, 500)
        : respuesta({ Key: url.pathname, Id: 'x' })
    }
    if (url.pathname === '/rest/v1/comprobantes_gasto') {
      return fallaFila ? respuesta({ message: 'caida' }, 500) : new Response(null, { status: 201 })
    }
    throw new Error('llamada inesperada: ' + metodo + ' ' + url.pathname)
  }) as typeof fetch
})

test.afterEach(() => {
  globalThis.fetch = original
  for (const k of Object.keys(ENTORNO)) {
    if (entornoOriginal[k] === undefined) delete process.env[k]
    else process.env[k] = entornoOriginal[k]
  }
})

function peticion(c: unknown, cabeceras: Record<string, string> = { 'x-bot-token': TOKEN }) {
  return new Request('http://x/api/bot/comprobante/subir', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabeceras },
    body: JSON.stringify(c)
  })
}

const alBucket = () => llamadas.filter((l) => l.ruta.startsWith('/storage/'))
const aLaFila = () => llamadas.filter((l) => l.ruta.startsWith('/rest/v1/comprobantes_gasto'))

test('sube la foto al bucket privado y liga la fila al movimiento', async () => {
  const c = cuerpo()
  const r = await POST(peticion(c))
  const obj = await r.json()
  const ruta = ID_MOV + '/' + c.sha256 + '.jpg'
  expect(r.status).toBe(200)
  expect(obj).toEqual({ ok: true, ruta })

  expect(alBucket()).toHaveLength(1)
  expect(alBucket()[0].ruta).toBe('/storage/v1/object/' + BUCKET_COMPROBANTES + '/' + ruta)
  expect(alBucket()[0].cabeceras.get('x-upsert')).toBe('true')
  const enviado = alBucket()[0].cuerpo as Uint8Array
  expect(Buffer.from(enviado).equals(jpeg())).toBe(true)

  expect(aLaFila()).toHaveLength(1)
  expect(aLaFila()[0].ruta).toContain('on_conflict=id_movimiento%2Csha256')
  expect(aLaFila()[0].cabeceras.get('prefer')).toContain('resolution=ignore-duplicates')
  const fila = JSON.parse(String(aLaFila()[0].cuerpo))
  expect(fila.id_movimiento).toBe(ID_MOV)
  expect(fila.borrador_id).toBe(BORRADOR)
  expect(fila.rfc_emisor).toBe('GCH120515AB3')
  expect(fila.folio).toBe('A-48213')
  expect(fila.fecha_ticket).toBe('2026-11-02')
  expect(fila.iva).toBe(68.97)
  expect(fila.url_facturacion).toBe('https://facturacion.gaschile.mx')
  expect(fila.ocr.monto).toBe(500)
})

test('sin token no entra', async () => {
  const r = await POST(peticion(cuerpo(), {}))
  expect(r.status).toBe(401)
  expect(llamadas).toHaveLength(0)
})

test('en ensayo no toca ni el bucket ni la tabla', async () => {
  const r = await POST(peticion(cuerpo(), { 'x-bot-token': TOKEN, 'x-bot-ensayo': '1' }))
  expect((await r.json()).ok).toBe(false)
  expect(llamadas).toHaveLength(0)
})

test('un telegram_id sin alta no sube nada', async () => {
  const r = await POST(peticion(cuerpo({ telegram_id: DESCONOCIDO })))
  expect(r.status).toBe(403)
  expect(alBucket()).toHaveLength(0)
  expect(aLaFila()).toHaveLength(0)
})

test('sin movimiento escrito no hay foto: nada antes del clic', async () => {
  hayMovimiento = false
  const r = await POST(peticion(cuerpo()))
  expect(r.status).toBe(404)
  expect(alBucket()).toHaveLength(0)
  expect(aLaFila()).toHaveLength(0)
})

test('si falla el bucket no se escribe la fila, y el bot se entera', async () => {
  fallaStorage = true
  const r = await POST(peticion(cuerpo()))
  expect(r.status).toBe(502)
  expect((await r.json()).ok).toBeUndefined()
  expect(aLaFila()).toHaveLength(0)
})

test('si falla la fila el bot se entera, y el reintento pega en la misma ruta', async () => {
  fallaFila = true
  const c = cuerpo()
  const r = await POST(peticion(c))
  expect(r.status).toBe(502)
  fallaFila = false
  const r2 = await POST(peticion(c))
  expect(r2.status).toBe(200)
  const rutas = alBucket().map((l) => l.ruta)
  expect(rutas).toHaveLength(2)
  expect(rutas[0]).toBe(rutas[1])
})

test.describe('validarSubida', () => {
  const error = (c: unknown) => {
    const r = validarSubida(c)
    return r.ok ? null : r.error
  }

  test('acepta el cuerpo del bot', () => {
    expect(error(cuerpo())).toBeNull()
  })

  test('acepta justo 200 KB y niega un byte mas', () => {
    expect(error(cuerpo({}, jpeg(TOPE_BYTES)))).toBeNull()
    expect(error(cuerpo({}, jpeg(TOPE_BYTES + 3)))).toMatch(/200 KB/)
  })

  test('niega lo que no es JPEG aunque lo declare', () => {
    expect(error(cuerpo({}, Buffer.from('PNG89a-no-soy-un-jpeg')))).toMatch(/no es un JPEG/)
    expect(error(cuerpo({ mime: 'image/png' }))).toMatch(/JPEG/)
  })

  test('niega un sha256 que no corresponde', () => {
    expect(error(cuerpo({ sha256: 'a'.repeat(64) }))).toMatch(/no corresponde/)
    expect(error(cuerpo({ sha256: '../../etc' }))).toMatch(/sha256 invalido/)
  })

  test('niega ids malformados: la ruta del bucket se arma con ellos', () => {
    expect(error(cuerpo({ id_movimiento: '../otro' }))).toMatch(/id_movimiento/)
    expect(error(cuerpo({ borrador_id: 'x' }))).toMatch(/borrador_id/)
    expect(error(cuerpo({ telegram_id: 'x' }))).toMatch(/telegram_id/)
    expect(error(cuerpo({ borrador_id: null }))).toBeNull()
  })

  test('niega lo que no es objeto y la imagen vacia', () => {
    expect(error(null)).toBeTruthy()
    expect(error([])).toBeTruthy()
    expect(error(cuerpo({ imagen_b64: '' }))).toMatch(/Falta/)
  })
})

test.describe('filaDeComprobante', () => {
  function fila(factura: Record<string, unknown>) {
    const r = validarSubida(cuerpo({ ticket: { factura } }))
    if (!r.ok) throw new Error(r.error)
    return filaDeComprobante(r.subida, rutaDeComprobante(ID_MOV, r.subida.sha256))
  }

  test('cada columna de la fila existe en la migracion', () => {
    const sql = readFileSync('supabase/migrations/20261104235356_comprobantes_gasto.sql', 'utf8')
    const columnas = new Set(
      [...sql.matchAll(/^\s+([a-z_0-9]+)\s+(?:uuid|bigint|text|integer|date|numeric|jsonb|timestamptz)\b/gm)]
        .map((m) => m[1])
    )
    expect(columnas.size).toBeGreaterThan(20)
    expect(Object.keys(fila({})).filter((c) => !columnas.has(c))).toEqual([])
  })

  test('una fecha imposible no tumba la fila', () => {
    expect(fila({ fecha: '2026-02-31' }).fecha_ticket).toBeNull()
    expect(fila({ fecha: 'ayer' }).fecha_ticket).toBeNull()
    expect(fila({ fecha: '2026-02-28' }).fecha_ticket).toBe('2026-02-28')
  })

  test('los numeros raros quedan en null', () => {
    expect(fila({ total: 'mucho' }).total).toBeNull()
    expect(fila({ total: 1e15 }).total).toBeNull()
    expect(fila({ total: 500 }).total).toBe(500)
  })

  test('sin ticket la foto se guarda igual', () => {
    const r = validarSubida(cuerpo({ ticket: null }))
    if (!r.ok) throw new Error(r.error)
    const f = filaDeComprobante(r.subida, 'x')
    expect(f.rfc_emisor).toBeNull()
    expect(f.ocr).toBeNull()
  })

  test('el texto viene acotado', () => {
    expect(String(fila({ razon_social: 'a'.repeat(9000) }).razon_social)).toHaveLength(500)
  })
})
