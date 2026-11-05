/**
 * 2026-11-03 -- LA FOTO DEL TICKET QUE LLEGA DEL BOT. Solo logica pura: validar lo
 * que manda `bot/comprobantes.py` y armar la fila de `comprobantes_gasto`. Lo que
 * toca Storage y Postgres vive en `app/api/bot/comprobante/subir/route.ts`.
 *
 * Escrito el 2026-11-03 por el ejecutor del Socio (bot ERP, fotos de tickets).
 *
 * LOS TOPES SON DEL PLAN GRATIS de la organizacion de Supabase: JPEG, lado largo
 * de 1600 px y 200 KB como maximo. Los aplica el bot al comprimir y se vuelven a
 * exigir aqui, porque el cuerpo es lo unico que esta ruta puede medir. El bucket
 * tiene ademas su propio tope (262144 bytes) y solo acepta image/jpeg.
 *
 * Los campos del ticket salieron de un modelo que leyo una foto de un tercero:
 * son DATO. Aqui solo se guardan, acotados, y ninguno decide nada.
 */
import { createHash } from 'node:crypto'

export const BUCKET_COMPROBANTES = 'tickets_gasto'
export const TOPE_BYTES = 200 * 1024
const TOPE_B64 = Math.ceil((TOPE_BYTES * 4) / 3) + 4
const TOPE_TEXTO = 500
// numeric(14,2)
const TOPE_NUMERICO = 1e12

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RE_SHA256 = /^[0-9a-f]{64}$/
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/

type Objeto = Record<string, unknown>

export interface SubidaDeComprobante {
  telegramId: number
  idMovimiento: string
  borradorId: string | null
  sha256: string
  bytes: Buffer
  ancho: number | null
  alto: number | null
  ticket: Objeto | null
}

export type ResultadoDeSubida =
  | { ok: true; subida: SubidaDeComprobante }
  | { ok: false; error: string }

function objeto(v: unknown): Objeto | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Objeto) : null
}

function entero(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null
}

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const limpio = v.trim().slice(0, TOPE_TEXTO)
  return limpio === '' ? null : limpio
}

function numero(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < TOPE_NUMERICO ? v : null
}

/** "2026-02-31" no es una fecha: Postgres la rechazaria y tumbaria toda la fila. */
function fecha(v: unknown): string | null {
  if (typeof v !== 'string' || !RE_FECHA.test(v)) return null
  const d = new Date(v + 'T00:00:00Z')
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null
}

export function rutaDeComprobante(idMovimiento: string, sha256: string): string {
  return idMovimiento + '/' + sha256 + '.jpg'
}

export function validarSubida(cuerpo: unknown): ResultadoDeSubida {
  const c = objeto(cuerpo)
  if (!c) return { ok: false, error: 'Cuerpo invalido.' }

  const telegramId = Number(c.telegram_id)
  if (!Number.isSafeInteger(telegramId)) return { ok: false, error: 'telegram_id invalido.' }

  const idMovimiento = c.id_movimiento
  if (typeof idMovimiento !== 'string' || !RE_UUID.test(idMovimiento)) {
    return { ok: false, error: 'id_movimiento invalido.' }
  }
  const borrador = c.borrador_id ?? null
  if (borrador !== null && (typeof borrador !== 'string' || !RE_UUID.test(borrador))) {
    return { ok: false, error: 'borrador_id invalido.' }
  }

  if (c.mime !== 'image/jpeg') return { ok: false, error: 'Solo se guarda JPEG.' }
  const sha256 = c.sha256
  if (typeof sha256 !== 'string' || !RE_SHA256.test(sha256)) {
    return { ok: false, error: 'sha256 invalido.' }
  }

  const b64 = c.imagen_b64
  if (typeof b64 !== 'string' || b64 === '') return { ok: false, error: 'Falta la imagen.' }
  if (b64.length > TOPE_B64) return { ok: false, error: 'La imagen pasa de 200 KB.' }
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0 || bytes.length > TOPE_BYTES) {
    return { ok: false, error: 'La imagen pasa de 200 KB.' }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, error: 'La imagen no es un JPEG.' }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    return { ok: false, error: 'El sha256 no corresponde a la imagen.' }
  }

  return {
    ok: true,
    subida: {
      telegramId,
      idMovimiento,
      borradorId: borrador as string | null,
      sha256,
      bytes,
      ancho: entero(c.ancho),
      alto: entero(c.alto),
      ticket: objeto(c.ticket)
    }
  }
}

/** La fila de `comprobantes_gasto`. Lo que no se puede guardar queda en null. */
export function filaDeComprobante(s: SubidaDeComprobante, ruta: string): Objeto {
  const factura = objeto(s.ticket?.factura) ?? {}
  return {
    id_movimiento: s.idMovimiento,
    borrador_id: s.borradorId,
    telegram_id: s.telegramId,
    ruta_storage: ruta,
    sha256: s.sha256,
    mime: 'image/jpeg',
    bytes: s.bytes.length,
    ancho: s.ancho,
    alto: s.alto,
    rfc_emisor: texto(factura.rfc_emisor),
    razon_social: texto(factura.razon_social),
    folio: texto(factura.folio),
    fecha_ticket: fecha(factura.fecha),
    hora_ticket: texto(factura.hora),
    subtotal: numero(factura.subtotal),
    iva: numero(factura.iva),
    total: numero(factura.total),
    forma_pago: texto(factura.forma_pago),
    url_facturacion: texto(factura.url_facturacion),
    leyenda_facturacion: texto(factura.leyenda_facturacion),
    ocr: s.ticket
  }
}
