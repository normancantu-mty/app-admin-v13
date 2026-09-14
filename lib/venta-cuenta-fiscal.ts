/**
 * Regla comercial: la cuenta fiscal factura a LOCALES y a cliente final, nunca a distribuidores.
 *
 * Por que existe: la factura se le hace al LOCAL, no al distribuidor. Cuando el local paga, se le
 * paga al distribuidor por su servicio, para que el distribuidor no tenga que sacar permiso de
 * venta de alcohol. Por lo tanto un ticket con destino a la cuenta fiscal NUNCA debe tener a un
 * DST como comprador.
 *
 * Dos ventas a David Flores (DST) se capturaron asi por error y el motor de impuesto inverso les
 * separo IVA e IEPS que no existian; se corrigieron en la migracion
 * 20260902210208_corregir_dos_tickets_david_flores_cuenta_fiscal.sql.
 *
 * ERP-21 (2026-09-14): antes esto se decidia por el NOMBRE de la cuenta. Ahora se decide por
 * `tipo_fiscalidad`, que es la columna que ya existia y que el nombre estaba suprimiendo.
 * `tests/fiscalidad-por-columna.spec.ts` caza la reaparicion del criterio textual.
 */

/** Unica fuente de verdad de la fiscalidad: la columna, jamas el nombre. ERP-21. */
export function esCuentaFiscal(tipoFiscalidad: string | null | undefined): boolean {
  return (tipoFiscalidad ?? '').toUpperCase() === 'FULL_TAX'
}

export const ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR =
  'La cuenta fiscal factura a locales y a cliente final, no a distribuidores.'

/**
 * Devuelve el mensaje de error si la venta viola la regla, o `null` si es valida.
 * Solo bloquea la combinacion cuenta fiscal + comprador DST; cualquier otra pasa.
 */
export function validarCompradorContraCuentaFiscal(
  tipoFiscalidad: string | null | undefined,
  rolComprador: string | null | undefined
): string | null {
  if (!esCuentaFiscal(tipoFiscalidad)) return null
  if (rolComprador !== 'DST') return null
  return ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR
}
