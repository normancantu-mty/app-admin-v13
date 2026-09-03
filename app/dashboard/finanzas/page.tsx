/**
 * Dashboard Financiero.
 *
 * **El Account_Firewall ya no se arma aqui.** Antes esta pantalla resolvia la
 * entidad ADMIN y sus cuentas (dos consultas), se traia el ledger historico
 * COMPLETO con sus dos joins de nombres, y sobre esas filas corria en memoria
 * `filtrarMovimientosFirewallAdmin`, `calcularResumen`, `calcularEgresosAdmin` y
 * `calcularPasivosFiscalesAdmin`. Ahora:
 *
 *  · Ingresos, Egresos y Balance salen de las banderas de
 *    `v_movimiento_clasificado`.
 *  · IVA e IEPS por pagar salen de `v_pasivo_fiscal`, una sola fila.
 *  · La tabla de movimientos sigue leyendo `finanzas_ledger`, porque **necesita
 *    los nombres de la cuenta destino y de la entidad relacionada y una vista
 *    no tiene llaves foraneas: PostgREST no puede embeber recursos sobre ella.**
 *    Lo que si cambio es el recorte: las filas se filtran por los `id` que la
 *    vista marco con `toca_cuenta_admin`, no por un firewall recalculado.
 *
 * Las funciones de `lib/dashboard-utils.ts` que dejaron de llamarse siguen
 * exportadas y probadas: son la referencia de la prueba de equivalencia.
 */
export const dynamic = 'force-dynamic'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import {
  calcularFechasPorRango,
  fetchTodasLasFilas,
  getDesgloseCategorias,
  limitesRangoMX
} from '@/lib/dashboard-utils'
import { leerPasivoFiscal, type FilaMovimientoClasificado } from '@/lib/vistas'
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
  descripcion?: string | null
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

/**
 * Cliente por request con la sesion del usuario. Las vistas son
 * `security_invoker`: leen con ESTE cliente, asi que un DST no obtiene ni una
 * fila que su RLS no le deje ver.
 */
async function getServerSupabaseClient() {
  const cookieStore = await cookies()
  return createServerClient(
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
}

async function getMovimientos(fechaInicio?: string, fechaFin?: string): Promise<MovimientoFinanciero[]> {
  try {
    const supabase = await getServerSupabaseClient()
    
    // `descripcion` va en el select a proposito: `esPagoImpuestoIva/Ieps` la lee
    // para descontar los pagos de impuesto del pasivo, y sin ella esa resta
    // nunca podia ocurrir.
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const data = await fetchTodasLasFilas<MovimientoQueryRow>(() => {
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
          descripcion,
          fecha_movimiento,
          status,
          usuario_creador,
          cuenta_destino:cuentas_financieras!id_cuenta_destino(nombre),
          entidad_relacionada:entidades!finanzas_ledger_id_entidad_relacionada_fkey(nombre)
        `)
        .order('fecha_movimiento', { ascending: false })

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'finanzas getMovimientos')

    return data.map((row) => ({
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

/** Fila de `v_movimiento_clasificado`: lo minimo que necesitan las tarjetas. */
type MovimientoClasificado = Pick<
  FilaMovimientoClasificado,
  'id' | 'monto' | 'toca_cuenta_admin' | 'es_ingreso_admin' | 'es_egreso_admin'
>

/**
 * Movimientos ya clasificados por la base para el periodo pedido.
 *
 * Falla cerrada sin condicional: quien no ve las cuentas del ADMIN recibe las
 * cuatro banderas en `false`, que es lo mismo que devolvia
 * `filtrarMovimientosFirewallAdmin` con la lista de cuentas vacia.
 */
async function getMovimientosClasificados(
  fechaInicio?: string,
  fechaFin?: string
): Promise<MovimientoClasificado[]> {
  try {
    const supabase = await getServerSupabaseClient()
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    return await fetchTodasLasFilas<MovimientoClasificado>(() => {
      let query = supabase
        .from('v_movimiento_clasificado')
        .select('id, monto, toca_cuenta_admin, es_ingreso_admin, es_egreso_admin')

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query as never
    }, 'finanzas v_movimiento_clasificado')
  } catch (error) {
    console.error('Error in getMovimientosClasificados:', error)
    return []
  }
}

/** Las tres tarjetas de arriba, sumando las banderas que ya puso la vista. */
function resumirClasificados(filas: MovimientoClasificado[]): ResumenFinanciero {
  const ingresos = filas.filter((m) => m.es_ingreso_admin).reduce((sum, m) => sum + Number(m.monto), 0)
  const egresos = filas.filter((m) => m.es_egreso_admin).reduce((sum, m) => sum + Number(m.monto), 0)
  return { ingresos, egresos, balance: ingresos - egresos }
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

  let movimientosPeriodo: MovimientoFinanciero[] = []
  let clasificadosHistoricos: MovimientoClasificado[] = []
  let clasificadosPeriodo: MovimientoClasificado[] = []
  let categorias: CategoriaResumen[] = []
  let currentUser: CurrentUser | null = null
  let reservasFiscales = { ivaPorPagar: 0, iepsPorPagar: 0 }

  try {
    // El historico ya no se trae con sus dos joins de nombres: la tabla de abajo
    // solo pinta el periodo, y las tarjetas del historico solo necesitan monto y
    // banderas.
    const results = await Promise.allSettled([
      getMovimientos(fechaInicio, fechaFin),
      getMovimientosClasificados(),
      getMovimientosClasificados(fechaInicio, fechaFin),
      getCurrentUser()
    ])

    movimientosPeriodo = results[0].status === 'fulfilled' ? results[0].value : []
    clasificadosHistoricos = results[1].status === 'fulfilled' ? results[1].value : []
    clasificadosPeriodo = results[2].status === 'fulfilled' ? results[2].value : []
    currentUser = results[3].status === 'fulfilled' ? results[3].value : null
  } catch (error) {
    console.error('🕵️‍♂️ [OJO DE DIOS] Error obteniendo datos:', error)
    currentUser = null
  }

  const userRole = (currentUser?.rol?.toUpperCase() || 'INVITADO') as string
  const isAdmin = userRole === 'ADMIN' || userRole === 'ADMINISTRADOR'
  const canMutate = isAdmin || userRole === 'SUB-ADMIN'
  // Sin `adminAccountIds.length > 0`: si no se resuelve el ADMIN, el firewall
  // tiene que dejar la vista vacia, no abrirse y mostrar el ledger de la red.
  const aplicarFirewallFinanzasAdmin =
    userRole === 'ADMIN' || userRole === 'ADMINISTRADOR' || userRole === 'SUB-ADMIN'

  try {
    categorias = (await getDesgloseCategorias(
      fechaInicio,
      fechaFin,
      aplicarFirewallFinanzasAdmin
    )) as CategoriaResumen[]
  } catch (error) {
    console.error('Error obteniendo desglose de categorías:', error)
    categorias = []
  }

  try {
    const pasivo = await leerPasivoFiscal(await getServerSupabaseClient())
    reservasFiscales = {
      ivaPorPagar: Number(pasivo?.iva_por_pagar ?? 0),
      iepsPorPagar: Number(pasivo?.ieps_por_pagar ?? 0)
    }
  } catch (error) {
    console.error('Error obteniendo pasivos fiscales:', error)
  }

  // El recorte de la tabla ya no recalcula el firewall: usa los `id` que la
  // vista marco. Con la lista vacia la tabla queda vacia, que es como tiene que
  // fallar.
  const idsQueTocanAdmin = new Set(
    clasificadosPeriodo.filter((m) => m.toca_cuenta_admin).map((m) => m.id)
  )
  const movimientosPeriodoVista = aplicarFirewallFinanzasAdmin
    ? movimientosPeriodo.filter((m) => idsQueTocanAdmin.has(m.id))
    : movimientosPeriodo

  const resumenHistorico = resumirClasificados(clasificadosHistoricos)
  const resumenPeriodo = resumirClasificados(clasificadosPeriodo)
  // El estado vacio miraba el historico con firewall: mismas filas, otra fuente.
  const hayHistorico = aplicarFirewallFinanzasAdmin
    ? clasificadosHistoricos.some((m) => m.toca_cuenta_admin)
    : clasificadosHistoricos.length > 0
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
      ) : !hayHistorico ? (
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

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
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
