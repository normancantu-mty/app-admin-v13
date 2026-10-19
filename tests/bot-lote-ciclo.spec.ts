/**
 * Lote v2 — pruebas PURAS del ciclo del lote (lib/bot-lote-ciclo.ts) y del Brix
 * en el lote del dia de produccion (lib/bot-lotes.ts).
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 * Llaman a las funciones reales; ninguna lee el codigo fuente como texto.
 */
import { expect, test } from '@playwright/test'
import {
  diaDeTemperatura,
  diasEntre,
  mensajeDeFermentacion,
  normalizarEtapa,
  resumenTemperatura,
  sellarEtapa,
  selloEtapaCoincide,
  type ContextoEtapa
} from '@/lib/bot-lote-ciclo'
import { mensajeDeConfirmacionLote, normalizarLote, sellarLote, selloLoteCoincide, type ContextoLote } from '@/lib/bot-lotes'

const AHORA = new Date('2026-10-22T18:00:00Z') // 12:00 en Fresnillo

function ctx(extra: Partial<ContextoEtapa> = {}): ContextoEtapa {
  return {
    idLote: 'lote-1',
    codigoLote: 'L-19-10.1',
    fechaInicio: '2026-10-19',
    telegramId: 111,
    etiqueta: 'norman',
    ahora: AHORA,
    idInsumoAditivo: 'ins-al',
    ...extra
  }
}

test.describe('normalizarEtapa', () => {
  test('aditivo 2: una entrada con el insumo resuelto, fecha de hoy en Mexico', () => {
    const r = normalizarEtapa({ etapa: 'aditivo_2', kg: '2.5' }, ctx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.fecha).toBe('2026-10-22')
    expect(r.payload.entradas).toEqual([{ id_insumo: 'ins-al', cantidad: 2.5 }])
    expect(r.payload.garrafas).toEqual([])
    expect(r.payload.usuario_creador).toBe('telegram:norman')
  })

  test('aditivo 2 sin insumo en catalogo -> error, no inventa', () => {
    expect(normalizarEtapa({ etapa: 'aditivo_2', kg: 2 }, ctx({ idInsumoAditivo: null })).ok).toBe(false)
    expect(normalizarEtapa({ etapa: 'aditivo_2', kg: 0 }, ctx()).ok).toBe(false)
  })

  test('destilacion: garrafas numeradas por orden, sin litros', () => {
    const r = normalizarEtapa(
      { etapa: 'destilacion', garrafas: [{ peso_kg: '18.5', grado_alcohol: 52 }, { peso_kg: 17, grado: '48' }] },
      ctx()
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.garrafas).toEqual([
      { numero: 1, peso_kg: 18.5, grado_alcohol: 52 },
      { numero: 2, peso_kg: 17, grado_alcohol: 48 }
    ])
    expect(JSON.stringify(r.payload)).not.toContain('litros')
  })

  test('destilacion: % fuera de 0..100 o peso <= 0 -> error duro', () => {
    expect(normalizarEtapa({ etapa: 'destilacion', garrafas: [{ peso_kg: 10, grado_alcohol: 120 }] }, ctx()).ok).toBe(false)
    expect(normalizarEtapa({ etapa: 'destilacion', garrafas: [{ peso_kg: 0, grado_alcohol: 40 }] }, ctx()).ok).toBe(false)
    expect(normalizarEtapa({ etapa: 'destilacion', garrafas: [] }, ctx()).ok).toBe(false)
  })

  test('una etapa antes de la produccion -> error', () => {
    expect(normalizarEtapa({ etapa: 'aditivo_2', kg: 1 }, ctx({ fechaInicio: '2026-10-25' })).ok).toBe(false)
  })

  test('el sello cambia si cambia una garrafa', () => {
    const a = normalizarEtapa({ etapa: 'destilacion', garrafas: [{ peso_kg: 10, grado_alcohol: 40 }] }, ctx())
    const b = normalizarEtapa({ etapa: 'destilacion', garrafas: [{ peso_kg: 10, grado_alcohol: 41 }] }, ctx())
    if (!a.ok || !b.ok) throw new Error('debian ser validas')
    const s = sellarEtapa(a.payload)
    expect(selloEtapaCoincide(a.payload, s)).toBe(true)
    expect(selloEtapaCoincide(b.payload, s)).toBe(false)
  })
})

test.describe('temperatura de la fermentacion', () => {
  const DIAS = [
    { fecha: '2026-10-18', fuente: 'open-meteo exterior', t_min: 0, t_max: 40, t_prom: 20 }, // fuera
    { fecha: '2026-10-19', fuente: 'open-meteo exterior', t_min: 8, t_max: 24, t_prom: 15 },
    { fecha: '2026-10-20', fuente: 'open-meteo exterior', t_min: 6, t_max: 26, t_prom: 16 },
    { fecha: '2026-10-21', fuente: 'open-meteo exterior', t_min: 9, t_max: 22, t_prom: 14.2 },
    { fecha: '2026-10-20', fuente: 'manual', t_min: 19, t_max: 23, t_prom: 21 }
  ]

  test('min de minimos, max de maximos, promedio de promedios, por fuente', () => {
    const r = resumenTemperatura(DIAS, '2026-10-19', '2026-10-22')
    const om = r.find((x) => x.fuente === 'open-meteo exterior')
    expect(om).toEqual({ fuente: 'open-meteo exterior', dias_con_dato: 3, min: 6, max: 26, prom: 15.1 })
    expect(r.find((x) => x.fuente === 'manual')).toEqual({ fuente: 'manual', dias_con_dato: 1, min: 19, max: 23, prom: 21 })
  })

  test('sin dato lo dice; no inventa', () => {
    expect(resumenTemperatura([], '2026-10-19', '2026-10-22')).toEqual([])
    expect(mensajeDeFermentacion('2026-10-19', '2026-10-25', [])).toContain('todavia sin dato')
    expect(diasEntre('2026-10-19', '2026-10-25')).toBe(6)
  })

  test('validador de dias: orden min<=prom<=max y solo dos fuentes', () => {
    expect(diaDeTemperatura({ fecha: '2026-10-19', fuente: 'manual', t_min: 1, t_max: 3, t_prom: 2 })).not.toBeNull()
    expect(diaDeTemperatura({ fecha: '2026-10-19', fuente: 'manual', t_min: 3, t_max: 1, t_prom: 2 })).toBeNull()
    expect(diaDeTemperatura({ fecha: '2026-10-19', fuente: 'termometro', t_min: 1, t_max: 3, t_prom: 2 })).toBeNull()
    expect(diaDeTemperatura({ fecha: '19/10/2026', fuente: 'manual', t_min: 1, t_max: 3, t_prom: 2 })).toBeNull()
  })
})

test.describe('Brix en el lote del dia de produccion', () => {
  function contextoLote(): ContextoLote {
    return { etiqueta: 'norman', ahora: new Date('2026-10-19T18:00:00Z'), codigosTomados: [], insumos: [], envasado: [] }
  }

  test('brix_chile y brix_final viajan en el payload y en la confirmacion', () => {
    const r = normalizarLote({ codigo_lote: 'L-19-10.1', brix_chile: 12.5, brix_final: '18' }, contextoLote())
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.payload.brix_chile).toBe(12.5)
    expect(r.payload.brix_final).toBe(18)
    const m = mensajeDeConfirmacionLote(r.payload, r.desglose, r.avisos, r.codigoSugerido)
    expect(m).toContain('Brix chile: 12.5')
    expect(m).toContain('Brix final: 18')
  })

  test('sin Brix el payload no trae la llave: los sellos de antes siguen valiendo', () => {
    const r = normalizarLote({ codigo_lote: 'L-19-10.2' }, contextoLote())
    if (!r.ok) throw new Error(r.error)
    expect('brix_chile' in r.payload).toBe(false)
    expect(selloLoteCoincide(r.payload, sellarLote(r.payload))).toBe(true)
  })

  test('Brix fuera de 0..100 -> error duro', () => {
    expect(normalizarLote({ codigo_lote: 'L-19-10.3', brix_chile: 150 }, contextoLote()).ok).toBe(false)
  })
})
