import { test, expect } from '@playwright/test'
import {
  elegirLoteDestino,
  esAgregarALote,
  faltantesDeEmpaque,
  filasDelPeriodo,
  lunesDe,
  movimientosDeEnvasado,
  periodoDeProduccion,
  sellarAgregar,
  selloAgregarCoincide,
  textoProduccion,
  type FilaEnvasado,
  type LoteExistente,
  type PayloadAgregar
} from '../lib/bot-envasado'

/**
 * Fase 8, Bloque D (D81-D83) — la parte pura del envasado. Sin base.
 * La equivalencia con `movimientos_de_envasado` (Postgres) esta en
 * `tests/envasado-inventario.spec.ts`.
 */

const RECETA = [
  { id_insumo: 'botella', cantidad_requerida: 1 },
  { id_insumo: 'corcho', cantidad_requerida: 1 },
  { id_insumo: 'lamina', cantidad_requerida: 0.5 }
]

test.describe('D82 — lo que el envasado mueve', () => {
  test('24 botellas: +24 PRODUCCION y un TRASPASO por insumo de la receta', () => {
    expect(movimientosDeEnvasado('p750', 24, RECETA)).toEqual([
      { id_producto: 'p750', tipo_movimiento: 'PRODUCCION', cantidad: 24 },
      { id_producto: 'botella', tipo_movimiento: 'TRASPASO', cantidad: 24 },
      { id_producto: 'corcho', tipo_movimiento: 'TRASPASO', cantidad: 24 },
      { id_producto: 'lamina', tipo_movimiento: 'TRASPASO', cantidad: 12 }
    ])
  })

  test('CONTROL: cero botellas no mueve nada (ni negativas, ni fracciones)', () => {
    expect(movimientosDeEnvasado('p750', 0, RECETA)).toEqual([])
    expect(movimientosDeEnvasado('p750', -3, RECETA)).toEqual([])
    expect(movimientosDeEnvasado('p750', 2.5, RECETA)).toEqual([])
  })

  test('el empaque que no alcanza se dice; dos formatos que comparten insumo suman', () => {
    const movs = [
      ...movimientosDeEnvasado('p750', 10, RECETA),
      ...movimientosDeEnvasado('p250', 10, [{ id_insumo: 'lamina', cantidad_requerida: 0.5 }])
    ]
    const nombres = new Map([['lamina', 'Lamina'], ['corcho', 'Corcho'], ['botella', 'Botella']])
    const avisos = faltantesDeEmpaque(movs, new Map([['botella', 100], ['corcho', 4], ['lamina', 9]]), nombres)
    expect(avisos).toHaveLength(2)
    expect(avisos[0]).toContain('Falta Corcho: ocupas 10 y hay 4')
    expect(avisos[0]).toContain('queda en -6')
    expect(avisos[1]).toContain('Falta Lamina: ocupas 10 y hay 9')
  })

  test('CONTROL: con stock de sobra no hay avisos, y un insumo ausente cuenta como 0', () => {
    const movs = movimientosDeEnvasado('p750', 2, RECETA)
    expect(faltantesDeEmpaque(movs, new Map([['botella', 2], ['corcho', 2], ['lamina', 1]]), new Map())).toEqual([])
    expect(faltantesDeEmpaque(movs, new Map([['botella', 2], ['corcho', 2]]), new Map())).toHaveLength(1)
  })
})

test.describe('D81 — a que lote va', () => {
  const HOY = '2026-09-22'
  const L = (codigo_lote: string, fecha_inicio: string): LoteExistente => ({
    id: 'id-' + codigo_lote,
    codigo_lote,
    fecha_inicio
  })

  test('un solo lote abierto: va a ese, y se dice que fue por default', () => {
    const r = elegirLoteDestino(null, [L('L-VIEJO', '2026-07-01'), L('L-09', '2026-09-10')], HOY)
    expect(r).toEqual({ ok: true, lote: L('L-09', '2026-09-10'), porDefault: true })
  })

  test('CONTROL: ningun lote abierto -> error, no inventa uno', () => {
    const r = elegirLoteDestino(null, [L('L-VIEJO', '2026-07-01')], HOY)
    expect(r.ok).toBe(false)
  })

  test('varios abiertos -> pregunta con los codigos a la vista', () => {
    const r = elegirLoteDestino(null, [L('L-A', '2026-09-01'), L('L-B', '2026-09-15')], HOY)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('2 lotes abiertos')
      expect(r.error).toContain('L-B, L-A')
    }
  })

  test('dicho por codigo (sin importar mayusculas) -> ese, aunque sea viejo', () => {
    const r = elegirLoteDestino('l-viejo', [L('L-VIEJO', '2026-07-01'), L('L-09', '2026-09-10')], HOY)
    expect(r).toEqual({ ok: true, lote: L('L-VIEJO', '2026-07-01'), porDefault: false })
  })

  test('CONTROL: codigo que no existe -> error, no cae al lote abierto', () => {
    const r = elegirLoteDestino('L-ERRATA', [L('L-09', '2026-09-10')], HOY)
    expect(r.ok).toBe(false)
  })

  test('esAgregarALote: solo envasado, o codigo que ya existe', () => {
    const base = { codigoDictado: null, codigosTomados: ['L-09'], hayInsumos: false, hayTandas: false, hayEnvasado: true, hayFermentacion: false }
    expect(esAgregarALote(base)).toBe(true)
    expect(esAgregarALote({ ...base, codigoDictado: 'l-09', hayInsumos: true })).toBe(true)
    // CONTROLES: lote nuevo
    expect(esAgregarALote({ ...base, hayInsumos: true })).toBe(false)
    expect(esAgregarALote({ ...base, hayFermentacion: true })).toBe(false)
    expect(esAgregarALote({ ...base, codigoDictado: 'L-NUEVO' })).toBe(false)
    expect(esAgregarALote({ ...base, hayEnvasado: false })).toBe(false)
  })

  test('el sello del borrador de agregar se rompe si cambia una botella', () => {
    const p: PayloadAgregar = {
      id_lote: 'x',
      codigo_lote: 'L-09',
      usuario_creador: 'bot',
      entradas: [],
      tandas: [],
      envasado: [{ id_producto: 'p750', botellas: 24 }]
    }
    const sello = sellarAgregar(p)
    expect(selloAgregarCoincide(p, sello)).toBe(true)
    expect(selloAgregarCoincide({ ...p, envasado: [{ id_producto: 'p750', botellas: 25 }] }, sello)).toBe(false)
  })
})

test.describe('D83 — cuantas botellas se hicieron', () => {
  const HOY = '2026-09-22' // martes

  test('la semana empieza en lunes', () => {
    expect(lunesDe('2026-09-22')).toBe('2026-09-21')
    expect(lunesDe('2026-09-21')).toBe('2026-09-21')
    expect(lunesDe('2026-09-27')).toBe('2026-09-21') // domingo
  })

  test('periodos: vacio/hoy, ayer, semana, mes, lote', () => {
    expect(periodoDeProduccion(null, HOY)).toMatchObject({ tipo: 'dia', desde: HOY, hasta: HOY })
    expect(periodoDeProduccion('ayer', HOY)).toMatchObject({ desde: '2026-09-21', hasta: '2026-09-21' })
    expect(periodoDeProduccion('esta semana', HOY)).toMatchObject({ tipo: 'semana', desde: '2026-09-21' })
    expect(periodoDeProduccion('mes', HOY)).toMatchObject({ tipo: 'mes', desde: '2026-09-01' })
    expect(periodoDeProduccion('L-09', HOY)).toMatchObject({ tipo: 'lote', codigo: 'L-09' })
  })

  const FILAS: FilaEnvasado[] = [
    { fecha: '2026-09-22', codigo_lote: 'L-09', producto: 'Plata 750', botellas: 24 },
    { fecha: '2026-09-22', codigo_lote: 'L-09', producto: 'Plata 250', botellas: 12 },
    { fecha: '2026-09-21', codigo_lote: 'L-09', producto: 'Plata 750', botellas: 6 },
    { fecha: '2026-09-20', codigo_lote: 'L-08', producto: 'Plata 750', botellas: 100 }
  ]

  test('hoy suma solo hoy; la semana no cuenta el domingo anterior', () => {
    const hoy = periodoDeProduccion('hoy', HOY)
    expect(textoProduccion(filasDelPeriodo(FILAS, hoy), hoy)).toContain('Envasado hoy: 36 botellas.')
    const semana = periodoDeProduccion('semana', HOY)
    const t = textoProduccion(filasDelPeriodo(FILAS, semana), semana)
    expect(t).toContain('42 botellas')
    expect(t).toContain('30 de Plata 750')
    expect(t).toContain('2 dias con envasado')
  })

  test('por lote junta todos sus dias', () => {
    const lote = periodoDeProduccion('l-08', HOY)
    expect(textoProduccion(filasDelPeriodo(FILAS, lote), lote)).toContain('100 botellas')
  })

  test('CONTROL: sin filas lo dice, no reporta cero como si hubiera envasado', () => {
    const ayer = periodoDeProduccion('ayer', '2026-09-30')
    expect(textoProduccion(filasDelPeriodo(FILAS, ayer), ayer)).toBe('No hay envasado registrado ayer.')
  })
})
