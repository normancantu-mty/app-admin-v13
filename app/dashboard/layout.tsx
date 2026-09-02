'use client'

import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useEffect, useState } from 'react'
import ProtectedRoute from '@/components/ProtectedRoute'
import { supabase } from '@/lib/supabase'
import { DateFilterProvider } from '@/components/providers/DateFilterProvider'
import { DashboardSidebar } from '@/components/ui/DashboardSidebar'
import { TopBar } from '@/components/ui/TopBar'

export default function DashboardLayout({
  children,
}: {
  children: ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [userRole, setUserRole] = useState<string | null>(null)
  const [entidadId, setEntidadId] = useState<string | null>(null)
  const [isLoadingRole, setIsLoadingRole] = useState(true)
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [isMobileOpen, setIsMobileOpen] = useState(false)

  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session && session.user.email) {
          const { data: entidad } = await supabase
            .from('entidades')
            .select('id, rol')
            .eq('email', session.user.email)
            .single()
          
          if (entidad) {
            setUserRole(entidad.rol)
            setEntidadId(entidad.id)
            
            if (entidad.rol !== 'ADMIN' && entidad.rol !== 'SOCIO') {
              const protectedPaths = ['/dashboard/finanzas', '/dashboard/inventario', '/dashboard/general']
              const isProtectedPath = protectedPaths.some(path => pathname.includes(path))
              
              if (isProtectedPath) {
                const dest =
                  entidad.rol === 'DST'
                    ? '/dashboard/distribuidores'
                    : `/dashboard/distribuidores/${entidad.id}`
                router.replace(dest)
              }
            }
          }
        }
      } catch (error) {
        console.error('Error fetching user role:', error)
      } finally {
        setIsLoadingRole(false)
      }
    }
    
    fetchUserRole()
  }, [pathname, router])

  useEffect(() => {
    setIsMobileOpen(false)
  }, [pathname])

  const getNavItems = () => {
    if (userRole === 'ADMIN') {
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
        }
      ]
    } else if (userRole === 'SOCIO') {
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
        }
      ]
    } else if (entidadId) {
      if (userRole === 'DST') {
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
    return []
  }

  const navItems = getNavItems()

  return (
    <ProtectedRoute>
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
          navItems={navItems}
          pathname={pathname}
          isLoadingRole={isLoadingRole}
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
    </ProtectedRoute>
  )
}
