import { supabase } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface FeedItem {
  id: string
  fecha: string
  tipo: 'TICKET' | 'FINANZAS' | 'INVENTARIO'
  mensaje: string
  colorBadge: string
  icono: string
}

interface Ticket {
  id: string
  fecha_transaccion: string
  total_cobrado_real: number
  condicion_pago: 'CONTADO' | 'CONCESION' | null
  vendedor: {
    nombre: string
  } | null
  comprador: {
    nombre: string
  } | null
}

interface Finanza {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string
  monto: number
  categoria_gasto: string
  entidad: {
    nombre: string
  } | null
}

interface Inventario {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string
  cantidad: number
  producto: {
    nombre: string
  }[]
}

interface TicketRaw extends Omit<Ticket, 'vendedor' | 'comprador'> {
  vendedor: Ticket['vendedor'] | Ticket['vendedor'][]
  comprador: Ticket['comprador'] | Ticket['comprador'][]
}

interface FinanzaRaw extends Omit<Finanza, 'entidad'> {
  entidad: Finanza['entidad'] | Finanza['entidad'][]
}

async function getFeedData() {
  try {
    const [ticketsRes, finanzasRes, inventarioRes] = await Promise.all([
      supabase
        .from('transacciones_tickets')
        .select('id, fecha_transaccion, total_cobrado_real, condicion_pago, vendedor:entidades!id_vendedor(nombre), comprador:entidades!id_comprador(nombre)')
        .limit(20)
        .order('fecha_transaccion', { ascending: false }),
      
      supabase
        .from('finanzas_ledger')
        .select('id, fecha_movimiento, tipo_movimiento, monto, categoria_gasto, entidad:entidades!id_entidad_relacionada(nombre)')
        .limit(20)
        .order('fecha_movimiento', { ascending: false }),
      
      supabase
        .from('inventario_ledger')
        .select('id, fecha_movimiento, tipo_movimiento, cantidad, producto:catalogo_productos!id_producto(nombre)')
        .neq('tipo_movimiento', 'SALIDA_VENTA')
        .limit(20)
        .order('fecha_movimiento', { ascending: false })
    ])

    const ticketsRaw: TicketRaw[] = (ticketsRes.data || []) as TicketRaw[]
    const finanzasRaw: FinanzaRaw[] = (finanzasRes.data || []) as FinanzaRaw[]
    const inventario: Inventario[] = inventarioRes.data || []

    const feedItems: FeedItem[] = []

    ticketsRaw.forEach((ticketRaw) => {
      const ticket: Ticket = {
        ...ticketRaw,
        vendedor: Array.isArray(ticketRaw.vendedor) ? ticketRaw.vendedor[0] : ticketRaw.vendedor,
        comprador: Array.isArray(ticketRaw.comprador) ? ticketRaw.comprador[0] : ticketRaw.comprador
      }
      const nombreVendedor = ticket.vendedor?.nombre || 'Un Distribuidor'
      const nombreComprador = ticket.comprador?.nombre || 'Público en General'
      const esConcesion = ticket.condicion_pago === 'CONCESION'
      feedItems.push({
        id: `ticket-${ticket.id}`,
        fecha: ticket.fecha_transaccion,
        tipo: 'TICKET',
        mensaje: esConcesion
          ? `TRASPASO CONCESIÓN: ${nombreVendedor} transfirió inventario a ${nombreComprador}`
          : `${nombreVendedor} le vendió $${ticket.total_cobrado_real.toFixed(2)} a ${nombreComprador}`,
        colorBadge: esConcesion ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-800',
        icono: '🛍️'
      })
    })

    finanzasRaw.forEach((finanzaRaw) => {
      const finanza: Finanza = {
        ...finanzaRaw,
        entidad: Array.isArray(finanzaRaw.entidad) ? finanzaRaw.entidad[0] : finanzaRaw.entidad
      }
      const nombreEntidad = finanza.entidad?.nombre || 'El Administrador'
      const tipoFinanza = finanza.tipo_movimiento
      const colorBadge =
        tipoFinanza === 'ABONO_DEUDA' || tipoFinanza === 'INGRESO_COMISION'
          ? 'bg-green-100 text-green-600'
          : tipoFinanza === 'DEUDA_A_MATRIZ'
            ? 'bg-gray-100 text-gray-500'
            : 'bg-red-100 text-red-800'
      const mensaje =
        tipoFinanza === 'ABONO_DEUDA'
          ? `${nombreEntidad}: Pago recibido / Deuda saldada ($${finanza.monto.toFixed(2)})`
          : tipoFinanza === 'INGRESO_COMISION'
            ? `${nombreEntidad}: Comisión ganada por red ($${finanza.monto.toFixed(2)})`
            : tipoFinanza === 'DEUDA_A_MATRIZ'
              ? `${nombreEntidad}: Efectivo recolectado (Por entregar a Matriz) ($${finanza.monto.toFixed(2)})`
              : `${nombreEntidad} registró un(a) ${tipoFinanza} de $${finanza.monto.toFixed(2)}`
      feedItems.push({
        id: `finanza-${finanza.id}`,
        fecha: finanza.fecha_movimiento,
        tipo: 'FINANZAS',
        mensaje,
        colorBadge,
        icono: '💰'
      })
    })

    inventario.forEach(inv => {
      feedItems.push({
        id: `inventario-${inv.id}`,
        fecha: inv.fecha_movimiento,
        tipo: 'INVENTARIO',
        mensaje: `Se registró un(a) ${inv.tipo_movimiento} de ${inv.cantidad} uds de ${inv.producto[0]?.nombre || 'Producto'}`,
        colorBadge: 'bg-purple-100 text-purple-800',
        icono: '📦'
      })
    })

    feedItems.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())

    return feedItems.slice(0, 30)
  } catch (error) {
    console.error('Error fetching feed data:', error)
    return []
  }
}

function formatFecha(fecha: string) {
  const date = new Date(fecha)
  return date.toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export default async function FeedPage() {
  const feedItems = await getFeedData()

  return (
    <div className="p-8">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-800">Auditoría en Tiempo Real</h1>
          <p className="text-gray-600 mt-2">Eventos unificados de tickets, finanzas e inventario</p>
        </div>

        {feedItems.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-gray-400 text-6xl mb-4">📋</div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">No hay eventos registrados</h3>
            <p className="text-gray-500">Los eventos aparecerán aquí en tiempo real</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="space-y-4">
              {feedItems.map((item, index) => (
                <div key={item.id} className="relative">
                  {index !== feedItems.length - 1 && (
                    <div className="absolute left-5 top-10 bottom-0 w-0.5 bg-gray-200"></div>
                  )}
                  
                  <div className="flex gap-4">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center text-xl z-10">
                      {item.icono}
                    </div>
                    
                    <div className="flex-1 pb-6">
                      <div className="flex items-start justify-between mb-1">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${item.colorBadge}`}>
                          {item.tipo}
                        </span>
                        <span className="text-xs text-gray-500">
                          {formatFecha(item.fecha)}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 mt-2">
                        {item.mensaje}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
