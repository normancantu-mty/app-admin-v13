/**
 * FASE 8 — lo del servidor del bot que se prueba sin base y sin red.
 *
 * - D76: la cartera se filtra por deudor ("cuanto me debe aeropuerto" -> solo
 *   Aeropuerto); sin filtro ("quien me debe") sigue siendo la lista entera.
 * - D77: que borradores PENDIENTE se rehidratan tras un reinicio del bot.
 * - D79: `conservar_pendientes` solo cuenta si viene `true` literal.
 *
 * Cada bloque lleva su control negativo en la misma corrida.
 */
import { test, expect } from '@playwright/test'
import { filtrarCartera, textoCartera } from '@/lib/bot-consultas'
import {
  contextoDelCuerpo,
  pendientesVigentes,
  tipoDelPayload,
  VIDA_DEL_PENDIENTE_MS
} from '@/lib/bot-pendiente'
import { conservaPendientes } from '@/lib/bot-servidor'
import type { FilaCarteraVista } from '@/lib/vistas'

function fila(nombre: string, deuda: number): FilaCarteraVista {
  return {
    id_entidad: nombre,
    nombre,
    rol: 'LOC',
    recibidas: 0,
    salidas: 0,
    libro_dice: 0,
    generado: deuda,
    abonado: 0,
    porcentaje_pagado: 0.5,
    estimado_en_piso: 0,
    deuda,
    dias_sin_abono: 3
  } as unknown as FilaCarteraVista
}

const CARTERA = [fila('Aeropuerto', 10170), fila('Delirio 85', 7992), fila('Martín Reyes', 11327)]

test.describe('D76 — la cartera de UN deudor', () => {
  test('"aeropuerto" devuelve solo Aeropuerto, y el texto no nombra a nadie mas', () => {
    const solo = filtrarCartera(CARTERA, 'aeropuerto')
    expect(solo.map((f) => f.nombre)).toEqual(['Aeropuerto'])
    const texto = textoCartera(solo, 'aeropuerto')
    expect(texto).toContain('Aeropuerto')
    expect(texto).toContain('$10,170.00')
    expect(texto).not.toContain('Delirio')
    expect(texto).not.toContain('Martín')
  })

  test('sin acentos ni mayusculas: "martin reyes" empata "Martín Reyes"', () => {
    expect(filtrarCartera(CARTERA, 'MARTIN reyes').map((f) => f.nombre)).toEqual(['Martín Reyes'])
  })

  test('CONTROL: "quien me debe" (sin filtro, o vacio) devuelve a todos', () => {
    expect(filtrarCartera(CARTERA, null)).toHaveLength(3)
    expect(filtrarCartera(CARTERA, '  ')).toHaveLength(3)
    const texto = textoCartera(filtrarCartera(CARTERA, null))
    for (const n of ['Aeropuerto', 'Delirio 85', 'Martín Reyes']) expect(texto).toContain(n)
  })

  test('CONTROL NEGATIVO: el camino viejo (filtro tirado) contesta la cartera entera', () => {
    // Asi contestaba el 2026-09-21: el filtro no llegaba y salia todo.
    expect(textoCartera(CARTERA)).toContain('Delirio 85')
  })

  test('un nombre que no esta se dice, no se contesta con la lista entera', () => {
    const nadie = filtrarCartera(CARTERA, 'fulano')
    expect(nadie).toHaveLength(0)
    expect(textoCartera(nadie, 'fulano')).toContain('No encuentro a "fulano"')
  })

  test('un deudor al corriente dice que no debe nada', () => {
    const alCorriente = filtrarCartera([fila('Eden', 0)], 'eden')
    expect(textoCartera(alCorriente, 'eden')).toBe('Eden: no te debe nada hoy.')
  })
})

test.describe('D77 — los pendientes que se rehidratan', () => {
  const ahora = new Date('2026-09-23T05:00:00Z')
  const hace = (min: number) => new Date(ahora.getTime() - min * 60000).toISOString()
  const sello = 'a'.repeat(64)

  test('el payload de cada ruta proponer se lee con el tipo del bot', () => {
    expect(tipoDelPayload({ tipo: 'venta' })).toBe('venta')
    expect(tipoDelPayload({ tipo: 'alta_entidad' })).toBe('alta')
    expect(tipoDelPayload({ fila: { monto: 45 }, meta: {} })).toBe('gasto')
    expect(tipoDelPayload({ tipo: 'otra_cosa' })).toBeNull()
    // Auditoria 2026-11-04: estos cinco se perdian en un reinicio.
    for (const tipo of ['entrega_efectivo', 'alta_miembro', 'alta_categoria', 'entrada_insumo', 'lote_etapa']) {
      expect(tipoDelPayload({ tipo })).toBe(tipo)
    }
    expect(tipoDelPayload({ meta: {} })).toBeNull()
    expect(tipoDelPayload(null)).toBeNull()
  })

  test('el contexto del bot se sanea y vuelve con el pendiente', () => {
    const cuentas = [{ id: 'c1', nombre: 'Efectivo', extra: 'no' }]
    const contexto = contextoDelCuerpo(
      {
        cuenta: { oida: 'la de Kevin', raro: 'x' },
        propuesta: { monto: 400, descripcion: 'gasolina', objeto: { a: 1 } },
        sugeridas: ['A', 2]
      },
      { cuentas, id_cuenta: 'c1' }
    )
    expect(contexto?.cuenta).toEqual({ oida: 'la de Kevin' })
    expect(contexto?.propuesta).toEqual({ monto: 400, descripcion: 'gasolina' })
    expect(contexto?.sugeridas).toEqual(['A'])
    expect(contexto?.cuentas).toEqual([{ id: 'c1', nombre: 'Efectivo' }])

    const fila = (payload: unknown) => [
      { id: 'b', sello, payload, estado: 'PENDIENTE', creado_en: new Date(ahora.getTime() - 60000).toISOString() }
    ]
    expect(pendientesVigentes(fila({ fila: {}, meta: { contexto_bot: contexto } }), ahora)[0].contexto).toEqual(contexto)
    expect(pendientesVigentes(fila({ fila: {}, meta: {} }), ahora)[0]).not.toHaveProperty('contexto')
  })

  test('sin contexto, o demasiado grande, no se guarda nada', () => {
    const servidor = { cuentas: [], id_cuenta: 'c1' }
    expect(contextoDelCuerpo(undefined, servidor)).toBeNull()
    expect(contextoDelCuerpo({ cuenta: {} }, servidor)).toBeNull()
    const propuesta = Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['k' + i, 'x'.repeat(900)]))
    expect(contextoDelCuerpo({ propuesta }, servidor)).toBeNull()
  })

  test('solo PENDIENTE, de menos de 30 min, del mas viejo al mas nuevo', () => {
    const filas = [
      { id: 'b', sello, payload: { fila: {} }, estado: 'PENDIENTE', creado_en: hace(5) },
      { id: 'a', sello, payload: { tipo: 'venta' }, estado: 'PENDIENTE', creado_en: hace(29) },
      { id: 'viejo', sello, payload: { tipo: 'venta' }, estado: 'PENDIENTE', creado_en: hace(31) },
      { id: 'hecho', sello, payload: { tipo: 'venta' }, estado: 'CONFIRMADO', creado_en: hace(1) },
      { id: 'raro', sello, payload: { tipo: 'x' }, estado: 'PENDIENTE', creado_en: hace(1) }
    ]
    const r = pendientesVigentes(filas, ahora)
    expect(r.map((p) => [p.borrador_id, p.tipo])).toEqual([
      ['a', 'venta'],
      ['b', 'gasto']
    ])
    expect(r[0].sello).toBe(sello)
  })

  test('CONTROL: el borde es exactamente VIDA_DEL_PENDIENTE_MS', () => {
    const justo = new Date(ahora.getTime() - VIDA_DEL_PENDIENTE_MS).toISOString()
    const pasado = new Date(ahora.getTime() - VIDA_DEL_PENDIENTE_MS - 1).toISOString()
    const f = (c: string) => [{ id: 'x', sello, payload: { tipo: 'abono' }, estado: 'PENDIENTE', creado_en: c }]
    expect(pendientesVigentes(f(justo), ahora)).toHaveLength(1)
    expect(pendientesVigentes(f(pasado), ahora)).toHaveLength(0)
  })
})

test.describe('D79 — conservar_pendientes', () => {
  test('solo `true` literal conserva; todo lo demas cancela como siempre', () => {
    expect(conservaPendientes({ conservar_pendientes: true })).toBe(true)
    // CONTROL NEGATIVO: el default de siempre.
    expect(conservaPendientes({})).toBe(false)
    expect(conservaPendientes({ conservar_pendientes: 'true' })).toBe(false)
    expect(conservaPendientes({ conservar_pendientes: 1 })).toBe(false)
    expect(conservaPendientes(null)).toBe(false)
  })
})
