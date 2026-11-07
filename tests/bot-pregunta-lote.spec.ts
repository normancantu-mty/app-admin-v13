/**
 * Fase 7B — PREGUNTAS DE LOTES Y FIN DE FERMENTACION, LO PURO.
 * Escrito el 2026-11-07 por el ejecutor del Socio.
 *
 * Llaman a las funciones reales (sin red). Lo de punta a punta, con las rutas,
 * esta en `tests/bot-lote-trazabilidad.spec.ts`.
 */
import { expect, test } from '@playwright/test'
import {
  codigoDeLote,
  interpretarLote,
  lineaDeTiempo,
  resumenGarrafas,
  textoLotesAbiertos,
  textoProduccionMes,
  textoTrazabilidad,
  type DatosDeLote
} from '@/lib/bot-pregunta-lote'
import { interpretarPregunta } from '@/lib/bot-pregunta'
import { mensajeDeEtapa, normalizarEtapa, type ContextoEtapa } from '@/lib/bot-lote-ciclo'
import { diasFermentacion } from '@/components/v2/lotes/estado'

const HOY = '2026-11-07'

test.describe('interpretar preguntas de lotes', () => {
  test('codigo: normaliza mayusculas y el guion', () => {
    expect(codigoDeLote('trazabilidad del l-12-10.1')).toBe('L-12-10.1')
    expect(codigoDeLote('lote L12-10.1')).toBe('L-12-10.1')
    expect(codigoDeLote('lote l1017')).toBe('L-1017')
    expect(codigoDeLote('lote 12')).toBeNull()
  })

  for (const [frase, tipo] of [
    ['trazabilidad del lote L-12-10.1', 'trazabilidad_lote'],
    ['¿Me das la trazabilidad del L-12-10.1?', 'trazabilidad_lote'],
    ['historial del lote L-12-10.1', 'trazabilidad_lote'],
    ['linea de tiempo del lote L-12-10.1', 'trazabilidad_lote'],
    ['en que etapa va el lote L-12-10.1', 'etapa_lote'],
    ['¿En qué etapa va el lote L-12-10.1?', 'etapa_lote'],
    ['como va el lote L-12-10.1', 'etapa_lote'],
    ['lotes abiertos', 'lotes_abiertos'],
    ['que lotes hay abiertos?', 'lotes_abiertos'],
    ['lotes sin destilar', 'lotes_abiertos'],
    ['cuanto se produjo este mes', 'produccion_mes'],
    ['cuanto producimos el mes pasado', 'produccion_mes'],
    ['produccion del mes', 'produccion_mes']
  ] as const) {
    test(`'${frase}' -> ${tipo}`, () => {
      const r = interpretarPregunta(frase, [], HOY)
      expect(r.tipo).toBe(tipo)
    })
  }

  test('el codigo viaja con la pregunta', () => {
    expect(interpretarLote('trazabilidad del lote l-12-10.1', null, HOY)).toEqual({ tipo: 'trazabilidad_lote', codigo: 'L-12-10.1' })
    expect(interpretarLote('trazabilidad del lote', null, HOY)).toEqual({ tipo: 'trazabilidad_lote', codigo: null })
  })

  test('produccion: "el mes pasado" usa el periodo de periodoDe', () => {
    const r = interpretarPregunta('cuanto producimos el mes pasado', [], HOY)
    expect(r).toMatchObject({ tipo: 'produccion_mes', periodo: { etiqueta: 'el mes pasado', desde: '2026-10-01', hasta: '2026-10-31' } })
    const e = interpretarPregunta('cuanto se produjo este mes', [], HOY)
    expect(e).toMatchObject({ periodo: { desde: '2026-11-01', hasta: HOY } })
  })

  // CONTROLES: los registros y las preguntas de antes NO se vuelven pregunta de lote.
  for (const frase of [
    'termino la fermentacion del L-12-10.1, 72 horas',
    'le pusimos 4 kilos de aditivo 2 al L-12-10.1',
    'ya destilamos el L-12-10.1, 2 garrafas',
    'envasamos 40 de 750',
    'cuanto debe Aeropuerto',
    'cuanto hay en Spin',
    'ventas de la semana',
    'produccion de hoy',
    'stock'
  ]) {
    test(`CONTROL '${frase}' no es pregunta de lote`, () => {
      expect(interpretarLote(frase, null, HOY)).toBeNull()
    })
  }
})

function datos(extra: Partial<DatosDeLote> = {}): DatosDeLote {
  return {
    lote: { id: 'l', codigo_lote: 'L-12-10.1', fecha_inicio: '2026-10-12', fecha_fin_fermentacion: '2026-10-15', horas_fermentacion: 72, brix_chile: 12 },
    entradas: [
      { id_insumo: 'c', cantidad: 40, nombre: 'Chile Guajillo', sku: 'chile-guajillo', unidad: 'KILOGRAMOS' },
      { id_insumo: 'a1', cantidad: 8000, nombre: 'Aditivo 1', sku: 'mosto-1', unidad: 'GRAMOS' },
      { id_insumo: 'a2', cantidad: 1500, nombre: 'Aditivo 2', sku: 'aditivo-2', unidad: 'GRAMOS' }
    ],
    etapas: [
      { etapa: 'destilacion', fecha: '2026-10-17', datos: { garrafas: 3 } },
      { etapa: 'aditivo_2', fecha: '2026-10-16', datos: { cantidad: 1500, unidad: 'g' } }
    ],
    salidas: [
      { numero_tanda: 2, litros: null, grado_alcohol: 8, peso_kg: 15 },
      { numero_tanda: 1, litros: null, grado_alcohol: 43, peso_kg: 20 },
      { numero_tanda: 3, litros: null, grado_alcohol: null, peso_kg: 10 }
    ],
    envasado: [],
    ...extra
  }
}

test.describe('la linea de tiempo', () => {
  test('garrafas: total de kilos y alcohol puro (calculo) sin la que no trae grado', () => {
    const g = resumenGarrafas(datos().salidas)
    expect(g).toEqual({ n: 3, kgTotal: 45, kgAlcohol: 9.8, sinGrado: 1 }) // 20x0.43 + 15x0.08 = 8.6 + 1.2
  })

  test('orden por fecha; el aditivo 2 en SU fecha (lote_etapas), no en el dia de produccion', () => {
    const l = lineaDeTiempo(datos())
    expect(l.map((e) => [e.fecha, e.titulo])).toEqual([
      ['2026-10-12', 'Dia de produccion'],
      ['2026-10-15', 'Fin de fermentacion'],
      ['2026-10-16', 'Aditivo 2'],
      ['2026-10-17', 'Destilacion: 3 garrafa(s)']
    ])
    expect(l[0].detalle).toEqual(['Aditivo 1: 8000 g (8 kg)', 'Chile Guajillo: 40 kg', 'Brix del chile: 12'])
    expect(l[1].detalle).toEqual(['Fermento 3 dia(s) (72 h)'])
    expect(l[2].detalle).toEqual(['Aditivo 2: 1500 g (1.5 kg)'])
    expect(l[3].detalle.slice(0, 3)).toEqual(['Garrafa 1: 20 kg al 43%', 'Garrafa 2: 15 kg al 8%', 'Garrafa 3: 10 kg (sin grado)'])
    expect(l[3].detalle[3]).toBe('Total: 45 kg')
    expect(l[3].detalle[4]).toContain('Alcohol puro: ~9.8 kg (calculo: peso x grado')
    expect(l[3].detalle[4]).toContain('1 garrafa(s) sin grado no cuentan')
  })

  test('aditivo 2 cargado por la web (sin etapa): va al dia de produccion, sin fecha propia inventada', () => {
    const l = lineaDeTiempo(datos({ etapas: [] }))
    expect(l[0].detalle).toContain('Aditivo 2: 1500 g (1.5 kg)')
    expect(l.some((e) => e.titulo === 'Aditivo 2')).toBe(false)
  })

  test('sin fin ni destilacion: sigue fermentando con los dias a hoy', () => {
    const t = textoTrazabilidad(
      datos({ lote: { id: 'l', codigo_lote: 'L-01-11.1', fecha_inicio: '2026-11-01', fecha_fin_fermentacion: null, horas_fermentacion: null }, etapas: [], salidas: [] }),
      HOY
    )
    expect(t).toContain('Etapa: fermentando')
    expect(t).toContain('Sigue fermentando: lleva 6 dia(s)')
  })

  test('botellas ligadas al lote se cuentan; la nota del envasado diario siempre va', () => {
    const t = textoTrazabilidad(datos({ envasado: [{ fecha: '2026-10-20', botellas: 40, nombre: 'Destilado 750' }] }), HOY)
    expect(t).toContain('Etapa: envasado')
    expect(t).toContain('ENVASADO: 40 de Destilado 750')
    expect(t).toContain('Botellas ligadas al lote: 40')
    expect(t).toContain('El envasado diario no se liga a un lote')
  })

  test('lotes abiertos: sin destilar, del mas viejo al mas nuevo', () => {
    const base = datos()
    const t = textoLotesAbiertos(
      [
        { ...base, lote: { ...base.lote, codigo_lote: 'L-B', fecha_inicio: '2026-11-03', fecha_fin_fermentacion: null }, etapas: [], salidas: [] },
        { ...base, lote: { ...base.lote, codigo_lote: 'L-A', fecha_inicio: '2026-11-01', fecha_fin_fermentacion: '2026-11-05' }, etapas: [], salidas: [] },
        base
      ],
      HOY
    )
    expect(t.split('\n')).toEqual([
      'Lotes abiertos (sin destilar): 2',
      expect.stringContaining('- L-A: desde') as unknown as string,
      expect.stringContaining('- L-B: desde') as unknown as string
    ])
    expect(t).toContain('L-A: desde 01/11/2026'.slice(0, 5))
    expect(textoLotesAbiertos([base], HOY)).toBe('No hay lotes abiertos: todos ya se destilaron.')
  })

  test('produccion del periodo', () => {
    const t = textoProduccionMes(
      { etiqueta: 'este mes' },
      {
        iniciados: [{ codigo_lote: 'L-01-11.1', kgChile: 40 }, { codigo_lote: 'L-02-11.1', kgChile: 35.5 }],
        destilados: [{ codigo_lote: 'L-12-10.1', salidas: datos().salidas }],
        envasado: [{ nombre: 'Destilado 750', botellas: 40 }, { nombre: 'Destilado 250', botellas: 12 }]
      }
    )
    expect(t).toContain('Lotes iniciados: 2 (L-01-11.1, L-02-11.1)')
    expect(t).toContain('Chile metido: 75.5 kg')
    expect(t).toContain('Garrafas: 3, 45 kg')
    expect(t).toContain('Alcohol puro: ~9.8 kg')
    expect(t).toContain('Botellas envasadas: 52')
  })
})

const AHORA = new Date('2026-10-22T18:00:00Z')
function ctx(extra: Partial<ContextoEtapa> = {}): ContextoEtapa {
  return { idLote: 'lote-1', codigoLote: 'L-19-10.1', fechaInicio: '2026-10-19', telegramId: 111, etiqueta: 'norman', ahora: AHORA, ...extra }
}

test.describe('fin de fermentacion (normalizar)', () => {
  test('sin fecha = hoy; horas opcionales; sin entradas ni garrafas', () => {
    const r = normalizarEtapa({ etapa: 'fin_fermentacion' }, ctx())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload).toMatchObject({ etapa: 'fin_fermentacion', fecha: '2026-10-22', entradas: [], garrafas: [] })
    expect(r.payload.horas_fermentacion).toBeUndefined()
  })

  test('fecha y horas dichas; el mensaje dice los dias', () => {
    const r = normalizarEtapa({ etapa: 'fin_fermentacion', fecha: '2026-10-21', horas: 50 }, ctx())
    expect(r.ok && r.payload.horas_fermentacion).toBe(50)
    if (!r.ok) return
    const m = mensajeDeEtapa(r.payload, '2026-10-19')
    expect(m).toContain('FIN DE FERMENTACION')
    expect(m).toContain('Fermento 2 dia(s)')
    expect(m).toContain('Horas de fermentacion: 50')
  })

  for (const [nombre, pedido, extra, error] of [
    ['futuro', { fecha: '2026-10-23' }, {}, 'futuro'],
    ['antes del inicio', { fecha: '2026-10-18' }, {}, 'antes del inicio'],
    ['fecha rara', { fecha: '22/10' }, {}, 'No entendi la fecha'],
    ['horas 0', { horas: 0 }, {}, 'horas'],
    ['horas de mas', { horas: 24 * 31 + 1 }, {}, 'horas'],
    ['ya tenia fin', {}, { finActual: '2026-10-20' }, 'ya tiene fin']
  ] as const) {
    test(`no: ${nombre}`, () => {
      const r = normalizarEtapa({ etapa: 'fin_fermentacion', ...pedido }, ctx(extra))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(error)
    })
  }
})

test.describe('web: dias de fermentacion y el detalle', () => {
  test('diasFermentacion: el fin manda sobre la destilacion', () => {
    expect(diasFermentacion('2026-10-12', '2026-10-15', '2026-10-17', HOY)).toEqual({ dias: 3, enCurso: false })
    expect(diasFermentacion('2026-10-12', null, '2026-10-17', HOY)).toEqual({ dias: 5, enCurso: false })
    expect(diasFermentacion('2026-11-01', null, null, HOY)).toEqual({ dias: 6, enCurso: true })
  })
  // DetalleLote usa `lineaDeTiempo` (arriba). Pintarlo aqui no se puede: el runner de
  // Playwright transforma el JSX del componente a su formato de component testing.

})
