import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { elegirLoteDestino, type LoteExistente } from '../lib/bot-envasado'

/**
 * Cazador F0 · WP-7a — envasado sin lote abierto: ya no es un 422.
 * Escrito el 2026-10-17 por el ejecutor B del Socio.
 *
 * `elegirLoteDestino` ahora dice POR QUE no hay destino; la ruta convierte
 * `sin_abiertos` en una oferta (`ofrecer_abrir_lote`) y deja el 422 solo para
 * la errata de codigo y los varios abiertos. El flujo del bot (oferta -> boton
 * -> `abrir_lote_nuevo`) lo mide `bot/probar_plantilla.py`.
 */

const HOY = '2026-10-17'
const L = (codigo_lote: string, fecha_inicio: string): LoteExistente => ({
  id: 'id-' + codigo_lote,
  codigo_lote,
  fecha_inicio
})

test('ningun lote abierto -> motivo sin_abiertos', () => {
  const r = elegirLoteDestino(null, [L('L-VIEJO', '2026-07-01')], HOY)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.motivo).toBe('sin_abiertos')
})

test('sin ningun lote en la base -> sin_abiertos', () => {
  const r = elegirLoteDestino(null, [], HOY)
  expect(r.ok === false && r.motivo).toBe('sin_abiertos')
})

test('CONTROL: codigo que no existe -> no_existe (sigue siendo error, no se ofrece abrir)', () => {
  const r = elegirLoteDestino('L-ERRATA', [L('L-09', '2026-10-10')], HOY)
  expect(r.ok === false && r.motivo).toBe('no_existe')
})

test('CONTROL: varios abiertos -> varios (se pregunta cual)', () => {
  const r = elegirLoteDestino(null, [L('L-A', '2026-10-01'), L('L-B', '2026-10-15')], HOY)
  expect(r.ok === false && r.motivo).toBe('varios')
})

test('la ruta ofrece abrir el lote en vez del 422 cuando no hay abiertos', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'proponer', 'route.ts'), 'utf8')
  const i = src.indexOf("destino.motivo === 'sin_abiertos'")
  expect(i).toBeGreaterThan(0)
  const tramo = src.slice(i, i + 1200)
  expect(tramo).toContain('ofrecer_abrir_lote: true')
  expect(tramo).toContain('cuerpo.abrir_lote_nuevo !== true')
  expect(tramo).toContain('agregar = false')
})

test('la plantilla del lote es DATOS: el YAML trae los 4 campos numerados y sus rangos', () => {
  const y = readFileSync(join(__dirname, '..', 'bot', 'plantillas', 'lote.yaml'), 'utf8')
  for (const c of ['kg_chile', 'dias_fermentacion', 'tandas', 'tipo_chile']) expect(y).toContain('nombre: ' + c)
  expect(y).toContain('rango: [1, 1000]')
  expect(y).toContain('rango: [1, 31]')
})
