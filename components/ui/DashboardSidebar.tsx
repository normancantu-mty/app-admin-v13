'use client'

import Link from 'next/link'

export type DashboardNavItem = {
  href: string
  label: string
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

function navIconFromLabel(label: string): string {
  const trimmed = label.trim()
  const firstToken = trimmed.split(/\s+/)[0] ?? ''
  if (firstToken && /\p{Extended_Pictographic}/u.test(firstToken)) {
    return firstToken
  }
  if (/finanzas/i.test(label)) return '💰'
  if (/inventario/i.test(label)) return '📦'
  if (/distribuidor|directorio|red|locales/i.test(label)) return '👥'
  if (/estado de cuenta/i.test(label)) return '📊'
  if (/catálogo|catalogo|precios/i.test(label)) return '🏷️'
  if (/dashboard general/i.test(label)) return '👁️'
  return '•'
}

function labelWithoutLeadingEmoji(label: string): string {
  return label.replace(/^(\p{Extended_Pictographic}+\s*)+/u, '').trim() || label
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
    const base = 'flex items-center gap-3 transition-colors'
    const layout = isCollapsed
      ? 'justify-center px-2 py-3 md:px-2'
      : 'px-4 py-3 md:px-6'
    const state = isActive
      ? 'bg-blue-50 text-blue-600 font-medium border-r-4 border-blue-600'
      : 'text-gray-700 hover:bg-gray-100 hover:text-blue-600'
    return `${base} ${layout} ${state}`
  }

  return (
    <aside
      className={[
        'fixed inset-y-0 left-0 z-40 flex flex-col bg-white shadow-md transition-all duration-300 ease-in-out',
        'md:relative md:z-auto',
        isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        isCollapsed ? 'md:w-20' : 'md:w-64',
        'w-64'
      ].join(' ')}
      aria-label="Navegación principal"
    >
      <div
        className={[
          'flex shrink-0 items-center border-b border-gray-100 p-4 md:p-6',
          isCollapsed ? 'justify-center md:px-2' : ''
        ].join(' ')}
      >
        {isCollapsed ? (
          <span className="text-xl font-bold text-gray-800" title="Destilado Digital">
            DD
          </span>
        ) : (
          <h2 className="text-xl font-bold leading-tight text-gray-800 md:text-2xl">
            Destilado Digital
          </h2>
        )}
      </div>

      <nav className="mt-2 flex-1 overflow-y-auto md:mt-4">
        {isLoadingRole ? (
          <div
            className={[
              'text-gray-500',
              isCollapsed ? 'px-2 py-3 text-center text-xs' : 'px-6 py-3 text-sm'
            ].join(' ')}
          >
            {isCollapsed ? '…' : 'Cargando...'}
          </div>
        ) : (
          navItems.map((item) => {
            const icon = navIconFromLabel(item.label)
            const textLabel = labelWithoutLeadingEmoji(item.label)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={getLinkClassName(item.href)}
                title={textLabel}
                onClick={onCloseMobile}
              >
                <span className="shrink-0 text-lg leading-none" aria-hidden="true">
                  {icon}
                </span>
                <span className={isCollapsed ? 'hidden' : 'block truncate text-sm'}>
                  {item.label}
                </span>
              </Link>
            )
          })
        )}
      </nav>

      <div className="hidden shrink-0 border-t border-gray-100 p-2 md:block">
        <button
          type="button"
          onClick={onToggleCollapse}
          className={[
            'flex w-full items-center rounded-lg py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900',
            isCollapsed ? 'justify-center px-2' : 'justify-between px-4'
          ].join(' ')}
          aria-expanded={!isCollapsed}
          aria-label={isCollapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
          title={isCollapsed ? 'Expandir menú' : 'Contraer menú'}
        >
          <span className="text-base leading-none" aria-hidden="true">
            {isCollapsed ? '›|' : '‹|'}
          </span>
          {!isCollapsed && <span className="text-xs text-gray-500">Contraer</span>}
        </button>
      </div>
    </aside>
  )
}
