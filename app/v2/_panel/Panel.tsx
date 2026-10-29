/**
 * Paridad v2 — el panel unico, segun el rol. Escrito el 2026-10-29 por el ejecutor
 * del Socio. ADMIN y SOCIO ven la matriz; DST, LOC y SUB-ADMIN ven su nodo.
 */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { PanelMando } from './PanelMando'
import { PanelNodo } from './PanelNodo'

export async function Panel() {
  const usuario = await exigirSesionV2()
  return esRolDeMandoV2(usuario.rol) ? <PanelMando /> : <PanelNodo />
}
