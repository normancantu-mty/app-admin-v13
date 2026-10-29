/**
 * Front v2 — la puerta de rol de `/v2`, compartida por el layout y CADA pagina.
 * Escrito el 2026-10-29 por el ejecutor de las correcciones del Front v2
 * (lanzado por el Socio).
 *
 * Por que en cada pagina y no solo en el layout: en el App Router el layout y la
 * pagina se renderizan en paralelo, y un layout no envuelve las peticiones RSC de
 * una pagina hija en una navegacion del cliente. La comprobacion del layout sola
 * no garantiza que la pagina no lea ni entregue datos. Cada `page.tsx` de
 * `app/v2` llama a `exigirMandoV2()` antes de leer la base (lo vigila una prueba
 * en `tests/v2-front-dinero.spec.ts`).
 */

import { redirect } from 'next/navigation'
import { getAuthUser, getCurrentUser, type CurrentUser } from '@/lib/auth-utils'
import { RUTA_LOGIN } from '@/lib/puerta-dashboard'
import { esRolDeMandoV2 } from './roles'

/** Sin sesion rebota al login; sin rol de mando (ADMIN o SOCIO), a `/dashboard`. */
export async function exigirMandoV2(): Promise<CurrentUser> {
  const auth = await getAuthUser()
  if (!auth) redirect(RUTA_LOGIN)
  const usuario = await getCurrentUser()
  if (!usuario || !esRolDeMandoV2(usuario.rol)) redirect('/dashboard')
  return usuario
}
