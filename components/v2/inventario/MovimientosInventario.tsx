'use client'
// Paridad v2: copia de app/dashboard/inventario/MovimientosTable.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useState, useTransition } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { deleteInventarioMovement } from '@/app/actions/audit'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import { formatFechaHoraMX } from '@/lib/utils'
import { VENTANA_EDICION_MS } from '@/lib/constants'

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

  // Espejo exacto de `assertAnnullmentAllowed` en `app/actions/audit.ts`.
  return Date.now() - createdAt <= VENTANA_EDICION_MS
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
  const { refrescar } = useModalV2()
  const [isPending, startTransition] = useTransition()
  const [visibleRows, setVisibleRows] = useState(15)

  const visibleMovimientos = movimientos.slice(0, visibleRows)

  const getClaseTipoMovimiento = (tipo: string) => {
    const esEntrada = isTipoMovimientoEntrada(tipo)
    const esSalida = isTipoMovimientoSalida(tipo)
    const esMerma = tipo === 'MERMA'
    const esDevolucionFisica = tipo === 'DEVOLUCION_FISICA'
    if (esMerma) return 'bg-red-100 text-red-800'
    if (esDevolucionFisica) return 'bg-amber-100 text-amber-800'
    if (esEntrada) return 'bg-green-100 text-green-800'
    if (esSalida) return 'bg-red-100 text-red-800'
    return 'bg-gray-100 text-gray-800'
  }

  return (
    <div className="flex flex-col space-y-4">
      <div className="hidden w-full overflow-x-auto md:block">
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
            {visibleMovimientos.map((mov) => {
              const isAnulado = mov.status === 'ANULADO'
              const claseTipoMovimiento = getClaseTipoMovimiento(mov.tipo_movimiento)
              const canDelete = canDeleteMovement(mov, sessionEmail, sessionRole)
              const rowClass = isAnulado ? 'opacity-60 line-through' : ''

              return (
                <tr key={mov.id} className={`hover:bg-gray-50 ${rowClass}`}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {formatFechaHoraMX(mov.fecha_movimiento)}
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
                                refrescar()
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

      <div className="grid grid-cols-1 gap-4 px-4 md:hidden">
        {visibleMovimientos.map((mov) => {
          const isAnulado = mov.status === 'ANULADO'
          const claseTipoMovimiento = getClaseTipoMovimiento(mov.tipo_movimiento)
          const canDelete = canDeleteMovement(mov, sessionEmail, sessionRole)
          const cardClass = isAnulado ? 'opacity-60 line-through' : ''

          return (
            <div
              key={mov.id}
              className={`space-y-3 rounded-lg bg-white p-4 shadow ${cardClass}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-gray-500">Fecha y hora</p>
                  <p className="text-sm font-medium text-gray-900">{formatFechaHoraMX(mov.fecha_movimiento)}</p>
                </div>
                {isAnulado && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                    Anulado
                  </span>
                )}
              </div>

              <div className="space-y-2 text-sm">
                <p>
                  <span className="font-medium text-gray-500">Producto: </span>
                  <span className="text-gray-900">{mov.producto_nombre}</span>
                </p>
                <p>
                  <span className="font-medium text-gray-500">Entidad: </span>
                  {mov.es_entidad_admin ? (
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                      {mov.entidad_nombre || 'Admin'}
                    </span>
                  ) : (
                    <span className="text-gray-900">{mov.entidad_nombre || 'Sin entidad'}</span>
                  )}
                </p>
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-500">Tipo Movimiento: </span>
                  <span
                    className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${claseTipoMovimiento}`}
                  >
                    {mov.tipo_movimiento}
                  </span>
                </p>
                <p>
                  <span className="font-medium text-gray-500">Cantidad: </span>
                  <span className="font-semibold text-gray-900">{Number(mov.cantidad).toFixed(4)}</span>
                </p>
                <p>
                  <span className="font-medium text-gray-500">Creado por: </span>
                  <span className="text-gray-700">{mov.usuario_creador || 'Legacy / Sistema'}</span>
                </p>
              </div>

              {canMutate && (
                <div className="border-t border-gray-100 pt-3">
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
                            refrescar()
                          } catch (error) {
                            alert(
                              error instanceof Error ? error.message : 'Error al anular movimiento.'
                            )
                          }
                        })
                      }
                      className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      Anular
                    </button>
                  ) : (
                    <p className="text-center text-xs text-gray-400">Anulación bloqueada</p>
                  )}
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
  )
}
