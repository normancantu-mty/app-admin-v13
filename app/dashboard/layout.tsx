/**
 * LA PUERTA DE `/dashboard`, EN EL SERVIDOR — ERP-07.
 *
 * Antes este archivo era `'use client'` y decidia el permiso dentro de un
 * `useEffect`: `supabase.auth.getSession()` en el navegador, la entidad
 * resuelta **por correo**, y un `router.replace` si no cuadraba. Eso no es una
 * puerta. Cuando el `useEffect` corre, el HTML del Server Component y sus datos
 * ya viajaron: el `replace` cambia lo que se VE, no lo que se ENTREGO.
 *
 * Ahora la sesion se resuelve ANTES de renderizar, en dos capas:
 *
 *  1. `proxy.ts` — rebota a `/login` con el cuerpo vacio. Es la puerta.
 *  2. este layout — vuelve a preguntar (defensa en profundidad: si un dia el
 *     `matcher` deja de casar, la puerta sigue cerrada) y ademas resuelve rol y
 *     entidad **por `entidades.auth_id`**, no por correo.
 *
 * Lo de abajo, `<DashboardShell/>`, es `'use client'` y solo dibuja. Ahi ya no
 * se decide ningun permiso: el rol le llega resuelto como prop.
 *
 * POR QUE EL MENU SIGUE DECLARADO AQUI. `tests/menu-lateral.spec.ts` lee las 24
 * etiquetas de ESTE archivo a proposito — una prueba que se escribe sus propios
 * datos de entrada se califica con su propio examen. Moverlas al componente
 * habria dejado esa prueba midiendo cero etiquetas, y en verde.
 */

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { ReactNode } from 'react'
import { getAuthUser, getCurrentUser } from '@/lib/auth-utils'
import { CABECERA_RUTA, destinoPorRol, RUTA_LOGIN } from '@/lib/puerta-dashboard'
import type { DashboardNavItem } from '@/components/ui/DashboardSidebar'
import DashboardShell from '@/components/DashboardShell'

/**
 * La puerta lee cookies: esta pantalla no se puede prerenderizar estatica. Sin
 * esto, Next podria servir un HTML cacheado que nadie vuelve a comprobar.
 */
export const dynamic = 'force-dynamic'

/** El menu de cada rol. El contador de avisos lo pega el cliente (ERP-59). */
function itemsDeMenu(rol: string | null, entidadId: string | null): DashboardNavItem[] {
  if (rol === 'ADMIN') {
    return [
      {
        href: '/dashboard/general',
        label: '👁️ Dashboard General'
      },
      {
        href: '/dashboard/finanzas',
        label: 'Finanzas'
      },
      {
        href: '/dashboard/inventario',
        label: 'Inventario'
      },
      {
        href: '/dashboard/catalogo',
        label: '🏷️ Catálogo / Precios'
      },
      {
        href: '/dashboard/distribuidores',
        label: 'Distribuidores'
      },
      {
        href: '/dashboard/cartera',
        label: '📋 Cartera'
      },
      {
        href: '/dashboard/conteo',
        label: '🔢 Conteo fisico'
      },
      {
        href: '/dashboard/ventas',
        label: '📈 Ventas por mes'
      },
      {
        href: '/dashboard/avisos',
        label: '⚠️ Cola de captura'
      }
    ]
  }

  if (rol === 'SOCIO') {
    return [
      {
        href: '/dashboard/general',
        label: '👁️ Dashboard General'
      },
      {
        href: '/dashboard/finanzas',
        label: '💰 Finanzas'
      },
      {
        href: '/dashboard/inventario',
        label: '📦 Inventario'
      },
      {
        href: '/dashboard/catalogo',
        label: '🏷️ Catálogo / Precios'
      },
      {
        href: '/dashboard/distribuidores',
        label: '👥 Distribuidores'
      },
      {
        href: '/dashboard/cartera',
        label: '📋 Cartera'
      },
      {
        href: '/dashboard/avisos',
        label: '⚠️ Cola de captura'
      }
    ]
  }

  if (!entidadId) return []

  if (rol === 'DST') {
    return [
      {
        href: '/dashboard/distribuidores',
        label: 'Directorio de Red / Mis Locales'
      },
      {
        href: `/dashboard/distribuidores/${entidadId}`,
        label: 'Mi Estado de Cuenta'
      },
      {
        href: '/dashboard/catalogo',
        label: '🏷️ Catálogo / Precios'
      },
      {
        href: '/dashboard/conteo',
        label: '🔢 Conteo fisico'
      },
      {
        href: '/dashboard/ventas',
        label: '📈 Ventas por mes'
      },
      {
        href: '/dashboard/avisos',
        label: '⚠️ Cola de captura'
      }
    ]
  }

  return [
    {
      href: `/dashboard/distribuidores/${entidadId}`,
      label: 'Mi Estado de Cuenta'
    },
    {
      href: '/dashboard/catalogo',
      label: '🏷️ Catálogo / Precios'
    }
  ]
}

export default async function DashboardLayout({
  children
}: {
  children: ReactNode
}) {
  // 1. ¿Hay sesion? Si no, no se pinta nada.
  const usuarioAuth = await getAuthUser()
  if (!usuarioAuth) redirect(RUTA_LOGIN)

  // 2. Rol y entidad, por `auth_id`. Puede venir `null` si la cuenta existe en
  //    `auth` pero no tiene fila en `entidades`: ese caso NO rebota -seria el
  //    bucle login → dashboard → login- y entra con el menu vacio, igual que
  //    antes.
  const usuario = await getCurrentUser()
  const rol = usuario?.rol ?? null
  const entidadId = usuario?.id ?? null

  // 3. Reubicacion por rol, tambien en el servidor. La ruta la pone la
  //    puerta (`proxy.ts`) en una cabecera de peticion; un layout no la recibe como
  //    prop. Si la cabecera faltara, aqui no se reubica y queda el respaldo de
  //    experiencia que hace el cliente.
  const pathname = (await headers()).get(CABECERA_RUTA)
  if (pathname) {
    const destino = destinoPorRol({ rol, entidadId, pathname })
    if (destino) redirect(destino)
  }

  return (
    <DashboardShell navItems={itemsDeMenu(rol, entidadId)} rol={rol} entidadId={entidadId}>
      {children}
    </DashboardShell>
  )
}
