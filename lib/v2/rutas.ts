/**
 * La ruta base del Front v2. Escrito el 2026-10-30 por un ejecutor del Socio
 * (plan lazy-growing-grove, Fase A1): la URL `/v2` pasa a `/panel`.
 *
 * Es la UNICA fuente del segmento: todo enlace, redirect, revalidatePath y
 * prefijo de modal se arma con `RUTA_BASE`. Las URLs viejas `/v2/...` las
 * reenvia `next.config.ts` (redirect permanente) para no romper marcadores.
 * Los imports `@/components/v2` y `@/lib/v2` NO cambian: v2 ahi es la version
 * del codigo, no la URL.
 */
export const RUTA_BASE = '/panel'

/** Prefijo de las rutas interceptadas como modal (`/panel/m/...`). */
export const PREFIJO_MODAL = `${RUTA_BASE}/m/`

/** ¿Esta ruta es la base o cuelga de ella? Compara por segmento: `/panelx` no cuenta. */
export function esRutaDelPanel(ruta: string): boolean {
  return ruta === RUTA_BASE || ruta.startsWith(`${RUTA_BASE}/`)
}
