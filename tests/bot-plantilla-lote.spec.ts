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
 * la errata de codigo y los varios abiertos. RONDA 5 (2026-10-19): la oferta se
 * RETIRO por decision de Norman (el envasado es diario y no se liga a un lote);
 * `elegirLoteDestino` sigue para el agregar a un lote con insumos.
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

// Lote v2, ronda 5 (B, Norman 2026-10-19): se RETIRO la oferta de abrir un lote
// ante un envasado sin lote abierto (WP-7a). El envasado es diario y no se liga
// a ningun lote: lo mide tests/bot-envasado-diario.spec.ts en el handler.
test('ronda 5: la ruta ya NO ofrece abrir un lote desde un envasado', () => {
  const src = readFileSync(join(__dirname, '..', 'app', 'api', 'bot', 'lote', 'proponer', 'route.ts'), 'utf8')
  expect(src).not.toContain('ofrecer_abrir_lote: true')
  expect(src).not.toContain('abrir_lote_nuevo')
  expect(src).toContain("tipo: 'envasado_diario'")
})

// Lote v2 (2026-10-19, ejecutor del Socio): la plantilla cambio por decision de
// Norman (kilos+tipo de chile, Brix chile, kilos aditivo 1, Brix final; sin dias
// de fermentacion ni tandas). El comportamiento lo mide bot/probar_plantilla.py.
test('la plantilla del lote es DATOS: el YAML trae los campos nuevos, sus rangos y el formato del codigo', () => {
  const y = readFileSync(join(__dirname, '..', 'bot', 'plantillas', 'lote.yaml'), 'utf8')
  for (const c of ['kg_chile', 'tipo_chile', 'brix_chile', 'aditivo_1', 'brix_final']) expect(y).toContain('nombre: ' + c)
  for (const c of ['dias_fermentacion', 'tandas']) expect(y).not.toContain('nombre: ' + c)
  expect(y).toContain('rango: [1, 1000]')
  expect(y).toContain("formato_codigo: 'L-{dd}-{mm}.{n}'")
  // Ronda 6: Norman decidio el 2026-10-19 (plan v3 §8): aditivo 1 = ing-az, aditivo 2 = ing-al; sin marca.
  // Fase 7 (2026-11-07): 'ing-az'/'ing-al' no existen en el catalogo de produccion;
  // los SKU reales de "Aditivo 1" y "Aditivo 2" son 'mosto-1' y 'aditivo-2'.
  expect(y).toMatch(/^aditivo_1_sku: 'mosto-1'$/m)
  expect(y).toMatch(/^aditivo_2_sku: 'aditivo-2'$/m)
  expect(y).toContain('Decidido por Norman el 2026-10-19')
  expect(y).not.toContain('CONFIRMAR CON NORMAN')
})
