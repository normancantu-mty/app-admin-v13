'use client'

import { useDateFilter } from '@/components/providers/DateFilterProvider'

export function TopBar() {
  const { dateRange, setDateRange } = useDateFilter()

  const getDisplayText = () => {
    switch (dateRange) {
      case 'HOY': return 'Hoy'
      case 'ESTE_MES': return 'Este Mes'
      case 'TRIMESTRE': return 'Trimestre'
      case 'PERSONALIZADO': return 'Personalizado'
      default: return 'Este Mes'
    }
  }

  return (
    <div className="bg-white border-b border-gray-200 p-4 flex justify-between items-center">
      <div id="date-filter-display">{getDisplayText()}</div>
      <select
        value={dateRange}
        onChange={(e) => setDateRange(e.target.value as DateRange)}
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
  )
