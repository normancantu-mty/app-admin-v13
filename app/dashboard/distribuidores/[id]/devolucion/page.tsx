'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

interface ProductoConPrecio {
  id: string
  sku: string
  nombre: string
  precio_final: number
}

export default function DevolucionPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [productos, setProductos] = useState<ProductoConPrecio[]>([])
  const [isLoadingData, setIsLoadingData] = useState(true)

  const [idProducto, setIdProducto] = useState('')
  const [cantidad, setCantidad] = useState('')

  const [subtotal, setSubtotal] = useState(0)

  useEffect(() => {
    const fetchProductos = async () => {
      try {
        const { data, error } = await supabase
          .from('catalogo_productos')
          .select(`
            id,
            sku,
            nombre,
            listas_precios (precio_final)
          `)
          .eq('tipo', 'TERMINADO')
          .order('nombre', { ascending: true })

        if (error) {
          console.error('Error fetching productos:', error)
          return
        }

        const productosConPrecio = (data || []).map((p: any) => ({
          id: p.id,
          sku: p.sku,
          nombre: p.nombre,
          precio_final: p.listas_precios?.[0]?.precio_final || 0
        }))

        setProductos(productosConPrecio)
      } catch (error) {
        console.error('Error in fetchProductos:', error)
      } finally {
        setIsLoadingData(false)
      }
    }

    fetchProductos()
  }, [])

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
      // PASO A: Restaurar Inventario
      const { error: errorInventario } = await supabase
        .from('inventario_ledger')
        .insert({
          id_producto: idProducto,
          tipo_movimiento: 'ENTRADA_COMPRA',
          cantidad: cantidadNum,
          notas: 'Devolución de Distribuidor'
        })

      if (errorInventario) {
        console.error('Error details:', errorInventario.message, errorInventario.details, errorInventario.hint)
        alert(`Error al registrar entrada de inventario: ${errorInventario.message}`)
        return
      }

      // PASO B: Cancelar Deuda
      const { error: errorFinanzas } = await supabase
        .from('finanzas_ledger')
        .insert({
          id_entidad_relacionada: resolvedParams.id,
          tipo_movimiento: 'ABONO_DEUDA',
          monto: subtotal,
          categoria_gasto: 'Devolucion de Mercancia'
        })

      if (errorFinanzas) {
        console.error('Error details:', errorFinanzas.message, errorFinanzas.details, errorFinanzas.hint)
        alert(`Error al registrar cancelación de deuda: ${errorFinanzas.message}`)
        return
      }

      alert('✅ Devolución procesada exitosamente. Stock restaurado y deuda cancelada.')
      router.push(`/dashboard/distribuidores/${resolvedParams.id}`)
      router.refresh()
    } catch (error: any) {
      console.error('Error details:', error?.message, error?.details, error?.hint)
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
    <div className="p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <Link 
            href={`/dashboard/distribuidores/${resolvedParams.id}`}
            className="text-blue-600 hover:text-blue-800 mb-4 inline-block"
          >
            ← Volver
          </Link>
          <h1 className="text-3xl font-bold text-gray-800">Registrar Devolución de Mercancía</h1>
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
              <Link
                href={`/dashboard/distribuidores/${resolvedParams.id}`}
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
