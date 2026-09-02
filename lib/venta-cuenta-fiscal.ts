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
 */

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/**
 * TODO ERP-21: detectar la cuenta fiscal por `tipo_fiscalidad` en vez de por el nombre.
 * El match textual es fragil (renombrar la cuenta, o crear una segunda que contenga
 * "fresnillo", cambia el comportamiento fiscal en silencio). Se usa aqui el mecanismo que
 * ya existe en `pos.ts` para no introducir un segundo criterio mientras ERP-21 sigue abierto.
 */
export function esCuentaFiscal(cuentaNombre: string | null | undefined): boolean {
  return normalizeText(cuentaNombre ?? '').includes('fresnillo')
}

export const ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR =
  'La cuenta fiscal factura a locales y a cliente final, no a distribuidores.'

/**
 * Devuelve el mensaje de error si la venta viola la regla, o `null` si es valida.
 * Solo bloquea la combinacion cuenta fiscal + comprador DST; cualquier otra pasa.
 */
export function validarCompradorContraCuentaFiscal(
  cuentaNombre: string | null | undefined,
  rolComprador: string | null | undefined
): string | null {
  if (!esCuentaFiscal(cuentaNombre)) return null
  if (rolComprador !== 'DST') return null
  return ERROR_CUENTA_FISCAL_A_DISTRIBUIDOR
}
