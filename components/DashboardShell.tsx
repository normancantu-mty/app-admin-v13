'use client'

/**
 * EL CASCARON DEL TABLERO — solo dibuja. ERP-07.
 *
 * Es lo que quedo de `app/dashboard/layout.tsx` cuando la puerta se fue al
 * servidor: barra lateral, barra de arriba, el menu movil y el contador de la
 * cola. **Aqui ya no se decide ningun permiso.** `rol` y `entidadId` llegan
 * resueltos como props, desde el servidor y por `entidades.auth_id`.
 *
 * QUE SE FUE Y POR QUE
 *
 *  · El `useEffect` que pedia la sesion al navegador: lo hace `proxy.ts`
 *    antes de renderizar. Ver `lib/puerta-dashboard.ts`.
 *  · `<ProtectedRoute>`: comprobaba lo mismo una tercera vez y pintaba
 *    "Verificando sesión..." en cada carga. Con la puerta en el servidor, un
 *    usuario sin sesion ya no llega hasta aqui; y si llegara, no habria nada
 *    que esconder porque el layout de servidor ya redirigio.
 *  · `isLoadingRole`: el rol llega en el primer render. Ya no hay un estado
 *    intermedio en el que el menu no sabe quien eres.
 *
 * LO QUE SE QUEDO, Y ES EXPERIENCIA, NUNCA PERMISO: la reubicacion por rol
 * cuando el servidor no la hizo (ver `destinoPorRol`). El servidor la decide
 * primero; esto solo evita que una navegacion del lado del cliente deje al
 * usuario mirando una pantalla que el servidor le habria negado.
 */

import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { DateFilterProvider } from '@/components/providers/DateFilterProvider'
import { DashboardSidebar, type DashboardNavItem } from '@/components/ui/DashboardSidebar'
import { TopBar } from '@/components/ui/TopBar'
import { destinoPorRol } from '@/lib/puerta-dashboard'

/** El unico renglon que lleva contador hoy (ERP-59). */
const HREF_AVISOS = '/dashboard/avisos'

type DashboardShellProps = {
  navItems: DashboardNavItem[]
  rol: string | null
  entidadId: string | null
  children: ReactNode
}

export default function DashboardShell({
  navItems,
  rol,
  entidadId,
  children
}: DashboardShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  // ERP-59. El contador de la cola de captura. Se cuenta desde el cliente
  // porque este componente ya es de navegador y el RLS hace el acotado solo:
  // un DST cuenta los suyos, un ADMIN los de todos. Si falla, se queda en 0 y
  // el menu se ve sin contador -- nunca revienta la navegacion.
  const [avisosAbiertos, setAvisosAbiertos] = useState(0)

  useEffect(() => {
    const contarAvisos = async () => {
      const { count, error } = await supabase
        .from('avisos_captura')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'ABIERTO')

      // `console.error` y no `alert`: es una lectura de fondo al montar. Un
      // alert aqui congela la UI (LECCIONES_DE_GUERRA).
      if (error) {
        console.error('[avisos] No se pudo contar la cola:', error.message)
        return
      }
      setAvisosAbiertos(count ?? 0)
    }

    contarAvisos()
  }, [pathname])

  useEffect(() => {
    setIsMobileOpen(false)
  }, [pathname])

  // RESPALDO DE EXPERIENCIA, NO DE PERMISO. La decision ya la tomo el servidor
  // en `app/dashboard/layout.tsx`; esto solo cubre la navegacion del lado del
  // cliente. Si esta linea desapareciera, la puerta seguiria cerrada.
  useEffect(() => {
    const destino = destinoPorRol({ rol, entidadId, pathname })
    if (destino) router.replace(destino)
  }, [rol, entidadId, pathname, router])

  const items = navItems.map((item) =>
    item.href === HREF_AVISOS ? { ...item, badge: avisosAbiertos } : item
  )

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-950">
      {isMobileOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          aria-label="Cerrar menú de navegación"
          onClick={() => setIsMobileOpen(false)}
        />
      ) : null}

      <DashboardSidebar
        navItems={items}
        pathname={pathname}
        isLoadingRole={false}
        isCollapsed={isCollapsed}
        isMobileOpen={isMobileOpen}
        onToggleCollapse={() => setIsCollapsed((prev) => !prev)}
        onCloseMobile={() => setIsMobileOpen(false)}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        <DateFilterProvider>
          <TopBar onMenuClick={() => setIsMobileOpen(true)} />
          <div className="flex-1 overflow-auto">{children}</div>
        </DateFilterProvider>
      </main>
    </div>
  )
}
