'use client'
// Paridad v2: copia de app/dashboard/distribuidores/[id]/devolucion/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

/**
 * Formulario de devolucion. **Solo UI**: no lee ni escribe la base.
 * El catalogo con su precio y las dos filas del ledger las maneja
 * `app/actions/devoluciones.ts`, que ademas compensa si la segunda falla.
 */

import { useState, useEffect } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import {
  getProductosDevolucionAction,
  registrarDevolucionAction,
  type ProductoDevolucion
} from '@/app/actions/devoluciones'

export default function Devolucion({ id, padre }: { id: string; padre: string }) {
  const resolvedParams = { id }
  const { irTrasGuardar, cerrar } = useModalV2()
  const [isLoading, setIsLoading] = useState(false)
  const [productos, setProductos] = useState<ProductoDevolucion[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)

  const [idProducto, setIdProducto] = useState('')
  const [cantidad, setCantidad] = useState('')

  const [subtotal, setSubtotal] = useState(0)

  useEffect(() => {
    const fetchProductos = async () => {
      try {
        const resultado = await getProductosDevolucionAction(resolvedParams.id)

        if (!resultado.success || !resultado.data) {
          console.error('Error cargando productos de devolucion:', resultado.error)
          return
        }

        setProductos(resultado.data.productos)
      } catch (error) {
        console.error('Error in fetchProductos:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchProductos()
  }, [resolvedParams.id])

  useEffect(() => {
    if (idProducto && cantidad) {
      const producto = productos.find(p => p.id === idProducto)
      if (producto) {
        const cantidadNum = parseFloat(cantidad)
        if (!isNaN(cantidadNum) && cantidadNum > 0) {
          setSubtotal(producto.precio_final * cantidadNum)
        } else {
          setSubtotal(0)
        }
      }
    } else {
      setSubtotal(0)
    }
  }, [idProducto, cantidad, productos])

  const handleProcesarDevolucion = async () => {
    if (!idProducto || !cantidad) {
      alert('Por favor completa el producto y la cantidad.')
      return
    }

    const cantidadNum = parseFloat(cantidad)
    if (isNaN(cantidadNum) || cantidadNum <= 0) {
      alert('La cantidad debe ser un valor numérico positivo.')
      return
    }

    setIsLoading(true)

    try {
      const resultado = await registrarDevolucionAction({
        idEntidad: resolvedParams.id,
        idProducto,
        cantidad: cantidadNum
      })

      if (!resultado.success) {
        alert(resultado.error || 'No se pudo procesar la devolución.')
        return
      }

      alert('✅ Devolución procesada exitosamente. Stock restaurado y deuda cancelada.')
      // v2 (2026-10-29, Socio ejecutor): sin refrescar() junto al push. El refresh del
      // route ACTUAL le puede ganar al push y deja al usuario en el formulario ya guardado
      // (medido 2 veces en 4 baterias: abono y POS) -> riesgo de capturar dos veces. Con
      // staleTimes.dynamic = 0 (default de Next 15+) el push ya trae datos frescos.
      irTrasGuardar(padre)
    } catch (error) {
      console.error('Error al procesar la devolución:', error)
      alert('Error al procesar la devolución. Inténtalo de nuevo.')
    } finally {
      setIsLoading(false)
    }
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(amount)
  }

  return (
    <div className="v1">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-xl font-bold text-gray-800">Registrar devolución de mercancía</h1>
          <p className="text-gray-600 mt-2">Logística inversa: restaura stock y cancela deuda</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="space-y-6">
            <div>
              <label htmlFor="producto" className="block text-sm font-medium text-gray-700 mb-2">
                Producto a Devolver
              </label>
              <select
                id="producto"
                value={idProducto}
                onChange={(e) => setIdProducto(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
                disabled={isLoadingData}
              >
                <option value="">
                  {isLoadingData ? 'Cargando productos...' : 'Selecciona un producto...'}
                </option>
                {productos.map(producto => (
                  <option key={producto.id} value={producto.id}>
                    {producto.sku} - {producto.nombre} ({formatCurrency(producto.precio_final)})
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">Producto terminado que el distribuidor está devolviendo</p>
            </div>

            <div>
              <label htmlFor="cantidad" className="block text-sm font-medium text-gray-700 mb-2">
                Cantidad
              </label>
              <input
                type="number"
                id="cantidad"
                value={cantidad}
                onChange={(e) => setCantidad(e.target.value)}
                min="1"
                step="1"
                placeholder="Ej. 10"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500"
              />
              <p className="text-xs text-gray-500 mt-1">Número de piezas a devolver</p>
            </div>

            {subtotal > 0 && (
              <div className="border-t border-gray-200 pt-4">
                <div className="bg-blue-50 border border-blue-200 rounded-md p-4">
                  <h3 className="text-sm font-semibold text-blue-800 mb-2">📋 Preview de Transacción</h3>
                  <div className="text-sm text-blue-700 space-y-2">
                    <p>
                      <strong>Monto a cancelar:</strong> {formatCurrency(subtotal)}
                    </p>
                    <p>
                      <strong>Cantidad a restaurar:</strong> {cantidad} piezas
                    </p>
                    <div className="mt-3 pt-3 border-t border-blue-300">
                      <p className="text-xs">
                        ℹ️ Se restarán <strong>{formatCurrency(subtotal)}</strong> de la deuda del distribuidor 
                        y se sumarán <strong>{cantidad} piezas</strong> al inventario.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleProcesarDevolucion}
                disabled={isLoading || !idProducto || !cantidad || subtotal <= 0}
                className="flex-1 bg-red-600 text-white py-3 px-4 rounded-md hover:bg-red-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Procesando...' : '🔄 Procesar Devolución'}
              </button>
              <button
                type="button"
                onClick={() => cerrar(padre)}
                className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
