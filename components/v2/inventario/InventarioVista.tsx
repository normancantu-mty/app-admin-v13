// Paridad v2: copia de app/dashboard/inventario/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.
import { createServerClient } from '@supabase/ssr'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { getCurrentUser } from '@/lib/auth-utils'
import { cookies } from 'next/headers'
import { calcularFechasPorRango, fetchTodasLasFilas, limitesRangoMX } from '@/lib/dashboard-utils'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import LogisticaInversaModal from './LogisticaInversa'
import MovimientosTable from './MovimientosInventario'
import { PestanasInv, type Pestana } from './Pestanas'
import { TablaStock } from './TablaStock'
import { cant } from './formato-inv'

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

/**
 * `sinAcciones`: la pagina `/v2/inventario` ya pone Envasar y Comprar en su encabezado (Paginas v2, 2026-10-29).
 * Inventario compacto (2026-10-30, ejecutor del Socio): KPIs arriba y el detalle en pestañas
 * (Stock, Movimientos y las `extras` que mande la pagina: compras y envasados, lotes). `ver`
 * es la pestaña inicial (`?ver=` de la pagina); `enUrl` escribe la pestaña elegida en la URL.
 */
export default async function InventarioVista({
  sinAcciones = false,
  extras = [],
  ver,
  enUrl = false
}: { sinAcciones?: boolean; extras?: Pestana[]; ver?: string; enUrl?: boolean } = {}) {
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
          if (mov.tipo_movimiento.startsWith('ENTRADA')) return acc + mov.cantidad;
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

  const piezasConcesion = inventarioConcesion.reduce((s, p) => s + Number(p.stock_consignado), 0)
  const terminados = productosConStock.filter((p) => p.tipo === 'TERMINADO')
  const piezasTerminadas = terminados.reduce((s, p) => s + Math.max(0, p.stock_actual), 0)
  const stockBajo = productosConStock.filter((p) => p.stock_actual <= 10).length
  const filasStock = productosConStockOrdenados.map((p) => ({
    id: p.id,
    sku: p.sku,
    nombre: p.nombre,
    tipo: p.tipo,
    unidad_medida: p.unidad_medida,
    stock_actual: p.stock_actual
  }))

  const pestanas: Pestana[] = [
    { id: 'stock', titulo: 'Stock', cuenta: productosConStock.length, contenido: <TablaStock productos={filasStock} /> },
    {
      id: 'movimientos',
      titulo: 'Movimientos',
      cuenta: ultimosMovimientos.length,
      contenido: (
        <MovimientosTable
          movimientos={ultimosMovimientos}
          sessionEmail={currentUser?.email ?? null}
          sessionRole={currentUser?.rol ?? null}
          canMutate={Boolean(canMutate)}
        />
      )
    },
    ...(inventarioConcesion.length > 0
      ? [
          {
            id: 'concesion',
            titulo: 'En concesión',
            cuenta: inventarioConcesion.length,
            contenido: (
              <div className="inv-scroll">
                <table className="t inv-t">
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th className="r">Piezas</th>
                      <th className="r">Valor comercial</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inventarioConcesion.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <b>{p.nombre}</b>
                          <div className="inv-sub mono">{p.sku}</div>
                        </td>
                        <td className="r">{Number(p.stock_consignado).toFixed(0)} pz</td>
                        <td className="r">{formatCurrency(p.valor_consignado)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        ]
      : []),
    ...extras
  ]

  return (
    <div className="inv">
      <div className="inv-barra">
        <p className="inv-sub">Stock de la matriz contra todo el ledger; KPIs y movimientos del rango global.</p>
        {canMutate && (
          <div className="fila-acc">
            {!sinAcciones && (
              <>
                <AbrirModal href="/v2/m/envasado" titulo="Registrar envasado" tam="md" className="btn p">
                  Producción (Envasar)
                </AbrirModal>
                <AbrirModal href="/v2/m/compra" titulo="Comprar insumos" tam="md" className="btn">
                  Comprar Insumos
                </AbrirModal>
              </>
            )}
            <LogisticaInversaModal productos={productos.map((p) => ({ id: p.id, nombre: p.nombre, sku: p.sku }))} distribuidores={distribuidores} />
          </div>
        )}
      </div>

      {productosConStock.length === 0 ? (
        <div className="vacio">
          <b>No hay productos en el catálogo</b>
          Comienza agregando productos a tu inventario.
        </div>
      ) : (
        <>
          <div className="kpis inv-kpis" data-testid="inv-kpis">
            <div className="kpi fuerte">
              <span className="t">Valor comercial</span>
              <span className="v pos">{formatCurrency(kpis.valorComercialInventario)}</span>
              <span className="d">
                <b>{cant(piezasTerminadas)}</b> pz terminadas · precio Zacatecas
              </span>
            </div>
            <div className="kpi">
              <span className="t">En concesión</span>
              <span className="v">{formatCurrency(valorTotalConcesion)}</span>
              <span className="d">
                {inventarioConcesion.length === 0 ? (
                  'No hay stock en concesión'
                ) : (
                  <>
                    <b>{cant(piezasConcesion)}</b> pz en {inventarioConcesion.length} producto{inventarioConcesion.length === 1 ? '' : 's'}
                  </>
                )}
              </span>
            </div>
            <div className="kpi">
              <span className="t">Mermas del rango</span>
              <span className="v">{Number(kpis.totalMermas).toFixed(2)}</span>
              <span className="d">unidades mermadas (no anuladas)</span>
            </div>
            <div className="kpi">
              <span className="t">Stock bajo</span>
              <span className={`v ${stockBajo > 0 ? 'neg' : ''}`}>{stockBajo}</span>
              <span className="d">
                productos con 10 o menos de {productosConStock.length}
              </span>
            </div>
          </div>

          <PestanasInv pestanas={pestanas} inicial={ver} enUrl={enUrl} />
        </>
      )}
    </div>
  )
}
