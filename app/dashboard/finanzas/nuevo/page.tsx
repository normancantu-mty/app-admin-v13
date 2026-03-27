'use client'

import { useState, useTransition } from 'react'
import RecurrenceFields from './RecurrenceFields'
import { bulkDeleteMovements } from '@/app/actions/audit'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { requireMutationPermission } from '@/lib/auth-utils'

// Strict Business Categories - Exhaustive List
const CATEGORIAS_INGRESOS = [
  { value: 'Venta_Directa', label: 'Venta Directa' },
  { value: 'Venta_Red_DST', label: 'Venta Red DST' },
  { value: 'Aportacion_Capital', label: 'Aportación Capital' },
  { value: 'Abono_Deuda', label: 'Abono Deuda' }
]

const CATEGORIAS_EGRESOS = [
  { value: 'Compra_Insumos', label: 'Compra Insumos' },
  { value: 'Nomina_y_Honorarios', label: 'Nómina y Honorarios' },
  { value: 'Logistica_Envios', label: 'Logística Envíos' },
  { value: 'Marketing_y_Relaciones', label: 'Marketing y Relaciones' },
  { value: 'Servicios_Basicos', label: 'Servicios Básicos' },
  { value: 'Fuga_Fiscal_IVA', label: 'Fuga Fiscal IVA' },
  { value: 'Fuga_Fiscal_IEPS', label: 'Fuga Fiscal IEPS' },
  { value: 'Gastos_Personales_Socio', label: 'Gastos Personales Socio' },
  { value: 'Ajuste_Caja', label: 'Ajuste Caja' }
]

export default function NuevoMovimientoPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [tipoMovimiento, setTipoMovimiento] = useState('ingreso')
  const [categoria, setCategoria] = useState('Venta_Directa')
  const [monto, setMonto] = useState('')
  const [tieneMarbete, setTieneMarbete] = useState(false)
  const [descripcion, setDescripcion] = useState('')

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      // Check if user has mutation permission (not SOCIO)
      await requireMutationPermission()

      const { error } = await supabase
        .from('finanzas_ledger')
        .insert({
          tipo_movimiento: tipoMovimiento,
          categoria: categoria,
          monto: parseFloat(monto),
          tiene_marbete: tieneMarbete,
          descripcion: descripcion
        })

      if (error) {
        console.error('Error inserting transaction:', error)
        const errorMessage = `Error: ${error.message}${error.details ? `\nDetalles: ${error.details}` : ''}`
        alert(errorMessage)
        return
      }

      router.push('/dashboard/finanzas')
      router.refresh()
    } catch (error: unknown) {
      let errorMessage = 'Error al guardar el movimiento. Inténtalo de nuevo.'
      if (error instanceof Error) {
        errorMessage = error.message
      } else if (typeof error === 'string') {
        errorMessage = error
      }
      console.error('Error in handleSubmit:', error)
      alert(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <Link 
            href="/dashboard/finanzas"
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver a Finanzas
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Nuevo Movimiento Financiero</h1>
        </div>

        {/* Form Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
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
                  setTipoMovimiento(e.target.value)
                  // Reset categoria to first option when tipo changes
                  setCategoria(e.target.value === 'ingreso' ? 'Venta_Directa' : 'Compra_Insumos')
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                required
              >
                <option value="ingreso">💰 Ingreso</option>
                <option value="egreso">💸 Egreso</option>
              </select>
            </div>

            {/* Categoría - Strict Business Categories */}
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
                {tipoMovimiento === 'ingreso' ? (
                  <optgroup label="💰 INGRESOS">
                    {CATEGORIAS_INGRESOS.map(cat => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  <optgroup label="💸 EGRESOS">
                    {CATEGORIAS_EGRESOS.map(cat => (
                      <option key={cat.value} value={cat.value}>
                        {cat.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>

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

            {/* ¿Tiene Marbete? */}
            <div className="flex items-center">
              <input
                type="checkbox"
                id="tiene_marbete"
                name="tiene_marbete"
                checked={tieneMarbete}
                onChange={(e) => setTieneMarbete(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="tiene_marbete" className="ml-2 block text-sm text-gray-700">
                ¿Tiene Marbete?
              </label>
            </div>

            {/* Campos de Recurrencia */}
            {tipoMovimiento === 'egreso' && <RecurrenceFields />}

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
        </div>
      </div>
    </div>
  )
}
