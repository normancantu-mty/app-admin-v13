'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface PendingApproval {
  id: string
  fecha_movimiento: string
  monto: number
  categoria_gasto: string | null
  entidad_relacionada: { nombre: string } | null
  cuenta_destino: { nombre: string } | null
}

export interface FiscalLeakResult {
  montoBase: number
  ieps: number
  iva: number
  gastoOperativo: number
}

export function calculateFiscalLeak(
  monto: number,
  tipoCuentaDestino: TipoCuentaDestino
): FiscalLeakResult {
  let base: number
  let ieps: number
  let iva: number
  let gastoOperativo = 0

  switch(tipoCuentaDestino) {
    case 'CUENTA_FRESNILLO':
      base = monto / FACTOR_FRESNILLO
      ieps = base * TASA_IEPS
      iva = (base + ieps) * TASA_IVA
      break
    case 'CUENTA_PERSONAL':
      base = monto / (1 + TASA_IVA)
      ieps = 0
      iva = base * TASA_IVA
      break
    case 'EFECTIVO':
      base = monto
      ieps = 0
      iva = 0
      // Fuga fiscal: empresa absorbe el IVA
      gastoOperativo = monto * TASA_IVA / (1 + TASA_IVA)
  }

  return {
    montoBase: parseFloat(base.toFixed(2)),
    ieps: parseFloat(ieps.toFixed(2)),
    iva: parseFloat(iva.toFixed(2)),
    gastoOperativo: parseFloat(gastoOperativo.toFixed(2))
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

export default function PendingApprovalsPanel() {
  const router = useRouter()
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [processingId, setProcessingId] = useState<string | null>(null)

  const loadApprovals = async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/finanzas/aprobaciones', { method: 'GET' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data?.error || 'No se pudieron cargar los pendientes.')
        setApprovals([])
        return
      }

      const data = await res.json()
      setApprovals(data?.approvals || [])
    } catch {
      alert('Error de red al cargar pendientes.')
      setApprovals([])
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadApprovals()
  }, [])

  const currentUser = useCurrentUser()
  const isSubAdmin = currentUser?.rol === 'SUB-ADMIN'

  const onAction = async (id: string, action: 'APPROVE' | 'REJECT') => {
    if (isSubAdmin) return
    
    setProcessingId(id)
    try {
      const res = await fetch('/api/finanzas/aprobaciones', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action })
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data?.error || 'No se pudo procesar la acción.')
        return
      }

      await loadApprovals()
      router.refresh()
    } catch {
      alert('Error de red al procesar la solicitud.')
    } finally {
      setProcessingId(null)
    }
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg shadow-sm">
      <div className="px-6 py-4 border-b border-amber-200">
        <h2 className="text-lg font-semibold text-amber-900">Abonos por Aprobar</h2>
        <p className="text-sm text-amber-700 mt-1">
          Estos abonos no impactan balance hasta ser aprobados.
        </p>
      </div>

      {isLoading ? (
        <div className="px-6 py-6 text-sm text-amber-800">
          Cargando abonos pendientes...
        </div>
      ) : approvals.length === 0 ? (
        <div className="px-6 py-6 text-sm text-amber-800">
          No hay abonos pendientes en este momento.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-amber-200">
            <thead className="bg-amber-100/60">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Fecha
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Distribuidor
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Cuenta Destino
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Referencia
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Monto
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium text-amber-800 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-amber-100">
              {approvals.map((item) => (
                <tr key={item.id} className="hover:bg-amber-50/60">
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {new Date(item.fecha_movimiento).toLocaleDateString('es-MX', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric'
                    })}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-900">
                    {item.entidad_relacionada?.nombre || 'Sin entidad'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {item.cuenta_destino?.nombre || 'N/A'}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {item.categoria_gasto || 'Sin referencia'}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-blue-700">
                    {formatCurrency(item.monto)}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right">
                    <div className="flex justify-end gap-2">
                      {!isSubAdmin && (
                        <>
                          <button
                            onClick={() => onAction(item.id, 'REJECT')}
                            disabled={processingId === item.id}
                            className="px-3 py-1.5 text-xs font-medium rounded-md border border-red-200 text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Rechazar
                          </button>
                          <button
                            onClick={() => onAction(item.id, 'APPROVE')}
                            disabled={processingId === item.id}
                            className="px-3 py-1.5 text-xs font-medium rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Aprobar
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
