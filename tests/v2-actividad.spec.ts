import { test, expect } from '@playwright/test'
import { diasDesde, ultimaActividad, ultimaActividadPorNodo } from '../lib/actividad'

/**
 * v2, ronda 2 de la auditoria (2026-10-29, Socio ejecutor): UNA regla de actividad para el
 * Dashboard General y el directorio (`lib/actividad.ts`). Antes, Dulceria el Eden, Mi dulce
 * catrina y Luis Rodriguez (deuda y consignacion 0 en la conciliacion, sin filas propias)
 * salian "Sin contacto" en el directorio y "Hace 1 dias" en el tablero.
 */
const CORTE = '2026-10-27T23:59:00-06:00' // fecha de corte de la captura, 23:59 hora de Mexico

test.describe('v2 · actividad: dias de calendario en hora de Mexico', () => {
  test('corte del 27 a las 23:59, hoy 29 a las 10:00 (MX) -> 2 dias, no 1', () => {
    expect(diasDesde(CORTE, new Date('2026-10-29T10:00:00-06:00'))).toBe(2)
  })
  test('cruzar la medianoche de Mexico es un dia aunque pasen 2 horas', () => {
    // 27 23:00 MX -> 28 01:00 MX
    expect(diasDesde('2026-10-28T05:00:00Z', new Date('2026-10-28T07:00:00Z'))).toBe(1)
  })
  test('la medianoche UTC NO cuenta: 27 17:00 MX -> 27 20:00 MX es el mismo dia', () => {
    expect(diasDesde('2026-10-27T23:00:00Z', new Date('2026-10-28T02:00:00Z'))).toBe(0)
  })
  test('sin fecha -> null; fecha futura -> 0', () => {
    expect(diasDesde(null)).toBeNull()
    expect(diasDesde('2030-01-01T00:00:00Z', new Date('2026-10-29T12:00:00Z'))).toBe(0)
  })
  test('ultimaActividad toma la mas reciente e ignora basura', () => {
    expect(ultimaActividad([null, '', 'no-es-fecha', '2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z'])?.toISOString())
      .toBe('2026-10-20T00:00:00.000Z')
    expect(ultimaActividad([null, undefined])).toBeNull()
  })
})

test.describe('v2 · actividad: que cuenta y que no', () => {
  const vacio = { finanzas: [], inventario: [], tickets: [] }

  test('un nodo sin filas propias toma el corte de arranque (Eden, Catrina, Luis)', () => {
    const r = ultimaActividadPorNodo(['eden'], { ...vacio, fechaArranque: CORTE })
    expect(r.get('eden')?.toISOString()).toBe(new Date(CORTE).toISOString())
  })
  test('sin corte y sin nada -> null (el directorio pinta ⚪)', () => {
    expect(ultimaActividadPorNodo(['x'], vacio).get('x')).toBeNull()
  })
  test('lo ANULADO no cuenta, en ningun ledger', () => {
    const r = ultimaActividadPorNodo(['n'], {
      finanzas: [{ id_entidad_relacionada: 'n', fecha_movimiento: '2026-10-28T00:00:00Z', status: 'ANULADO' }],
      inventario: [{ id_entidad_destino: 'n', fecha_movimiento: '2026-10-28T00:00:00Z', status: 'ANULADO' }],
      tickets: [{ id_comprador: 'n', fecha_transaccion: '2026-10-28T00:00:00Z', status: 'ANULADO' }],
      fechaArranque: '2026-10-01T00:00:00Z'
    })
    expect(r.get('n')?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
  test('cuentan: finanzas relacionada, inventario destino Y origen, tickets como comprador, seguimiento', () => {
    const base = { ...vacio, fechaArranque: '2026-10-01T00:00:00Z' }
    const caso = (extra: object) => ultimaActividadPorNodo(['n'], { ...base, ...extra }).get('n')?.toISOString()
    expect(caso({ finanzas: [{ id_entidad_relacionada: 'n', fecha_movimiento: '2026-10-05T00:00:00Z', status: 'ACTIVO' }] })).toBe('2026-10-05T00:00:00.000Z')
    expect(caso({ inventario: [{ id_entidad_origen: 'n', id_entidad_destino: 'otro', fecha_movimiento: '2026-10-06T00:00:00Z', status: 'ACTIVO' }] })).toBe('2026-10-06T00:00:00.000Z')
    expect(caso({ tickets: [{ id_comprador: 'n', fecha_transaccion: '2026-10-07T00:00:00Z', status: 'ACTIVO' }] })).toBe('2026-10-07T00:00:00.000Z')
    expect(caso({ seguimiento: new Map([['n', '2026-10-08T00:00:00Z']]) })).toBe('2026-10-08T00:00:00.000Z')
  })
  test('CONTROL NEGATIVO: la fila de OTRO nodo no le cuenta a este', () => {
    const r = ultimaActividadPorNodo(['n'], {
      ...vacio,
      finanzas: [{ id_entidad_relacionada: 'otro', fecha_movimiento: '2026-10-28T00:00:00Z', status: 'ACTIVO' }]
    })
    expect(r.get('n')).toBeNull()
  })
})
