import { createServerClient } from '@supabase/ssr'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import { cookies } from 'next/headers'
import { calcularFechasPorRango, fetchTodasLasFilas, limitesRangoMX } from '@/lib/dashboard-utils'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import LogisticaInversaModal from './LogisticaInversaModal'
import MovimientosTable from './MovimientosTable'

// Cliente por request con la sesion del usuario. NUNCA el cliente browser de
// '@/lib/supabase' aqui: en un Server Component viaja sin sesion, o sea como
// `anon`, y con RLS encendido no ve nada.
async function getSupabaseServer() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
      },
    }
  )
}

const ZONA_PRECIO_REFERENCIA = 'Zacatecas'

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
    const supabase = await getSupabaseServer()
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
    const supabase = await getSupabaseServer()
    // Rango [inicio, fin+1dia) anclado a America/Mexico_City, igual que el resto
    // de las pantallas. Sin `.limit(1000)`: de este ledger sale el stock, y un
    // stock truncado no da error, da un numero falso.
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    return await fetchTodasLasFilas<MovimientoInventario>(() => {
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

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'getInventarioLedger')
  } catch (error) {
    console.error('Error in getInventarioLedger:', error)
    return []
  }
}

/**
 * El mismo corte que `getInventarioLedger(fechaInicio, fechaFin)` hacia en
 * Postgres (`gte desde` y `lt hastaExclusivo`), aplicado a filas ya traidas.
 * Sin rango devuelve todo, igual que la consulta.
 */
function recortarAlRango(
  movimientos: MovimientoInventario[],
  fechaInicio?: string,
  fechaFin?: string
): MovimientoInventario[] {
  const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)
  if (!desde || !hastaExclusivo) return movimientos
  const inicio = Date.parse(desde)
  const fin = Date.parse(hastaExclusivo)
  return movimientos.filter((mov) => {
    const t = Date.parse(mov.fecha_movimiento)
    return t >= inicio && t < fin
  })
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
    const supabase = await getSupabaseServer()
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

/**
 * Precio de lista de referencia por producto: el mas alto de la zona
 * `Zacatecas`. Es una eleccion, pero es UNA: antes esta pantalla valuaba el
 * mismo inventario con dos precios distintos, y el otro era
 * `listas_precios[0]`, o sea la primera fila que devolviera Postgres, de
 * cualquier zona y sin orden garantizado.
 */
async function getPreciosRetailPorProducto(): Promise<Map<string, number>> {
  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase
      .from('listas_precios')
      .select('id_producto, precio_final, zona')
      .eq('zona', ZONA_PRECIO_REFERENCIA)

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

/** Unico precio con el que esta pantalla valua una botella. */
function precioReferencia(
  producto: Pick<Producto, 'id' | 'costo_unitario'>,
  preciosRetailPorProducto: Map<string, number>
): number {
  return preciosRetailPorProducto.get(producto.id) ?? producto.costo_unitario ?? 0
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
      return sum + producto.stock_actual * precioReferencia(producto, preciosRetailPorProducto)
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
  
  // El ledger se pide UNA vez, completo (el stock lo necesita entero), y el rango
  // se recorta aqui con los mismos limites `[desde, hastaExclusivo)` que la
  // consulta usaba. Antes eran dos lecturas del mismo ledger con sus dos joins.
  const [productos, movimientosStock, distribuidores, currentUser, preciosRetailPorProducto] = await Promise.all([
    getCatalogoProductos(),
    getInventarioLedger(),
    getDistribuidores(),
    getCurrentUser(),
    getPreciosRetailPorProducto()
  ])
  const movimientosRango = recortarAlRango(movimientosStock, fechaInicio, fechaFin)

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
          // AJUSTE_INVENTARIO (2026-11-03): correccion del ADMIN sobre la cubeta, cantidad CON SIGNO.
          if (mov.tipo_movimiento.startsWith('ENTRADA') || mov.tipo_movimiento === 'AJUSTE_INVENTARIO') return acc + mov.cantidad;
          if (mov.tipo_movimiento.startsWith('SALIDA') || mov.tipo_movimiento === 'MERMA') return acc - mov.cantidad;
          return acc;
        }, 0);

        const precioFinal = precioReferencia(producto, preciosRetailPorProducto);
        
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
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <h1 className="text-2xl font-bold text-gray-800 sm:text-3xl">Control de Inventario</h1>
        {canMutate && (
          <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end md:gap-3">
            <Link
              href="/dashboard/inventario/nuevo"
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 sm:w-auto sm:flex-none"
            >
              Producción (Envasar)
            </Link>
            <Link
              href="/dashboard/inventario/compra"
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 sm:w-auto sm:flex-none"
            >
              Comprar Insumos
            </Link>
            <div className="w-full min-w-[9rem] flex-1 sm:w-auto sm:flex-none">
              <LogisticaInversaModal
                productos={productos.map((p) => ({ id: p.id, nombre: p.nombre, sku: p.sku }))}
                distribuidores={distribuidores}
              />
            </div>
          </div>
        )}
      </div>

      {productosConStock.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
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

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6 flex flex-col justify-between">
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

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
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

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Stock Actual por Producto</h2>
            </div>
            <div className="hidden w-full overflow-x-auto md:block">
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

            <div className="grid grid-cols-1 gap-4 p-4 md:hidden">
              {productosConStockOrdenados.map((producto: ProductoConStock) => (
                <div key={producto.id} className="space-y-3 rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-gray-500">Nombre</p>
                      <p className="text-base font-semibold text-gray-900">{producto.nombre}</p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${
                        producto.tipo === 'INSUMO' ? 'bg-gray-100 text-gray-800' : 'bg-blue-100 text-blue-800'
                      }`}
                    >
                      {producto.tipo}
                    </span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">SKU:</span>
                      <span className="text-gray-900">{producto.sku}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Unidad de Medida:</span>
                      <span className="text-gray-900">{producto.unidad_medida}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Stock Actual:</span>
                      <span className={`font-semibold ${producto.stock_actual <= 10 ? 'text-red-600' : 'text-gray-900'}`}>
                        {Number(producto.stock_actual).toFixed(4)}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 overflow-hidden">
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
