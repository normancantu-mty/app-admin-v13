'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ReactNode, useEffect, useState } from 'react'
import ProtectedRoute from '@/components/ProtectedRoute'
import { supabase } from '@/lib/supabase'
import { DateFilterProvider } from '@/components/providers/DateFilterProvider'
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

  const getLinkClassName = (href: string) => {
    const isActive = pathname === href
    return `block px-6 py-3 transition-colors ${
      isActive
        ? 'bg-blue-50 text-blue-600 font-medium border-r-4 border-blue-600'
        : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600'
    }`
  }

  return (
    <ProtectedRoute>
      <div className="flex h-screen bg-gray-100">
        {/* Sidebar */}
        <aside className="w-64 bg-white shadow-md">
          <div className="p-6">
            <h2 className="text-2xl font-bold text-gray-800">Destilado Digital</h2>
          </div>
          <nav className="mt-6">
          {isLoadingRole ? (
            <div className="px-6 py-3 text-gray-500">Cargando...</div>
          ) : (
            navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={getLinkClassName(item.href)}
              >
                {item.label}
              </Link>
            ))
          )}
        </nav>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto flex flex-col">
          <DateFilterProvider>
            <TopBar />
            <div className="flex-1 overflow-auto">
              {children}
            </div>
          </DateFilterProvider>
        </main>
      </div>
    </ProtectedRoute>
  )
}
