'use client'

import { ThemeToggle } from '@/components/ui/ThemeToggle'
import { PrivacidadToggle } from '@/components/ui/PrivacidadToggle'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

type TopBarProps = {
  onMenuClick?: () => void
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const router = useRouter()
  const [rango, setRango] = useState('ESTE_MES')

  useEffect(() => {
    const match = document.cookie.match(new RegExp('(^| )global_rango=([^;]+)'))
    if (match) setRango(match[2])
  }, [])

  const getDisplayText = () => {
    switch (rango) {
      case 'HOY': return 'Hoy'
      case 'ESTE_MES': return 'Este Mes'
      case 'TRIMESTRE': return 'Trimestre'
      case 'PERSONALIZADO': return 'Personalizado'
      case 'TODO': return 'Histórico Completo'
      default: return 'Este Mes'
    }
  }

  const handleChange = (value: string) => {
    setRango(value)
    document.cookie = `global_rango=${value}; path=/; max-age=2592000`
    router.refresh()
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          onClick={onMenuClick}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-xl text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800 md:hidden"
          aria-label="Abrir menú de navegación"
        >
          ☰
        </button>
        <div id="date-filter-display" className="truncate text-sm font-medium text-gray-800 dark:text-gray-100 sm:text-base">
          {getDisplayText()}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <PrivacidadToggle />
        <ThemeToggle />
        <select
          value={rango}
          onChange={(e) => handleChange(e.target.value)}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
        >
          <option value="HOY">Hoy</option>
          <option value="ESTE_MES">Este Mes</option>
          <option value="TRIMESTRE">Trimestre</option>
          <option value="PERSONALIZADO">Personalizado</option>
          <option value="TODO">Histórico Completo</option>
        </select>
      </div>
    </div>
  )
}
