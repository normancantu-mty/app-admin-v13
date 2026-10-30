/**
 * Front v2 — vista de saldos «Individual | Sumado»: lo que comparten el servidor
 * (`VistaSaldos`) y la pildora cliente (`SelectorVista`). Escrito el 2026-10-30
 * por el ejecutor de saldos (lanzado por el Socio).
 */

export type Vista = 'individual' | 'sumado'

export const COOKIE_VISTA = 'v2_vista_saldos'

/** Cualquier valor que no sea 'sumado' es la vista de siempre. */
export function vistaDeCookie(v: string | undefined): Vista {
  return v === 'sumado' ? 'sumado' : 'individual'
}

/** Guarda la eleccion en la cookie que lee `VistaSaldos` (solo en el navegador). Un año; Lax basta. */
export function guardarVista(v: Vista): void {
  document.cookie = `${COOKIE_VISTA}=${v}; path=/; max-age=31536000; samesite=lax`
}
