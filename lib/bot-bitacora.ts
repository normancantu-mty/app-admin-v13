/**
 * Cazador F0 · WP-2a — lo PURO de la bitacora del bot (`tests/bot-bitacora.spec.ts`).
 *
 * La ruta `app/api/bot/bitacora` valida aqui cada fila antes de escribirla. Lo
 * que la base vuelve a comprobar (origen, clave unica, solo-agregar) se repite a
 * proposito: un 400 claro es mejor que un 500 de Postgres.
 */

export const ORIGENES_BITACORA = ['grupo', 'privado', 'voz', 'bot', 'reunion'] as const
export type OrigenBitacora = (typeof ORIGENES_BITACORA)[number]

export const TOPE_FILAS_BITACORA = 50
/** Un mensaje de Telegram mide 4096; una transcripcion de reunion, mucho mas. */
export const TOPE_TEXTO_BITACORA = 100_000

export interface FilaBitacora {
  clave: string
  origen: OrigenBitacora
  chat_id: number | null
  chat_tipo: string | null
  telegram_id: number | null
  persona: string | null
  mensaje_id: number | null
  fecha: string
  texto: string | null
  transcripcion: string | null
  adjunto_ref: string | null
  respuesta_a: number | null
  procesado: boolean
}

function entero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? n : null
}

function texto(v: unknown, tope: number): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s === '' ? null : s.slice(0, tope)
}

function fechaIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const d = new Date(typeof v === 'number' ? v * 1000 : String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export type FilaNormalizada = { ok: true; fila: FilaBitacora } | { ok: false; error: string }

export function normalizarFilaBitacora(crudo: unknown): FilaNormalizada {
  if (typeof crudo !== 'object' || crudo === null) return { ok: false, error: 'fila invalida.' }
  const c = crudo as Record<string, unknown>
  const clave = String(c.clave ?? '').trim()
  if (clave.length < 3 || clave.length > 200) return { ok: false, error: 'clave invalida.' }
  const origen = String(c.origen ?? '') as OrigenBitacora
  if (!ORIGENES_BITACORA.includes(origen)) return { ok: false, error: `origen invalido: ${origen}.` }
  return {
    ok: true,
    fila: {
      clave,
      origen,
      chat_id: entero(c.chat_id),
      chat_tipo: texto(c.chat_tipo, 20),
      telegram_id: entero(c.telegram_id),
      persona: texto(c.persona, 120),
      mensaje_id: entero(c.mensaje_id),
      // Sin fecha valida, la de ahora. No se manda NULL: la columna es NOT NULL
      // y un upsert con varias filas no aplica el DEFAULT a la que no la trae.
      fecha: fechaIso(c.fecha) ?? new Date().toISOString(),
      texto: texto(c.texto, TOPE_TEXTO_BITACORA),
      transcripcion: texto(c.transcripcion, TOPE_TEXTO_BITACORA),
      adjunto_ref: texto(c.adjunto_ref, 500),
      respuesta_a: entero(c.respuesta_a),
      procesado: c.procesado === true
    }
  }
}

/** Las etiquetas de una NOTA: solo `lote`, `persona`, `cliente`, como texto. `null` si no queda ninguna. */
export function normalizarEtiquetas(crudo: unknown): Record<string, string> | null {
  if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) return null
  const fuera: Record<string, string> = {}
  for (const llave of ['lote', 'persona', 'cliente', 'tipo']) {
    const v = (crudo as Record<string, unknown>)[llave]
    if (v === null || v === undefined) continue
    const s = String(v).trim().slice(0, 120)
    if (s !== '') fuera[llave] = s
  }
  return Object.keys(fuera).length > 0 ? fuera : null
}
