/**
 * Front v2 — la puerta y el marco de `/v2`. Escrito el 2026-10-29 por el ejecutor
 * del Front v2 (lanzado por el Socio).
 *
 * Rutas NUEVAS a proposito: no tocan `/dashboard/*` (pantallas actuales) ni el
 * `/dashboard/panel` del rediseño de Cristian. La puerta es doble, igual que en
 * `/dashboard`: `proxy.ts` rebota sin sesion (`/v2` esta en RUTAS_PROTEGIDAS) y
 * este layout vuelve a preguntar y ademas exige rol de mando (ADMIN o SOCIO):
 * el tablero muestra el dinero de la matriz. La misma comprobacion
 * (`exigirMandoV2`, lib/v2/puerta.ts) se repite en CADA pagina.
 */

import type { ReactNode } from 'react'
import { headers } from 'next/headers'
import Link from 'next/link'
import { CABECERA_RUTA } from '@/lib/puerta-dashboard'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import './v2.css'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Fresnillo · ERP v2' }

const NAV = [
  { href: '/v2', label: 'Inicio' },
  { href: '/v2/cartera', label: 'Cartera' },
  { href: '/v2/cuenta/efectivo', label: 'Cuentas', prefijo: '/v2/cuenta' }
]

export default async function LayoutV2({ children }: { children: ReactNode }) {
  const usuario = await exigirMandoV2()

  const ruta = (await headers()).get(CABECERA_RUTA) ?? '/v2'

  return (
    <div className="v2">
      <header className="top">
        <div className="top-in">
          <Link href="/v2" className="marca">
            <span className="logo">F</span>
            <span>
              <b>Fresnillo</b>
              <small>Destilado de chile</small>
            </span>
          </Link>
          <nav className="nav">
            {NAV.map((n) => {
              const on = n.prefijo ? ruta.startsWith(n.prefijo) : ruta === n.href
              return (
                <Link key={n.href} href={n.href} className={on ? 'on' : ''}>
                  {n.label}
                </Link>
              )
            })}
          </nav>
          <div className="der">
            <span>
              {usuario.nombre} · {usuario.rol}
            </span>
            <Link href="/dashboard/general">ERP actual</Link>
          </div>
        </div>
      </header>
      <div className="wrap">{children}</div>
    </div>
  )
}
