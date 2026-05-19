'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { procesarCorteInventarioAction } from '@/app/actions/auditoria'

interface CobranzaRow {
  idProducto: string
  producto: string
  stockEsperado: number
  precioCobroUnitario: number
}

interface CuentaOption {
  id: string
  nombre: string
}

interface CobranzaClientProps {
  idEntidadObjetivo: string
  rows: CobranzaRow[]
  cuentasDestino: CuentaOption[]
  cuentaDestinoDefault: string
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(value)
}

export default function CobranzaClient({
  idEntidadObjetivo,
  rows,
  cuentasDestino,
  cuentaDestinoDefault
}: CobranzaClientProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [idCuentaDestino, setIdCuentaDestino] = useState(cuentaDestinoDefault)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [showToast, setShowToast] = useState(false)
  const [conteos, setConteos] = useState<Record<string, string>>(
    Object.fromEntries(rows.map((row) => [row.idProducto, String(row.stockEsperado)]))
  )

  const resumen = useMemo(() => {
    const detalles = rows.map((row) => {
      const fisico = Number(conteos[row.idProducto] ?? row.stockEsperado)
      const diferencia = roundTo2(row.stockEsperado - (Number.isFinite(fisico) ? fisico : 0))
      return {
        ...row,
        fisico: Number.isFinite(fisico) ? fisico : 0,
        diferencia
      }
    })

    const hasSobregiro = detalles.some((row) => row.diferencia < 0)
    const totalVentaUnidades = roundTo2(detalles.filter((row) => row.diferencia > 0).reduce((acc, row) => acc + row.diferencia, 0))
    const montoEstimado = roundTo2(
      detalles
        .filter((row) => row.diferencia > 0)
        .reduce((acc, row) => acc + (row.diferencia * row.precioCobroUnitario), 0)
    )

    return { detalles, hasSobregiro, totalVentaUnidades, montoEstimado }
  }, [rows, conteos])

  const hasDiferenciasPositivas = resumen.detalles.some((row) => row.diferencia > 0)
  const disableSubmit = isPending || resumen.hasSobregiro || !hasDiferenciasPositivas || !idCuentaDestino

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSuccess(null)

    const conteosFisicos = resumen.detalles.map((row) => ({
      idProducto: row.idProducto,
      fisico: row.fisico
    }))

    startTransition(async () => {
      try {
        const result = await procesarCorteInventarioAction({
          idEntidad: idEntidadObjetivo,
          conteosFisicos,
          idCuentaDestino
        })

        if (!result.ok) {
          setError(result.error || 'No se pudo procesar la cobranza.')
          return
        }

        setSuccess(`Cobranza procesada correctamente. Ticket generado: ${result.ticketId}`)
        setShowToast(true)
        setTimeout(() => {
          setShowToast(false)
          if (result.ticketId) {
            router.push(`/ticket/${result.ticketId}`)
            return
          }
          router.push(`/dashboard/distribuidores/${idEntidadObjetivo}`)
        }, 900)
      } catch (submitError: unknown) {
        const message = submitError instanceof Error
          ? submitError.message
          : 'Error inesperado al procesar cobranza.'
        setError(message)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {showToast && success && (
        <div className="fixed top-4 right-4 z-50 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-700 shadow-lg">
          {success}
        </div>
      )}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Producto</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stock Sistema</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Conteo Físico</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Botellas Vendidas</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {resumen.detalles.map((row) => {
              const isSobregiro = row.diferencia < 0
              return (
                <tr key={row.idProducto} className={isSobregiro ? 'bg-red-50' : ''}>
                  <td className="px-6 py-4 text-sm font-medium text-gray-900">{row.producto}</td>
                  <td className="px-6 py-4 text-sm text-gray-700">{row.stockEsperado.toFixed(4)}</td>
                  <td className="px-6 py-4">
                    <input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={conteos[row.idProducto] ?? ''}
                      onChange={(e) => setConteos((prev) => ({ ...prev, [row.idProducto]: e.target.value }))}
                      className={`w-40 rounded-md border px-3 py-2 text-sm ${
                        isSobregiro ? 'border-red-400 text-red-700' : 'border-gray-300'
                      }`}
                    />
                  </td>
                  <td className={`px-6 py-4 text-sm font-semibold ${isSobregiro ? 'text-red-600' : 'text-gray-800'}`}>
                    {row.diferencia.toFixed(4)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor="cuenta_destino" className="block text-sm font-medium text-gray-700 mb-1">
            Cuenta destino de cobranza
          </label>
          <select
            id="cuenta_destino"
            value={idCuentaDestino}
            onChange={(e) => setIdCuentaDestino(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {cuentasDestino.length === 0 ? (
              <option value="">No hay cuentas disponibles</option>
            ) : (
              cuentasDestino.map((cuenta) => (
                <option key={cuenta.id} value={cuenta.id}>
                  {cuenta.nombre}
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
        <p className="text-blue-900 font-medium">Resumen de cobranza</p>
        <p className="text-blue-800 mt-1">Botellas vendidas detectadas: {resumen.totalVentaUnidades.toFixed(4)}</p>
        <p className="text-blue-800">Monto estimado a cobrar: {formatCurrency(resumen.montoEstimado)}</p>
      </div>

      {resumen.hasSobregiro && (
        <p className="text-sm text-red-600">
          Sobregiro físico detectado: hay productos con conteo físico mayor al stock del sistema.
        </p>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {success && <p className="text-sm text-green-700">{success}</p>}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disableSubmit}
          className="rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          {isPending ? 'Procesando...' : 'Procesar Cobranza'}
        </button>
      </div>
    </form>
  )
}
