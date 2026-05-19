export const dynamic = 'force-dynamic'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import {
  calcularEgresosAdmin,
  calcularFechasPorRango,
  calcularPasivosFiscalesAdmin,
  getDesgloseCategorias
} from '@/lib/dashboard-utils'
import { movimientoContableEfectivo } from '@/lib/finance-utils'
import type { CurrentUser } from '@/lib/auth-utils'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import PendingApprovalsPanel from './PendingApprovalsPanel'
import MovimientosTable from './MovimientosTable'
import { CategoryBreakdown } from '@/components/dashboard/CategoryBreakdown'

interface MovimientoFinanciero {
  id: string
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  tipo_movimiento: string
  monto: number
  categoria: string
  categoria_gasto?: string | null
  fecha_movimiento: string
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'ANULADO' | 'ACTIVO'
  usuario_creador?: string | null
  cuenta_destino: { nombre: string } | null
  entidad_relacionada: { nombre: string } | null
}

interface ResumenFinanciero {
  ingresos: number
  egresos: number
  balance: number
}

interface CategoriaResumen {
  categoria: string
  monto: number
  porcentaje: number
}

interface MovimientoQueryRow extends Omit<MovimientoFinanciero, 'cuenta_destino' | 'entidad_relacionada'> {
  cuenta_destino: { nombre: string } | { nombre: string }[] | null
  entidad_relacionada: { nombre: string } | { nombre: string }[] | null
}

const TIPOS_INGRESO_CAJA_BRUTO = new Set(['INGRESO_VENTA', 'ABONO_DEUDA'])

function esIngresoCajaBrutoAdmin(tipoMovimiento: string): boolean {
  return TIPOS_INGRESO_CAJA_BRUTO.has(tipoMovimiento)
}

function movimientoTocaCuentaAdmin(
  m: Pick<MovimientoFinanciero, 'id_cuenta_destino' | 'id_cuenta_origen'>,
  adminAccountSet: Set<string>
): boolean {
  return (
    Boolean(m.id_cuenta_destino && adminAccountSet.has(m.id_cuenta_destino)) ||
    Boolean(m.id_cuenta_origen && adminAccountSet.has(m.id_cuenta_origen))
  )
}

function filtrarMovimientosFirewallAdmin(
  movimientos: MovimientoFinanciero[],
  adminAccountIds: string[]
): MovimientoFinanciero[] {
  if (adminAccountIds.length === 0) return movimientos
  const adminAccountSet = new Set(adminAccountIds)
  return movimientos.filter((m) => movimientoTocaCuentaAdmin(m, adminAccountSet))
}

async function getMovimientos(fechaInicio?: string, fechaFin?: string): Promise<MovimientoFinanciero[]> {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set() {
            // No-op en server component
          },
          remove() {
            // No-op en server component
          }
        }
      }
    )
    
    let query = supabase
      .from('finanzas_ledger')
      .select(`
        id,
        id_cuenta_origen,
        id_cuenta_destino,
        tipo_movimiento,
        monto,
        categoria,
        categoria_gasto,
        fecha_movimiento,
        status,
        usuario_creador,
        cuenta_destino:cuentas_financieras!id_cuenta_destino(nombre),
        entidad_relacionada:entidades!finanzas_ledger_id_entidad_relacionada_fkey(nombre)
      `)
      .order('fecha_movimiento', { ascending: false })
      .limit(1000)

    if (fechaInicio && fechaFin) {
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
      console.error('Error fetching movimientos:', error)
      return []
    }

    return ((data as MovimientoQueryRow[] | null) || []).map((row) => ({
      ...row,
      cuenta_destino: Array.isArray(row.cuenta_destino)
        ? (row.cuenta_destino[0] ?? null)
        : (row.cuenta_destino ?? null),
      entidad_relacionada: Array.isArray(row.entidad_relacionada)
        ? (row.entidad_relacionada[0] ?? null)
        : (row.entidad_relacionada ?? null)
    }))
  } catch (error) {
    console.error('Error in getMovimientos:', error)
    return []
  }
}

function calcularResumen(
  movimientos: MovimientoFinanciero[],
  adminAccountIds: string[]
): ResumenFinanciero {
  const adminAccountSet = new Set(adminAccountIds)
  const movimientosActivos = movimientos.filter((m) =>
    movimientoContableEfectivo(m.status, m.categoria)
  )

  const ingresos = movimientosActivos
    .filter((m) => esIngresoCajaBrutoAdmin(m.tipo_movimiento))
    .filter((m) => m.id_cuenta_destino != null && adminAccountSet.has(m.id_cuenta_destino))
    .reduce((sum, m) => sum + m.monto, 0)

  const egresos = calcularEgresosAdmin(movimientosActivos, adminAccountIds)

  const balance = ingresos - egresos
  return { ingresos, egresos, balance }
}

async function getAdminAccountIds(): Promise<string[]> {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          }
        }
      }
    )
    const { data: adminEntity, error: adminError } = await supabase
      .from('entidades')
      .select('id')
      .eq('rol', 'ADMIN')
      .limit(1)
      .maybeSingle()
    if (adminError || !adminEntity?.id) return []

    const { data: cuentas, error: cuentasError } = await supabase
      .from('cuentas_financieras')
      .select('id')
      .eq('id_entidad', adminEntity.id)
    if (cuentasError || !cuentas) return []

    return cuentas.map((cuenta) => cuenta.id)
  } catch {
    return []
  }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function SummaryCard({
  title,
  amount,
  color,
  helperText
}: {
  title: string
  amount: number
  color: string
  helperText?: string
}) {
  const colorClasses = {
    green: 'bg-green-50 border-green-200 text-green-800',
    red: 'bg-red-50 border-red-200 text-red-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    purple: 'bg-purple-50 border-purple-200 text-purple-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800'
  }

  return (
    <div className={`p-6 rounded-lg border ${colorClasses[color as keyof typeof colorClasses]}`}>
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      <p className="text-2xl font-bold">{formatCurrency(amount)}</p>
      {helperText && (
        <p className="mt-1 text-xs opacity-80">{helperText}</p>
      )}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="text-center py-12">
      <div className="text-gray-400 text-6xl mb-4">💰</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">La caja está limpia</h3>
      <p className="text-gray-500">No hay movimientos financieros registrados aún.</p>
    </div>
  )
}

function FinanzasAuthSkeleton() {
  return (
    <div className="space-y-8 animate-pulse" aria-busy="true" aria-label="Cargando datos financieros">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-lg bg-gray-200/80 border border-gray-100" />
        ))}
      </div>
      <div className="h-40 rounded-lg bg-gray-100 border border-gray-200" />
      <div className="h-72 rounded-lg bg-white border border-gray-200 shadow-sm" />
    </div>
  )
}

export default async function FinanzasPage() {
  const cookieStore = await cookies()
  if (process.env.NODE_ENV === 'development') {
    console.log('🔑 [AUTH DEBUG] Cookie store accesible:', Boolean(cookieStore))
  }
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)

  let movimientosHistoricos: MovimientoFinanciero[] = []
  let movimientosPeriodo: MovimientoFinanciero[] = []
  let categorias: CategoriaResumen[] = []
  let currentUser: CurrentUser | null = null
  let adminAccountIds: string[] = []

  try {
    const results = await Promise.allSettled([
      getMovimientos(),
      getMovimientos(fechaInicio, fechaFin),
      getCurrentUser(),
      getAdminAccountIds()
    ])

    movimientosHistoricos = results[0].status === 'fulfilled' ? results[0].value : []
    movimientosPeriodo = results[1].status === 'fulfilled' ? results[1].value : []
    currentUser = results[2].status === 'fulfilled' ? results[2].value : null
    adminAccountIds = results[3].status === 'fulfilled' ? results[3].value : []
  } catch (error) {
    console.error('🕵️‍♂️ [OJO DE DIOS] Error obteniendo datos:', error)
    currentUser = null
  }

  const userRole = (currentUser?.rol?.toUpperCase() || 'INVITADO') as string
  const isAdmin = userRole === 'ADMIN' || userRole === 'ADMINISTRADOR'
  const canMutate = isAdmin || userRole === 'SUB-ADMIN'
  const aplicarFirewallFinanzasAdmin =
    adminAccountIds.length > 0 &&
    (userRole === 'ADMIN' || userRole === 'ADMINISTRADOR' || userRole === 'SUB-ADMIN')

  try {
    categorias = (await getDesgloseCategorias(
      fechaInicio,
      fechaFin,
      aplicarFirewallFinanzasAdmin ? adminAccountIds : undefined
    )) as CategoriaResumen[]
  } catch (error) {
    console.error('Error obteniendo desglose de categorías:', error)
    categorias = []
  }

  const movimientosHistoricosVista = aplicarFirewallFinanzasAdmin
    ? filtrarMovimientosFirewallAdmin(movimientosHistoricos, adminAccountIds)
    : movimientosHistoricos
  const movimientosPeriodoVista = aplicarFirewallFinanzasAdmin
    ? filtrarMovimientosFirewallAdmin(movimientosPeriodo, adminAccountIds)
    : movimientosPeriodo

  const resumenHistorico = calcularResumen(movimientosHistoricosVista, adminAccountIds)
  const resumenPeriodo = calcularResumen(movimientosPeriodoVista, adminAccountIds)
  const reservasFiscales = calcularPasivosFiscalesAdmin(
    movimientosHistoricosVista,
    adminAccountIds
  )
  const sessionUserMissing = !currentUser

  if (process.env.NODE_ENV === 'development') {
    console.log(
      '🕵️‍♂️ [OJO DE DIOS] Usuario actual detectado:',
      currentUser?.email || 'No autenticado',
      '| Rol:',
      userRole
    )
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-gray-800">Dashboard Financiero</h1>
        {canMutate && (
          <div className="flex gap-2">
            <Link
              href="/pos"
              className="bg-gray-800 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-900"
            >
              📦 Ir al POS
            </Link>
            <Link
              href="/dashboard/finanzas/nuevo"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              + Nuevo Movimiento
            </Link>
          </div>
        )}
      </div>

      {/* Panel de aprobación visible solo para ADMIN, justo debajo del título */}
      {isAdmin && <PendingApprovalsPanel isSubAdmin={(currentUser?.rol as string) === 'SUB-ADMIN'} />}

      {sessionUserMissing ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">Verificando sesión…</p>
          <FinanzasAuthSkeleton />
        </div>
      ) : movimientosHistoricosVista.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <SummaryCard
              title="Ingresos del Periodo"
              amount={resumenPeriodo.ingresos}
              color="green"
              helperText="En este periodo"
            />
            <SummaryCard
              title="Egresos del Periodo"
              amount={resumenPeriodo.egresos}
              color="red"
              helperText="En este periodo"
            />
            <SummaryCard
              title="Balance Neto"
              amount={resumenHistorico.balance}
              color={resumenHistorico.balance >= 0 ? 'blue' : 'red'}
              helperText="Acumulado histórico"
            />
          </div>

          <div className="bg-white rounded-lg border border-purple-200 p-6">
            <h2 className="text-lg font-semibold text-purple-900">Obligaciones Fiscales (Reservas)</h2>
            <p className="text-sm text-purple-700 mt-1">Pasivos históricos segregados fuera de caja líquida.</p>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <SummaryCard
                title="IVA por Pagar"
                amount={reservasFiscales.ivaPorPagar}
                color="purple"
                helperText="Acumulado PASIVO_IVA"
              />
              <SummaryCard
                title="IEPS por Pagar"
                amount={reservasFiscales.iepsPorPagar}
                color="amber"
                helperText="Acumulado PASIVO_IEPS"
              />
            </div>
          </div>

          <CategoryBreakdown categorias={categorias} />

          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">Movimientos Financieros</h2>
            </div>
            {movimientosPeriodoVista.length === 0 ? (
              <div className="px-6 py-8 text-sm text-gray-500">
                No hay movimientos en el periodo seleccionado.
              </div>
            ) : null}
            <MovimientosTable
              movimientos={movimientosPeriodoVista}
              sessionEmail={currentUser?.email ?? null}
              sessionRole={currentUser?.rol ?? null}
            />
          </div>
        </>
      )}
    </div>
  )
}
