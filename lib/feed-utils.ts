import { supabase } from './supabase'

// ============================================================================
// INTERFACES - Natural Language Audit Feed
// ============================================================================

export interface AuditEvent {
  id: string
  timestamp: string
  tipo: 'VENTA' | 'ABONO' | 'GASTO' | 'PRODUCCION' | 'MERMA'
  descripcion: string
  monto?: number
  color: 'green' | 'blue' | 'red' | 'purple' | 'orange'
}

interface TicketRaw {
  id: string
  fecha_transaccion: string
  total_cobrado_real: number
  vendedor?: { nombre: string } | { nombre: string }[]
  comprador?: { nombre: string } | { nombre: string }[]
  ticket_detalles?: Array<{
    cantidad: number
    catalogo_productos?: { nombre: string } | { nombre: string }[]
  }>
}

interface FinanzaRaw {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  entidad?: { nombre: string } | { nombre: string }[]
}

interface InventarioRaw {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string | null
  cantidad: number
  producto?: { nombre: string } | { nombre: string }[]
}

// ============================================================================
// DATA FETCHING - Server-Side Only
// ============================================================================

export async function fetchAuditFeed(limit: number = 10, offset: number = 0): Promise<AuditEvent[]> {
  try {
    // Fetch tickets (sales)
    const { data: tickets, error: ticketsError } = await supabase
      .from('transacciones_tickets')
      .select(`
        id,
        fecha_transaccion,
        total_cobrado_real,
        vendedor:entidades!id_vendedor(nombre),
        comprador:entidades!id_comprador(nombre),
        ticket_detalles(
          cantidad,
          catalogo_productos(nombre)
        )
      `)
      .order('fecha_transaccion', { ascending: false })
      .range(offset, offset + limit - 1)

    if (ticketsError) {
      console.error('Error fetching tickets for feed:', ticketsError?.message, ticketsError?.details, ticketsError?.hint)
    }

    // Fetch finanzas (payments and expenses)
    const { data: finanzas, error: finanzasError } = await supabase
      .from('finanzas_ledger')
      .select(`
        id,
        fecha_movimiento,
        tipo_movimiento,
        monto,
        categoria,
        entidad:entidades!id_entidad_relacionada(nombre)
      `)
      .order('fecha_movimiento', { ascending: false })
      .range(offset, offset + limit - 1)

    if (finanzasError) {
      console.error('Error fetching finanzas for feed:', finanzasError?.message, finanzasError?.details, finanzasError?.hint)
    }

    // Fetch inventario (production and merma)
    const { data: inventario, error: inventarioError } = await supabase
      .from('inventario_ledger')
      .select(`
        id,
        fecha_movimiento,
        tipo_movimiento,
        cantidad,
        producto:catalogo_productos!id_producto(nombre)
      `)
      .in('tipo_movimiento', ['PRODUCCION', 'MERMA'])
      .order('fecha_movimiento', { ascending: false })
      .range(offset, offset + limit - 1)

    if (inventarioError) {
      console.error('Error fetching inventario for feed:', inventarioError?.message, inventarioError?.details, inventarioError?.hint)
    }

    // Translate all events to natural language
    const eventos: AuditEvent[] = []

    // Process tickets
    if (tickets) {
      tickets.forEach((ticket: TicketRaw) => {
        eventos.push(translateTicketToNaturalLanguage(ticket))
      })
    }

    // Process finanzas
    if (finanzas) {
      finanzas.forEach((finanza: FinanzaRaw) => {
        eventos.push(translateFinanzaToNaturalLanguage(finanza))
      })
    }

    // Process inventario
    if (inventario) {
      inventario.forEach((inv: InventarioRaw) => {
        eventos.push(translateInventarioToNaturalLanguage(inv))
      })
    }

    // Sort all events by timestamp descending
    eventos.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Return only the requested limit
    return eventos.slice(0, limit)

  } catch (error: any) {
    console.error('Error in fetchAuditFeed:', error?.message)
    return []
  }
}

// ============================================================================
// PURE FUNCTIONS - Natural Language Translation
// ============================================================================

function translateTicketToNaturalLanguage(ticket: TicketRaw): AuditEvent {
  const vendedor = (ticket.vendedor as any)?.nombre || 'Vendedor'
  const comprador = (ticket.comprador as any)?.nombre || 'Cliente'
  
  // Get product summary
  let productosTexto = ''
  if (ticket.ticket_detalles && ticket.ticket_detalles.length > 0) {
    const totalCantidad = ticket.ticket_detalles.reduce((sum, d) => sum + d.cantidad, 0)
    const primerProducto = (ticket.ticket_detalles[0].catalogo_productos as any)?.nombre || 'Producto'
    productosTexto = ticket.ticket_detalles.length === 1
      ? `${totalCantidad}x ${primerProducto}`
      : `${totalCantidad} productos`
  }

  const descripcion = productosTexto
    ? `${vendedor} vendió ${productosTexto} a ${comprador} por $${ticket.total_cobrado_real.toLocaleString('es-MX')}`
    : `${vendedor} vendió a ${comprador} por $${ticket.total_cobrado_real.toLocaleString('es-MX')}`

  return {
    id: `ticket-${ticket.id}`,
    timestamp: ticket.fecha_transaccion,
    tipo: 'VENTA',
    descripcion,
    monto: ticket.total_cobrado_real,
    color: 'green'
  }
}

function translateFinanzaToNaturalLanguage(finanza: FinanzaRaw): AuditEvent {
  const entidad = (finanza.entidad as any)?.nombre || 'Entidad'
  // Null-safe string manipulation
  const categoriaLegible = (finanza.categoria || 'Operación').replace(/_/g, ' ')
  const tipoMovimiento = finanza.tipo_movimiento || 'GASTO'

  let descripcion = ''
  let tipo: AuditEvent['tipo'] = 'GASTO'
  let color: AuditEvent['color'] = 'red'

  if (tipoMovimiento === 'ABONO_DEUDA') {
    descripcion = `${entidad} abonó $${finanza.monto.toLocaleString('es-MX')} (${categoriaLegible})`
    tipo = 'ABONO'
    color = 'blue'
  } else if (tipoMovimiento === 'INGRESO') {
    descripcion = `Ingreso de $${finanza.monto.toLocaleString('es-MX')} en ${categoriaLegible}`
    tipo = 'ABONO'
    color = 'green'
  } else {
    descripcion = `Gasto de $${finanza.monto.toLocaleString('es-MX')} en ${categoriaLegible}`
    tipo = 'GASTO'
    color = 'red'
  }

  return {
    id: `finanza-${finanza.id}`,
    timestamp: finanza.fecha_movimiento,
    tipo,
    descripcion,
    monto: finanza.monto,
    color
  }
}

function translateInventarioToNaturalLanguage(inv: InventarioRaw): AuditEvent {
  const producto = (inv.producto as any)?.nombre || 'Producto'
  // Null-safe tipo_movimiento
  const tipoMovimiento = inv.tipo_movimiento || 'PRODUCCION'
  
  let descripcion = ''
  let tipo: AuditEvent['tipo'] = 'PRODUCCION'
  let color: AuditEvent['color'] = 'purple'

  if (tipoMovimiento === 'PRODUCCION') {
    descripcion = `Admin produjo ${inv.cantidad}x botellas de ${producto}`
    tipo = 'PRODUCCION'
    color = 'purple'
  } else if (tipoMovimiento === 'MERMA') {
    descripcion = `Merma de ${inv.cantidad}x botellas de ${producto}`
    tipo = 'MERMA'
    color = 'orange'
  }

  return {
    id: `inventario-${inv.id}`,
    timestamp: inv.fecha_movimiento,
    tipo,
    descripcion,
    color
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function calcularTiempoTranscurrido(fecha: string): string {
  const ahora = new Date()
  const fechaEvento = new Date(fecha)
  const diffMs = ahora.getTime() - fechaEvento.getTime()
  const diffMinutos = Math.floor(diffMs / (1000 * 60))
  const diffHoras = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMinutos < 1) return 'Hace un momento'
  if (diffMinutos < 60) return `Hace ${diffMinutos} min`
  if (diffHoras < 24) return `Hace ${diffHoras}h`
  if (diffDias === 1) return 'Ayer'
  if (diffDias < 7) return `Hace ${diffDias} días`
  if (diffDias < 30) return `Hace ${Math.floor(diffDias / 7)} semanas`
  return `Hace ${Math.floor(diffDias / 30)} meses`
}

export function getColorClasses(color: AuditEvent['color']): { border: string; bg: string; text: string; dot: string } {
  const colorMap = {
    green: {
      border: 'border-green-500',
      bg: 'bg-green-50',
      text: 'text-green-900',
      dot: 'bg-green-500'
    },
    blue: {
      border: 'border-blue-500',
      bg: 'bg-blue-50',
      text: 'text-blue-900',
      dot: 'bg-blue-500'
    },
    red: {
      border: 'border-red-500',
      bg: 'bg-red-50',
      text: 'text-red-900',
      dot: 'bg-red-500'
    },
    purple: {
      border: 'border-purple-500',
      bg: 'bg-purple-50',
      text: 'text-purple-900',
      dot: 'bg-purple-500'
    },
    orange: {
      border: 'border-orange-500',
      bg: 'bg-orange-50',
      text: 'text-orange-900',
      dot: 'bg-orange-500'
    }
  }

  return colorMap[color]
}
