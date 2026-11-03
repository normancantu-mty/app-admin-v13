/**
 * Ruta ESCONDIDA de correcciones del ADMIN (2026-11-03, agente de la ruta admin).
 * Sin enlace en ningun menu: se entra escribiendo `/panel/correcciones`.
 *
 * Puertas: `proxy.ts` rebota sin sesion; este layout y la pagina (en paralelo,
 * por eso los dos) responden 404 a todo rol que no sea ADMIN; la server action y
 * la RPC vuelven a exigir ADMIN.
 */

import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Fresnillo · ERP', robots: { index: false, follow: false } }

export default async function LayoutCorrecciones({ children }: { children: ReactNode }) {
  // Solo ADMIN (SOCIO incluido fuera): 404, la ruta "no existe".
  const usuario = await exigirSesionV2()
  if (usuario.rol !== 'ADMIN') notFound()
  return <>{children}</>
}
