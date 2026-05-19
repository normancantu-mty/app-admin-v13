'use client'

import { useMemo, useState, useTransition } from 'react'
import type { FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { registrarSalidaCascada } from '@/app/actions/inventario'

interface EntidadOption {
  id: string
  nombre: string
}

interface ProductoOption {
  id?: string
  idProducto?: string
  id_producto?: string
  nombre: string
  sku?: string
}

interface BotonReportarMermaProps {
  entidades: EntidadOption[]
  productos: ProductoOption[]
  usuarioCreador: string | null
  entidadFijaId?: string
  entidadFijaNombre?: string
}

export default function BotonReportarMerma({
  entidades,
  productos,
  usuarioCreador,
  entidadFijaId,
  entidadFijaNombre
}: BotonReportarMermaProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const productosNormalizados = useMemo(
    () =>
      productos
        .map((producto) => ({
          id: producto.id ?? producto.idProducto ?? producto.id_producto ?? '',
          nombre: producto.nombre,
          sku: producto.sku
        }))
        .filter((producto) => Boolean(producto.id)),
    [productos]
  )
  const fallbackUsuario = usuarioCreador || 'sistema@erp.local'
  const usaEntidadFija = Boolean(entidadFijaId)
  const entidadInicial = entidades[0]?.id || ''

  const openModal = () => {
    setOpen(true)
  }

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)
    const submittedIdEntidad = String(formData.get('id_entidad') || '').trim()
    const submittedIdProducto = String(formData.get('id_producto') || '').trim()
    const submittedCantidad = Number(formData.get('cantidad'))

    console.log('🔥 BULLETPROOF PAYLOAD:', {
      id_entidad: submittedIdEntidad,
      id_producto: submittedIdProducto,
      cantidad: submittedCantidad
    })
    console.log('PAYLOAD INSPECTION:', {
      idProductoSeleccionado: submittedIdProducto,
      rawProductList: productos
    })

    if (!submittedIdProducto || submittedIdProducto.trim() === '') {
      alert('CRITICAL ERROR: Select element did not pass a value.')
      return
    }

    if (!submittedIdEntidad) {
      alert('Selecciona un distribuidor válido.')
      return
    }

    if (!Number.isFinite(submittedCantidad) || submittedCantidad <= 0) {
      alert('La cantidad debe ser mayor a cero.')
      return
    }

    startTransition(async () => {
      try {
        const result = await registrarSalidaCascada({
          id_entidad: submittedIdEntidad,
          id_producto: submittedIdProducto,
          cantidad_a_deducir: submittedCantidad,
          tipo_movimiento: 'MERMA',
          usuario_creador: fallbackUsuario
        })

        if (!result.success) {
          throw new Error(result.error || 'No se pudo registrar la merma.')
        }

        alert('Merma registrada con deducción en cascada.')
        setOpen(false)
        router.refresh()
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Error al registrar merma.')
      }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700"
      >
        Reportar Merma (Cascada)
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-xl">
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-base font-semibold text-gray-900">Reportar Merma</h3>
              <p className="text-xs text-gray-500 mt-1">Motor Zero-Trust en cascada: PAGADO → CONSIGNADO.</p>
            </div>

            <form onSubmit={onSubmit}>
              <div className="p-5 space-y-4">
                {usaEntidadFija ? (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Distribuidor</label>
                    <div className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">
                      {entidadFijaNombre || 'Distribuidor seleccionado'}
                    </div>
                    <input type="hidden" name="id_entidad" value={entidadFijaId || ''} />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Distribuidor</label>
                    <select
                      name="id_entidad"
                      defaultValue={entidadInicial}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                    >
                      <option value="">Selecciona distribuidor</option>
                      {entidades.map((entidad) => (
                        <option key={entidad.id} value={entidad.id}>
                          {entidad.nombre}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Producto</label>
                  <select
                    name="id_producto"
                    defaultValue={productosNormalizados[0]?.id || ''}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  >
                    <option value="">Selecciona producto</option>
                    {productos.map((producto) => {
                      const productId = producto.id || producto.id_producto || producto.idProducto || ''
                      if (!productId) return null
                      return (
                        <option key={productId} value={productId}>
                          {producto.sku ? `${producto.sku} - ` : ''}{producto.nombre}
                        </option>
                      )
                    })}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Cantidad a deducir</label>
                  <input
                    type="number"
                    name="cantidad"
                    min="0.0001"
                    step="0.0001"
                    defaultValue="1"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => setOpen(false)}
                  className="px-3 py-2 rounded-md text-sm border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-3 py-2 rounded-md text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {isPending ? 'Guardando...' : 'Confirmar merma'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  )
}
