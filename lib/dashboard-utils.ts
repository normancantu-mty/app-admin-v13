import { supabase } from './supabase'

export interface DesgloseIngresos {
  ventaRed: number
  ventaDirecta: number
  abonos: number
}

export interface DesgloseEgresos {
  insumos: number
  renta: number
  logistica: number
  otros: number
}

export interface FinanzasDashboard {
  totalIngresos: number
  totalEgresos: number
  desgloseIngresos: DesgloseIngresos
  desgloseEgresos: DesgloseEgresos
}

export interface EntidadLiderazgo {
  id: string
  nombre: string
  rol: string
  patrocinador: string | null
  ingresoNetoEmpresa: number
  deudaActual: number
  diasSinActividad: number
  ultimaActividad: string
}

export interface LiderazgoRed {
  nodosAlfa: EntidadLiderazgo[]
  subNodos: EntidadLiderazgo[]
}

export interface SemaforoAlerta {
  id: string
  nombre: string
  diasSinActividad: number
  deudaActual: number
}

export interface AlertaInventario {
  id: string
  nombre: string
  sku: string
  stockActual: number
  minimoRequerido: number
}

export interface AspectosUrgentes {
  semaforosRojos: SemaforoAlerta[]
  semaforosAmarillos: SemaforoAlerta[]
  alertasInventario: AlertaInventario[]
}

export interface EventoFeed {
  id: string
  tipo: string
  descripcion: string
  fecha: string
  haceCuantoTiempo: string
}

export async function getFinanzasDashboard(
  fechaInicio?: string,
  fechaFin?: string
): Promise<FinanzasDashboard> {
  try {
    let query = supabase.from('finanzas_ledger').select('tipo_movimiento, monto, categoria').eq('status', 'APPROVED')

    if (fechaInicio) {
      query = query.gte('fecha_movimiento', fechaInicio)
    }
    if (fechaFin) {
      query = query.lte('fecha_movimiento', fechaFin)
    }

    const { data: movimientos, error } = await query

    if (error || !movimientos) {
      console.error('Error fetching finanzas:', error?.message, error?.details, error?.hint)
      return {
        totalIngresos: 0,
        totalEgresos: 0,
        desgloseIngresos: { ventaRed: 0, ventaDirecta: 0, abonos: 0 },
        desgloseEgresos: { insumos: 0, renta: 0, logistica: 0, otros: 0 }
      }
    }

    const tiposIngreso = ['INGRESO_VENTA', 'ABONO_DEUDA']
    const tiposEgreso = ['GASTO_OPERATIVO', 'SUBSIDIO_FISCAL', 'COMPRA_INSUMOS', 'COMISION_PASIVA']

    const ingresos = movimientos.filter(m => tiposIngreso.includes(m.tipo_movimiento))
    const egresos = movimientos.filter(m => tiposEgreso.includes(m.tipo_movimiento))

    const totalIngresos = ingresos.reduce((sum, m) => sum + m.monto, 0)
    const totalEgresos = egresos.reduce((sum, m) => sum + m.monto, 0)

    const ventaRed = ingresos
      .filter(m => m.tipo_movimiento === 'INGRESO_VENTA' && m.categoria === 'VENTA_RED')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const ventaDirecta = ingresos
      .filter(m => m.tipo_movimiento === 'INGRESO_VENTA' && m.categoria === 'VENTA_DIRECTA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const abonos = ingresos
      .filter(m => m.tipo_movimiento === 'ABONO_DEUDA')
      .reduce((sum, m) => sum + m.monto, 0)

    const insumos = egresos
      .filter(m => m.categoria === 'INSUMOS' || m.tipo_movimiento === 'COMPRA_INSUMOS')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const renta = egresos
      .filter(m => m.categoria === 'RENTA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const logistica = egresos
      .filter(m => m.categoria === 'LOGISTICA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const otros = egresos
      .filter(m => !['INSUMOS', 'RENTA', 'LOGISTICA'].includes(m.categoria) && m.tipo_movimiento !== 'COMPRA_INSUMOS')
      .reduce((sum, m) => sum + m.monto, 0)

    return {
      totalIngresos,
      totalEgresos,
      desgloseIngresos: { ventaRed, ventaDirecta, abonos },
      desgloseEgresos: { insumos, renta, logistica, otros }
    }
  } catch (error: any) {
    console.error('Error in getFinanzasDashboard:', error?.message, error?.details, error?.hint)
    return {
      totalIngresos: 0,
      totalEgresos: 0,
      desgloseIngresos: { ventaRed: 0, ventaDirecta: 0, abonos: 0 },
      desgloseEgresos: { insumos: 0, renta: 0, logistica: 0, otros: 0 }
    }
  }
}

export async function getLiderazgoRed(
  fechaInicio?: string,
  fechaFin?: string
): Promise<LiderazgoRed> {
  try {
    const { data: entidades, error: entidadesError } = await supabase
      .from('entidades')
      .select('id, nombre, rol, id_padre')
      .neq('rol', 'ADMIN')

    if (entidadesError || !entidades) {
      console.error('Error fetching entidades:', entidadesError?.message, entidadesError?.details, entidadesError?.hint)
      return { nodosAlfa: [], subNodos: [] }
    }

    let ticketsQuery = supabase
      .from('transacciones_tickets')
      .select('id_comprador, monto_base_ingreso, total_cobrado_real, fecha_transaccion')

    if (fechaInicio) {
      ticketsQuery = ticketsQuery.gte('fecha_transaccion', fechaInicio)
    }
    if (fechaFin) {
      ticketsQuery = ticketsQuery.lte('fecha_transaccion', fechaFin)
    }

    const { data: tickets, error: ticketsError } = await ticketsQuery

    if (ticketsError) {
      console.error('Error fetching tickets:', ticketsError?.message, ticketsError?.details, ticketsError?.hint)
    }

    let ledgerQuery = supabase
      .from('finanzas_ledger')
      .select('id_entidad_relacionada, tipo_movimiento, monto, fecha_movimiento')
      .eq('status', 'APPROVED')

    if (fechaInicio) {
      ledgerQuery = ledgerQuery.gte('fecha_movimiento', fechaInicio)
    }
    if (fechaFin) {
      ledgerQuery = ledgerQuery.lte('fecha_movimiento', fechaFin)
    }

    const { data: ledger, error: ledgerError } = await ledgerQuery

    if (ledgerError) {
      console.error('Error fetching ledger:', ledgerError?.message, ledgerError?.details, ledgerError?.hint)
    }

    const entidadesConMetricas: EntidadLiderazgo[] = entidades.map(entidad => {
      const ticketsComprador = tickets?.filter(t => t.id_comprador === entidad.id) || []
      const abonosEntidad = ledger?.filter(
        l => l.id_entidad_relacionada === entidad.id && l.tipo_movimiento === 'ABONO_DEUDA'
      ) || []

      const ingresoNetoEmpresa = ticketsComprador.reduce((sum, t) => sum + (t.monto_base_ingreso || 0), 0)
      
      const totalGenerado = ticketsComprador.reduce((sum, t) => sum + (t.total_cobrado_real || 0), 0)
      const totalAbonado = abonosEntidad.reduce((sum, a) => sum + a.monto, 0)
      const deudaActual = totalGenerado - totalAbonado

      const ultimaActividadTicket = ticketsComprador.length > 0
        ? new Date(Math.max(...ticketsComprador.map(t => new Date(t.fecha_transaccion).getTime())))
        : null

      const ultimaActividadLedger = abonosEntidad.length > 0
        ? new Date(Math.max(...abonosEntidad.map(l => new Date(l.fecha_movimiento).getTime())))
        : null

      let ultimaActividad: Date | null = null
      if (ultimaActividadTicket && ultimaActividadLedger) {
        ultimaActividad = ultimaActividadTicket > ultimaActividadLedger ? ultimaActividadTicket : ultimaActividadLedger
      } else if (ultimaActividadTicket) {
        ultimaActividad = ultimaActividadTicket
      } else if (ultimaActividadLedger) {
        ultimaActividad = ultimaActividadLedger
      }

      const diasSinActividad = ultimaActividad
        ? Math.floor((Date.now() - ultimaActividad.getTime()) / (1000 * 60 * 60 * 24))
        : 999

      const padre = entidades.find(e => e.id === entidad.id_padre)

      return {
        id: entidad.id,
        nombre: entidad.nombre,
        rol: entidad.rol,
        patrocinador: padre ? padre.nombre : null,
        ingresoNetoEmpresa,
        deudaActual,
        diasSinActividad,
        ultimaActividad: ultimaActividad ? ultimaActividad.toISOString() : ''
      }
    })

    const nodosAlfa = entidadesConMetricas
      .filter(e => !e.patrocinador)
      .sort((a, b) => b.ingresoNetoEmpresa - a.ingresoNetoEmpresa)

    const subNodos = entidadesConMetricas
      .filter(e => e.patrocinador)
      .sort((a, b) => b.ingresoNetoEmpresa - a.ingresoNetoEmpresa)

    return { nodosAlfa, subNodos }
  } catch (error: any) {
    console.error('Error in getLiderazgoRed:', error?.message, error?.details, error?.hint)
    return { nodosAlfa: [], subNodos: [] }
  }
}

export async function getAspectosUrgentes(): Promise<AspectosUrgentes> {
  try {
    const { data: inventarioLedger, error: inventarioError } = await supabase
      .from('inventario_ledger')
      .select('id_producto, tipo_movimiento, cantidad')

    if (inventarioError) {
      console.error('Error fetching inventario:', inventarioError?.message, inventarioError?.details, inventarioError?.hint)
    }

    const { data: productos, error: productosError } = await supabase
      .from('catalogo_productos')
      .select('id, nombre, sku')

    if (productosError) {
      console.error('Error fetching productos:', productosError?.message, productosError?.details, productosError?.hint)
    }

    const alertasInventario: AlertaInventario[] = []

    if (inventarioLedger && productos) {
      const stockPorProducto = new Map<string, number>()

      inventarioLedger.forEach(mov => {
        const stockActual = stockPorProducto.get(mov.id_producto) || 0
        if (mov.tipo_movimiento === 'ENTRADA') {
          stockPorProducto.set(mov.id_producto, stockActual + mov.cantidad)
        } else if (mov.tipo_movimiento === 'SALIDA') {
          stockPorProducto.set(mov.id_producto, stockActual - mov.cantidad)
        }
      })

      stockPorProducto.forEach((stock, idProducto) => {
        if (stock < 20) {
          const producto = productos.find(p => p.id === idProducto)
          if (producto) {
            alertasInventario.push({
              id: producto.id,
              nombre: producto.nombre,
              sku: producto.sku,
              stockActual: stock,
              minimoRequerido: 20
            })
          }
        }
      })
    }

    const liderazgo = await getLiderazgoRed()
    const todasEntidades = [...liderazgo.nodosAlfa, ...liderazgo.subNodos]

    const semaforosRojos: SemaforoAlerta[] = todasEntidades
      .filter(e => e.diasSinActividad > 30)
      .map(e => ({
        id: e.id,
        nombre: e.nombre,
        diasSinActividad: e.diasSinActividad,
        deudaActual: e.deudaActual
      }))

    const semaforosAmarillos: SemaforoAlerta[] = todasEntidades
      .filter(e => e.diasSinActividad > 15 && e.diasSinActividad <= 30)
      .map(e => ({
        id: e.id,
        nombre: e.nombre,
        diasSinActividad: e.diasSinActividad,
        deudaActual: e.deudaActual
      }))

    return {
      semaforosRojos,
      semaforosAmarillos,
      alertasInventario
    }
  } catch (error: any) {
    console.error('Error in getAspectosUrgentes:', error?.message, error?.details, error?.hint)
    return {
      semaforosRojos: [],
      semaforosAmarillos: [],
      alertasInventario: []
    }
  }
}

export async function getFeedGlobal(): Promise<EventoFeed[]> {
  try {
    const { data: tickets, error: ticketsError } = await supabase
      .from('transacciones_tickets')
      .select('id, id_vendedor, id_comprador, total_cobrado_real, fecha_transaccion, comprador:entidades!id_comprador(nombre)')
      .order('fecha_transaccion', { ascending: false })
      .limit(10)

    if (ticketsError) {
      console.error('Error fetching tickets for feed:', ticketsError?.message, ticketsError?.details, ticketsError?.hint)
    }

    const { data: ledger, error: ledgerError } = await supabase
      .from('finanzas_ledger')
      .select('id, tipo_movimiento, monto, categoria, fecha_movimiento, id_entidad_relacionada')
      .eq('status', 'APPROVED')
      .order('fecha_movimiento', { ascending: false })
      .limit(10)

    if (ledgerError) {
      console.error('Error fetching ledger for feed:', ledgerError?.message, ledgerError?.details, ledgerError?.hint)
    }

    const eventos: EventoFeed[] = []

    if (tickets) {
      tickets.forEach(ticket => {
        const compradorNombre = (ticket.comprador as any)?.nombre || 'Cliente'
        eventos.push({
          id: ticket.id,
          tipo: 'Venta',
          descripcion: `Venta a ${compradorNombre} - $${ticket.total_cobrado_real.toLocaleString('es-MX')}`,
          fecha: ticket.fecha_transaccion,
          haceCuantoTiempo: calcularTiempoTranscurrido(ticket.fecha_transaccion)
        })
      })
    }

    if (ledger) {
      ledger.forEach(mov => {
        let tipo = 'Movimiento'
        let descripcion = ''

        if (mov.tipo_movimiento === 'ABONO_DEUDA') {
          tipo = 'Abono'
          descripcion = `Abono - $${mov.monto.toLocaleString('es-MX')}`
        } else if (mov.tipo_movimiento === 'GASTO_OPERATIVO') {
          tipo = 'Gasto'
          descripcion = `Gasto: ${mov.categoria} - $${mov.monto.toLocaleString('es-MX')}`
        } else if (mov.tipo_movimiento === 'COMPRA_INSUMOS') {
          tipo = 'Gasto'
          descripcion = `Compra Insumos - $${mov.monto.toLocaleString('es-MX')}`
        } else if (mov.tipo_movimiento === 'SUBSIDIO_FISCAL') {
          tipo = 'Gasto'
          descripcion = `Subsidio Fiscal - $${mov.monto.toLocaleString('es-MX')}`
        } else if (mov.tipo_movimiento === 'COMISION_PASIVA') {
          tipo = 'Gasto'
          descripcion = `Comisión Pasiva - $${mov.monto.toLocaleString('es-MX')}`
        }

        eventos.push({
          id: mov.id,
          tipo,
          descripcion,
          fecha: mov.fecha_movimiento,
          haceCuantoTiempo: calcularTiempoTranscurrido(mov.fecha_movimiento)
        })
      })
    }

    eventos.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())

    return eventos.slice(0, 15)
  } catch (error: any) {
    console.error('Error in getFeedGlobal:', error?.message, error?.details, error?.hint)
    return []
  }
}

function calcularTiempoTranscurrido(fecha: string): string {
  const ahora = Date.now()
  const entonces = new Date(fecha).getTime()
  const diferencia = ahora - entonces

  const minutos = Math.floor(diferencia / (1000 * 60))
  const horas = Math.floor(diferencia / (1000 * 60 * 60))
  const dias = Math.floor(diferencia / (1000 * 60 * 60 * 24))

  if (minutos < 1) return 'Hace un momento'
  if (minutos < 60) return `Hace ${minutos} min`
  if (horas < 24) return `Hace ${horas} ${horas === 1 ? 'hora' : 'horas'}`
  return `Hace ${dias} ${dias === 1 ? 'día' : 'días'}`
}
