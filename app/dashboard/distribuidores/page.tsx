import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import {
  getMovimientosFinanzas,
  getMovimientosInventario,
  getInventarioLedger,
  getProductos,
  calcularUltimoMovimiento,
  getSemaforoMovimiento,
  calcularValorFisicoInventario,
  calcularRiesgoJineteo
} from '@/lib/risk-utils'
import { getCurrentUser } from '@/lib/auth-utils'

interface Entidad {
  id: string
  nombre: string
  rol: 'DST' | 'LOC' | 'SOCIO'
  zona: string
  telefono: string
  comision_base: number
  comision_base_local: number
  comision_hijo_local: number
  comision_logistica: number
  id_padre: string | null
  ultimo_seguimiento: string | null
}

interface FinanzaLedger {
  id_entidad_relacionada: string
  tipo_movimiento: string
  monto: number
}

interface KPIsRed {
  totalRed: number
  distribuidores: number
  locales: number
}

async function getEntidades(): Promise<Entidad[]> {
  try {
    const { data, error } = await supabase
      .from('entidades')
      .select('*')
      .neq('rol', 'ADMIN')
      .order('rol', { ascending: true })

    if (error) {
      console.error('Error fetching entidades:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getEntidades:', error)
    return []
  }
}

async function getFinanzasLedger(): Promise<FinanzaLedger[]> {
  try {
    const { data, error } = await supabase
      .from('finanzas_ledger')
      .select('id_entidad_relacionada, tipo_movimiento, monto')
      .eq('status', 'APPROVED')

    if (error) {
      console.error('Error fetching finanzas_ledger:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getFinanzasLedger:', error)
    return []
  }
}

async function getTickets(): Promise<{ id_comprador: string; total_cobrado_real: number }[]> {
  try {
    const { data, error } = await supabase
      .from('transacciones_tickets')
      .select('id_comprador, total_cobrado_real')

    if (error) {
      console.error('Error fetching tickets:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getTickets:', error)
    return []
  }
}

function calcularSaldoPendiente(
  idEntidad: string,
  tickets: { id_comprador: string; total_cobrado_real: number }[],
  finanzas: FinanzaLedger[]
): number {
  const totalGenerado = tickets
    .filter(t => t.id_comprador === idEntidad)
    .reduce((sum, t) => sum + t.total_cobrado_real, 0)

  const totalAbonado = finanzas
    .filter(f => f.id_entidad_relacionada === idEntidad && f.tipo_movimiento === 'ABONO_DEUDA')
    .reduce((sum, f) => sum + f.monto, 0)

  return totalGenerado - totalAbonado
}

function getSemaforoSeguimiento(ultimoSeguimiento: string | null): string {
  if (!ultimoSeguimiento) return '🔴'

  const hoy = new Date()
  const fechaSeguimiento = new Date(ultimoSeguimiento)
  const diasTranscurridos = Math.floor((hoy.getTime() - fechaSeguimiento.getTime()) / (1000 * 60 * 60 * 24))

  if (diasTranscurridos < 7) return '🟢'
  if (diasTranscurridos <= 14) return '🟡'
  return '🔴'
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
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
  const [
    entidades,
    finanzas,
    tickets,
    movimientosFinanzas,
    movimientosInventario,
    inventario,
    productos,
    currentUser
  ] = await Promise.all([
    getEntidades(),
    getFinanzasLedger(),
    getTickets(),
    getMovimientosFinanzas(),
    getMovimientosInventario(),
    getInventarioLedger(),
    getProductos(),
    getCurrentUser()
  ])
  const kpis = calcularKPIs(entidades)
  const canMutate = currentUser?.rol !== 'SOCIO'

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
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Directorio de la Red</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Nombre
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Rol
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Zona
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Patrocinador
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Saldo Pendiente
                    </th>
                    <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Seguimiento
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Riesgo / Jineteo
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Acciones
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {entidades.map((entidad: Entidad) => {
                    const padre = entidades.find(e => e.id === entidad.id_padre)
                    const saldoPendiente = calcularSaldoPendiente(entidad.id, tickets, finanzas)
                    
                    // TRAFFIC LIGHT: Calculate from actual last movement (finanzas + inventario)
                    const ultimoMovimiento = calcularUltimoMovimiento(
                      entidad.id,
                      movimientosFinanzas,
                      movimientosInventario
                    )
                    const semaforo = getSemaforoMovimiento(ultimoMovimiento)
                    
                    // ANTI-FRAUD: Calculate physical inventory value and fraud risk
                    const valorFisico = calcularValorFisicoInventario(entidad.id, inventario, productos)
                    const riesgo = calcularRiesgoJineteo(saldoPendiente, valorFisico)
                    
                    return (
                      <tr key={entidad.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {entidad.nombre}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          entidad.rol === 'DST' 
                            ? 'bg-blue-100 text-blue-800' 
                            : 'bg-purple-100 text-purple-800'
                        }`}>
                          {entidad.rol}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {entidad.zona}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {padre ? padre.nombre : 'Línea Directa'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold">
                        <span className={saldoPendiente > 0 ? 'text-red-600' : 'text-green-600'}>
                          {formatCurrency(saldoPendiente)}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center text-2xl">
                        {semaforo}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        {riesgo.estado === 'FALTANTE' ? (
                          <div className="flex items-center gap-2">
                            <span className="text-red-600 text-xl">🔴</span>
                            <div>
                              <div className="text-red-600 font-semibold">
                                {formatCurrency(riesgo.riesgo)}
                              </div>
                              <div className="text-xs text-red-500">Faltante</div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="text-green-600 text-xl">🟢</span>
                            <div className="text-green-600 font-semibold text-xs">Sano</div>
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">
                        <Link
                          href={`/dashboard/distribuidores/${entidad.id}`}
                          className="text-blue-600 hover:text-blue-800 font-medium"
                        >
                          Ver Estado de Cuenta
                        </Link>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
