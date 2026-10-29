/**
 * Paridad v2 — lo que pinta `children` cuando la URL es la de un modal y se llego
 * por recarga o enlace directo (navegacion dura): el mismo panel, con el modal
 * encima. Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Panel } from './_panel/Panel'

export default async function PanelPorDefecto() {
  await exigirSesionV2()
  return <Panel />
}
