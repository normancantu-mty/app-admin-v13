'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { registrarProduccionAction } from '@/app/actions/inventario'

interface Producto {
  id: string
  nombre: string
  sku: string
  tipo: 'INSUMO' | 'TERMINADO'
}

interface Receta {
  id: string
  id_producto_terminado: string
  id_insumo: string
  cantidad_requerida: number
}

interface InsumoConsumo {
  id_insumo: string
  nombre_insumo: string
  cantidad_unitaria: number
  cantidad_total: number
}

export default function NuevoMovimientoInventarioPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [productos, setProductos] = useState<Producto[]>([])
  const [recetas, setRecetas] = useState<Receta[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)
  
  const [productoSeleccionado, setProductoSeleccionado] = useState('')
  const [cantidadProducir, setCantidadProducir] = useState('')
  const [previewInsumos, setPreviewInsumos] = useState<InsumoConsumo[]>([])

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [productosRes, recetasRes] = await Promise.all([
          supabase
            .from('catalogo_productos')
            .select('id, nombre, sku, tipo')
            .order('nombre', { ascending: true }),
          supabase
            .from('recetas_produccion')
            .select('*')
        ])

        if (productosRes.error) {
          console.error('Error fetching productos:', productosRes.error)
        } else {
          setProductos(productosRes.data || [])
        }

        if (recetasRes.error) {
          console.error('Error fetching recetas:', recetasRes.error)
        } else {
          setRecetas(recetasRes.data || [])
        }
      } catch (error) {
        console.error('Error in fetchData:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchData()
  }, [])

  useEffect(() => {
    if (!productoSeleccionado || !cantidadProducir) {
      setPreviewInsumos([])
      return
    }

    const cantidad = parseFloat(cantidadProducir)
    if (isNaN(cantidad) || cantidad <= 0) {
      setPreviewInsumos([])
      return
    }

    const recetaProducto = recetas.filter(r => r.id_producto_terminado === productoSeleccionado)
    
    if (recetaProducto.length === 0) {
      setPreviewInsumos([])
      return
    }

    const insumosCalculados: InsumoConsumo[] = recetaProducto.map(receta => {
      const insumo = productos.find(p => p.id === receta.id_insumo)
      return {
        id_insumo: receta.id_insumo,
        nombre_insumo: insumo?.nombre || 'Insumo Desconocido',
        cantidad_unitaria: receta.cantidad_requerida,
        cantidad_total: receta.cantidad_requerida * cantidad
      }
    })

    setPreviewInsumos(insumosCalculados)
  }, [productoSeleccionado, cantidadProducir, recetas, productos])

  const handleRegistrarProduccion = async () => {
    // ERP-59 · W3. Este guardia tenia `previewInsumos.length === 0` y sobrevivia
    // al del boton: quitar uno sin el otro no ablanda nada, solo mueve el
    // rechazo. La falta de receta ya NO detiene la produccion -- las botellas
    // existen -- y el servidor deja el aviso de que el insumo quedo sin descontar.
    if (!productoSeleccionado || !cantidadProducir) {
      alert('Selecciona el producto terminado y la cantidad producida.')
      return
    }

    setIsLoading(true)

    try {
      const cantidad = parseFloat(cantidadProducir)
      const result = await registrarProduccionAction({
        idProductoTerminado: productoSeleccionado,
        cantidad
      })

      if (!result.success) {
        alert(result.error || 'Error al registrar producción.')
        return
      }

      alert('✅ Producción registrada exitosamente. Inventario actualizado.')
      setProductoSeleccionado('')
      setCantidadProducir('')
      setPreviewInsumos([])
      router.refresh()
    } catch (error) {
      console.error('Error in handleRegistrarProduccion:', error)
      alert('Error al registrar la producción. Inténtalo de nuevo.')
    } finally {
      setIsLoading(false)
    }
  }

  const productosTerminados = productos.filter(p => p.tipo === 'TERMINADO')

  return (
    <div className="p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link 
            href="/dashboard/inventario"
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver a Inventario
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Registro de Producción (Envasado)</h1>
          <p className="text-gray-600 mt-2">Sistema automático de deducción de insumos basado en BOM</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
          <div className="space-y-6">
            <div>
              <label htmlFor="producto" className="block text-sm font-medium text-gray-700 mb-2">
                Producto Terminado a Envasar
              </label>
              <select
                id="producto"
                value={productoSeleccionado}
                onChange={(e) => setProductoSeleccionado(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                disabled={isLoadingData}
              >
                <option value="">
                  {isLoadingData ? 'Cargando productos...' : 'Selecciona un producto terminado...'}
                </option>
                {productosTerminados.map(producto => (
                  <option key={producto.id} value={producto.id}>
                    [{producto.sku}] - {producto.nombre}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="cantidad" className="block text-sm font-medium text-gray-700 mb-2">
                Cantidad a Producir
              </label>
              <input
                type="number"
                id="cantidad"
                value={cantidadProducir}
                onChange={(e) => setCantidadProducir(e.target.value)}
                min="1"
                step="0.01"
                placeholder="Ej: 50"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {previewInsumos.length > 0 && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-semibold text-gray-800 mb-4">Preview: Insumos a Consumir</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Insumo
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Cantidad por Unidad
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Cantidad Total a Consumir
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {previewInsumos.map((insumo) => (
                        <tr key={insumo.id_insumo}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-900">
                            {insumo.nombre_insumo}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-500">
                            {Number(insumo.cantidad_unitaria).toFixed(4)}
                          </td>
                          <td className="px-4 py-3 text-sm font-semibold text-red-600">
                            {Number(insumo.cantidad_total).toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-4 pt-4">
              <button
                onClick={handleRegistrarProduccion}
                // ERP-59 · W3. `previewInsumos.length === 0` (sin receta) salio de
                // aqui: las botellas EXISTEN y el servidor ya las registra. Lo que
                // no pasa es el descuento de insumos, y de eso avisa la cola.
                disabled={isLoading || !productoSeleccionado || !cantidadProducir}
                className="flex-1 bg-blue-600 text-white py-3 px-4 rounded-md hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed font-semibold"
              >
                {isLoading ? 'Registrando...' : '✅ Registrar Producción'}
              </button>
              <Link
                href="/dashboard/inventario"
                className="flex-1 bg-gray-200 text-gray-800 py-3 px-4 rounded-md hover:bg-gray-300 transition-colors text-center font-medium"
              >
                Cancelar
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
