'use client'

import { useState, useTransition } from 'react'
import { bulkDeleteMovements } from '@/app/actions/audit'
import { useRouter } from 'next/navigation'
import { formatCurrency, formatFechaHoraMX } from '@/lib/utils'

interface MovimientosTableProps {
  movimientos: {
    id: string
    id_cuenta_destino: string | null
    tipo_movimiento: string
    monto: number
    categoria: string
    fecha_movimiento: string
    status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'ANULADO' | 'ACTIVO'
    usuario_creador?: string | null
    cuenta_destino: { nombre: string } | null
    /** Entity that owns or is the beneficiary of this ledger movement. */
    entidad_relacionada?: { nombre: string } | null
  }[]
  sessionEmail?: string | null
  sessionRole?: string | null
}

const PREFIJOS_INGRESO = ['INGRESO_', 'ABONO_', 'COMISION_']
const TIPOS_INGRESO_EXPLICITOS = new Set(['SUBSIDIO_FISCAL'])
const DELETE_WINDOW_HOURS_DST = 24
const DELETE_WINDOW_MINUTES_WORKER = 15

function esIngreso(tipoMovimiento: string): boolean {
  return (
    TIPOS_INGRESO_EXPLICITOS.has(tipoMovimiento) ||
    PREFIJOS_INGRESO.some(prefijo => tipoMovimiento.startsWith(prefijo))
  )
}

function getClaseMonto(tipoMovimiento: string): string {
  if (esIngreso(tipoMovimiento)) return 'text-green-600'
  if (tipoMovimiento.startsWith('EGRESO_') || tipoMovimiento.startsWith('GASTO_') || tipoMovimiento.startsWith('CARGO_')) {
    return 'text-red-600'
  }
  return 'text-gray-600'
}

function getPrefijoMonto(tipoMovimiento: string): string {
  if (esIngreso(tipoMovimiento)) return '+'
  if (tipoMovimiento.startsWith('EGRESO_') || tipoMovimiento.startsWith('GASTO_') || tipoMovimiento.startsWith('CARGO_')) {
    return '-'
  }
  return ''
}

export default function MovimientosTable({ movimientos, sessionEmail, sessionRole }: MovimientosTableProps) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [visibleRows, setVisibleRows] = useState(15)
  const [isPending, startTransition] = useTransition()
  const now = Date.now()

  const canDeleteMovimiento = (movimiento: MovimientosTableProps['movimientos'][number]) => {
    if (movimiento.status === 'ANULADO') return false
    const role = (sessionRole || '').toUpperCase()
    if (role === 'ADMIN') return true
    if (!sessionEmail) return false
    if (movimiento.usuario_creador !== sessionEmail) return false

    const createdAt = new Date(movimiento.fecha_movimiento).getTime()
    if (!Number.isFinite(createdAt)) return false

    if (role === 'DST') {
      const ageHours = (now - createdAt) / (1000 * 60 * 60)
      return ageHours <= DELETE_WINDOW_HOURS_DST
    }

    if (role === 'WORKER' || role === 'TRABAJADOR') {
      const ageMinutes = (now - createdAt) / (1000 * 60)
      return ageMinutes <= DELETE_WINDOW_MINUTES_WORKER
    }

    return true
  }

  const showSelectionColumn = movimientos.some(canDeleteMovimiento)

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return
    
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

  const visibleMovimientos = movimientos.slice(0, visibleRows)

  return (
    <>
      <div className="flex justify-end mb-4">
        {selectedIds.length > 0 && (
          <button
            onClick={handleBulkDelete}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isPending ? 'Anulando...' : `Anular seleccionados (${selectedIds.length})`}
          </button>
        )}
      </div>

      <div className="flex flex-col space-y-4">
        <div className="hidden w-full overflow-x-auto md:block">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
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
                  Asignado A
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Monto
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Creado por
                </th>
                {showSelectionColumn && (
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Anular
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {visibleMovimientos.map((movimiento) => {
                const canDelete = canDeleteMovimiento(movimiento)
                const isAnulado = movimiento.status === 'ANULADO'
                const rowClass = isAnulado ? 'opacity-60 line-through' : ''

                return (
                  <tr key={movimiento.id} className={`hover:bg-gray-50 ${rowClass}`}>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatFechaHoraMX(movimiento.fecha_movimiento)}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900">
                      <div className="font-medium">{movimiento.tipo_movimiento}</div>
                      <div className="text-gray-500 text-xs">{movimiento.categoria}</div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {movimiento.cuenta_destino?.nombre || 'N/A'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {movimiento.entidad_relacionada?.nombre
                        ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-800">
                            {movimiento.entidad_relacionada.nombre}
                          </span>
                        )
                        : <span className="text-gray-400 text-xs">—</span>
                      }
                    </td>
                    <td className={`px-6 py-4 whitespace-nowrap text-sm font-semibold ${getClaseMonto(movimiento.tipo_movimiento)}`}>
                      {getPrefijoMonto(movimiento.tipo_movimiento)}{formatCurrency(movimiento.monto)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {movimiento.usuario_creador?.trim() || '—'}
                    </td>
                    {showSelectionColumn && (
                      <td className="px-6 py-4 whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(movimiento.id)}
                          disabled={!canDelete || isPending}
                          onChange={() => toggleSelectId(movimiento.id)}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                          aria-label={`Anular movimiento ${movimiento.id}`}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-1 gap-4 px-4 md:hidden">
          {visibleMovimientos.map((movimiento) => {
            const canDelete = canDeleteMovimiento(movimiento)
            const isAnulado = movimiento.status === 'ANULADO'
            const cardClass = isAnulado ? 'opacity-60 line-through' : ''

            return (
              <div
                key={movimiento.id}
                className={`space-y-3 rounded-lg bg-white p-4 shadow ${cardClass}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-medium text-gray-500">Fecha y hora</p>
                    <p className="text-sm font-medium text-gray-900">
                      {formatFechaHoraMX(movimiento.fecha_movimiento)}
                    </p>
                  </div>
                  {isAnulado && (
                    <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                      Anulado
                    </span>
                  )}
                </div>

                <div className="space-y-1 text-sm">
                  <p className="text-xs font-medium text-gray-500">Concepto</p>
                  <p className="font-medium text-gray-900">{movimiento.tipo_movimiento}</p>
                  <p>
                    <span className="font-medium text-gray-500">Categoría: </span>
                    <span className="text-gray-700">{movimiento.categoria}</span>
                  </p>
                </div>

                <div className="space-y-2 text-sm">
                  <p>
                    <span className="font-medium text-gray-500">Cuenta: </span>
                    <span className="text-gray-900">{movimiento.cuenta_destino?.nombre || 'N/A'}</span>
                  </p>
                  <p>
                    <span className="font-medium text-gray-500">Asignado A: </span>
                    {movimiento.entidad_relacionada?.nombre ? (
                      <span className="inline-flex rounded bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-800">
                        {movimiento.entidad_relacionada.nombre}
                      </span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </p>
                  <p>
                    <span className="font-medium text-gray-500">Monto: </span>
                    <span className={`font-semibold ${getClaseMonto(movimiento.tipo_movimiento)}`}>
                      {getPrefijoMonto(movimiento.tipo_movimiento)}
                      {formatCurrency(movimiento.monto)}
                    </span>
                  </p>
                  <p>
                    <span className="font-medium text-gray-500">Creado por: </span>
                    <span className="text-gray-700">{movimiento.usuario_creador?.trim() || '—'}</span>
                  </p>
                </div>

                {showSelectionColumn && (
                  <div className="flex items-center gap-2 border-t border-gray-100 pt-3">
                    <input
                      type="checkbox"
                      id={`annul-mobile-${movimiento.id}`}
                      checked={selectedIds.includes(movimiento.id)}
                      disabled={!canDelete || isPending}
                      onChange={() => toggleSelectId(movimiento.id)}
                      className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <label
                      htmlFor={`annul-mobile-${movimiento.id}`}
                      className={`text-sm ${canDelete ? 'text-gray-700' : 'text-gray-400'}`}
                    >
                      Seleccionar para anular
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {visibleRows < movimientos.length && (
          <div className="flex justify-center pb-4">
            <button
              type="button"
              onClick={() => setVisibleRows((prev) => prev + 15)}
              className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100"
            >
              Cargar más...
            </button>
          </div>
        )}
      </div>
    </>
  )
}
