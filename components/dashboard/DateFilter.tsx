'use client'

import { useState } from 'react'

export default function DateFilter() {
  const [fechaInicio, setFechaInicio] = useState('2026-03-01')
  const [fechaFin, setFechaFin] = useState('2026-03-14')

  const handleAplicar = () => {
    console.log('Aplicar filtro:', { fechaInicio, fechaFin })
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-4">
      <div className="flex items-center gap-4">
        <label className="text-sm font-medium text-gray-700">Período:</label>
        <input 
          type="date" 
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          value={fechaInicio}
          onChange={(e) => setFechaInicio(e.target.value)}
        />
        <span className="text-gray-500">—</span>
        <input 
          type="date" 
          className="px-3 py-2 border border-gray-300 rounded-md text-sm"
          value={fechaFin}
          onChange={(e) => setFechaFin(e.target.value)}
        />
        <button 
          onClick={handleAplicar}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          Aplicar
        </button>
      </div>
    </div>
  )
}
