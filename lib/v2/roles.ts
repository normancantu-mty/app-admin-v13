/**
 * Front v2 — quien puede ver y hacer que en `/v2`. Escrito el 2026-10-29 por el
 * ejecutor de las correcciones del Front v2; ampliado el 2026-10-29 por el
 * ejecutor de la paridad v2. PURO: se prueba en `tests/v2-front-dinero.spec.ts`.
 * Las puertas de servidor que lo usan viven en `lib/v2/puerta.ts`.
 *
 * La autorizacion de verdad sigue en las server actions y en el RLS; esto solo
 * decide que botones se pintan.
 */

/** El tablero de la matriz muestra su dinero: solo roles de mando. */
export const ROLES_DE_MANDO_V2 = ['ADMIN', 'SOCIO'] as const

export function esRolDeMandoV2(rol: string | null | undefined): boolean {
  return (ROLES_DE_MANDO_V2 as readonly string[]).includes(rol ?? '')
}

/** Captura de la matriz (gasto, compra, envasado, anular, aprobar): solo ADMIN. SOCIO es de solo lectura. */
export function puedeCapturarMatriz(rol: string | null | undefined): boolean {
  return rol === 'ADMIN'
}

/**
 * Vender por el POS: ADMIN y DST. El LOC no: la RLS de `transacciones_tickets` solo tiene
 * INSERT para ADMIN y DST (tickets_ins_admin / tickets_ins_dst), asi que su venta fallaba
 * en la v1 con "violates row-level security". Abrirselo es una decision de esquema, no de UI.
 */
export function puedeVender(rol: string | null | undefined): boolean {
  return rol === 'ADMIN' || rol === 'DST'
}

/** Operar sobre un nodo (abono, conteo, alta de local): ADMIN y DST (el DST, solo en su red). */
export function puedeOperarNodo(rol: string | null | undefined): boolean {
  return rol === 'ADMIN' || rol === 'DST'
}
