'use client'

import { useState } from 'react'

export default function RecurrenceFields() {
  const [isRecurring, setIsRecurring] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center">
        <input
          type="checkbox"
          id="es_recurrente"
          name="es_recurrente"
          checked={isRecurring}
          onChange={(e) => setIsRecurring(e.target.checked)}
          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
        />
        <label htmlFor="es_recurrente" className="ml-2 block text-sm text-gray-700">
          ¿Gasto Recurrente?
        </label>
      </div>

      {isRecurring && (
        <>
          <div>
            <label htmlFor="frecuencia" className="block text-sm font-medium text-gray-700 mb-2">
              Frecuencia
            </label>
            <select
              id="frecuencia"
              name="frecuencia"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              required
            >
              <option value="MENSUAL">Mensual</option>
              <option value="QUINCENAL">Quincenal</option>
            </select>
          </div>

          <div>
            <label htmlFor="duracion_meses" className="block text-sm font-medium text-gray-700 mb-2">
              Duración (meses)
            </label>
            <input
              type="number"
              id="duracion_meses"
              name="duracion_meses"
              min="1"
              placeholder="Dejar vacío para indefinido"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
        </>
      )}
    </div>
  )
}
