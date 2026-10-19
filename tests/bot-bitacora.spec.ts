import { test, expect } from '@playwright/test'
import { normalizarFilaBitacora, normalizarEtiquetas, TOPE_TEXTO_BITACORA } from '../lib/bot-bitacora'

/**
 * Cazador F0 · WP-2a — lo puro de la bitacora del bot (`lib/bot-bitacora.ts`).
 * Escrito el 2026-10-17 por el ejecutor B del Socio.
 *
 * Ejecuta la funcion que la ruta `/api/bot/bitacora` usa antes de escribir.
 * El comportamiento de la tabla (solo-agregar, ON CONFLICT) se probo contra
 * Supabase LOCAL y el del bot en `bot/probar_bitacora.py`.
 */

test('una fila valida sale normalizada', () => {
  const r = normalizarFilaBitacora({
    clave: 'tg:-100:5:grupo', origen: 'grupo', chat_id: '-100', telegram_id: 222,
    mensaje_id: 5, fecha: '2026-10-17T15:00:00Z', texto: 'lote 7', persona: 'Kevin'
  })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.fila.chat_id).toBe(-100)
  expect(r.fila.fecha).toBe('2026-10-17T15:00:00.000Z')
  expect(r.fila.procesado).toBe(false)
  expect(r.fila.transcripcion).toBeNull()
})

test('sin fecha, la de ahora: nunca NULL a una columna NOT NULL', () => {
  const r = normalizarFilaBitacora({ clave: 'tg:1:2:privado', origen: 'privado' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(Math.abs(Date.parse(r.fila.fecha) - Date.now())).toBeLessThan(5000)
})

test('fecha epoch (segundos de Telegram) se entiende', () => {
  const r = normalizarFilaBitacora({ clave: 'tg:1:2:privado', origen: 'privado', fecha: 1792249200 })
  expect(r.ok && r.fila.fecha.startsWith('2026-')).toBe(true)
})

test('origen o clave invalidos se rechazan con 400 claro', () => {
  expect(normalizarFilaBitacora({ clave: 'tg:1:2:x', origen: 'whatsapp' }).ok).toBe(false)
  expect(normalizarFilaBitacora({ clave: 'ab', origen: 'grupo' }).ok).toBe(false)
  expect(normalizarFilaBitacora(null).ok).toBe(false)
})

test('procesado solo es true si viene true literal', () => {
  const r = normalizarFilaBitacora({ clave: 'tg:1:2:bot', origen: 'bot', procesado: 'true' })
  expect(r.ok && r.fila.procesado).toBe(false)
})

test('un texto gigante se recorta al tope', () => {
  const r = normalizarFilaBitacora({ clave: 'tg:1:2:reunion', origen: 'reunion', texto: 'a'.repeat(TOPE_TEXTO_BITACORA + 10) })
  expect(r.ok && r.fila.texto?.length).toBe(TOPE_TEXTO_BITACORA)
})

test('etiquetas: solo lote, persona, cliente, tipo; vacias -> null', () => {
  expect(normalizarEtiquetas({ lote: 7, persona: ' Kevin ', otra: 'x' })).toEqual({ lote: '7', persona: 'Kevin' })
  expect(normalizarEtiquetas({ otra: 'x' })).toBeNull()
  expect(normalizarEtiquetas(['lote'])).toBeNull()
})
