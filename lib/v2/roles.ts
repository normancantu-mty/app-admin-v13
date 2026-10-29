/**
 * Front v2 — quien puede ver `/v2`. Escrito el 2026-10-29 por el ejecutor de las
 * correcciones del Front v2 (lanzado por el Socio). PURO: se prueba en
 * `tests/v2-front-dinero.spec.ts`. La puerta de servidor que lo usa vive en
 * `lib/v2/puerta.ts`.
 */

/** El tablero muestra el dinero de la matriz: solo roles de mando. */
export const ROLES_DE_MANDO_V2 = ['ADMIN', 'SOCIO'] as const

export function esRolDeMandoV2(rol: string | null | undefined): boolean {
  return (ROLES_DE_MANDO_V2 as readonly string[]).includes(rol ?? '')
}
