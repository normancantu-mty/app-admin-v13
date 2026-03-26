import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth-utils'

interface Entidad {
  id: string
  nombre: string
  rol: 'DST' | 'LOC' | 'SOCIO'
  zona: string
  telefono: string
}

interface TransaccionTicket {
  id: string
  fecha_transaccion: string
  monto_base_ingreso: number
  total_cobrado_real: number
  id_vendedor: string
  id_comprador: string | null
}

interface FinanzaLedger {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string
  monto: number
  categoria_gasto: string
}

interface ActividadUnificada {
  fecha: string
  tipo: 'VENTA' | 'ABONO'
  monto: number
  referencia: string
}

async function getEntidad(id: string): Promise<Entidad | null> {
  try {
    const { data, error } = await supabase
      .from('entidades')
      .select('id, nombre, rol, zona, telefono')
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching entidad:', error)
      return null
    }

    return data
  } catch (error) {
    console.error('Error in getEntidad:', error)
    return null
  }
}

async function getTransaccionesTickets(idEntidad: string): Promise<TransaccionTicket[]> {
  try {
    const { data, error } = await supabase
      .from('transacciones_tickets')
      .select('id, fecha_transaccion, monto_base_ingreso, total_cobrado_real, id_vendedor, id_comprador')
      .or(`id_vendedor.eq.${idEntidad},id_comprador.eq.${idEntidad}`)
      .order('fecha_transaccion', { ascending: false })

    if (error) {
      console.error('Error fetching transacciones_tickets:', error)
      return []
    }

    return data || []
  } catch (error) {
    console.error('Error in getTransaccionesTickets:', error)
    return []
  }
}

async function getFinanzasLedger(idEntidad: string): Promise<FinanzaLedger[]> {
  try {
    const { data, error } = await supabase
      .from('finanzas_ledger')
      .select('id, fecha_movimiento, tipo_movimiento, monto, categoria_gasto')
      .eq('id_entidad_relacionada', idEntidad)
      .eq('status', 'APPROVED')
      .order('fecha_movimiento', { ascending: false })

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

function calcularSaldos(tickets: TransaccionTicket[], finanzas: FinanzaLedger[], idEntidad: string) {
  const totalGenerado = tickets.reduce((sum, ticket) => {
    const monto = ticket.id_comprador === idEntidad ? ticket.total_cobrado_real : ticket.monto_base_ingreso
    return sum + monto
  }, 0)
  
  const totalAbonado = finanzas
    .filter(f => f.tipo_movimiento === 'ABONO_DEUDA')
    .reduce((sum, f) => sum + f.monto, 0)
  
  const saldoPendiente = totalGenerado - totalAbonado

  return {
    totalGenerado,
    totalAbonado,
    saldoPendiente
  }
}

function unificarActividades(tickets: TransaccionTicket[], finanzas: FinanzaLedger[], idEntidad: string): ActividadUnificada[] {
  const actividades: ActividadUnificada[] = []

  tickets.forEach(ticket => {
    const esCompra = ticket.id_comprador === idEntidad
    actividades.push({
      fecha: ticket.fecha_transaccion,
      tipo: 'VENTA',
      monto: esCompra ? ticket.total_cobrado_real : ticket.monto_base_ingreso,
      referencia: esCompra ? 'Carga de stock (Compra)' : 'Venta realizada'
    })
  })

  finanzas
    .filter(f => f.tipo_movimiento === 'ABONO_DEUDA')
    .forEach(finanza => {
      actividades.push({
        fecha: finanza.fecha_movimiento,
        tipo: 'ABONO',
        monto: finanza.monto,
        referencia: finanza.categoria_gasto || 'Abono manual'
      })
    })

  actividades.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())

  return actividades
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

export default async function EstadoCuentaPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = await params
  const entidad = await getEntidad(resolvedParams.id)

  if (!entidad) {
    notFound()
  }

  const [tickets, finanzas, currentUser] = await Promise.all([
    getTransaccionesTickets(resolvedParams.id),
    getFinanzasLedger(resolvedParams.id),
    getCurrentUser()
  ])

  const saldos = calcularSaldos(tickets, finanzas, resolvedParams.id)
  const actividades = unificarActividades(tickets, finanzas, resolvedParams.id)
  const canMutate = currentUser?.rol !== 'SOCIO'

  return (
    <div className="p-8 space-y-6">
      {/* HEADER CON PANEL DE MANDO - Jerarquía de Acción Implementada */}
      <div className="flex justify-between items-center">
        <div>
          <Link 
            href="/dashboard/distribuidores"
            className="text-blue-600 hover:text-blue-800 mb-2 inline-block"
          >
            ← Volver a Distribuidores
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-gray-800">{entidad.nombre}</h1>
            <span className={`inline-flex px-3 py-1 text-sm font-semibold rounded-full ${
              entidad.rol === 'DST' 
                ? 'bg-blue-100 text-blue-800' 
                : 'bg-purple-100 text-purple-800'
            }`}>
              {entidad.rol}
            </span>
          </div>
          <p className="text-gray-600 mt-1">{entidad.zona} • {entidad.telefono || 'Sin teléfono'}</p>
        </div>
        
        {/* PANEL DE MANDO - 3 Botones con Jerarquía de Acción */}
        {canMutate && (
          <div className="flex gap-3">
            {/* Botón 1: Nueva Venta - Color secundario/neutro - Query params pre-configurados */}
            <Link
              href={`/pos?vendedor=${resolvedParams.id}`}
              className="bg-slate-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-slate-700 transition-colors flex items-center gap-2"
            >
              <span>📦</span>
              <span>Nueva Venta</span>
            </Link>
            
            {/* Botón 2: Registrar Abono - Color verde/destacado - Acción primaria */}
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}/abono`}
              className="bg-green-600 text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-green-700 transition-colors flex items-center gap-2 shadow-sm"
            >
              <span>💵</span>
              <span>Registrar Abono</span>
            </Link>
            
            {/* Botón 3: Devolución - Color outline/advertencia */}
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}/devolucion`}
              className="border-2 border-orange-500 text-orange-600 px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-orange-50 transition-colors flex items-center gap-2"
            >
              <span>🔄</span>
              <span>Devolución</span>
            </Link>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Total Generado</p>
              <p className="text-3xl font-bold text-blue-600 mt-2">{formatCurrency(saldos.totalGenerado)}</p>
            </div>
            <div className="bg-blue-100 p-3 rounded-full">
              <span className="text-2xl">💰</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Deuda total por ventas realizadas</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Total Abonado</p>
              <p className="text-3xl font-bold text-green-600 mt-2">{formatCurrency(saldos.totalAbonado)}</p>
            </div>
            <div className="bg-green-100 p-3 rounded-full">
              <span className="text-2xl">✅</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Pagos realizados a la cuenta</p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Saldo Pendiente</p>
              <p className={`text-3xl font-bold mt-2 ${
                saldos.saldoPendiente > 0 ? 'text-red-600' : 'text-green-600'
              }`}>
                {formatCurrency(saldos.saldoPendiente)}
              </p>
            </div>
            <div className={`p-3 rounded-full ${
              saldos.saldoPendiente > 0 ? 'bg-red-100' : 'bg-green-100'
            }`}>
              <span className="text-2xl">{saldos.saldoPendiente > 0 ? '⚠️' : '✨'}</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {saldos.saldoPendiente > 0 ? 'Deuda pendiente de pago' : 'Cuenta al corriente'}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Historial de Actividad</h2>
          <p className="text-sm text-gray-600 mt-1">Registro cronológico de ventas y abonos</p>
        </div>
        
        {actividades.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-gray-500">No hay actividad registrada</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Fecha
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Tipo
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Referencia
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Monto
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {actividades.map((actividad, index) => (
                  <tr key={index} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {formatDate(actividad.fecha)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        actividad.tipo === 'VENTA' 
                          ? 'bg-blue-100 text-blue-800' 
                          : 'bg-green-100 text-green-800'
                      }`}>
                        {actividad.tipo}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {actividad.referencia}
                    </td>
                    <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium text-right ${
                      actividad.tipo === 'VENTA' ? 'text-red-600' : 'text-green-600'
                    }`}>
                      {actividad.tipo === 'VENTA' ? '+' : '-'}{formatCurrency(actividad.monto)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
