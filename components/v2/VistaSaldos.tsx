/**
 * Front v2 — el selector «Individual | Sumado» del encabezado. Escrito el
 * 2026-10-30 por el ejecutor de saldos (lanzado por el Socio).
 *
 * Componente de SERVIDOR: lee la cookie con la eleccion guardada y pinta la
 * pildora cliente ya en esa posicion, asi el primer HTML trae la vista correcta
 * (sin parpadeo de hidratacion). El cambio de vista es CSS puro; ver
 * `components/v2/saldos/SelectorVista.tsx`.
 */

import { cookies } from 'next/headers'
import { SelectorVista } from './saldos/SelectorVista'
import { COOKIE_VISTA, vistaDeCookie } from './saldos/vista'
import { puedeVerFinanzas } from '@/lib/v2/roles'

/** Solo quien ve el dinero de la matriz (`puedeVerFinanzas`) ve el selector; a un nodo no se le pinta. */
export async function VistaSaldos({ rol, permisoFinanzas }: { rol: string; permisoFinanzas?: boolean }) {
  if (!puedeVerFinanzas({ rol, permiso_finanzas: permisoFinanzas })) return null
  const guardada = (await cookies()).get(COOKIE_VISTA)?.value
  return <SelectorVista inicial={vistaDeCookie(guardada)} />
}
