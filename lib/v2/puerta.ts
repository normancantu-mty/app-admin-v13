/**
 * Front v2 — las puertas de `/v2`, compartidas por el layout, el panel y CADA
 * modal. Escrito el 2026-10-29 por el ejecutor de las correcciones del Front v2;
 * reescrito el 2026-10-29 por el ejecutor de la paridad v2 (un solo panel para
 * todos los roles).
 *
 * Por que en cada pagina y no solo en el layout: en el App Router el layout y la
 * pagina se renderizan en paralelo, y un layout no envuelve las peticiones RSC de
 * una pagina hija en una navegacion del cliente. Cada `page.tsx`/`default.tsx`
 * de `app/v2` llama a `exigirSesionV2()` o `exigirMandoV2()` antes de leer la
 * base (lo vigila `tests/v2-front-dinero.spec.ts`).
 *
 * `cache` (React): layout, panel y modal corren en la MISMA peticion y comparten
 * el resultado: 1 getUser + 1 select por peticion en el camino feliz (A4 del
 * diagnostico de lentitud).
 */

import { cache } from 'react'
import { notFound, redirect } from 'next/navigation'
import { getAuthUser, getCurrentUser, type CurrentUser } from '@/lib/auth-utils'
import { RUTA_LOGIN } from '@/lib/puerta-dashboard'
import { esRolDeMandoV2 } from './roles'

/** Cualquier rol con entidad. Sin sesion, al login; con sesion pero sin entidad, 404. */
export const exigirSesionV2 = cache(async (): Promise<CurrentUser> => {
  const usuario = await getCurrentUser()
  if (usuario) return usuario
  // Camino raro: distinguir "sin sesion" (login) de "sesion sin entidad".
  const auth = await getAuthUser()
  if (!auth) redirect(RUTA_LOGIN)
  notFound()
})

/** Solo ADMIN y SOCIO (el dinero de la matriz). Otro rol vuelve a su panel. */
export const exigirMandoV2 = cache(async (): Promise<CurrentUser> => {
  const usuario = await exigirSesionV2()
  if (!esRolDeMandoV2(usuario.rol)) redirect('/v2')
  return usuario
})
