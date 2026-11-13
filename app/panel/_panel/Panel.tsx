/**
 * Paridad v2 — el panel unico, segun el rol. Escrito el 2026-10-29 por el ejecutor
 * del Socio. ADMIN y SOCIO ven la matriz; DST, LOC y SUB-ADMIN ven su nodo.
 * EMPLEADO_ADMIN (2026-11-13): con permiso de finanzas, el de la matriz; sin el,
 * `PanelOperador` (captura operativa, sin dinero).
 */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeVerFinanzas } from '@/lib/v2/roles'
import { PanelMando } from './PanelMando'
import { PanelNodo } from './PanelNodo'
import { PanelOperador } from './PanelOperador'

export async function Panel() {
  const usuario = await exigirSesionV2()
  if (puedeVerFinanzas(usuario)) return <PanelMando />
  return usuario.rol === 'EMPLEADO_ADMIN' ? <PanelOperador /> : <PanelNodo />
}
