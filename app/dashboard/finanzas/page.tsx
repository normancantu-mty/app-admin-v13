export const dynamic = 'force-dynamic'
import { supabase } from '@/lib/supabase'
import { cookies } from 'next/headers'
import { calcularFechasPorRango, getDesgloseCategorias } from '@/lib/dashboard-utils'
import type { CurrentUser } from '@/lib/auth-utils'
import Link from 'next/link'
import { getCurrentUser } from '@/lib/auth-utils'
import PendingApprovalsPanel from './PendingApprovalsPanel'
import MovimientosTable from './MovimientosTable'
import { CategoryBreakdown } from '@/components/dashboard/CategoryBreakdown'

interface MovimientoFinanciero {
  id: string
  id_cuenta_destino: string
  tipo_movimiento: string
  monto: number
  categoria: string
  fecha_movimiento: string
  status: 'APPROVED' | 'PENDING' | 'REJECTED'
  cuenta_destino: {
    nombre: string
  } | null
}

interface ResumenFinanciero {
  ingresos: number
  egresos: number
  balance: number
}

const TIPOS_INGRESO = ['INGRESO_VENTA', 'ABONO_DEUDA']
const TIPOS_EGRESO = ['GASTO_OPERATIVO', 'SUBSIDIO_FISCAL', 'COMISION_PASIVA']

async function getMovimientos(fechaInicio?: string, fechaFin?: string): Promise<MovimientoFinanciero[]> {
  try {
    let query = supabase
      .from('finanzas_ledger')
      .select('*, cuenta_destino:cuentas_financieras!id_cuenta_destino(nombre)')
      .eq('status', 'APPROVED')
      .order('fecha_movimiento', { ascending: false })

    if (fechaInicio && fechaFin) {
      query = query
        .gte('fecha_movimiento', fechaInicio)
        .lte('fecha_movimiento', fechaFin)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching movimientos:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getMovimientos:', error)
    return []
  }
}

function calcularResumen(movimientos: MovimientoFinanciero[]): ResumenFinanciero {
  const ingresos = movimientos
    .filter(m => TIPOS_INGRESO.includes(m.tipo_movimiento))
    .reduce((sum, m) => sum + m.monto, 0)

  const egresos = movimientos
    .filter(m => TIPOS_EGRESO.includes(m.tipo_movimiento))
    .reduce((sum, m) => sum + m.monto, 0)

  const balance = ingresos - egresos

  return { ingresos, egresos, balance }
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function SummaryCard({ title, amount, color }: { title: string; amount: number; color: string }) {
  const colorClasses = {
    green: 'bg-green-50 border-green-200 text-green-800',
    red: 'bg-red-50 border-red-200 text-red-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800'
  }

  return (
    <div className={`p-6 rounded-lg border ${colorClasses[color as keyof typeof colorClasses]}`}>
      <h3 className="text-sm font-medium mb-2">{title}</h3>
      <p className="text-2xl font-bold">{formatCurrency(amount)}</p>
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

export default async function FinanzasPage() {
  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)

  let movimientos: MovimientoFinanciero[] = [];
  let categorias: any[] = [];
  let currentUser: CurrentUser | null = null;
  
  try {
    [movimientos, currentUser, categorias] = await Promise.all([
      getMovimientos(fechaInicio, fechaFin),
      getCurrentUser(),
      getDesgloseCategorias(fechaInicio, fechaFin)
    ]);
  } catch (error) {
    console.error('🕵️‍♂️ [OJO DE DIOS] Error obteniendo datos:', error);
    currentUser = null;
  }
  
  const resumen = calcularResumen(movimientos);
  const userRole = currentUser?.rol?.toUpperCase() || 'INVITADO';
  const isAdmin = userRole === 'ADMIN' || userRole === 'ADMINISTRADOR';
  const canMutate = isAdmin || userRole === 'SUB-ADMIN';
  
  console.log('🕵️‍♂️ [OJO DE DIOS] Usuario actual detectado:', currentUser?.email || 'No autenticado', '| Rol:', userRole);

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
      {isAdmin && <PendingApprovalsPanel isSubAdmin={currentUser?.rol === 'SUB-ADMIN'} />}

      {movimientos.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <SummaryCard
              title="Ingresos"
              amount={resumen.ingresos}
              color="green"
            />
            <SummaryCard
              title="Egresos"
              amount={resumen.egresos}
              color="red"
            />
            <SummaryCard
              title="Balance Neto"
              amount={resumen.balance}
              color={resumen.balance >= 0 ? 'blue' : 'red'}
            />
          </div>

          <CategoryBreakdown categorias={categorias} />

          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">Movimientos Financieros</h2>
            </div>
            <MovimientosTable movimientos={movimientos} isAdmin={isAdmin} />
          </div>
        </>
      )}
    </div>
  )
}
