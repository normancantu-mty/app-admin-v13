'use client'

import { useRouter } from 'next/navigation'

export function TopBar({ initialRango }: { initialRango: string }) {
  const router = useRouter()
  const rango = initialRango

  const getDisplayText = () => {
    switch (rango) {
      case 'HOY': return 'Hoy'
      case 'ESTE_MES': return 'Este Mes'
      case 'TRIMESTRE': return 'Trimestre'
      case 'PERSONALIZADO': return 'Personalizado'
      default: return 'Este Mes'
    }
  }

  const handleChange = (value: string) => {
    document.cookie = `global_rango=${value}; path=/; max-age=2592000`
    router.refresh()
  }

  return (
    <div className="bg-white border-b border-gray-200 p-4 flex justify-between items-center">
      <div id="date-filter-display">{getDisplayText()}</div>
      <select
        value={rango}
        onChange={(e) => handleChange(e.target.value)}
        className="px-3 py-2 border border-gray-300 rounded-md text-sm"
      >
        <option value="HOY">Hoy</option>
        <option value="ESTE_MES">Este Mes</option>
        <option value="TRIMESTRE">Trimestre</option>
        <option value="PERSONALIZADO">Personalizado</option>
      </select>
    </div>
  )
}
