'use client'

import Link from 'next/link'
import { filaDeMenu } from '@/lib/nav-menu'

export type DashboardNavItem = {
  href: string
  label: string
  /**
   * Contador rojo a la derecha del renglon. Hoy solo lo usa la cola de captura
   * (ERP-59): un aviso que nadie ve no sirve de nada, y esconderlo detras de un
   * clic es lo mismo que no tenerlo. `0` o ausente no dibuja nada.
   */
  badge?: number
}

type DashboardSidebarProps = {
  navItems: DashboardNavItem[]
  pathname: string
  isLoadingRole: boolean
  isCollapsed: boolean
  isMobileOpen: boolean
  onToggleCollapse: () => void
  onCloseMobile: () => void
}

export function DashboardSidebar({
  navItems,
  pathname,
  isLoadingRole,
  isCollapsed,
  isMobileOpen,
  onToggleCollapse,
  onCloseMobile
}: DashboardSidebarProps) {
  const getLinkClassName = (href: string) => {
    const isActive = pathname === href
    const base = 'relative flex items-center gap-3 transition-colors'
    const layout = isCollapsed
      ? 'justify-center px-2 py-3 md:px-2'
      : 'px-4 py-3 md:px-6'
    const state = isActive
      ? 'bg-blue-50 text-blue-600 font-medium border-r-4 border-blue-600 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-500'
      : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-blue-300'
    return `${base} ${layout} ${state}`
  }

  return (
    <aside
      className={[
        'fixed inset-y-0 left-0 z-40 flex flex-col bg-white shadow-md transition-all duration-300 ease-in-out dark:bg-gray-900 dark:shadow-gray-950/50',
        'md:relative md:z-auto',
        isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        isCollapsed ? 'md:w-20' : 'md:w-64',
        'w-64'
      ].join(' ')}
      aria-label="Navegación principal"
    >
      <div
        className={[
          'flex shrink-0 items-center border-b border-gray-100 p-4 dark:border-gray-800 md:p-6',
          isCollapsed ? 'justify-center md:px-2' : ''
        ].join(' ')}
      >
        {isCollapsed ? (
          <span className="text-xl font-bold text-gray-800 dark:text-gray-100" title="Destilado Digital">
            DD
          </span>
        ) : (
          <h2 className="text-xl font-bold leading-tight text-gray-800 dark:text-gray-100 md:text-2xl">
            Destilado Digital
          </h2>
        )}
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto md:mt-4">
        {isLoadingRole ? (
          <div
            className={[
              'text-gray-500 dark:text-gray-400',
              isCollapsed ? 'px-2 py-3 text-center text-xs' : 'px-6 py-3 text-sm'
            ].join(' ')}
          >
            {isCollapsed ? '…' : 'Cargando...'}
          </div>
        ) : (
          navItems.map((item) => {
            // Las dos mitades salen de `lib/nav-menu.ts`, que es donde se
            // pueden probar sin navegador. Ver tests/menu-lateral.spec.ts.
            const { icono, texto } = filaDeMenu(item.label)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={getLinkClassName(item.href)}
                title={texto}
                onClick={onCloseMobile}
              >
                <span className="shrink-0 text-lg leading-none" aria-hidden="true">
                  {icono}
                </span>
                {/* `texto`, NUNCA `item.label`: el icono de arriba ya pinto ese
                    mismo emoji. Aqui iba item.label y por eso cada renglon salia
                    con el emoji doble -- menos Finanzas, Inventario y
                    Distribuidores, las unicas tres etiquetas del bloque ADMIN
                    que no empiezan con emoji. El centinela que lo impide de
                    vuelta es tests/menu-lateral.spec.ts, que lee las etiquetas
                    REALES de app/dashboard/layout.tsx. */}
                <span className={isCollapsed ? 'hidden' : 'block truncate text-sm'}>
                  {texto}
                </span>
                {item.badge ? (
                  <span
                    className={[
                      'shrink-0 rounded-full bg-red-600 text-center text-xs font-bold leading-none text-white',
                      isCollapsed
                        ? 'absolute right-1 top-1 min-w-[1.15rem] px-1 py-0.5'
                        : 'ml-auto min-w-[1.5rem] px-2 py-1'
                    ].join(' ')}
                    aria-label={`${item.badge} aviso(s) abierto(s)`}
                  >
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                ) : null}
              </Link>
            )
          })
        )}
      </nav>

      <div className="hidden shrink-0 border-t border-gray-100 p-2 dark:border-gray-800 md:block">
        <button
          type="button"
          onClick={onToggleCollapse}
          className={[
            'flex w-full items-center rounded-lg py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100',
            isCollapsed ? 'justify-center px-2' : 'justify-between px-4'
          ].join(' ')}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
          title={isCollapsed ? 'Expandir menú' : 'Contraer menú'}
        >
          <span className="text-base leading-none" aria-hidden="true">
            {isCollapsed ? '›|' : '‹|'}
          </span>
          {!isCollapsed && <span className="text-xs text-gray-500 dark:text-gray-400">Contraer</span>}
        </button>
      </div>
    </aside>
  )
}
