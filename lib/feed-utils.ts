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
  color: 'green' | 'blue' | 'red' | 'purple' | 'orange' | 'gray'
}

interface TicketRaw {
  id: string
  fecha_transaccion: string
  total_cobrado_real: number
  condicion_pago: 'CONTADO' | 'CONCESION' | null
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
  categoria_gasto: string | null
  id_ticket: string | null
  entidad?: { nombre: string } | { nombre: string }[]
}

interface InventarioRaw {
  id: string
  fecha_movimiento: string
  tipo_movimiento: string | null
  cantidad: number
  producto?: { nombre: string } | { nombre: string }[]
}

function getNombreFromRelation(
  relation?: { nombre: string } | { nombre: string }[] | null,
  fallback: string = 'Entidad'
): string {
  if (!relation) return fallback
  if (Array.isArray(relation)) {
    return relation[0]?.nombre || fallback
  }
  return relation.nombre || fallback
}

function getNombreProductoFromDetalle(
  detalle?: { catalogo_productos?: { nombre: string } | { nombre: string }[] }
): string {
  const relation = detalle?.catalogo_productos
  if (!relation) return 'Producto'
  if (Array.isArray(relation)) {
    return relation[0]?.nombre || 'Producto'
  }
  return relation.nombre || 'Producto'
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
        condicion_pago,
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
        categoria_gasto,
        id_ticket,
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
      .order('fecha_movimiento', { ascending: false })
      .range(offset, offset + limit - 1)

    if (inventarioError) {
      console.error('Error fetching inventario for feed:', inventarioError?.message, inventarioError?.details, inventarioError?.hint)
    }

    // Translate all events to natural language
    const eventos: AuditEvent[] = []

    const ticketsReciboCobro = new Set(
      ((finanzas as FinanzaRaw[] | null) || [])
        .filter((finanza) => finanza.tipo_movimiento === 'ABONO_DEUDA' && Boolean(finanza.id_ticket))
        .map((finanza) => finanza.id_ticket as string)
    )

    // Process tickets
    if (tickets) {
      tickets.forEach((ticket: TicketRaw) => {
        const esReciboCobro = ticket.condicion_pago === 'CONTADO' && ticketsReciboCobro.has(ticket.id)
        eventos.push(translateTicketToNaturalLanguage(ticket, esReciboCobro))
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

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'unknown error'
    console.error('Error in fetchAuditFeed:', errorMessage)
    return []
  }
}

// ============================================================================
// PURE FUNCTIONS - Natural Language Translation
// ============================================================================

function translateTicketToNaturalLanguage(ticket: TicketRaw, esReciboCobro: boolean): AuditEvent {
  const vendedor = getNombreFromRelation(ticket.vendedor, 'Vendedor')
  const comprador = getNombreFromRelation(ticket.comprador, 'Cliente')
  const esConcesion = ticket.condicion_pago === 'CONCESION'
  
  // Get product summary
  let productosTexto = ''
  if (ticket.ticket_detalles && ticket.ticket_detalles.length > 0) {
    const totalCantidad = ticket.ticket_detalles.reduce((sum, d) => sum + d.cantidad, 0)
    const primerProducto = getNombreProductoFromDetalle(ticket.ticket_detalles[0])
    productosTexto = ticket.ticket_detalles.length === 1
      ? `${totalCantidad}x ${primerProducto}`
      : `${totalCantidad} productos`
  }

  const descripcion = esReciboCobro
    ? (productosTexto
      ? `RECIBO DE COBRO: ${vendedor} registró cobro de ${productosTexto} a ${comprador}`
      : `RECIBO DE COBRO: ${vendedor} registró cobro a ${comprador}`)
    : esConcesion
    ? (productosTexto
      ? `TRASPASO CONCESIÓN: ${vendedor} transfirió ${productosTexto} a ${comprador}`
      : `TRASPASO CONCESIÓN: ${vendedor} transfirió inventario a ${comprador}`)
    : (productosTexto
      ? `${vendedor} vendió ${productosTexto} a ${comprador} por $${ticket.total_cobrado_real.toLocaleString('es-MX')}`
      : `${vendedor} vendió a ${comprador} por $${ticket.total_cobrado_real.toLocaleString('es-MX')}`)

  return {
    id: `ticket-${ticket.id}`,
    timestamp: ticket.fecha_transaccion,
    tipo: 'VENTA',
    descripcion,
    monto: ticket.total_cobrado_real,
    color: esReciboCobro ? 'blue' : (esConcesion ? 'gray' : 'green')
  }
}

function translateFinanzaToNaturalLanguage(finanza: FinanzaRaw): AuditEvent {
  const entidad = getNombreFromRelation(finanza.entidad, 'Entidad')
  // Null-safe string manipulation
  const categoriaLegible = (finanza.categoria_gasto || 'Operación').replace(/_/g, ' ')
  const tipoMovimiento = finanza.tipo_movimiento || 'GASTO'

  let descripcion = ''
  let tipo: AuditEvent['tipo'] = 'GASTO'
  let color: AuditEvent['color'] = 'red'

  if (tipoMovimiento === 'ABONO_DEUDA') {
    descripcion = `Pago recibido / Deuda saldada: ${entidad} abonó $${finanza.monto.toLocaleString('es-MX')}`
    tipo = 'ABONO'
    color = 'green'
  } else if (tipoMovimiento === 'INGRESO_COMISION') {
    descripcion = `Comisión ganada por red: ${entidad} registró $${finanza.monto.toLocaleString('es-MX')}`
    tipo = 'ABONO'
    color = 'green'
  } else if (tipoMovimiento === 'DEUDA_A_MATRIZ') {
    descripcion = `Efectivo recolectado (Por entregar a Matriz): ${entidad} resguardó $${finanza.monto.toLocaleString('es-MX')}`
    tipo = 'ABONO'
    color = 'gray'
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
  const producto = getNombreFromRelation(inv.producto, 'Producto')
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
  } else {
    descripcion = `${tipoMovimiento.replace(/_/g, ' ')} de ${inv.cantidad}x de ${producto}`
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
      text: 'text-green-600',
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
    },
    gray: {
      border: 'border-gray-500',
      bg: 'bg-gray-100',
      text: 'text-gray-500',
      dot: 'bg-gray-500'
    }
  }

  return colorMap[color]
}
