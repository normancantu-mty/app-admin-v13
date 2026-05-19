import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import { getStockEsperadoPorEntidad } from '@/lib/inventario-auditoria'
import CobranzaClient from './CobranzaClient'

export const dynamic = 'force-dynamic'

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export default async function CobranzaPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    notFound()
  }
  if (currentUser.rol === 'SOCIO') {
    notFound()
  }

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

  const { data: entidadObjetivo, error: entidadObjetivoError } = await supabase
    .from('entidades')
    .select('id, nombre, rol, id_nodo_padre, id_padre, comision_base, comision_base_local')
    .eq('id', resolvedParams.id)
    .single()

  if (entidadObjetivoError || !entidadObjetivo) {
    notFound()
  }

  const targetParentId = entidadObjetivo.id_nodo_padre ?? entidadObjetivo.id_padre
  const puedeAuditar =
    currentUser.rol === 'ADMIN' ||
    currentUser.id === entidadObjetivo.id ||
    (currentUser.rol === 'DST' && targetParentId === currentUser.id)

  if (!puedeAuditar) {
    notFound()
  }

  const { data: entidadOperadora, error: entidadOperadoraError } = await supabase
    .from('entidades')
    .select('id, rol, comision_base, comision_base_local, comision_hijo_local')
    .eq('id', currentUser.id)
    .single()

  if (entidadOperadoraError || !entidadOperadora) {
    notFound()
  }

  const { data: cuentasDestino } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id_entidad', entidadOperadora.id)
    .order('nombre', { ascending: true })

  const cuentas = cuentasDestino || []
  if (cuentas.length === 0) {
    return (
      <div className="p-8">
        No hay cuentas destino disponibles para registrar la cobranza.
      </div>
    )
  }

  let cuentaDefault = cuentas.find((cuenta) => normalizeText(cuenta.nombre).startsWith('cta-'))
  if (currentUser.rol === 'ADMIN') {
    const cuentaFresnillo = cuentas.find((cuenta) => normalizeText(cuenta.nombre).includes('fresnillo'))
    cuentaDefault = cuentaFresnillo ?? cuentaDefault ?? cuentas[0]
  } else {
    cuentaDefault = cuentaDefault ?? cuentas[0]
  }

  const stockEsperado = await getStockEsperadoPorEntidad(entidadObjetivo.id)
  const idsProductos = stockEsperado.map((item) => item.idProducto)

  const { data: productos } = idsProductos.length > 0
    ? await supabase
        .from('catalogo_productos')
        .select('id, nombre, costo_unitario, listas_precios(precio_final)')
        .in('id', idsProductos)
    : { data: [] }

  const rows = stockEsperado.map((item) => {
    const producto = (productos || []).find((p) => p.id === item.idProducto)
    // If it's already a decimal (0.15), use it directly. If it's a whole number (15), divide by 100.
    const precioRetail = Number(producto?.listas_precios?.[0]?.precio_final || 0)
    const rawComision = Number(entidadObjetivo.comision_base_local || 0.15)
    const comisionDecimal = rawComision < 1 ? rawComision : (rawComision / 100)
    const precioCobroUnitario = precioRetail * (1 - comisionDecimal)
    return {
      ...item,
      precioCobroUnitario
    }
  })

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-800">Cobrar, contar inventario</h1>
          <p className="text-gray-600 mt-1">
            Entidad auditada: {entidadObjetivo.nombre} ({entidadObjetivo.rol})
          </p>
        </div>
        <Link
          href={`/dashboard/distribuidores/${entidadObjetivo.id}`}
          className="text-blue-600 hover:text-blue-800 text-sm font-medium"
        >
          ← Volver al perfil
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-gray-600">
          No hay productos terminados con stock esperado para esta entidad.
        </div>
      ) : (
        <CobranzaClient
          idEntidadObjetivo={entidadObjetivo.id}
          rows={rows}
          cuentasDestino={cuentas.map((cuenta) => ({ id: cuenta.id, nombre: cuenta.nombre }))}
          cuentaDestinoDefault={cuentaDefault.id}
        />
      )}
    </div>
  )
}
