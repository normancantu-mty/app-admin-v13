/**
 * Paridad v2 — lo que pinta `children` cuando la URL es la de un modal y se llego
 * por recarga o enlace directo (navegacion dura): el mismo panel, con el modal
 * encima. Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import { esRutaDelPanel } from '@/lib/v2/rutas'
import { headers } from 'next/headers'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Panel } from './_panel/Panel'

/**
 * Perf 2026-10-30: ¿la pide el router del cliente (navegacion suave o prefetch)
 * DESDE una pantalla de `/panel` (con este layout ya montado), y no es una carga de
 * documento ni una server action? Next quita `RSC` y `Next-Router-State-Tree` de
 * `headers()` (y de `proxy.ts`), asi que se usan las cabeceras que pone el
 * NAVEGADOR: `Sec-Fetch-Dest` es `document` en una carga dura y `empty` en un
 * `fetch()`; `Referer` es la URL en la que esta el usuario. Si falta cualquiera
 * (curl, navegador viejo, politica sin referer) o se viene de fuera de `/panel`
 * (comprobado: desde `/dashboard` el cliente SI usa este slot), se pinta el
 * panel, como antes.
 */
function laPideElRouterDesdeV2(h: Headers): boolean {
  if (h.get('sec-fetch-dest') !== 'empty' || h.has('next-action')) return false
  try {
    const desde = new URL(h.get('referer') ?? '').pathname
    return esRutaDelPanel(desde)
  } catch {
    return false
  }
}

export default async function PanelPorDefecto() {
  await exigirSesionV2()
  // En navegacion suave (abrir un modal desde el panel o desde una pagina) el
  // router del cliente NO usa lo que se pinte en un slot `default`: reusa el
  // segmento que ya estaba activo (node_modules/next/dist/client/components/
  // router-reducer/ppr-navigations.js, `reuseActiveSegmentInDefaultSlot`). Pintar
  // aqui el panel eran ~20 lecturas tiradas que ademas retrasaban CADA modal
  // hasta que terminaba el panel.
  if (laPideElRouterDesdeV2(await headers())) return null
  return <Panel />
}
