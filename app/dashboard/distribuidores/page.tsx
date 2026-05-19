import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import Link from 'next/link'
import { cookies } from 'next/headers'
import {
  getMovimientosFinanzas,
  getMovimientosInventario,
  calcularUltimoMovimiento,
  getSemaforoMovimiento
} from '@/lib/risk-utils'
import {
  calcularSaldoPendienteInventarioConsignacion,
  calcularSaldoPorPagarEfectivo
} from '@/lib/distribuidores-saldos'
import { getCurrentUser } from '@/lib/auth-utils'
import DirectoryTableClient, { type DirectoryRow } from './DirectoryTableClient'

export const revalidate = 0

interface Entidad {
  id: string
  nombre: string
  nombre_entidad?: string | null
  rol: 'DST' | 'LOC' | 'SOCIO'
  id_cuenta: string | null
  zona: string
  telefono: string | null
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
  comision_logistica: number
  aplica_redondeo_costo: boolean
  id_nodo_padre: string | null
  id_padre: string | null
  ultimo_seguimiento: string | null
  ubicacion_maps?: string | null
  fecha_ultimo_abono?: string | null
  fecha_ultimo_seguimiento?: string | null
}

interface FinanzaLedger {
  id: string
  id_entidad_relacionada: string
  id_cuenta_destino: string | null
  tipo_movimiento: string
  monto: number
  categoria?: string | null
}

interface KPIsRed {
  totalRed: number
  distribuidores: number
  locales: number
}

type SessionRole = 'ADMIN' | 'DST' | 'LOC' | 'SOCIO' | 'SUB-ADMIN' | 'TRABAJADOR'

async function getServerSupabaseClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        }
      }
    }
  )
}

function getServiceRoleSupabaseClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

async function getEntidades(
  supabaseClient: SupabaseClient<Database>,
  sessionRole: string | null | undefined,
  currentUserEntityId: string | null | undefined
): Promise<Entidad[]> {
  try {
    console.log('[TKT-046] Fetching entities for role:', sessionRole, 'ID:', currentUserEntityId)

    if (!sessionRole || !currentUserEntityId) {
      return []
    }

    let query = supabaseClient
      .from('entidades')
      .select('*')
      .neq('rol', 'ADMIN')
      .order('rol', { ascending: true })

    if (sessionRole === 'DST') {
      query = query.or(`id.eq.${currentUserEntityId},id_nodo_padre.eq.${currentUserEntityId}`)
    } else if (sessionRole === 'LOC' || sessionRole === 'TRABAJADOR') {
      return []
    } else if (sessionRole !== 'ADMIN') {
      return []
    }

    const { data, error } = await query

    if (error) {
      console.error(
        'Error fetching entidades:',
        JSON.stringify(error, null, 2),
        error.message,
        error.details,
        error.hint
      )
      return []
    }

    // TKT-044 debug temporal: valida si la jerarquia llega del servidor.
    console.log(
      '[TKT-044] Hierarchy payload',
      (data || []).map((entidad) => ({
        id: entidad.id,
        nombre: entidad.nombre,
        id_nodo_padre: entidad.id_nodo_padre,
        id_padre: entidad.id_padre
      }))
    )
    console.log(
      '[TKT-044] prueba01-05 payload',
      (data || []).find((entidad) => entidad.nombre === 'prueba01-05') || null
    )

    const entityIds = (data || []).map((entidad) => entidad.id)
    let cuentasPorEntidad = new Map<string, string>()

    if (entityIds.length > 0) {
      const { data: cuentasData, error: cuentasError } = await supabaseClient
        .from('cuentas_financieras')
        .select('id, id_entidad')
        .in('id_entidad', entityIds)

      if (cuentasError) {
        console.error('Error fetching cuentas_financieras for entidades:', cuentasError)
      } else {
        cuentasPorEntidad = new Map(
          (cuentasData || [])
            .filter((cuenta) => Boolean(cuenta.id_entidad))
            .map((cuenta) => [cuenta.id_entidad as string, cuenta.id])
        )
      }
    }

    return (data || []).map((entidad) => ({
      ...entidad,
      rol: entidad.rol as Entidad['rol'],
      id_cuenta: cuentasPorEntidad.get(entidad.id) ?? null,
      telefono: entidad.telefono ?? null,
      comision_base: entidad.comision_base ?? 0,
      comision_base_local: entidad.comision_base_local ?? 0,
      comision_hijo_local: entidad.comision_hijo_local ?? 0,
      comision_logistica: entidad.comision_logistica ?? 0,
      aplica_redondeo_costo: entidad.aplica_redondeo_costo ?? true
    }))
  } catch (error) {
    console.error('Error in getEntidades:', error)
    return []
  }
}

async function getFinanzasLedger(
  serviceRoleClient: SupabaseClient<Database>,
  entityIds: string[],
  accountIds: string[]
): Promise<FinanzaLedger[]> {
  if (entityIds.length === 0 && accountIds.length === 0) {
    return []
  }

  try {
    let query = serviceRoleClient
      .from('finanzas_ledger')
      .select('id, id_entidad_relacionada, id_cuenta_destino, tipo_movimiento, monto, categoria')
      .in('status', ['ACTIVO', 'APPROVED'])

    if (entityIds.length > 0 && accountIds.length > 0) {
      query = query.or(
        `id_entidad_relacionada.in.(${entityIds.join(',')}),id_cuenta_destino.in.(${accountIds.join(',')})`
      )
    } else if (entityIds.length > 0) {
      query = query.in('id_entidad_relacionada', entityIds)
    } else {
      query = query.in('id_cuenta_destino', accountIds)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching finanzas_ledger:', error)
      return []
    }

    return (data || []).map((item) => ({
      id: item.id,
      id_entidad_relacionada: item.id_entidad_relacionada ?? '',
      id_cuenta_destino: item.id_cuenta_destino ?? null,
      tipo_movimiento: item.tipo_movimiento ?? '',
      monto: item.monto ?? 0
    }))
  } catch (error) {
    console.error('Error in getFinanzasLedger:', error)
    return []
  }
}

async function mergeDirectorioLegacyFinanzas(
  serviceRoleClient: SupabaseClient<Database>,
  base: FinanzaLedger[],
  entityIds: string[],
  adminLegacyAccountId: string | null
): Promise<FinanzaLedger[]> {
  if (!adminLegacyAccountId || entityIds.length === 0) return base

  const { data, error } = await serviceRoleClient
    .from('finanzas_ledger')
    .select('id, id_entidad_relacionada, id_cuenta_destino, tipo_movimiento, monto, categoria')
    .in('status', ['ACTIVO', 'APPROVED'])
    .in('id_entidad_relacionada', entityIds)
    .eq('id_cuenta_destino', adminLegacyAccountId)

  if (error) {
    console.error('Error merging legacy finanzas (directorio):', error)
    return base
  }

  const byId = new Map(base.map((row) => [row.id, row]))
  for (const row of data || []) {
    byId.set(row.id, {
      id: row.id,
      id_entidad_relacionada: row.id_entidad_relacionada ?? '',
      id_cuenta_destino: row.id_cuenta_destino ?? null,
      tipo_movimiento: row.tipo_movimiento ?? '',
      monto: row.monto ?? 0
    })
  }
  return Array.from(byId.values())
}

async function getAdminLegacyAccountIdForDirectorio(
  serviceRoleClient: SupabaseClient<Database>
): Promise<string | null> {
  const { data: adminEntity, error: adminError } = await serviceRoleClient
    .from('entidades')
    .select('id')
    .eq('rol', 'ADMIN')
    .limit(1)
    .maybeSingle()

  if (adminError || !adminEntity?.id) {
    return null
  }

  const { data: adminAccount, error: accountError } = await serviceRoleClient
    .from('cuentas_financieras')
    .select('id')
    .eq('id_entidad', adminEntity.id)
    .limit(1)
    .maybeSingle()

  if (accountError) {
    return null
  }

  return adminAccount?.id ?? null
}

async function getTickets(
  serviceRoleClient: SupabaseClient<Database>,
  entityIds: string[]
): Promise<
  {
    id_comprador: string | null
    id_vendedor: string | null
    total_cobrado_real: number
    monto_base_ingreso: number
    condicion_pago: 'CONTADO' | 'CONCESION'
    status?: string | null
  }[]
> {
  if (entityIds.length === 0) {
    return []
  }

  try {
    // Tickets se cargan con service role (no dependen del cliente SSR/cookies).
    const { data, error } = await serviceRoleClient
      .from('transacciones_tickets')
      .select('id_comprador, id_vendedor, total_cobrado_real, monto_base_ingreso, condicion_pago, status')
      .or(`id_comprador.in.(${entityIds.join(',')}),id_vendedor.in.(${entityIds.join(',')})`)

    if (error) {
      console.error(
        'Error fetching tickets:',
        JSON.stringify(error, null, 2),
        JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2),
        error.message,
        error.details,
        error.hint
      )
      return []
    }

    return (data || []).map((item) => ({
      id_comprador: item.id_comprador ?? null,
      id_vendedor: item.id_vendedor ?? null,
      total_cobrado_real: item.total_cobrado_real ?? 0,
      monto_base_ingreso: item.monto_base_ingreso ?? 0,
      condicion_pago: item.condicion_pago === 'CONCESION' ? 'CONCESION' : 'CONTADO',
      status: item.status ?? 'ACTIVO'
    }))
  } catch (error) {
    console.error(
      'Error in getTickets:',
      error instanceof Error ? error.stack : JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2),
      error instanceof Error ? error.message : undefined
    )
    return []
  }
}

function getFechaActividadComercial(
  ultimoMovimientoFinanciero: Date | null,
  fechaUltimoSeguimiento?: string | null
): Date | null {
  const fechaSeguimiento = fechaUltimoSeguimiento ? new Date(fechaUltimoSeguimiento) : null

  if (ultimoMovimientoFinanciero && fechaSeguimiento) {
    return ultimoMovimientoFinanciero.getTime() >= fechaSeguimiento.getTime()
      ? ultimoMovimientoFinanciero
      : fechaSeguimiento
  }

  return ultimoMovimientoFinanciero || fechaSeguimiento
}

function calcularDiasDesde(fecha: Date | null): number | null {
  if (!fecha) return null
  const hoy = new Date()
  const inicioHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
  const inicioFecha = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate())
  const diferenciaMs = inicioHoy.getTime() - inicioFecha.getTime()
  const dias = Math.floor(diferenciaMs / (1000 * 60 * 60 * 24))
  return Math.max(dias, 0)
}

function getSeguimientoTexto(diasSinSeguimiento: number | null): string {
  if (diasSinSeguimiento === null) {
    return 'Sin contacto'
  }
  return `${diasSinSeguimiento} días`
}

function calcularKPIs(entidades: Entidad[]): KPIsRed {
  const totalRed = entidades.length
  const distribuidores = entidades.filter(e => e.rol === 'DST').length
  const locales = entidades.filter(e => e.rol === 'LOC').length
  
  return { totalRed, distribuidores, locales }
}

function EmptyState() {
  return (
    <div className="text-center py-12">
      <div className="text-gray-400 text-6xl mb-4">👥</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">No hay distribuidores registrados</h3>
      <p className="text-gray-500">Comienza agregando el primer miembro a tu red.</p>
    </div>
  )
}

export default async function DistribuidoresPage() {
  // Fetch all data in parallel for maximum performance
  const supabaseClient = await getServerSupabaseClient()
  const serviceRoleClient = getServiceRoleSupabaseClient()
  const currentUser = await getCurrentUser()
  const sessionRole = (currentUser?.rol ?? null) as SessionRole | null
  const currentUserEntityId = currentUser?.id ?? null
  const entidades = await getEntidades(supabaseClient, sessionRole, currentUserEntityId)
  const entityIdsForScope = entidades.map((entidad) => entidad.id)
  const accountIdsForScope = entidades
    .map((entidad) => entidad.id_cuenta)
    .filter((idCuenta): idCuenta is string => Boolean(idCuenta))

  const [
    finanzasRaw,
    tickets,
    movimientosFinanzas,
    movimientosInventario
  ] = await Promise.all([
    getFinanzasLedger(serviceRoleClient, entityIdsForScope, accountIdsForScope),
    getTickets(serviceRoleClient, entityIdsForScope),
    getMovimientosFinanzas(),
    getMovimientosInventario()
  ])

  const adminLegacyAccountId = await getAdminLegacyAccountIdForDirectorio(serviceRoleClient)
  let finanzas = await mergeDirectorioLegacyFinanzas(
    serviceRoleClient,
    finanzasRaw,
    entityIdsForScope,
    adminLegacyAccountId
  )
  const kpis = calcularKPIs(entidades)
  const canMutate = currentUser?.rol !== 'SOCIO'
  const directorioRows: DirectoryRow[] = entidades.map((entidad: Entidad) => {
    const parentIdRaw = entidad.id_nodo_padre ?? entidad.id_padre
    const parentId = typeof parentIdRaw === 'string' ? parentIdRaw.trim() : null
    const padre = entidades.find((e) => e.id === parentId)
    const isDirectLine = !entidad.id_nodo_padre && !entidad.id_padre
    const saldoPendiente = calcularSaldoPendienteInventarioConsignacion(
      entidad,
      tickets,
      [entidad.id],
      finanzas.map((f) => ({
        tipo_movimiento: f.tipo_movimiento || null,
        monto: f.monto,
        id_entidad_relacionada: f.id_entidad_relacionada || null,
        categoria: f.categoria || null
      }))
    )
    const saldoPorPagar = calcularSaldoPorPagarEfectivo(entidad.id, finanzas)

    const ultimoMovimiento = calcularUltimoMovimiento(
      entidad.id,
      movimientosFinanzas,
      movimientosInventario
    )
    const ultimaActividadComercial = getFechaActividadComercial(
      ultimoMovimiento,
      entidad.fecha_ultimo_seguimiento ?? entidad.ultimo_seguimiento
    )
    const diasSinSeguimiento = calcularDiasDesde(ultimaActividadComercial)
    const semaforo = diasSinSeguimiento === null ? '⚪' : getSemaforoMovimiento(ultimaActividadComercial)

    return {
      id: entidad.id,
      nombre: entidad.nombre,
      rol: entidad.rol,
      zona: entidad.zona,
      telefono: entidad.telefono ?? null,
      comision_base: entidad.comision_base,
      comision_base_local: entidad.comision_base_local,
      comision_hijo_local: entidad.comision_hijo_local,
      aplica_redondeo_costo: entidad.aplica_redondeo_costo,
      ubicacionMaps: entidad.ubicacion_maps ?? null,
      patrocinador: padre
        ? (padre.nombre_entidad ?? padre.nombre)
        : (isDirectLine ? 'Línea Directa' : 'Padre no encontrado'),
      saldoPendiente,
      saldoPorPagar,
      semaforo,
      seguimientoTexto: getSeguimientoTexto(diasSinSeguimiento)
    }
  })

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-gray-800">Red de Distribuidores</h1>
        {canMutate && (
          <Link
            href="/dashboard/distribuidores/nuevo"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
          >
            + Nuevo Miembro
          </Link>
        )}
      </div>

      {entidades.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Total Red</p>
                  <p className="text-3xl font-bold text-gray-900 mt-2">{kpis.totalRed}</p>
                </div>
                <div className="bg-gray-100 p-3 rounded-full">
                  <span className="text-2xl">🌐</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Distribuidores Directos</p>
                  <p className="text-3xl font-bold text-blue-600 mt-2">{kpis.distribuidores}</p>
                </div>
                <div className="bg-blue-100 p-3 rounded-full">
                  <span className="text-2xl">👔</span>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">Locales</p>
                  <p className="text-3xl font-bold text-purple-600 mt-2">{kpis.locales}</p>
                </div>
                <div className="bg-purple-100 p-3 rounded-full">
                  <span className="text-2xl">🏪</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <DirectoryTableClient
              rows={directorioRows}
              canEdit={currentUser?.rol === 'ADMIN'}
              canDeleteEntity={currentUser?.rol === 'ADMIN'}
              showZonaColumn={currentUser?.rol === 'ADMIN'}
            />
          </div>
        </>
      )}
    </div>
  )
}
