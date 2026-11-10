/**
 * Suscripciones (2026-11-09) — la parte PURA de `lib/suscripciones.ts`: el
 * calendario, cuando toca preguntar, el estado del mes, el total y la fila del
 * egreso. Sin red, sin base. La ruta se prueba en `suscripciones-ruta.spec.ts`
 * y el bot en `bot/probar_suscripciones.py`.
 */
import { test, expect } from '@playwright/test'
import { disparadoresFiscalesEn } from '@/lib/bot-gastos'
import {
  debePreguntar,
  diaEfectivo,
  estadoDelMes,
  fechaDeCobro,
  filaDeEgreso,
  lineasDeTotal,
  mesActual,
  mesAnterior,
  patronDeNombre,
  pendientesAnteriores,
  rangoDelMes,
  textoDeLista,
  textoDePregunta,
  totalMensual,
  validarSuscripcion,
  volverAPreguntarEn,
  yaPagada,
  type MesDeSuscripcion,
  type Suscripcion
} from '@/lib/suscripciones'

const S = (o: Partial<Suscripcion> = {}): Suscripcion => ({
  id: 1,
  nombre: 'ManyChat',
  monto: 480,
  moneda: 'MXN',
  dia_cobro: 22,
  id_cuenta: null,
  subcategoria: 'Marketing y mensajería',
  activa: true,
  ...o
})
const F = (o: Partial<MesDeSuscripcion> = {}): MesDeSuscripcion => ({
  id_suscripcion: 1,
  mes: '2026-11',
  estado: 'PREGUNTADA',
  volver_a_preguntar: null,
  id_movimiento: null,
  monto_pagado: null,
  ...o
})
const AHORA = new Date('2026-11-22T18:00:00Z') // 12:00 en Mexico

test.describe('suscripciones · calendario', () => {
  test('dia de cobro: 31 en febrero = el ultimo dia; sin dia = el 1', () => {
    expect(diaEfectivo(31, '2026-02')).toBe(28)
    expect(diaEfectivo(31, '2028-02')).toBe(29)
    expect(diaEfectivo(31, '2026-04')).toBe(30)
    expect(diaEfectivo(null, '2026-11')).toBe(1)
    expect(fechaDeCobro(S({ dia_cobro: 5 }), '2026-11')).toBe('2026-11-05')
    expect(mesAnterior('2026-01')).toBe('2025-12')
  })

  test('el mes es el de Mexico, no el de UTC', () => {
    // 1-dic 03:00 UTC = 30-nov 21:00 en Mexico.
    expect(mesActual(new Date('2026-12-01T03:00:00Z'))).toBe('2026-11')
  })
})

test.describe('suscripciones · cuando toca preguntar', () => {
  test('el dia de cobro, desde las 9 (Mexico), sin fila: la primera', () => {
    expect(debePreguntar(S(), null, '2026-11-22', 12, AHORA)).toEqual({ preguntar: true, tipo: 'nueva' })
    expect(debePreguntar(S(), null, '2026-11-21', 12, AHORA)).toEqual({ preguntar: false })
    expect(debePreguntar(S(), null, '2026-11-22', 8, AHORA)).toEqual({ preguntar: false })
    expect(debePreguntar(S(), null, '2026-11-28', 12, AHORA)).toEqual({ preguntar: true, tipo: 'nueva' })
  })

  test('sin dia de cobro: el 1', () => {
    expect(debePreguntar(S({ dia_cobro: null }), null, '2026-11-01', 9, AHORA)).toEqual({ preguntar: true, tipo: 'nueva' })
  })

  test('UNA por mes: con fila PREGUNTADA, PAGADA o BAJA ya no', () => {
    for (const estado of ['PREGUNTADA', 'PAGADA', 'BAJA'] as const) {
      expect(debePreguntar(S(), F({ estado }), '2026-11-25', 12, AHORA)).toEqual({ preguntar: false })
    }
  })

  test('"Todavia no": a los 3 dias se vuelve a preguntar, antes no', () => {
    const dicho = new Date('2026-11-22T18:00:00Z')
    const fila = F({ estado: 'POSPUESTA', volver_a_preguntar: volverAPreguntarEn(dicho) })
    expect(debePreguntar(S(), fila, '2026-11-24', 12, new Date('2026-11-24T18:00:00Z'))).toEqual({ preguntar: false })
    expect(debePreguntar(S(), fila, '2026-11-25', 12, new Date('2026-11-25T18:00:00Z'))).toEqual({ preguntar: true, tipo: 'reintento' })
  })

  test('inactiva: nunca', () => {
    expect(debePreguntar(S({ activa: false }), null, '2026-11-22', 12, AHORA)).toEqual({ preguntar: false })
  })
})

test.describe('suscripciones · estado del mes (derivado de la base)', () => {
  test('PAGADA con egreso ACTIVO = pagada; con egreso ANULADO = pendiente', () => {
    const pagada = F({ estado: 'PAGADA', id_movimiento: 'm1', monto_pagado: 480 })
    expect(estadoDelMes(S(), pagada, '2026-11-25', true)).toBe('pagada')
    expect(estadoDelMes(S(), pagada, '2026-11-25', false)).toBe('pendiente')
    expect(yaPagada(pagada, false)).toBe(false)
  })

  test('PAGADA sin id (la marca fallo) cuenta como pagada: no se duplica', () => {
    expect(estadoDelMes(S(), F({ estado: 'PAGADA' }), '2026-11-25', false)).toBe('pagada')
    expect(yaPagada(F({ estado: 'PAGADA' }), false)).toBe(true)
  })

  test('antes del dia: por cobrar; despues sin pagar: pendiente; baja; inactiva', () => {
    expect(estadoDelMes(S(), null, '2026-11-10', false)).toBe('por_cobrar')
    expect(estadoDelMes(S(), null, '2026-11-22', false)).toBe('pendiente')
    expect(estadoDelMes(S(), F({ estado: 'POSPUESTA' }), '2026-11-23', false)).toBe('pendiente')
    expect(estadoDelMes(S({ activa: false }), F({ estado: 'BAJA' }), '2026-11-23', false)).toBe('baja')
    expect(estadoDelMes(S({ activa: false }), null, '2026-11-23', false)).toBe('inactiva')
  })
})

test.describe('suscripciones · total mensual', () => {
  test('MXN suma; USD va aparte; sin tipo de cambio inventado', () => {
    const subs = [
      S({ id: 1, monto: 480 }),
      S({ id: 2, nombre: 'Claude Max', monto: 200, moneda: 'USD' }),
      S({ id: 3, nombre: 'Google AI Pro', monto: 20, moneda: 'USD' }),
      S({ id: 4, nombre: 'Vieja', monto: 999, activa: false })
    ]
    const sinRef = totalMensual(subs, new Map())
    expect(sinRef).toEqual({ mxn: 480, usd: 220, aproxMxn: null, usdSinReferencia: ['Claude Max', 'Google AI Pro'] })
    expect(lineasDeTotal(sinRef).join('\n')).not.toContain('≈')

    // Con el ultimo cobro en pesos de Claude Max: aproximado, marcado ⚠️, y Google sigue aparte.
    const conRef = totalMensual(subs, new Map([[2, 3812.4]]))
    expect(conRef.aproxMxn).toBe(4292.4)
    expect(conRef.usdSinReferencia).toEqual(['Google AI Pro'])
    const texto = lineasDeTotal(conRef).join('\n')
    expect(texto).toContain('⚠️')
    expect(texto).toContain('$480.00 MXN')
    expect(texto).toContain('USD 220.00')
  })

  test('la lista dice monto, dia y estado', () => {
    const subs = [S({ id: 1 }), S({ id: 2, nombre: 'Claude Max', monto: 200, moneda: 'USD', dia_cobro: null })]
    const t = textoDeLista(
      [
        { s: subs[0], estado: 'pagada', montoPagado: 480 },
        { s: subs[1], estado: 'pendiente', montoPagado: null }
      ],
      '2026-11',
      totalMensual(subs, new Map())
    )
    expect(t).toContain('ManyChat: $480.00 · dia 22 · pagada ($480.00)')
    expect(t).toContain('Claude Max: USD 200.00 · sin dia · PENDIENTE')
    expect(t).toContain('noviembre 2026')
  })
})

test.describe('suscripciones · la fila del egreso', () => {
  test('misma forma que un gasto del bot, en Suscripciones / <subcategoria>', () => {
    const r = filaDeEgreso(S(), { mes: '2026-11', montoMxn: 480.004, idCuenta: 'c-1', etiqueta: 'norman', ahora: AHORA })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fila).toEqual({
      tipo_movimiento: 'GASTO_OPERATIVO',
      categoria: 'Suscripciones',
      subcategoria: 'Marketing y mensajería',
      categoria_gasto: null,
      descripcion: 'Suscripción ManyChat (2026-11)',
      monto: 480,
      fecha_movimiento: AHORA.toISOString(),
      id_cuenta_destino: 'c-1',
      id_cuenta_origen: null,
      usuario_creador: 'telegram:norman',
      status: 'ACTIVO',
      es_recurrente: true
    })
  })

  test('un nombre con texto fiscal no mueve el pasivo; montos fuera de rango no', () => {
    const r = filaDeEgreso(S({ nombre: 'pago IVA' }), { mes: '2026-11', montoMxn: 10, idCuenta: 'c', etiqueta: 'n', ahora: AHORA })
    expect(r.ok ? r.fila.descripcion : null).toBe('Suscripción pago I.V.A. (2026-11)')
    expect(r.ok ? disparadoresFiscalesEn(r.fila.descripcion) : null).toEqual([])
    expect(filaDeEgreso(S(), { mes: '2026-11', montoMxn: 0, idCuenta: 'c', etiqueta: 'n', ahora: AHORA }).ok).toBe(false)
    expect(filaDeEgreso(S(), { mes: '2026-11', montoMxn: 500001, idCuenta: 'c', etiqueta: 'n', ahora: AHORA }).ok).toBe(false)
    expect(filaDeEgreso(S(), { mes: '2026-13', montoMxn: 10, idCuenta: 'c', etiqueta: 'n', ahora: AHORA }).ok).toBe(false)
  })
})

test.describe('suscripciones · alta desde el ERP', () => {
  test('valida nombre, monto, moneda, dia y subcategoria', () => {
    const ok = validarSuscripcion({ nombre: '  Claude   Max ', monto: '200', moneda: 'usd', dia_cobro: '', subcategoria: 'IA' })
    expect(ok).toEqual({
      ok: true,
      valores: { nombre: 'Claude Max', monto: 200, moneda: 'USD', dia_cobro: null, id_cuenta: null, subcategoria: 'IA', activa: true, notas: null }
    })
    expect(validarSuscripcion({ nombre: 'x', monto: 10, dia_cobro: 32 }).ok).toBe(false)
    expect(validarSuscripcion({ nombre: 'x', monto: 10, moneda: 'EUR' }).ok).toBe(false)
    expect(validarSuscripcion({ nombre: 'x', monto: 10, subcategoria: 'Comida' }).ok).toBe(false)
    expect(validarSuscripcion({ nombre: '', monto: 10 }).ok).toBe(false)
  })

  test('una nota con un numero de tarjeta no se guarda', () => {
    expect(validarSuscripcion({ nombre: 'x', monto: 10, notas: 'tarjeta 4152 3138 0000 1234' }).ok).toBe(false)
    expect(validarSuscripcion({ nombre: 'x', monto: 10, notas: 'tarjeta de Spin' }).ok).toBe(true)
  })
})

// ─── RONDA 2 (auditoria 2026-11-09) ─────────────────────────────────────────

test.describe('suscripciones · ronda 2: lo que se perdia', () => {
  test('1. "Todavia no" de octubre sigue vivo en noviembre: se reintenta con SU mes', () => {
    const oct = F({ mes: '2026-10', estado: 'POSPUESTA', volver_a_preguntar: '2026-11-01T15:00:00.000Z', motivo_pospuesta: 'TODAVIA_NO' })
    // Ya es noviembre; la fila es de octubre.
    expect(debePreguntar(S(), oct, '2026-11-02', 12, new Date('2026-11-02T18:00:00Z'))).toEqual({ preguntar: true, tipo: 'reintento' })
    // Antes de las 9 tampoco.
    expect(debePreguntar(S(), oct, '2026-11-02', 8, new Date('2026-11-02T14:00:00Z'))).toEqual({ preguntar: false })
    // Dada de baja (inactiva) ya no.
    expect(debePreguntar(S({ activa: false }), oct, '2026-11-02', 12, new Date('2026-11-02T18:00:00Z'))).toEqual({ preguntar: false })
  })

  test('1. pendientes de meses anteriores: PREGUNTADA, POSPUESTA y PAGADA con egreso anulado; no pagada ni baja ni inactiva', () => {
    const subs = [S({ id: 1 }), S({ id: 2, nombre: 'Claude Max' }), S({ id: 3, nombre: 'Vieja', activa: false })]
    const filas = [
      F({ id_suscripcion: 1, mes: '2026-09', estado: 'PREGUNTADA' }),
      F({ id_suscripcion: 1, mes: '2026-10', estado: 'POSPUESTA' }),
      F({ id_suscripcion: 2, mes: '2026-09', estado: 'PAGADA', id_movimiento: 'm-ok', monto_pagado: 1 }),
      F({ id_suscripcion: 2, mes: '2026-10', estado: 'PAGADA', id_movimiento: 'm-anulado', monto_pagado: 1 }),
      F({ id_suscripcion: 2, mes: '2026-08', estado: 'BAJA' }),
      F({ id_suscripcion: 3, mes: '2026-10', estado: 'POSPUESTA' }),
      F({ id_suscripcion: 1, mes: '2026-11', estado: 'POSPUESTA' })
    ]
    const r = pendientesAnteriores(subs, filas, new Set(['m-ok']), '2026-11')
    expect(r.map((x) => `${x.s.id}:${x.fila.mes}`)).toEqual(['1:2026-09', '2:2026-10', '1:2026-10']) // mes, luego nombre (Claude Max < ManyChat)
    const t = textoDeLista([{ s: subs[0], estado: 'pendiente', montoPagado: null }], '2026-11', totalMensual(subs, new Map()), r)
    expect(t).toContain('Meses anteriores sin pagar:')
    expect(t).toContain('• ManyChat (septiembre 2026): $480.00')
    expect(t).toContain('• Claude Max (octubre 2026)')
  })

  test('2. PREGUNTADA sin id de mensaje y de hace mas de 6 h: se reenvia UNA vez', () => {
    const ahora = new Date('2026-11-22T22:00:00Z')
    const hace = (h: number) => new Date(ahora.getTime() - h * 3600000).toISOString()
    const muerta = F({ estado: 'PREGUNTADA', preguntada_en: hace(7), id_mensaje: null, reenvios: 0 })
    expect(debePreguntar(S(), muerta, '2026-11-22', 16, ahora)).toEqual({ preguntar: true, tipo: 'reenvio' })
    expect(debePreguntar(S(), { ...muerta, preguntada_en: hace(5) }, '2026-11-22', 16, ahora)).toEqual({ preguntar: false })
    expect(debePreguntar(S(), { ...muerta, id_mensaje: 77 }, '2026-11-22', 16, ahora)).toEqual({ preguntar: false })
    expect(debePreguntar(S(), { ...muerta, reenvios: 1 }, '2026-11-22', 16, ahora)).toEqual({ preguntar: false })
  })

  test('3. el texto del reintento dice POR QUE: "todavia no" solo si Norman lo dijo', () => {
    const tNo = textoDePregunta(S(), '2026-11', 'TODAVIA_NO')
    expect(tNo).toContain('todavia no')
    for (const motivo of ['ENVIO_FALLIDO', 'REENVIO', 'NUEVA'] as const) {
      const t = textoDePregunta(S(), '2026-11', motivo)
      expect(t, motivo).not.toContain('todavia no')
      expect(t, motivo).not.toContain('me dijiste')
      expect(t, motivo).toContain('¿Ya se pago la de noviembre 2026?')
    }
    expect(textoDePregunta(S(), '2026-11', 'ENVIO_FALLIDO')).toContain('no te llego')
  })

  test('5. el mes del egreso duplicado se busca en hora de Mexico; el nombre no rompe el filtro', () => {
    expect(rangoDelMes('2026-11')).toEqual({ desde: '2026-11-01T06:00:00.000Z', hasta: '2026-12-01T06:00:00.000Z' })
    expect(rangoDelMes('2026-12').hasta).toBe('2027-01-01T06:00:00.000Z')
    expect(patronDeNombre('ManyChat')).toBe('*ManyChat*')
    expect(patronDeNombre('Claude* (Max), 100%_x')).toBe('*Claude Max 100 x*')
  })
})
