import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import { cookies } from 'next/headers'
import { calcularFechasPorRango } from '@/lib/dashboard-utils'

interface Producto {
  id: string
  sku: string
  nombre: string
  tipo: 'INSUMO' | 'TERMINADO'
  unidad_medida: string
  costo_unitario: number
}

interface MovimientoInventario {
  id: string
  id_producto: string
  tipo_movimiento: string
  cantidad: number
  fecha_movimiento: string
}

interface ProductoConStock extends Producto {
  stock_actual: number
}

interface KPIsInventario {
  totalBotellas: number
  totalPastas: number
  totalInsumos: number
  totalMermas: number
}

const TIPOS_ENTRADA = ['ENTRADA_COMPRA', 'PRODUCCION']
const TIPOS_SALIDA = ['SALIDA_VENTA', 'MERMA', 'TRASPASO']

async function getCatalogoProductos(): Promise<Producto[]> {
  try {
    const { data, error } = await supabase
      .from('catalogo_productos')
      .select('*')
      .order('nombre', { ascending: true })

    if (error) {
      console.error('Error fetching catalogo_productos:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getCatalogoProductos:', error)
    return []
  }
}

async function getInventarioLedger(
  fechaInicio?: string,
  fechaFin?: string
): Promise<MovimientoInventario[]> {
  try {
    let query = supabase
      .from('inventario_ledger')
      .select('*')
      .order('fecha_movimiento', { ascending: false })

    if (fechaInicio && fechaFin) {
      query = query
        .gte('fecha_movimiento', fechaInicio)
        .lte('fecha_movimiento', fechaFin)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching inventario_ledger:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getInventarioLedger:', error)
    return []
  }
}

function calcularStockActual(productos: Producto[], movimientos: MovimientoInventario[]): ProductoConStock[] {
  return productos.map(producto => {
    const movimientosDelProducto = movimientos.filter(mov => mov.id_producto === producto.id)
    
    const stockActual = movimientosDelProducto.reduce((acc, mov) => {
      if (TIPOS_ENTRADA.includes(mov.tipo_movimiento)) {
        return acc + mov.cantidad
      }
      if (TIPOS_SALIDA.includes(mov.tipo_movimiento)) {
        return acc - mov.cantidad
      }
      return acc
    }, 0)
    
    return {
      ...producto,
      stock_actual: stockActual
    }
  })
}

function calcularKPIs(productosConStock: ProductoConStock[], movimientos: MovimientoInventario[]): KPIsInventario {
  const totalBotellas = productosConStock
    .filter(p => p.tipo === 'TERMINADO' && p.unidad_medida.toLowerCase().includes('ml'))
    .reduce((sum, p) => sum + p.stock_actual, 0)
  
  const totalPastas = productosConStock
    .filter(p => p.tipo === 'TERMINADO' && 
      (p.unidad_medida.toLowerCase().includes('kg') || 
       p.unidad_medida.toLowerCase().includes('gr')))
    .reduce((sum, p) => sum + p.stock_actual, 0)
  
  const totalInsumos = productosConStock
    .filter(p => p.tipo === 'INSUMO')
    .reduce((sum, p) => sum + p.stock_actual, 0)
  
  const totalMermas = movimientos
    .filter(mov => mov.tipo_movimiento === 'MERMA')
    .reduce((sum, mov) => sum + mov.cantidad, 0)
  
  return {
    totalBotellas,
    totalPastas,
    totalInsumos,
    totalMermas
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function EmptyState() {
  return (
    <div className="text-center py-12">
      <div className="text-gray-400 text-6xl mb-4">📦</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">No hay productos en el catálogo</h3>
      <p className="text-gray-500">Comienza agregando productos a tu inventario.</p>
    </div>
  )
}

export default async function InventarioPage() {
  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)
  
  const [productos, movimientos, currentUser] = await Promise.all([
    getCatalogoProductos(),
    getInventarioLedger(fechaInicio, fechaFin),
    getCurrentUser()
  ])
  
  const productosConStock = calcularStockActual(productos, movimientos)
  const kpis = calcularKPIs(productosConStock, movimientos)
  const canMutate = currentUser?.rol !== 'SOCIO'
  const ultimosMovimientos = movimientos.slice(0, 15)

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-gray-800">Control de Inventario</h1>
        {canMutate && (
          <div className="flex gap-3">
            <Link
              href="/dashboard/inventario/nuevo"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              Producción (Envasar)
            </Link>
            <Link
              href="/dashboard/inventario/compra"
              className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-700"
            >
              Comprar Insumos
            </Link>
            <button
              className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
            >
              Registrar Merma
            </button>
          </div>
        )}
      </div>

      {productosConStock.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Stock Botellas</p>
                  <p className="text-3xl font-bold text-blue-600 mt-2">{Number(kpis.totalBotellas).toFixed(2)}</p>
                </div>
                <div className="bg-blue-100 p-3 rounded-full">
                  <span className="text-2xl">🍾</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Stock Pastas</p>
                  <p className="text-3xl font-bold text-purple-600 mt-2">{Number(kpis.totalPastas).toFixed(2)}</p>
                </div>
                <div className="bg-purple-100 p-3 rounded-full">
                  <span className="text-2xl">🧴</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Insumos</p>
                  <p className="text-3xl font-bold text-gray-600 mt-2">{Number(kpis.totalInsumos).toFixed(4)}</p>
                </div>
                <div className="bg-gray-100 p-3 rounded-full">
                  <span className="text-2xl">🧰</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Mermas</p>
                  <p className="text-3xl font-bold text-orange-600 mt-2">{Number(kpis.totalMermas).toFixed(2)}</p>
                </div>
                <div className="bg-orange-100 p-3 rounded-full">
                  <span className="text-2xl">⚠️</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Stock Actual por Producto</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      SKU
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Nombre
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Tipo
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Unidad de Medida
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Stock Actual
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {productosConStock.map((producto: ProductoConStock) => (
                    <tr key={producto.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {producto.sku}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {producto.nombre}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          producto.tipo === 'INSUMO' 
                            ? 'bg-gray-100 text-gray-800' 
                            : 'bg-blue-100 text-blue-800'
                        }`}>
                          {producto.tipo}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {producto.unidad_medida}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                        <span className={producto.stock_actual <= 10 ? 'text-red-600' : 'text-gray-900'}>
                          {Number(producto.stock_actual).toFixed(4)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Últimos Movimientos</h2>
            </div>
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
                      Tipo Movimiento
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Cantidad
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {ultimosMovimientos.map((mov: MovimientoInventario) => {
                    const producto = productos.find(p => p.id === mov.id_producto)
                    const esEntrada = TIPOS_ENTRADA.includes(mov.tipo_movimiento)
                    const esSalida = TIPOS_SALIDA.includes(mov.tipo_movimiento)
                    
                    return (
                      <tr key={mov.id} className="hover:bg-gray-50">
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {new Date(mov.fecha_movimiento).toLocaleDateString('es-MX', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric'
                          })}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                          {producto?.nombre || 'Producto Desconocido'}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                            esEntrada
                              ? 'bg-green-100 text-green-800' 
                              : esSalida
                              ? 'bg-red-100 text-red-800'
                              : 'bg-gray-100 text-gray-800'
                          }`}>
                            {mov.tipo_movimiento}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                          {Number(mov.cantidad).toFixed(4)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
