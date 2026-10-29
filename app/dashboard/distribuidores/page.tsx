import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import Link from 'next/link'
import { cookies } from 'next/headers'
import { getSemaforoMovimiento } from '@/lib/risk-utils'
import { diasDesde } from '@/lib/actividad'
import { leerUltimaActividadRed } from '@/lib/actividad-servidor'
import { getCurrentUser } from '@/lib/auth-utils'
import { leerSaldosEntidad } from '@/lib/vistas'
import DirectoryTableClient, { type DirectoryRow } from './DirectoryTableClient'

/**
 * Directorio de la red.
 *
 * **Las dos columnas de dinero ya no se calculan aqui.** Antes esta pantalla se
 * traia el `finanzas_ledger` y los `transacciones_tickets` del ambito con
 * SERVICE ROLE —mas dos consultas para la cuenta legacy del ADMIN y una para
 * las cuentas de cada nodo— y corria fila por fila
 * `calcularSaldoPendienteInventarioConsignacion` y
 * `calcularSaldoPorPagarEfectivo`. Ahora las dos cifras vienen hechas de
 * `v_saldo_entidad`, en **una** consulta.
 *
 * Y se lee con el cliente de la SESION, no con service role: la vista es
 * `security_invoker`, asi que un DST obtiene su fila y las de sus locales y
 * nada mas. El recorte deja de depender de un `.in()` que alguien puede
 * olvidar y pasa a imponerlo el RLS de la base.
 *
 * Las dos funciones de `lib/distribuidores-saldos.ts` siguen vivas y probadas:
 * son la referencia contra la que las pruebas comparan la vista.
 */

export const revalidate = 0

interface Entidad {
  id: string
  nombre: string
  nombre_entidad?: string | null
  rol: 'DST' | 'LOC' | 'SOCIO'
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

    // La consulta a `cuentas_financieras` que habia aqui resolvia `id_cuenta`
    // para acotar el ledger del directorio. Ese ledger ya no se lee: el saldo
    // lo da `v_saldo_entidad`, y ninguna columna de la tabla usa la cuenta.
    return (data || []).map((entidad) => ({
      ...entidad,
      rol: entidad.rol as Entidad['rol'],
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

  const [saldos, actividadPorNodo] = await Promise.all([
    // Con el cliente de la SESION: la vista es `security_invoker` y recorta
    // sola. Con service role devolveria la red entera.
    leerSaldosEntidad(supabaseClient),
    // Service role a proposito, igual que antes: estas dos alimentan el
    // semaforo, no el dinero. Antes construian por su cuenta el cliente de
    // NAVEGADOR y respondian `permission denied` en silencio: los semaforos
    // salian todos rojos.
    // Ronda 2 (auditoria 2026-10-29): la MISMA lectura y regla que el Dashboard
    // General (`lib/actividad.ts`). Antes: otra regla, otro numero.
    leerUltimaActividadRed(serviceRoleClient, entidades)
  ])

  const saldoPorEntidad = new Map(saldos.map((fila) => [fila.id_entidad, fila]))
  const kpis = calcularKPIs(entidades)
  const canMutate = currentUser?.rol !== 'SOCIO'
  const directorioRows: DirectoryRow[] = entidades.map((entidad: Entidad) => {
    const parentIdRaw = entidad.id_nodo_padre ?? entidad.id_padre
    const parentId = typeof parentIdRaw === 'string' ? parentIdRaw.trim() : null
    const padre = entidades.find((e) => e.id === parentId)
    const isDirectLine = !entidad.id_nodo_padre && !entidad.id_padre
    // Las dos cifras vienen calculadas de `v_saldo_entidad`. Si la sesion no
    // alcanza a ver la fila del nodo, se muestra 0: nunca una cifra inventada.
    const saldo = saldoPorEntidad.get(entidad.id)
    const saldoPendiente = Number(saldo?.saldo_pendiente_consignacion ?? 0)
    const saldoPorPagar = Number(saldo?.saldo_por_pagar_efectivo ?? 0)

    const diasSinSeguimiento = diasDesde(actividadPorNodo.get(entidad.id) ?? null)
    const semaforo = getSemaforoMovimiento(diasSinSeguimiento)

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
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
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

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
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

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
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

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 overflow-hidden">
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
