import { supabase } from './supabase'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from './inventario-types'
import {
  esAbonoPendienteAprobacion,
  esPagoImpuestoIeps,
  esPagoImpuestoIva,
  movimientoContableEfectivo
} from './finance-utils'

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

export interface LiquidezPorCuenta {
  EFECTIVO: number
  CUENTA_PERSONAL: number
  CUENTA_FRESNILLO: number
}

export interface PasivosFiscalesAdmin {
  ivaPorPagar: number
  iepsPorPagar: number
}

type MovimientoPasivoFiscal = {
  tipo_movimiento: string
  monto: number
  status: string
  categoria?: string | null
  categoria_gasto?: string | null
  descripcion?: string | null
  id_cuenta_destino: string | null
  id_cuenta_origen?: string | null
}

export type MovimientoEgresoAdmin = {
  tipo_movimiento: string
  monto: number
  status: string
  categoria?: string | null
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
}

export const TIPOS_EGRESO_ADMIN = [
  'GASTO_OPERATIVO',
  'COMPRA_INSUMOS',
  'SUBSIDIO_FISCAL',
  'EGRESO_TRASPASO'
] as const

function movimientoTocaCuentaAdminId(
  mov: { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null },
  adminAccountSet: Set<string>
): boolean {
  return (
    Boolean(mov.id_cuenta_destino && adminAccountSet.has(mov.id_cuenta_destino)) ||
    Boolean(mov.id_cuenta_origen && adminAccountSet.has(mov.id_cuenta_origen))
  )
}

/** Resuelve la cuenta admin afectada por un egreso (GASTO_OPERATIVO usa destino legacy). */
export function resolveCuentaEgresoAdmin(
  mov: Pick<MovimientoEgresoAdmin, 'tipo_movimiento' | 'id_cuenta_origen' | 'id_cuenta_destino'>
): string | null {
  if (mov.tipo_movimiento === 'GASTO_OPERATIVO' || mov.tipo_movimiento === 'EGRESO_TRASPASO') {
    return mov.id_cuenta_origen ?? mov.id_cuenta_destino
  }
  return mov.id_cuenta_origen ?? mov.id_cuenta_destino
}

export function esTipoEgresoAdmin(tipoMovimiento: string): boolean {
  return (
    TIPOS_EGRESO_ADMIN.includes(tipoMovimiento as (typeof TIPOS_EGRESO_ADMIN)[number]) ||
    tipoMovimiento.startsWith('EGRESO_') ||
    tipoMovimiento.startsWith('GASTO_') ||
    tipoMovimiento.startsWith('CARGO_')
  )
}

/** Egresos del periodo alineados con General Dashboard (cuentas admin). */
export function calcularEgresosAdmin(
  movimientos: MovimientoEgresoAdmin[],
  adminAccountIds: string[]
): number {
  if (adminAccountIds.length === 0) return 0

  const adminAccountSet = new Set(adminAccountIds)
  return movimientos
    .filter((m) => movimientoContableEfectivo(m.status, m.categoria))
    .filter((m) => esTipoEgresoAdmin(m.tipo_movimiento))
    .filter((m) => {
      const cuenta = resolveCuentaEgresoAdmin(m)
      return cuenta != null && adminAccountSet.has(cuenta)
    })
    .reduce((sum, m) => sum + m.monto, 0)
}

/** Pasivos fiscales netos = PASIVO_* acumulado − pagos GASTO_OPERATIVO de impuestos. */
export function calcularPasivosFiscalesAdmin(
  movimientos: MovimientoPasivoFiscal[],
  adminAccountIds: string[]
): PasivosFiscalesAdmin {
  if (adminAccountIds.length === 0) {
    return { ivaPorPagar: 0, iepsPorPagar: 0 }
  }

  const adminAccountSet = new Set(adminAccountIds)
  const movimientosActivos = movimientos.filter(
    (mov) =>
      mov.status === 'ACTIVO' &&
      !esAbonoPendienteAprobacion(mov.categoria) &&
      movimientoTocaCuentaAdminId(mov, adminAccountSet)
  )

  const pasivosIva = movimientosActivos
    .filter((mov) => mov.tipo_movimiento === 'PASIVO_IVA')
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pasivosIeps = movimientosActivos
    .filter((mov) => mov.tipo_movimiento === 'PASIVO_IEPS')
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pagosIva = movimientosActivos
    .filter((mov) => esPagoImpuestoIva(mov))
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pagosIeps = movimientosActivos
    .filter((mov) => esPagoImpuestoIeps(mov))
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  return {
    ivaPorPagar: Math.max(0, pasivosIva - pagosIva),
    iepsPorPagar: Math.max(0, pasivosIeps - pagosIeps)
  }
}

function inferCuentaDestinoLegacy(categoriaGasto?: string | null): keyof LiquidezPorCuenta | null {
  const texto = (categoriaGasto || '').toUpperCase()
  if (!texto) return null

  if (texto.includes('FRESNILLO') || texto.includes('EMPRESA')) return 'CUENTA_FRESNILLO'
  if (texto.includes('PERSONAL')) return 'CUENTA_PERSONAL'
  if (texto.includes('EFECTIVO') || texto.includes('CAJA')) return 'EFECTIVO'

  return null
}

/** Cuentas financieras del ADMIN (ids + nombre para buckets de liquidez). */
async function fetchAdminCuentasRows(): Promise<{ id: string; nombre: string }[]> {
  const { data: adminEntity, error: adminErr } = await supabase
    .from('entidades')
    .select('id')
    .eq('rol', 'ADMIN')
    .limit(1)
    .maybeSingle()

  if (adminErr || !adminEntity?.id) {
    if (adminErr) console.error('fetchAdminCuentasRows entidad:', adminErr.message)
    return []
  }

  const { data: cuentas, error: cuentasErr } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre')
    .eq('id_entidad', adminEntity.id)

  if (cuentasErr || !cuentas) {
    if (cuentasErr) console.error('fetchAdminCuentasRows cuentas:', cuentasErr.message)
    return []
  }

  return cuentas.map((c) => ({ id: c.id, nombre: c.nombre ?? '' }))
}

/** IDs de cuentas financieras de la entidad ADMIN (misma regla que firewall en Finanzas). */
async function fetchAdminCuentaIds(): Promise<string[]> {
  const rows = await fetchAdminCuentasRows()
  return rows.map((r) => r.id)
}

function clasificarCuentaLiquidezPorNombre(nombre: string): keyof LiquidezPorCuenta | null {
  const cuentaUpper = String(nombre).toUpperCase()
  if (cuentaUpper.includes('EFECTIVO') || cuentaUpper.includes('CAJA')) return 'EFECTIVO'
  if (cuentaUpper.includes('PERSONAL')) return 'CUENTA_PERSONAL'
  if (cuentaUpper.includes('FRESNILLO') || cuentaUpper.includes('EMPRESA')) return 'CUENTA_FRESNILLO'
  return null
}

function movimientoTocaFirewallAdmin(
  row: { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null },
  adminSet: Set<string>
): boolean {
  return (
    Boolean(row.id_cuenta_destino && adminSet.has(row.id_cuenta_destino)) ||
    Boolean(row.id_cuenta_origen && adminSet.has(row.id_cuenta_origen))
  )
}

export async function getFinanzasDashboard(
  fechaInicio?: string,
  fechaFin?: string
): Promise<FinanzasDashboard> {
  try {
    const adminIds = await fetchAdminCuentaIds()
    const adminSet = new Set(adminIds)

    let query = supabase.from('finanzas_ledger')
      .select(
        'tipo_movimiento, monto, categoria, fecha_movimiento, id_cuenta_destino, id_cuenta_origen, status'
      )
      .in('status', ['APPROVED', 'ACTIVO'])

    if (fechaInicio && fechaFin) {
      query = query
        .gte('fecha_movimiento', fechaInicio)
        .lte('fecha_movimiento', fechaFin)
    }

    const { data: movimientosRaw, error } = await query

    if (error || !movimientosRaw) {
      console.error('Error fetching finanzas:', error?.message, error?.details, error?.hint)
      return {
        totalIngresos: 0,
        totalEgresos: 0,
        desgloseIngresos: { ventaRed: 0, ventaDirecta: 0, abonos: 0 },
        desgloseEgresos: { insumos: 0, renta: 0, logistica: 0, otros: 0 }
      }
    }

    const movimientos =
      adminIds.length === 0
        ? []
        : movimientosRaw.filter((m) => movimientoTocaFirewallAdmin(m, adminSet))

    const tiposIngreso = ['INGRESO_VENTA', 'ABONO_DEUDA']

    const ingresos = movimientos.filter(
      (m) =>
        tiposIngreso.includes(m.tipo_movimiento ?? '') &&
        movimientoContableEfectivo(m.status ?? '', m.categoria)
    )
    const egresos = movimientos.filter(
      (m) =>
        esTipoEgresoAdmin(m.tipo_movimiento ?? '') &&
        movimientoContableEfectivo(m.status ?? '', m.categoria) &&
        (() => {
          const cuenta = resolveCuentaEgresoAdmin({
            tipo_movimiento: m.tipo_movimiento ?? '',
            id_cuenta_origen: m.id_cuenta_origen ?? null,
            id_cuenta_destino: m.id_cuenta_destino ?? null
          })
          return cuenta != null && adminSet.has(cuenta)
        })()
    )

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
      .filter(
        (m) =>
          m.categoria === 'INSUMOS' ||
          m.categoria === 'Insumos' ||
          m.tipo_movimiento === 'COMPRA_INSUMOS'
      )
      .reduce((sum, m) => sum + m.monto, 0)
    
    const renta = egresos
      .filter(m => m.categoria === 'RENTA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const logistica = egresos
      .filter(m => m.categoria === 'LOGISTICA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const otros = egresos
      .filter(
        (m) =>
          !['INSUMOS', 'Insumos', 'RENTA', 'LOGISTICA'].includes(String(m.categoria ?? '')) &&
          m.tipo_movimiento !== 'COMPRA_INSUMOS'
      )
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

export async function getLiquidezPorCuenta(
  fechaInicio?: string,
  fechaFin?: string
): Promise<LiquidezPorCuenta> {
  const resultado: LiquidezPorCuenta = {
    EFECTIVO: 0,
    CUENTA_PERSONAL: 0,
    CUENTA_FRESNILLO: 0
  }

  try {
    const adminRows = await fetchAdminCuentasRows()
    const adminIds = adminRows.map((r) => r.id)
    const adminSet = new Set(adminIds)

    const cuentaIdABucket = new Map<string, keyof LiquidezPorCuenta>()
    for (const row of adminRows) {
      const bucket = clasificarCuentaLiquidezPorNombre(row.nombre)
      if (bucket) cuentaIdABucket.set(row.id, bucket)
    }

    let query = supabase
      .from('finanzas_ledger')
      .select('monto, tipo_movimiento, id_cuenta_destino, id_cuenta_origen, status, categoria')
      .in('status', ['APPROVED', 'ACTIVO'])

    if (fechaInicio && fechaFin) {
      query = query
        .gte('fecha_movimiento', fechaInicio)
        .lte('fecha_movimiento', fechaFin)
    }

    const { data, error } = await query

    if (error || !data) {
      console.error('Error fetching liquidez por cuenta:', error?.message, error?.details, error?.hint)
      return resultado
    }

    const tiposIngreso = new Set(['INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO'])
    const tiposEgreso = new Set([
      'GASTO_OPERATIVO',
      'CARGO_DEUDA',
      'SUBSIDIO_FISCAL',
      'COMPRA_INSUMOS',
      'EGRESO_TRASPASO'
    ])

    const filas =
      adminIds.length === 0
        ? []
        : data.filter(
            (mov) =>
              movimientoTocaFirewallAdmin(mov, adminSet) &&
              movimientoContableEfectivo(mov.status ?? '', mov.categoria)
          )

    filas.forEach((mov) => {
      const monto = Number(mov.monto) || 0

      if (tiposIngreso.has(mov.tipo_movimiento ?? '') && mov.id_cuenta_destino) {
        const bucket = cuentaIdABucket.get(mov.id_cuenta_destino)
        if (bucket) resultado[bucket] += monto
      }

      if (tiposEgreso.has(mov.tipo_movimiento ?? '')) {
        const cuentaId = resolveCuentaEgresoAdmin({
          tipo_movimiento: mov.tipo_movimiento ?? '',
          id_cuenta_origen: mov.id_cuenta_origen ?? null,
          id_cuenta_destino: mov.id_cuenta_destino ?? null
        })
        if (!cuentaId) return
        const bucket = cuentaIdABucket.get(cuentaId)
        if (bucket) resultado[bucket] -= monto
      }
    })

    return resultado
  } catch (error: any) {
    console.error('Error in getLiquidezPorCuenta:', error?.message, error?.details, error?.hint)
    return resultado
  }
}

export async function getLiderazgoRed(
  fechaInicio?: string,
  fechaFin?: string
): Promise<LiderazgoRed> {
  try {
    const { data: entidades, error: entidadesError } = await supabase
      .from('entidades')
      .select('id, nombre, rol, id_padre, id_nodo_padre')
      .neq('rol', 'ADMIN')

    if (entidadesError || !entidades) {
      console.error('Error fetching entidades:', entidadesError?.message, entidadesError?.details, entidadesError?.hint)
      return { nodosAlfa: [], subNodos: [] }
    }

    let ticketsQuery = supabase
      .from('transacciones_tickets')
      .select('id_comprador, monto_base_ingreso, total_cobrado_real, fecha_transaccion')

    if (fechaInicio && fechaFin) {
      ticketsQuery = ticketsQuery
        .gte('fecha_transaccion', fechaInicio)
        .lte('fecha_transaccion', fechaFin)
    }

    const { data: tickets, error: ticketsError } = await ticketsQuery

    if (ticketsError) {
      console.error('Error fetching tickets:', ticketsError?.message, ticketsError?.details, ticketsError?.hint)
    }

    let ledgerQuery = supabase
      .from('finanzas_ledger')
      .select('id_entidad_relacionada, tipo_movimiento, monto, fecha_movimiento')
      .in('status', ['APPROVED', 'ACTIVO'])

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
      
      const totalGenerado = ticketsComprador.reduce(
        (sum, t) => sum + (entidad.rol === 'DST' ? (t.monto_base_ingreso || 0) : (t.total_cobrado_real || 0)),
        0
      )
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

      const parentId = entidad.id_nodo_padre ?? entidad.id_padre
      const padre = entidades.find(e => e.id === parentId)

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
      .select('id_producto, tipo_movimiento, cantidad, status')

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
        if (mov.status === 'ANULADO') return
        const stockActual = stockPorProducto.get(mov.id_producto) || 0
        if (isTipoMovimientoEntrada(mov.tipo_movimiento)) {
          stockPorProducto.set(mov.id_producto, stockActual + mov.cantidad)
        } else if (isTipoMovimientoSalida(mov.tipo_movimiento)) {
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

export function calcularFechasPorRango(rango: string) {
  const hoy = new Date()
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
  
  switch (rango) {
    case 'TODO':
      return { fechaInicio: undefined, fechaFin: undefined }
    case 'HOY':
      return {
        fechaInicio: hoy.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    case 'ESTE_MES':
      return {
        fechaInicio: inicioMes.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    case 'TRIMESTRE':
      const inicioTrimestre = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1)
      return {
        fechaInicio: inicioTrimestre.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    default:
      return {
        fechaInicio: inicioMes.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
  }
}

/** Tipos que no deben inflar totales de categoría (doblete con ABONO / venta). */
const TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS = new Set([
  'INGRESO_COMISION',
  'DEUDA_A_MATRIZ',
  'COMISION_PASIVA'
])

export async function getDesgloseCategorias(
  fechaInicio?: string,
  fechaFin?: string,
  cuentaIdsAdmin?: string[]
) {
  try {
    let query = supabase
      .from('finanzas_ledger')
      .select('categoria, monto, tipo_movimiento, id_cuenta_destino, id_cuenta_origen')
      .in('status', ['APPROVED', 'ACTIVO'])

    if (fechaInicio && fechaFin) {
      query = query
        .gte('fecha_movimiento', fechaInicio)
        .lte('fecha_movimiento', fechaFin)
    }

    const { data, error } = await query

    if (error || !data) {
      console.error('Error fetching categorias:', error)
      return []
    }

    let filtrados = data.filter(
      (item) => !TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS.has(String(item.tipo_movimiento ?? ''))
    )

    if (cuentaIdsAdmin?.length) {
      const adminSet = new Set(cuentaIdsAdmin)
      filtrados = filtrados.filter(
        (item) =>
          Boolean(item.id_cuenta_destino && adminSet.has(item.id_cuenta_destino)) ||
          Boolean(item.id_cuenta_origen && adminSet.has(item.id_cuenta_origen))
      )
    }

    const total = filtrados.reduce((sum, item) => sum + item.monto, 0)
    const categoriasMap = new Map<string, number>()

    filtrados.forEach((item) => {
      const categoria = item.categoria || 'Sin Categoría'
      const current = categoriasMap.get(categoria) || 0
      categoriasMap.set(categoria, current + item.monto)
    })

    return Array.from(categoriasMap.entries()).map(([categoria, monto]) => ({
      categoria,
      monto,
      porcentaje: total > 0 ? Math.round((monto / total) * 100) : 0
    }))
  } catch (error) {
    console.error('Error in getDesgloseCategorias:', error)
    return []
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
      .in('status', ['APPROVED', 'ACTIVO'])
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
