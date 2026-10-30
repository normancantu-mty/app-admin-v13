'use client'
// Paridad v2: copia de app/dashboard/inventario/LogisticaInversaModal.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useActionState, useEffect, useMemo, useState } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import {
  registrarLogisticaInversaAction,
  type RegistrarLogisticaInversaState
} from '@/app/actions/inventario'

interface ProductoOption {
  id: string
  nombre: string
  sku: string
}

interface DistribuidorOption {
  id: string
  nombre: string
}

const initialState: RegistrarLogisticaInversaState = { success: false }

export default function LogisticaInversaModal({
  productos,
  distribuidores
}: {
  productos: ProductoOption[]
  distribuidores: DistribuidorOption[]
}) {
  const [open, setOpen] = useState(false)
  const { refrescar } = useModalV2()
  const [tipoMovimiento, setTipoMovimiento] = useState<'MERMA' | 'DEVOLUCION_FISICA'>('MERMA')
  // v2 (2026-10-29): el cierre tras guardar va en la propia accion, no en un effect
  // que hace setState al ver `state.success` (render en cascada; lint react-hooks).
  const [state, formAction, isPending] = useActionState(
    async (previo: RegistrarLogisticaInversaState, datos: FormData) => {
      const resultado = await registrarLogisticaInversaAction(previo, datos)
      if (resultado.success) {
        setOpen(false)
        setTipoMovimiento('MERMA')
        refrescar()
      }
      return resultado
    },
    initialState
  )

  const isDevolucionFisica = tipoMovimiento === 'DEVOLUCION_FISICA'
  const titulo = useMemo(() => 'Registrar Logística Inversa', [])

  useEffect(() => {
    if (!open) return
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPending) {
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [open, isPending])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn"
      >
        Registrar Logística Inversa
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logistica-inversa-title"
        >
          <div className="w-full max-w-2xl rounded-xl bg-white shadow-xl border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 id="logistica-inversa-title" className="text-lg font-semibold text-gray-900">
                {titulo}
              </h2>
              <button
                type="button"
                onClick={() => !isPending && setOpen(false)}
                className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                disabled={isPending}
                aria-label="Cerrar modal"
              >
                ✕
              </button>
            </div>

            <form action={formAction} className="px-6 py-5 space-y-4">
              <div>
                <label htmlFor="producto_id" className="block text-sm font-medium text-gray-700 mb-1">
                  Producto
                </label>
                <select
                  id="producto_id"
                  name="producto_id"
                  required
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Selecciona un producto...</option>
                  {productos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nombre} ({p.sku})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="tipo_movimiento" className="block text-sm font-medium text-gray-700 mb-1">
                    Tipo
                  </label>
                  <select
                    id="tipo_movimiento"
                    name="tipo_movimiento"
                    value={tipoMovimiento}
                    onChange={(e) => setTipoMovimiento(e.target.value as 'MERMA' | 'DEVOLUCION_FISICA')}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="MERMA">MERMA</option>
                    <option value="DEVOLUCION_FISICA">DEVOLUCION_FISICA</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="cantidad" className="block text-sm font-medium text-gray-700 mb-1">
                    Cantidad
                  </label>
                  <input
                    id="cantidad"
                    name="cantidad"
                    type="number"
                    min="0.0001"
                    step="0.0001"
                    required
                    placeholder="0.0000"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {isDevolucionFisica && (
                <div className="rounded-md border border-blue-200 bg-blue-50 p-4 space-y-4">
                  <div>
                    <label htmlFor="distribuidor_id" className="block text-sm font-medium text-gray-700 mb-1">
                      Distribuidor
                    </label>
                    <select
                      id="distribuidor_id"
                      name="distribuidor_id"
                      required={isDevolucionFisica}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Selecciona un distribuidor...</option>
                      {distribuidores.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.nombre}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor="monto_abono" className="block text-sm font-medium text-gray-700 mb-1">
                      Monto Abono (descuento de deuda)
                    </label>
                    <input
                      id="monto_abono"
                      name="monto_abono"
                      type="number"
                      min="0"
                      step="0.01"
                      required={isDevolucionFisica}
                      placeholder="0.00"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              )}

              {state.error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {state.error}
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={isPending}
                  className="px-4 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isPending ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
