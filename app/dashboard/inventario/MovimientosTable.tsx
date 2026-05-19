'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deleteInventarioMovement } from '@/app/actions/audit'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'

interface MovimientoInventario {
  id: string
  producto_nombre: string
  entidad_nombre?: string
  es_entidad_admin?: boolean
  status?: string | null
  tipo_movimiento: string
  cantidad: number
  fecha_movimiento: string
  usuario_creador?: string | null
}

const DELETE_WINDOW_HOURS_DST = 24
const DELETE_WINDOW_MINUTES_WORKER = 15

function canDeleteMovement(
  movimiento: MovimientoInventario,
  sessionEmail: string | null,
  sessionRole: string | null
): boolean {
  const role = (sessionRole || '').toUpperCase()
  const isAnulado = movimiento.status === 'ANULADO'
  if (role === 'ADMIN') return !isAnulado
  if (!sessionEmail) return false
  if (movimiento.usuario_creador !== sessionEmail) return false
  if (isAnulado) return false

  const createdAt = new Date(movimiento.fecha_movimiento).getTime()
  if (!Number.isFinite(createdAt)) return false

  if (role === 'DST') {
    const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60)
    return ageHours <= DELETE_WINDOW_HOURS_DST
  }

  if (role === 'WORKER' || role === 'TRABAJADOR') {
    const ageMinutes = (Date.now() - createdAt) / (1000 * 60)
    return ageMinutes <= DELETE_WINDOW_MINUTES_WORKER
  }

  return true
}

export default function MovimientosTable({
  movimientos,
  sessionEmail,
  sessionRole,
  canMutate
}: {
  movimientos: MovimientoInventario[]
  sessionEmail: string | null
  sessionRole: string | null
  canMutate: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [visibleRows, setVisibleRows] = useState(15)

  return (
    <div className="flex flex-col space-y-4">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Fecha
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Producto
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Entidad
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tipo Movimiento
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Cantidad
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Creado Por
              </th>
              {canMutate && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Anular
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {movimientos.slice(0, visibleRows).map((mov) => {
              const isAnulado = mov.status === 'ANULADO'
              const esEntrada = isTipoMovimientoEntrada(mov.tipo_movimiento)
              const esSalida = isTipoMovimientoSalida(mov.tipo_movimiento)
              const esMerma = mov.tipo_movimiento === 'MERMA'
              const esDevolucionFisica = mov.tipo_movimiento === 'DEVOLUCION_FISICA'
              const claseTipoMovimiento = esMerma
                ? 'bg-red-100 text-red-800'
                : esDevolucionFisica
                ? 'bg-amber-100 text-amber-800'
                : esEntrada
                ? 'bg-green-100 text-green-800'
                : esSalida
                ? 'bg-red-100 text-red-800'
                : 'bg-gray-100 text-gray-800'
              const canDelete = canDeleteMovement(mov, sessionEmail, sessionRole)
              const rowClass = isAnulado ? 'opacity-60 line-through' : ''

              return (
                <tr key={mov.id} className={`hover:bg-gray-50 ${rowClass}`}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {new Date(mov.fecha_movimiento).toLocaleDateString('es-MX', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric'
                    })}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {mov.producto_nombre}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    {mov.es_entidad_admin ? (
                      <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-slate-100 text-slate-700">
                        {mov.entidad_nombre || 'Admin'}
                      </span>
                    ) : (
                      <span className="text-gray-900">{mov.entidad_nombre || 'Sin entidad'}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${claseTipoMovimiento}`}>
                      {mov.tipo_movimiento}
                    </span>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                    {Number(mov.cantidad).toFixed(4)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {mov.usuario_creador || 'Legacy / Sistema'}
                  </td>
                  {canMutate && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      {canDelete ? (
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() =>
                            startTransition(async () => {
                              try {
                                const result = await deleteInventarioMovement(mov.id)
                                if (!result.success) {
                                  throw new Error('No se pudo anular el movimiento.')
                                }
                                router.refresh()
                              } catch (error) {
                                alert(error instanceof Error ? error.message : 'Error al anular movimiento.')
                              }
                            })
                          }
                          className="px-3 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          Anular
                        </button>
                      ) : (
                        <span className="text-xs text-gray-400">Bloqueado</span>
                      )}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
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
  )
}
