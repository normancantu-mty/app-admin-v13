import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import { cookies } from 'next/headers'
import { calcularFechasPorRango } from '@/lib/dashboard-utils'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import LogisticaInversaModal from './LogisticaInversaModal'
import MovimientosTable from './MovimientosTable'

interface Producto {
  id: string
  sku: string
  nombre: string
  tipo: 'INSUMO' | 'TERMINADO'
  unidad_medida: string
  costo_unitario: number
  listas_precios?: { precio_final: number }[] | null
}

interface MovimientoInventario {
  id: string
  id_producto: string
  status?: string | null
  cubeta?: string | null
  id_entidad_destino?: string | null
  id_entidad_origen?: string | null
  tipo_movimiento: string
  cantidad: number
  fecha_movimiento: string
  usuario_creador?: string | null
  entidad_destino?: { nombre: string; rol: string } | { nombre: string; rol: string }[] | null
  entidad_origen?: { nombre: string; rol: string } | { nombre: string; rol: string }[] | null
}

interface ProductoConStock extends Producto {
  stock_actual: number
}

interface KPIsInventario {
  totalMermas: number
  valorComercialInventario: number
}

interface Distribuidor {
  id: string
  nombre: string
}

async function getCatalogoProductos(): Promise<Producto[]> {
  try {
    const { data, error } = await supabase
      .from('catalogo_productos')
      .select('*, listas_precios(precio_final)')
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
      .select(`
        id,
        id_producto,
        status,
        cubeta,
        id_entidad_destino,
        id_entidad_origen,
        tipo_movimiento,
        cantidad,
        fecha_movimiento,
        usuario_creador,
        entidad_destino:entidades!inventario_ledger_id_entidad_destino_fkey(nombre, rol),
        entidad_origen:entidades!inventario_ledger_id_entidad_origen_fkey(nombre, rol)
      `)
      .order('fecha_movimiento', { ascending: false })
      .limit(1000)

    if (fechaInicio && fechaFin) {
      // Usa fin de día inclusivo para no ocultar movimientos del día actual.
      const fechaInicioTs = `${fechaInicio}T00:00:00.000Z`
      const finMasUnDia = new Date(`${fechaFin}T00:00:00.000Z`)
      finMasUnDia.setUTCDate(finMasUnDia.getUTCDate() + 1)
      const fechaFinExclusiveTs = finMasUnDia.toISOString()

      query = query
        .gte('fecha_movimiento', fechaInicioTs)
        .lt('fecha_movimiento', fechaFinExclusiveTs)
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

function normalizeEntidad(
  value?: { nombre: string; rol: string } | { nombre: string; rol: string }[] | null
): { nombre: string; rol: string } | null {
  if (!value) return null
  return Array.isArray(value) ? value[0] || null : value
}

function resolveEntidadDisplay(movimiento: MovimientoInventario): { nombre: string; esAdmin: boolean } {
  const entidadDestino = normalizeEntidad(movimiento.entidad_destino)
  const entidadOrigen = normalizeEntidad(movimiento.entidad_origen)

  const entidadResponsable = isTipoMovimientoEntrada(movimiento.tipo_movimiento)
    ? entidadDestino
    : isTipoMovimientoSalida(movimiento.tipo_movimiento)
    ? entidadOrigen
    : entidadDestino || entidadOrigen

  if (!entidadResponsable || entidadResponsable.rol === 'ADMIN') {
    return { nombre: 'Admin', esAdmin: true }
  }

  return { nombre: entidadResponsable.nombre, esAdmin: false }
}

async function getDistribuidores(): Promise<Distribuidor[]> {
  try {
    const { data, error } = await supabase
      .from('entidades')
      .select('id, nombre')
      .eq('rol', 'DST')
      .order('nombre', { ascending: true })

    if (error) {
      console.error('Error fetching distribuidores:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getDistribuidores:', error)
    return []
  }
}

async function getPreciosRetailPorProducto(): Promise<Map<string, number>> {
  try {
    const { data, error } = await supabase
      .from('listas_precios')
      .select('id_producto, precio_final, zona')
      .eq('zona', 'Zacatecas')

    if (error) {
      console.error('Error fetching listas_precios:', error)
      return new Map()
    }

    const preciosPorProducto = new Map<string, number>()
    for (const item of data || []) {
      if (!item.id_producto) continue
      const precio = Number(item.precio_final) || 0
      const existente = preciosPorProducto.get(item.id_producto) || 0
      if (precio > existente) {
        preciosPorProducto.set(item.id_producto, precio)
      }
    }

    return preciosPorProducto
  } catch (error) {
    console.error('Error in getPreciosRetailPorProducto:', error)
    return new Map()
  }
}

function calcularStockActual(productos: Producto[], movimientos: MovimientoInventario[]): ProductoConStock[] {
  return productos.map(producto => {
    const movimientosDelProducto = movimientos.filter(mov => mov.id_producto === producto.id)

    const stockActual = movimientosDelProducto.reduce((acc, mov) => {
      if (mov.status === 'ANULADO') {
        return acc
      }

      // Entity-perspective guard: this dashboard represents Admin's physical stock.
      // An ENTRADA row only increases Admin stock when its destination is Admin (or
      // unrouted, e.g. production batches with no explicit entity). Buyer-side
      // ENTRADA_COMPRA / ENTRADA_CONCESION rows (destino = LOC / DST) must be
      // ignored here — otherwise every sale double-counts the quantity back in.
      // A SALIDA row decreases Admin stock when its origin is Admin (or unrouted).
      const destino = normalizeEntidad(mov.entidad_destino)
      const origen  = normalizeEntidad(mov.entidad_origen)
      const destinoEsAdmin = !destino || destino.rol === 'ADMIN'
      const origenEsAdmin  = !origen  || origen.rol  === 'ADMIN'

      if (mov.tipo_movimiento === 'MERMA') {
        return origenEsAdmin ? acc - mov.cantidad : acc
      }
      if (mov.tipo_movimiento === 'DEVOLUCION_FISICA') {
        return destinoEsAdmin ? acc + mov.cantidad : acc
      }
      if (isTipoMovimientoEntrada(mov.tipo_movimiento)) {
        return destinoEsAdmin ? acc + mov.cantidad : acc
      }
      if (isTipoMovimientoSalida(mov.tipo_movimiento)) {
        return origenEsAdmin ? acc - mov.cantidad : acc
      }
      return acc
    }, 0)

    return {
      ...producto,
      stock_actual: stockActual
    }
  })
}

function calcularKPIs(
  productosConStock: ProductoConStock[],
  movimientos: MovimientoInventario[],
  preciosRetailPorProducto: Map<string, number>
): KPIsInventario {
  const movimientosActivos = movimientos.filter((mov) => mov.status !== 'ANULADO')
  const totalMermas = movimientosActivos
    .filter(mov => mov.tipo_movimiento === 'MERMA')
    .reduce((sum, mov) => sum + Math.abs(mov.cantidad), 0)

  const valorComercialInventario = productosConStock
    .filter((producto) => producto.tipo === 'TERMINADO')
    .reduce((sum, producto) => {
      const precioRetail = preciosRetailPorProducto.get(producto.id) ?? producto.costo_unitario
      return sum + (producto.stock_actual * precioRetail)
    }, 0)
  
  return {
    totalMermas,
    valorComercialInventario
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
  
  const [productos, movimientosRango, movimientosStock, distribuidores, currentUser, preciosRetailPorProducto] = await Promise.all([
    getCatalogoProductos(),
    getInventarioLedger(fechaInicio, fechaFin),
    getInventarioLedger(),
    getDistribuidores(),
    getCurrentUser(),
    getPreciosRetailPorProducto()
  ])
  
  // Stock actual debe calcularse contra todo el ledger (no solo contra rango de fechas).
  const productosConStock = calcularStockActual(productos, movimientosStock)
  const productosConStockOrdenados = [...productosConStock].sort((a, b) => {
    if (a.tipo === b.tipo) return 0
    if (a.tipo === 'TERMINADO') return -1
    if (b.tipo === 'TERMINADO') return 1
    return 0
  })
  // KPIs de la vista siguen el rango global seleccionado.
  const kpis = calcularKPIs(productosConStock, movimientosRango, preciosRetailPorProducto)

  const movimientos = movimientosStock
  // --- INICIO LÓGICA DE CONCESIÓN (Mejorada) ---
  const inventarioConcesion = productos
    .filter(p => p.tipo === 'TERMINADO')
    .map(producto => {
      try {
        const movsConsignado = movimientos.filter(m => 
          m.id_producto === producto.id && 
          m.cubeta === 'CONSIGNADO' && 
          m.status === 'ACTIVO'
        );
        
        const stockFisicoConsignado = movsConsignado.reduce((acc, mov) => {
          if (mov.status !== 'ACTIVO') return acc;
          if (mov.tipo_movimiento.startsWith('ENTRADA')) return acc + mov.cantidad;
          if (mov.tipo_movimiento.startsWith('SALIDA') || mov.tipo_movimiento === 'MERMA') return acc - mov.cantidad;
          return acc;
        }, 0);

        const precioFinal = producto.listas_precios?.[0]?.precio_final || 
                           preciosRetailPorProducto.get(producto.id) || 
                           0;
        
        return { 
          ...producto, 
          stock_consignado: Math.max(0, stockFisicoConsignado),
          valor_consignado: roundTo2(stockFisicoConsignado * precioFinal)
        };
      } catch (error) {
        console.error(`Error calculando concesión para producto ${producto.id}:`, error);
        return { ...producto, stock_consignado: 0, valor_consignado: 0 };
      }
    })
    .filter(p => p.stock_consignado > 0);

  const valorTotalConcesion = roundTo2(
    inventarioConcesion.reduce((sum, p) => sum + p.valor_consignado, 0)
  );
  // --- FIN LÓGICA DE CONCESIÓN ---

  function roundTo2(value: number): number {
    return Number(value.toFixed(2));
  }

  const canMutate = currentUser?.rol !== 'SOCIO'
  const ultimosMovimientos = movimientosRango.map((mov) => {
    const entidadDisplay = resolveEntidadDisplay(mov)
    return {
      ...mov,
      producto_nombre: productos.find((p) => p.id === mov.id_producto)?.nombre || 'Producto Desconocido',
      entidad_nombre: entidadDisplay.nombre,
      es_entidad_admin: entidadDisplay.esAdmin
    }
  })

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
            <LogisticaInversaModal
              productos={productos.map((p) => ({ id: p.id, nombre: p.nombre, sku: p.sku }))}
              distribuidores={distribuidores}
            />
          </div>
        )}
      </div>

      {productosConStock.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Valor Comercial del Inventario</p>
                  <p className="text-3xl font-bold text-emerald-600 mt-2">{formatCurrency(kpis.valorComercialInventario)}</p>
                </div>
                <div className="bg-emerald-100 p-3 rounded-full">
                  <span className="text-2xl">🏦</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-sm font-medium text-gray-600">Valor Comercial en Concesión</p>
                    <p className="text-3xl font-bold text-amber-600 mt-2">
                      {new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(valorTotalConcesion)}
                    </p>
                  </div>
                  <div className="p-3 bg-amber-50 rounded-full text-xl">📦</div>
                </div>
              </div>
              
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 mb-2">DESGLOSE FÍSICO (PIEZAS)</p>
                {inventarioConcesion.length === 0 ? (
                  <p className="text-sm text-gray-400">No hay stock en concesión.</p>
                ) : (
                  <ul className="space-y-1">
                    {inventarioConcesion.map(p => (
                      <li key={p.id} className="flex justify-between text-sm">
                        <span className="text-gray-600 truncate mr-2">{p.nombre}</span>
                        <span className="font-semibold text-gray-900">{Number(p.stock_consignado).toFixed(0)} pz</span>
                      </li>
                    ))}
                  </ul>
                )}
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
                  {productosConStockOrdenados.map((producto: ProductoConStock) => (
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
            <MovimientosTable
              movimientos={ultimosMovimientos}
              sessionEmail={currentUser?.email ?? null}
              sessionRole={currentUser?.rol ?? null}
              canMutate={Boolean(canMutate)}
            />
          </div>
        </>
      )}
    </div>
  )
}
