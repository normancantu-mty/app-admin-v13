import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { calculateWaterfall } from '@/lib/pricing-waterfall'

export const dynamic = 'force-dynamic'

type FiscalidadSimulada = 'LIBRE' | 'FULL_TAX' | 'IVA_ONLY'

export default async function CatalogoPage({
  searchParams
}: {
  searchParams: Promise<{
    fiscalidad?: string | string[]
    localId?: string | string[]
  }>
}) {
  const resolvedSearchParams = await searchParams
  const currencyFormatter = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
  })
  const fiscalidadQuery = Array.isArray(resolvedSearchParams.fiscalidad)
    ? resolvedSearchParams.fiscalidad[0]
    : resolvedSearchParams.fiscalidad
  const fiscalidadSimulada: FiscalidadSimulada = fiscalidadQuery === 'FULL_TAX' || fiscalidadQuery === 'IVA_ONLY'
    ? fiscalidadQuery
    : 'LIBRE'
  const localIdQuery = Array.isArray(resolvedSearchParams.localId)
    ? resolvedSearchParams.localId[0]
    : resolvedSearchParams.localId

  const cookieStore = await cookies()
  const supabase = createServerClient(
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

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: entidadActual } = user?.email
    ? await supabase
        .from('entidades')
        .select('id, rol, comision_base, comision_base_local, comision_hijo_local, aplica_redondeo_costo')
        .eq('email', user.email)
        .single()
    : { data: null }

  const rolActual = (entidadActual?.rol === 'DST' || entidadActual?.rol === 'LOC' || entidadActual?.rol === 'ADMIN'
    ? entidadActual.rol
    : 'LOC') as 'ADMIN' | 'DST' | 'LOC'

  const { data: entidadesSimulables } = rolActual === 'ADMIN'
    ? await supabase
        .from('entidades')
        .select('id, nombre, rol, comision_base, comision_base_local, aplica_redondeo_costo')
        .in('rol', ['DST', 'LOC'])
        .order('nombre', { ascending: true })
    : rolActual === 'DST' && entidadActual?.id
      ? await supabase
          .from('entidades')
          .select('id, nombre, rol, comision_base, comision_base_local, aplica_redondeo_costo')
          .eq('id_padre', entidadActual.id)
          .order('nombre', { ascending: true })
      : { data: [] }
  const entidadSeleccionada = (entidadesSimulables || []).find((item) => item.id === localIdQuery) || null

  const { data: productos, error } = await supabase
    .from('catalogo_productos')
    .select(`
      id,
      sku,
      nombre,
      costo_unitario,
      listas_precios (precio_final)
    `)
    .eq('tipo', 'TERMINADO')
    .order('nombre', { ascending: true })

  if (error) console.error('Error Productos:', JSON.stringify(error))

  const catalogoFinal = (productos || []).map((producto) => {
    const waterfall = calculateWaterfall(
      producto,
      entidadActual || {},
      rolActual,
      fiscalidadSimulada,
      entidadSeleccionada
    )
    return {
      ...producto,
      waterfall
    }
  })

  if (error) {
    return <div>Error al cargar el catálogo</div>
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Catálogo de Productos y Waterfall de Precio</h1>
      <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
        <form method="GET" className="flex flex-wrap items-end gap-4">
          <div>
            <label htmlFor="fiscalidad" className="block text-sm font-medium text-gray-700 mb-1">
              Simular margen de venta cobrando en
            </label>
            <select
              id="fiscalidad"
              name="fiscalidad"
              defaultValue={fiscalidadSimulada}
              className="px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="LIBRE">Efectivo (Sin Impuestos)</option>
              <option value="FULL_TAX">Cuenta Fresnillo (IVA + IEPS)</option>
              <option value="IVA_ONLY">Cuenta Personal (Solo IVA)</option>
            </select>
          </div>

          {(rolActual === 'DST' || rolActual === 'ADMIN') && (
            <div>
              <label htmlFor="localId" className="block text-sm font-medium text-gray-700 mb-1">
                Simular venta hacia
              </label>
              <select
                id="localId"
                name="localId"
                defaultValue={entidadSeleccionada?.id || ''}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                <option value="">Sin entidad seleccionada</option>
                {(entidadesSimulables || []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.nombre} ({item.rol})
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="submit"
            className="px-3 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700"
          >
            Aplicar simulación
          </button>
        </form>
      </div>
      <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Producto</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Precio Público</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Impuestos (SAT)</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tu Costo Operativo</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Precio para Entidad</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ganancia Directa</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ganancia por Red</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {catalogoFinal.map((producto) => (
              <tr key={producto.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{producto.nombre}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                  {currencyFormatter.format(producto.waterfall.precioPublico)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-600">
                  {currencyFormatter.format(producto.waterfall.impuestosRetenidos)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">
                  {currencyFormatter.format(producto.waterfall.tuCosto)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-indigo-700 font-medium">
                  {producto.waterfall.precioLocal > 0
                    ? currencyFormatter.format(producto.waterfall.precioLocal)
                    : '—'}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-emerald-700 font-medium">
                  {currencyFormatter.format(producto.waterfall.margenDirecto)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-amber-700 font-medium">
                  {currencyFormatter.format(producto.waterfall.comisionPasiva || 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
