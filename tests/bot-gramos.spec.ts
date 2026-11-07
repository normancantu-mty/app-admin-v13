/**
 * Fase 7A — LA UNIDAD GRAMOS. Escrito el 2026-11-07 por el ejecutor del Socio.
 *
 * El 2026-11-07 el coordinador cambio en produccion `catalogo_productos.unidad_medida`
 * de KILOGRAMOS a GRAMOS para Aditivo 1 y Aditivo 2 (sin convertir cantidades).
 * Regla: solo g <-> kg; cualquier otra conversion se pregunta, no se adivina.
 *
 * Puras: llaman a las funciones reales. Las rutas (etapa/proponer y lote/proponer)
 * se miden en `tests/bot-lote-trazabilidad.spec.ts`, con el mismo doble de PostgREST.
 */
import { expect, test } from '@playwright/test'
import { aUnidadDelInsumo, convertirMasa, leerCantidad, unidadCorta, type CantidadDicha } from '@/lib/bot-compra'
import { mensajeDeEtapa, normalizarEtapa, type ContextoEtapa } from '@/lib/bot-lote-ciclo'

function dicha(texto: string): CantidadDicha {
  const c = leerCantidad(texto)
  if (!c) throw new Error('no leyo cantidad de ' + texto)
  return c
}

test.describe('compra de un insumo en GRAMOS', () => {
  test('unidad corta: GRAMOS -> g', () => {
    expect(unidadCorta('GRAMOS')).toBe('g')
    expect(unidadCorta('KILOGRAMOS')).toBe('kg')
  })

  test('500 g a un insumo en GRAMOS = 500; 1.5 kg = 1500', () => {
    expect(aUnidadDelInsumo(dicha('500 g'), 'GRAMOS')).toEqual({ ok: true, cantidad: 500 })
    expect(aUnidadDelInsumo(dicha('500 gramos'), 'GRAMOS')).toEqual({ ok: true, cantidad: 500 })
    expect(aUnidadDelInsumo(dicha('1.5 kg'), 'GRAMOS')).toEqual({ ok: true, cantidad: 1500 })
    expect(aUnidadDelInsumo(dicha('2 kilos'), 'GRAMOS')).toEqual({ ok: true, cantidad: 2000 })
  })

  test('un numero pelon a un insumo en GRAMOS se pregunta (puede ser kilos)', () => {
    const r = aUnidadDelInsumo(dicha('5'), 'GRAMOS')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toContain('gramos o kilos')
  })

  test('litros, piezas o toneladas a GRAMOS: se pregunta', () => {
    expect(aUnidadDelInsumo(dicha('2 litros'), 'GRAMOS').ok).toBe(false)
    expect(aUnidadDelInsumo(dicha('3 piezas'), 'GRAMOS').ok).toBe(false)
    expect(aUnidadDelInsumo(dicha('1 ton'), 'GRAMOS').ok).toBe(false)
  })

  test('KILOGRAMOS sigue igual: 500 g = 0.5; pelon = kg', () => {
    expect(aUnidadDelInsumo(dicha('500 g'), 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 0.5 })
    expect(aUnidadDelInsumo(dicha('8'), 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 8 })
  })

  test('convertirMasa: solo g<->kg; a PIEZAS o LITROS no convierte', () => {
    expect(convertirMasa(8, 'kg', 'GRAMOS')).toEqual({ ok: true, cantidad: 8000 })
    expect(convertirMasa(800, 'g', 'GRAMOS')).toEqual({ ok: true, cantidad: 800 })
    expect(convertirMasa(800, 'g', 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 0.8 })
    expect(convertirMasa(8, 'kg', 'KILOGRAMOS')).toEqual({ ok: true, cantidad: 8 })
    expect(convertirMasa(2, 'kg', 'PIEZAS').ok).toBe(false)
    expect(convertirMasa(2, 'kg', 'LITROS').ok).toBe(false)
    expect(convertirMasa(0, 'kg', 'GRAMOS').ok).toBe(false)
  })
})

const AHORA = new Date('2026-10-22T18:00:00Z')
function ctx(extra: Partial<ContextoEtapa> = {}): ContextoEtapa {
  return {
    idLote: 'lote-1',
    codigoLote: 'L-19-10.1',
    fechaInicio: '2026-10-19',
    telegramId: 111,
    etiqueta: 'norman',
    ahora: AHORA,
    idInsumoAditivo: 'ins-ad2',
    unidadAditivo: 'GRAMOS',
    ...extra
  }
}

test.describe('aditivo 2 en la unidad del catalogo', () => {
  test('800 g -> 800 en lote_entradas; el mensaje dice g', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', cantidad: 800, unidad: 'g' }, ctx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.entradas).toEqual([{ id_insumo: 'ins-ad2', cantidad: 800 }])
    expect(r.payload.unidad_entrada).toBe('g')
    expect(mensajeDeEtapa(r.payload)).toContain('Aditivo 2: 800 g')
  })

  test('1.5 kg dicho -> 1500 g', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', cantidad: '1.5', unidad: 'kg' }, ctx())
    expect(r.ok && r.payload.entradas[0].cantidad).toBe(1500)
  })

  test('el campo viejo `kg` (bot sin actualizar) se lee como kilos: 4 -> 4000 g', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', kg: 4 }, ctx())
    expect(r.ok && r.payload.entradas[0].cantidad).toBe(4000)
  })

  test('cantidad sin unidad -> se pregunta, no se adivina', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', cantidad: 4 }, ctx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('gramos o en kilos')
  })

  test('un aditivo que se lleva en PIEZAS no se convierte desde kg', () => {
    expect(normalizarEtapa({ etapa: 'aditivo_2', cantidad: 4, unidad: 'kg' }, ctx({ unidadAditivo: 'PIEZAS' })).ok).toBe(false)
  })

  test('el tope duro se mide en kg: 100001 kg no; 100000 g (100 kg) si', () => {
    expect(normalizarEtapa({ etapa: 'aditivo_2', cantidad: 100001, unidad: 'kg' }, ctx()).ok).toBe(false)
    expect(normalizarEtapa({ etapa: 'aditivo_2', cantidad: 100000, unidad: 'g' }, ctx()).ok).toBe(true)
  })

  test('sin unidad del catalogo (llamador viejo) se asume KILOGRAMOS: 2.5 kg = 2.5', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', kg: 2.5 }, ctx({ unidadAditivo: undefined }))
    expect(r.ok && r.payload.entradas[0].cantidad).toBe(2.5)
  })
})
