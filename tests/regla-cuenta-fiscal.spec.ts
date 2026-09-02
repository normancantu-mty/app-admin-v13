import { test, expect } from '@playwright/test'
import {
  validarCompradorContraCuentaFiscal,
  esCuentaFiscal,
  ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR
} from '../lib/venta-cuenta-fiscal'

/**
 * La cuenta fiscal factura a LOCALES y a cliente final, nunca a distribuidores:
 * la factura se le hace al local, y al distribuidor se le paga por su servicio.
 * Dos ventas a David Flores (DST) se capturaron contra la cuenta fiscal por error;
 * esta regla es el guardarrail para que no se repita.
 */

test.describe('cuenta fiscal + comprador DST se rechaza', () => {
  test('DST contra la cuenta fiscal: rechazado con el mensaje claro', () => {
    const error = validarCompradorContraCuentaFiscal('Cuenta Fresnillo', 'DST')

    expect(error).toBe(ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR)
    expect(error).toContain('no a distribuidores')
  })

  test('LOC contra la cuenta fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('Cuenta Fresnillo', 'LOC')).toBeNull()
  })

  test('cliente final (sin comprador) contra la cuenta fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('Cuenta Fresnillo', null)).toBeNull()
    expect(validarCompradorContraCuentaFiscal('Cuenta Fresnillo', undefined)).toBeNull()
  })

  test('DST contra una cuenta no fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('Efectivo', 'DST')).toBeNull()
    expect(validarCompradorContraCuentaFiscal('Efectivo (David Flores)', 'DST')).toBeNull()
  })
})

test.describe('esCuentaFiscal: match textual, insensible a mayusculas y acentos', () => {
  test('reconoce la cuenta fiscal escrita de varias formas', () => {
    expect(esCuentaFiscal('Cuenta Fresnillo')).toBe(true)
    expect(esCuentaFiscal('CUENTA FRESNILLO')).toBe(true)
    expect(esCuentaFiscal('cuenta fresnillo')).toBe(true)
  })

  test('no marca como fiscal las cuentas de efectivo ni los vacios', () => {
    expect(esCuentaFiscal('Efectivo')).toBe(false)
    expect(esCuentaFiscal('Cuenta personal')).toBe(false)
    expect(esCuentaFiscal(null)).toBe(false)
    expect(esCuentaFiscal('')).toBe(false)
  })
})
