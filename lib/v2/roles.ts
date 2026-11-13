/**
 * Front v2 — quien puede ver y hacer que en `/panel`. Escrito el 2026-10-29 por el
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

/**
 * Captura OPERATIVA de la matriz (lotes, envasado, compra de insumos, inventario): ADMIN y
 * EMPLEADO_ADMIN (2026-11-13). SOCIO es de solo lectura. Lo de dinero (gasto) pide ademas
 * `puedeVerFinanzas`; lo de administracion (categorias, suscripciones, aprobar), `esAdmin`.
 */
export function puedeCapturarMatriz(rol: string | null | undefined): boolean {
  return rol === 'ADMIN' || rol === 'EMPLEADO_ADMIN'
}

/** Administracion (alta de usuarios, catalogo, categorias, suscripciones, aprobar, ajustes): solo ADMIN. */
export function esAdmin(rol: string | null | undefined): boolean {
  return rol === 'ADMIN'
}

/** ¿Ve la matriz (lotes, inventario)? Mando o empleado administrativo. */
export function veLaMatriz(rol: string | null | undefined): boolean {
  return esRolDeMandoV2(rol) || rol === 'EMPLEADO_ADMIN'
}

/**
 * ¿Ve el dinero de la matriz (finanzas, cuentas, cobranza, cartera, saldos)? ADMIN y SOCIO
 * siempre; EMPLEADO_ADMIN solo con `accesos.permiso_finanzas`. La base le deja leer y escribir
 * finanzas igual (la app movil lo necesita, opcion (a) del plan 2026-11-13): esto es UI y
 * guards de servidor, no un candado de datos.
 */
export function puedeVerFinanzas(
  usuario: { rol: string | null | undefined; permiso_finanzas?: boolean | null } | null | undefined
): boolean {
  if (!usuario) return false
  return esRolDeMandoV2(usuario.rol) || (usuario.rol === 'EMPLEADO_ADMIN' && usuario.permiso_finanzas === true)
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
