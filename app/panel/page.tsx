/**
 * Paridad v2 — `/panel`: el panel unico. Escrito el 2026-10-29 por el ejecutor del Socio.
 * `searchParams.act` (lo pone un modal tras guardar) hace la URL distinta y obliga
 * a leer de nuevo las cifras.
 */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Panel } from './_panel/Panel'

export const dynamic = 'force-dynamic'

export default async function InicioV2() {
  await exigirSesionV2()
  return <Panel />
}
