import { test, expect } from '@playwright/test'
import {
  permisoDeAccion,
  permisoDeConsulta,
  puedeAprobar,
  esAprobador,
  NORMAN_TELEGRAM_ID,
  ROL_TRABAJADOR,
  type AccionBot
} from '../lib/bot-permisos'
import { mensajeFaltaEmpaque } from '../lib/bot-envasado'

/**
 * Cazador F0 · WP-6 — la tabla del TRABAJADOR (`lib/bot-permisos.ts`).
 * Escrito el 2026-10-17 por el ejecutor B del Socio.
 * El recorrido completo (bot + rutas + base local) es `bot/probar_trabajador.py`.
 */

const TRABAJADOR = { rol: ROL_TRABAJADOR, requiereAprobacion: true }
const KEVIN = { rol: 'ADMIN', requiereAprobacion: true }

test('captura venta, gasto, lote y entrada de insumo: siempre a aprobacion', () => {
  for (const a of ['venta', 'gasto', 'lote', 'entrada_insumo'] as AccionBot[]) {
    expect(permisoDeAccion(TRABAJADOR, a)).toBe('aprobacion')
  }
})

test('nunca escribe directo, ni aunque la marca venga apagada', () => {
  expect(permisoDeAccion({ rol: ROL_TRABAJADOR, requiereAprobacion: false }, 'gasto')).toBe('aprobacion')
})

test('lo que la tabla no dice queda cerrado', () => {
  for (const a of ['abono', 'cotizacion', 'convertir', 'entidad', 'registrar', 'entrega_efectivo'] as AccionBot[]) {
    expect(permisoDeAccion(TRABAJADOR, a)).toBe('no')
  }
})

test('ninguna cifra agregada: solo precios', () => {
  for (const c of ['inventario', 'deuda', 'ventas', 'produccion'] as const) {
    expect(permisoDeConsulta(TRABAJADOR, c).ok).toBe(false)
  }
  // Auditoria 2026-11-03 (hallazgo 5): en grupo, todo por privado.
  expect(permisoDeConsulta(TRABAJADOR, 'precios')).toEqual({ ok: true, alcance: 'propio', privado: true })
  // CONTROL: Kevin sigue viendo todo.
  expect(permisoDeConsulta(KEVIN, 'inventario').ok).toBe(true)
})

test('no aprueba; solo Norman aprueba lo suyo (Kevin no, 2026-11-03)', () => {
  const t = { telegramId: 333, ...TRABAJADOR }
  expect(esAprobador(TRABAJADOR)).toBe(false)
  expect(puedeAprobar(t, { telegramId: 9, rol: 'DST', requiereAprobacion: false })).toBe(false)
  expect(puedeAprobar({ telegramId: NORMAN_TELEGRAM_ID, rol: 'ADMIN', requiereAprobacion: false }, t)).toBe(true)
  // Auditoria 2026-11-03 (hallazgo 1): un ADMIN sin marca que no es Norman no aprueba.
  expect(puedeAprobar({ telegramId: 111, rol: 'ADMIN', requiereAprobacion: false }, t)).toBe(false)
  expect(puedeAprobar({ telegramId: 222, ...KEVIN }, t)).toBe(false)
})

test('el aviso de falta de empaque no le ensena el stock', () => {
  const env = [{ nombre: 'Plata 750', botellas: 24 }]
  const f = [{ id_insumo: 'x', nombre: 'Corcho', ocupa: 24, hay: 7, falta: 17 }]
  const sin = mensajeFaltaEmpaque(env, f, true)
  expect(sin).toContain('Corcho: ocupo 24')
  expect(sin).not.toContain('tengo 7')
  expect(sin).not.toContain('faltan 17')
  // CONTROL: el de siempre si trae el stock.
  expect(mensajeFaltaEmpaque(env, f)).toContain('tengo 7')
})
