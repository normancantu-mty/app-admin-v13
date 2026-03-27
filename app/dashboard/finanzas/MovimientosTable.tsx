'use client'

import { useState, useTransition } from 'react'
import { bulkDeleteMovements } from '@/app/actions/audit'
import { useRouter } from 'next/navigation'
import { formatCurrency } from '@/lib/utils'

interface MovimientosTableProps {
  movimientos: {
    id: string
    id_cuenta_destino: string
    tipo_movimiento: string
    monto: number
    categoria: string
    fecha_movimiento: string
    status: 'APPROVED' | 'PENDING' | 'REJECTED'
    cuenta_destino: {
      nombre: string
    } | null
  }[]
  isAdmin: boolean
}

const TIPOS_INGRESO = ['INGRESO_VENTA', 'ABONO_DEUDA']
const TIPOS_EGRESO = ['GASTO_OPERATIVO', 'SUBSIDIO_FISCAL', 'COMISION_PASIVA']

export default function MovimientosTable({ movimientos, isAdmin }: MovimientosTableProps) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0 || !isAdmin) return
    
    startTransition(async () => {
      try {
        const result = await bulkDeleteMovements(selectedIds)
        if (!result.success) throw new Error('Error al borrar registros')
        setSelectedIds([])
        router.refresh()
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Error desconocido')
      }
    })
  }

  const toggleSelectId = (id: string) => {
    setSelectedIds(prev => 
      prev.includes(id) 
        ? prev.filter(i => i !== id) 
        : [...prev, id]
    )
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        {selectedIds.length > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Borrando...' : `Eliminar seleccionados (${selectedIds.length})`}
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {isAdmin && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Seleccionar
                </th>
              )}
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Fecha
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Concepto
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Cuenta
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Monto
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {movimientos.map((movimiento) => {
              const esIngreso = TIPOS_INGRESO.includes(movimiento.tipo_movimiento)
              
              return (
                <tr key={movimiento.id} className="hover:bg-gray-50">
                  {isAdmin && (
                    <td className="px-6 py-4 whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(movimiento.id)}
                        onChange={() => toggleSelectId(movimiento.id)}
                        className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                      />
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {new Date(movimiento.fecha_movimiento).toLocaleDateString('es-MX', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric'
                    })}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    <div className="font-medium">{movimiento.tipo_movimiento}</div>
                    <div className="text-gray-500 text-xs">{movimiento.categoria}</div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {movimiento.cuenta_destino?.nombre || 'N/A'}
                  </td>
                  <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold ${
                    esIngreso ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {esIngreso ? '+' : '-'}{formatCurrency(movimiento.monto)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
