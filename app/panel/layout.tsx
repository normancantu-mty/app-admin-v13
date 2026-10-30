/**
 * Front v2 — la puerta y el marco de `/panel`. Escrito el 2026-10-29 por el ejecutor
 * del Front v2; reescrito el 2026-10-29 por el ejecutor de paridad (Socio).
 *
 * UN SOLO PANEL: no hay menu. `children` es el panel (page.tsx / default.tsx) y
 * `modal` es el slot paralelo `@modal`, donde se abre TODO lo demas
 * (rutas `/panel/m/...`). La puerta es doble: `proxy.ts` rebota sin sesion y este
 * layout exige una sesion con entidad (`exigirSesionV2`). Lo que pinta el panel
 * depende del rol (mando ADMIN/SOCIO o nodo DST/LOC); cada pagina y cada modal
 * vuelve a preguntar.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import type { ReactNode } from 'react'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { ProveedorModal } from '@/components/v2/modal/ProveedorModal'
import { SesionMenu, TemaSelector } from '@/components/v2/Marco'
import { PrivacidadV2 } from '@/components/v2/Privacidad'
import { VistaSaldos } from '@/components/v2/VistaSaldos'
import './v2.css'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Fresnillo · ERP' }

export default async function LayoutV2({ children, modal }: { children: ReactNode; modal: ReactNode }) {
  const usuario = await exigirSesionV2()

  return (
    <div className="v2">
      <ProveedorModal>
        <header className="top">
          <div className="top-in">
            <a href={RUTA_BASE} className="marca">
              <span className="logo">F</span>
              <span>
                <b>Fresnillo</b>
                <small>Destilado de chile</small>
              </span>
            </a>
            <div className="der">
              <SesionMenu nombre={usuario.nombre} rol={usuario.rol} />
              <VistaSaldos rol={usuario.rol} />
              <PrivacidadV2 />
              <TemaSelector />
            </div>
          </div>
        </header>
        <div className="wrap panel">{children}</div>
        {modal}
        <div id="v2-portal" />
      </ProveedorModal>
    </div>
  )
}
