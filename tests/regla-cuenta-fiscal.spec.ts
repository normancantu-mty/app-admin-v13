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
 *
 * ERP-21 (2026-09-14): estas aserciones pasaban NOMBRES de cuenta ("Cuenta Fresnillo").
 * Ahora pasan el valor de `tipo_fiscalidad`, que es lo unico que decide la fiscalidad.
 * El centinela que impide volver al nombre vive en `tests/fiscalidad-por-columna.spec.ts`.
 */

test.describe('cuenta fiscal + comprador DST se rechaza', () => {
  test('DST contra la cuenta fiscal: rechazado con el mensaje claro', () => {
    const error = validarCompradorContraCuentaFiscal('FULL_TAX', 'DST')

    expect(error).toBe(ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR)
    expect(error).toContain('no a distribuidores')
  })

  test('LOC contra la cuenta fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('FULL_TAX', 'LOC')).toBeNull()
  })

  test('cliente final (sin comprador) contra la cuenta fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('FULL_TAX', null)).toBeNull()
    expect(validarCompradorContraCuentaFiscal('FULL_TAX', undefined)).toBeNull()
  })

  test('DST contra una cuenta no fiscal: permitido', () => {
    expect(validarCompradorContraCuentaFiscal('LIBRE', 'DST')).toBeNull()
    expect(validarCompradorContraCuentaFiscal('IVA_ONLY', 'DST')).toBeNull()
  })
})

test.describe('esCuentaFiscal: lee la columna, no el nombre', () => {
  test('solo FULL_TAX es cuenta fiscal', () => {
    expect(esCuentaFiscal('FULL_TAX')).toBe(true)
    expect(esCuentaFiscal('full_tax')).toBe(true)
  })

  test('IVA_ONLY y LIBRE no son la cuenta fiscal', () => {
    expect(esCuentaFiscal('IVA_ONLY')).toBe(false)
    expect(esCuentaFiscal('LIBRE')).toBe(false)
    expect(esCuentaFiscal(null)).toBe(false)
    expect(esCuentaFiscal(undefined)).toBe(false)
    expect(esCuentaFiscal('')).toBe(false)
  })

  /**
   * El defecto exacto que cerro ERP-21: el nombre de la cuenta no decide nada. Una cuenta
   * llamada "Cuenta Fresnillo" que NO sea FULL_TAX no es fiscal, y una que se llame de
   * cualquier otra forma pero SI lo sea, lo es. Renombrar dejo de mover impuestos.
   */
  test('el nombre de la cuenta ya no decide la fiscalidad', () => {
    expect(esCuentaFiscal('Cuenta Fresnillo')).toBe(false)
    expect(esCuentaFiscal('Efectivo')).toBe(false)
  })
})
