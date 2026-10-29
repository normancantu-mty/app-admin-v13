'use client'
// Paridad v2: copia de app/dashboard/distribuidores/[id]/HistorialActividadTableClient.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { useState, useTransition } from 'react'
import { anularMovimientoFinanzas } from '@/app/actions/audit'
import { annularTicketHistorialDistribuidorAction } from '@/app/actions/distribuidores'
import { formatFechaHoraMX } from '@/lib/utils'

export interface ActividadHistorialRow {
  fecha: string
  tipo: string
  monto: number
  referencia: string
  cuentaContexto?: string
  condicionPago?: 'CONTADO' | 'CONCESION'
  esVentaComoVendedor?: boolean
  movementStatus?: string | null
  policyTimestamp: string | null
  usuario_creador?: string | null
  annulTarget?: { kind: 'LEDGER'; id: string } | { kind: 'TICKET'; id: string }
  annulDisabled?: boolean
  annulDisabledReason?: string
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

export default function HistorialActividadTableClient({
  actividades,
  perfilEntidadId,
  mostrarCreadoPor = false
}: {
  actividades: ActividadHistorialRow[]
  perfilEntidadId: string
  mostrarCreadoPor?: boolean
}) {
  const { refrescar } = useModalV2()
  const [visibleRows, setVisibleRows] = useState(15)
  const [pendingAnnulId, setPendingAnnulId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const normalizeTipo = (tipo: string): string => tipo.replaceAll(' ', '_').toUpperCase()

  const getTipoBadgeClasses = (tipo: string): string => {
    const tipoNormalizado = normalizeTipo(tipo)
    if (tipoNormalizado === 'VENTA') return 'bg-blue-100 text-blue-800'
    if (tipoNormalizado === 'INGRESO_COMISION' || tipoNormalizado === 'ABONO_DEUDA' || tipoNormalizado === 'COMISION_PASIVA') return 'bg-green-100 text-green-800'
    if (tipoNormalizado === 'DEUDA_A_MATRIZ') return 'bg-gray-100 text-gray-700'
    return 'bg-slate-100 text-slate-700'
  }

  const handleAnnular = (row: ActividadHistorialRow) => {
    if ((row.movementStatus ?? 'ACTIVO') === 'ANULADO') return
    if (!row.annulTarget || row.annulDisabled || isPending) return

    const confirmed =
      typeof window !== 'undefined' &&
      window.confirm('¿Anular este movimiento? Se marcará como ANULADO (sin borrar datos).')
    if (!confirmed) return

    setActionError(null)
    const annulKey = row.annulTarget.id
    setPendingAnnulId(annulKey)

    startTransition(async () => {
      try {
        if (row.annulTarget?.kind === 'LEDGER') {
          await anularMovimientoFinanzas(row.annulTarget.id, { perfilEntidadId })
        } else if (row.annulTarget?.kind === 'TICKET') {
          await annularTicketHistorialDistribuidorAction(row.annulTarget.id, perfilEntidadId)
        }
        refrescar()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'No se pudo anular el movimiento.'
        setActionError(msg)
      } finally {
        setPendingAnnulId(null)
      }
    })
  }

  const visibleActividades = actividades.slice(0, visibleRows)

  if (actividades.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <p className="text-gray-500">No hay movimientos registrados.</p>
      </div>
    )
  }

  const getRowMeta = (actividad: ActividadHistorialRow) => {
    const isAnulado = (actividad.movementStatus ?? 'ACTIVO') === 'ANULADO'
    const annulKey =
      actividad.annulTarget?.kind === 'TICKET'
        ? actividad.annulTarget.id
        : actividad.annulTarget?.kind === 'LEDGER'
          ? actividad.annulTarget.id
          : null
    const showAnnul = Boolean(actividad.annulTarget)
    const rowBusy = Boolean(pendingAnnulId && annulKey === pendingAnnulId)
    const fechaDisplay = formatFechaHoraMX(actividad.policyTimestamp ?? actividad.fecha)

    const montoColor =
      normalizeTipo(actividad.tipo) === 'ABONO_DEUDA'
        ? 'text-green-600'
        : normalizeTipo(actividad.tipo) === 'INGRESO_COMISION' || normalizeTipo(actividad.tipo) === 'COMISION_PASIVA'
          ? 'text-green-600'
          : normalizeTipo(actividad.tipo) === 'DEUDA_A_MATRIZ'
            ? 'text-gray-500'
            : actividad.condicionPago === 'CONCESION' && actividad.esVentaComoVendedor
              ? 'text-gray-400'
              : actividad.condicionPago === 'CONCESION'
                ? 'text-red-600'
                : 'text-gray-500'

    const montoText =
      normalizeTipo(actividad.tipo) === 'ABONO_DEUDA'
        ? `-${formatCurrency(actividad.monto)}`
        : normalizeTipo(actividad.tipo) === 'INGRESO_COMISION' || normalizeTipo(actividad.tipo) === 'COMISION_PASIVA'
          ? `+${formatCurrency(actividad.monto)}`
          : normalizeTipo(actividad.tipo) === 'DEUDA_A_MATRIZ'
            ? formatCurrency(actividad.monto)
            : actividad.condicionPago === 'CONCESION'
              ? `+${formatCurrency(actividad.monto)}`
              : formatCurrency(actividad.monto)

    return { isAnulado, annulKey, showAnnul, rowBusy, fechaDisplay, montoColor, montoText }
  }

  return (
    <div>
      {actionError && (
        <div className="px-4 pt-4 md:px-6">
          <p className="text-sm text-red-600">{actionError}</p>
        </div>
      )}

      <div className="hidden w-full overflow-x-auto md:block">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Fecha
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tipo
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Referencia
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Monto
              </th>
              {mostrarCreadoPor && (
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Creado por
                </th>
              )}
              <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider w-24">
                Anular
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {visibleActividades.map((actividad, index) => {
              const { isAnulado, showAnnul, rowBusy, fechaDisplay, montoColor, montoText } =
                getRowMeta(actividad)
              const rowMuted = isAnulado ? 'opacity-50' : ''

              return (
                <tr key={`${actividad.tipo}-${actividad.fecha}-${index}`} className={`hover:bg-gray-50 ${rowMuted}`}>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`text-gray-900 ${isAnulado ? 'line-through text-gray-400' : ''}`}>
                        {fechaDisplay}
                      </span>
                      {isAnulado && (
                        <span className="inline-flex shrink-0 rounded border border-red-200 bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">
                          ANULADO
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm">
                    <span
                      className={`mr-2 inline-flex rounded-full px-2 py-1 text-xs font-semibold ${getTipoBadgeClasses(actividad.tipo)} ${isAnulado ? 'line-through opacity-80' : ''}`}
                    >
                      {actividad.tipo}
                    </span>
                    {normalizeTipo(actividad.tipo) === 'VENTA' && actividad.condicionPago === 'CONTADO' && (
                      <span
                        className={`inline-flex rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 ${isAnulado ? 'line-through' : ''}`}
                      >
                        CONTADO
                      </span>
                    )}
                    {normalizeTipo(actividad.tipo) === 'VENTA' && actividad.condicionPago === 'CONCESION' && (
                      <span
                        className={`inline-flex rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-700 ${isAnulado ? 'line-through' : ''}`}
                      >
                        CONCESION
                      </span>
                    )}
                  </td>
                  <td className={`px-6 py-4 text-sm ${isAnulado ? 'text-gray-400 line-through' : 'text-gray-500'}`}>
                    <div className="whitespace-pre-line">{actividad.referencia}</div>
                    {actividad.cuentaContexto && (
                      <div className="mt-1 text-xs text-gray-400">{actividad.cuentaContexto}</div>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <span className={`${montoColor} ${isAnulado ? 'line-through text-gray-400' : ''}`}>
                      {montoText}
                    </span>
                  </td>
                  {mostrarCreadoPor && (
                    <td className="px-6 py-4 whitespace-nowrap text-xs text-gray-500">
                      {actividad.usuario_creador?.trim() || '—'}
                    </td>
                  )}
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    {showAnnul ? (
                      <button
                        type="button"
                        title={
                          actividad.annulDisabled && actividad.annulDisabledReason
                            ? actividad.annulDisabledReason
                            : 'Anular movimiento'
                        }
                        disabled={Boolean(actividad.annulDisabled) || rowBusy || isPending}
                        onClick={() => handleAnnular(actividad)}
                        className="inline-flex items-center justify-center rounded-md p-2 text-gray-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
                        aria-label="Anular movimiento"
                      >
                        {rowBusy ? '…' : '🗑️'}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-4 px-4 pb-4 md:hidden">
        {visibleActividades.map((actividad, index) => {
          const { isAnulado, showAnnul, rowBusy, fechaDisplay, montoColor, montoText } = getRowMeta(actividad)
          const rowMuted = isAnulado ? 'opacity-50 line-through' : ''

          return (
            <div key={`mobile-${actividad.tipo}-${actividad.fecha}-${index}`} className={`space-y-3 rounded-lg bg-white p-4 shadow ${rowMuted}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium text-gray-500">Fecha y hora</p>
                  <p className="text-sm font-medium text-gray-900">{fechaDisplay}</p>
                </div>
                {isAnulado && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase text-red-700">
                    ANULADO
                  </span>
                )}
              </div>

              <div className="space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-500">Tipo: </span>
                  <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${getTipoBadgeClasses(actividad.tipo)}`}>
                    {actividad.tipo}
                  </span>
                  {normalizeTipo(actividad.tipo) === 'VENTA' && actividad.condicionPago === 'CONTADO' && (
                    <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
                      CONTADO
                    </span>
                  )}
                  {normalizeTipo(actividad.tipo) === 'VENTA' && actividad.condicionPago === 'CONCESION' && (
                    <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">
                      CONCESION
                    </span>
                  )}
                </p>
                <p>
                  <span className="font-medium text-gray-500">Referencia: </span>
                  <span className="whitespace-pre-line text-gray-700">{actividad.referencia}</span>
                </p>
                {actividad.cuentaContexto && (
                  <p>
                    <span className="font-medium text-gray-500">Cuenta: </span>
                    <span className="text-gray-600">{actividad.cuentaContexto}</span>
                  </p>
                )}
                <p>
                  <span className="font-medium text-gray-500">Monto: </span>
                  <span className={`font-semibold ${montoColor}`}>{montoText}</span>
                </p>
                {mostrarCreadoPor && (
                  <p>
                    <span className="font-medium text-gray-500">Creado por: </span>
                    <span className="text-gray-700">{actividad.usuario_creador?.trim() || '—'}</span>
                  </p>
                )}
              </div>

              {showAnnul && (
                <div className="border-t border-gray-100 pt-3">
                  <button
                    type="button"
                    title={
                      actividad.annulDisabled && actividad.annulDisabledReason
                        ? actividad.annulDisabledReason
                        : 'Anular movimiento'
                    }
                    disabled={Boolean(actividad.annulDisabled) || rowBusy || isPending}
                    onClick={() => handleAnnular(actividad)}
                    className="w-full rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-40"
                  >
                    {rowBusy ? 'Anulando…' : 'Anular movimiento'}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {visibleRows < actividades.length && (
        <div className="flex justify-center border-t border-gray-200 bg-gray-50 px-4 py-4 md:px-6">
          <button
            type="button"
            onClick={() => setVisibleRows((prev) => prev + 15)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
          >
            Cargar más...
          </button>
        </div>
      )}
    </div>
  )
}
