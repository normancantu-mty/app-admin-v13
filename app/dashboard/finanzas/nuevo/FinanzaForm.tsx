'use client'

import { useState } from 'react'
import RecurrenceFields from './RecurrenceFields'
import Link from 'next/link'
import { CATEGORIAS_INGRESOS, CATEGORIAS_EGRESOS } from '@/lib/catalog-constants'
import { SUBCATEGORIAS } from '@/lib/catalog-constants'

export default function FinanzaForm() {
  const [tipoMovimiento, setTipoMovimiento] = useState<'INGRESO_VENTA' | 'GASTO_OPERATIVO'>('INGRESO_VENTA')
  const [categoria, setCategoria] = useState('Venta_Directa')
  const [monto, setMonto] = useState('')
  const [descripcion, setDescripcion] = useState('')
  const [isLoading, setIsLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const formData = new FormData(e.currentTarget)
      const payload = {
        tipo_movimiento: tipoMovimiento,
        categoria,
        subcategoria: formData.get('subcategoria') || null,
        monto: parseFloat(monto),
        descripcion
      }

      const response = await fetch('/api/finanzas/nuevo', {
        method: 'POST',
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error('Error al guardar el movimiento')
      }

      window.location.href = '/dashboard/finanzas'
    } catch (error) {
      console.error('Error:', error)
      alert('Error al guardar el movimiento')
    } finally {
      setIsLoading(false)
    }
  }

  const categoriasActuales = tipoMovimiento === 'INGRESO_VENTA' ? CATEGORIAS_INGRESOS : CATEGORIAS_EGRESOS
  const subcategoriasActuales = SUBCATEGORIAS[categoria as keyof typeof SUBCATEGORIAS] || []

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Tipo de Movimiento */}
      <div>
        <label htmlFor="tipo_movimiento" className="block text-sm font-medium text-gray-700 mb-2">
          Tipo de Movimiento
        </label>
        <select
          id="tipo_movimiento"
          name="tipo_movimiento"
          value={tipoMovimiento}
          onChange={(e) => {
            const nuevoTipo = e.target.value as 'INGRESO_VENTA' | 'GASTO_OPERATIVO'
            setTipoMovimiento(nuevoTipo)
            setCategoria(nuevoTipo === 'INGRESO_VENTA' ? 'Venta_Directa' : 'Compra_Insumos')
          }}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          <option value="INGRESO_VENTA">💰 Ingreso</option>
          <option value="GASTO_OPERATIVO">💸 Egreso</option>
        </select>
      </div>

      {/* Categoría */}
      <div>
        <label htmlFor="categoria" className="block text-sm font-medium text-gray-700 mb-2">
          Categoría
        </label>
        <select
          id="categoria"
          name="categoria"
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        >
          {categoriasActuales.map(cat => (
            <option key={cat.value} value={cat.value}>
              {cat.label}
            </option>
          ))}
        </select>
      </div>

      {/* Subcategoría (condicional) */}
      {subcategoriasActuales.length > 0 && (
        <div>
          <label htmlFor="subcategoria" className="block text-sm font-medium text-gray-700 mb-2">
            Subcategoría
          </label>
          <select
            id="subcategoria"
            name="subcategoria"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          >
            {subcategoriasActuales.map(sub => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Monto */}
      <div>
        <label htmlFor="monto" className="block text-sm font-medium text-gray-700 mb-2">
          Monto (MXN)
        </label>
        <input
          type="number"
          id="monto"
          name="monto"
          value={monto}
          onChange={(e) => setMonto(e.target.value)}
          step="0.01"
          min="0"
          placeholder="0.00"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          required
        />
      </div>

      {/* Campos de Recurrencia */}
      {tipoMovimiento === 'GASTO_OPERATIVO' && <RecurrenceFields />}

      {/* Descripción */}
      <div>
        <label htmlFor="descripcion" className="block text-sm font-medium text-gray-700 mb-2">
          Descripción (Opcional)
        </label>
        <textarea
          id="descripcion"
          name="descripcion"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
          rows={3}
          placeholder="Añade notas o detalles adicionales..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      {/* Buttons */}
      <div className="flex gap-4 pt-4">
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Guardando...' : 'Guardar Movimiento'}
        </button>
        <Link
          href="/dashboard/finanzas"
          className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-md hover:bg-gray-300 transition-colors text-center"
        >
          Cancelar
        </Link>
      </div>
    </form>
  )
}
