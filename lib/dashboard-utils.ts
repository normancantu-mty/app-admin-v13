import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from './inventario-types'
import {
  esAbonoPendienteAprobacion,
  esPagoImpuestoIeps,
  esPagoImpuestoIva,
  movimientoContableEfectivo
} from './finance-utils'
import { limitesRangoMX } from './date-format'
import { calcularSaldoPendienteInventarioConsignacion } from './distribuidores-saldos'

// Re-exportado a propósito: las pantallas piden el rango a dashboard-utils, y la
// única implementación vive en date-format.ts junto con los límites del rango.
export { calcularFechasPorRango, limitesRangoMX } from './date-format'

/**
 * **Este modulo es server-only** (importa `next/headers`). No lo importes desde
 * un componente con `'use client'`: es un Client Boundary Error fatal.
 *
 * Cliente por request con la sesion del usuario. Antes este archivo usaba el
 * cliente de navegador de `lib/supabase.ts`; en un Server Component ese cliente
 * no ve las cookies de Next, viaja como `anon`, y desde que se cerro la lectura
 * anonima **cada consulta del Dashboard General devolvia
 * `permission denied for table ...`**. Los `try/catch` se lo tragaban y la
 * pantalla pintaba ceros. Mismo patron que ya usan `inventario/page.tsx` y
 * `feed/page.tsx`.
 */
async function getSupabaseServer() {
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

/**
 * Días sin actividad que pintan el semáforo. **Un solo umbral para todo el ERP**
 * (antes: 15/30 en el Dashboard General y 7/14 en el directorio, para la misma
 * entidad el mismo día). Se conserva 7/14, que es el que Norman ve a diario en
 * el directorio (`getSemaforoMovimiento` en `lib/risk-utils.ts`).
 */
export const DIAS_SEMAFORO_AMARILLO = 7
export const DIAS_SEMAFORO_ROJO = 14

/** Tope duro de PostgREST: sin `.range()` explícito nunca devuelve más de esto. */
const TAMANO_PAGINA = 1000

interface ConsultaPaginable<T> {
  range(desde: number, hasta: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/**
 * Trae **todas** las filas de una consulta, paginando con `.range()`.
 *
 * PostgREST corta en 1000 filas sin avisar. Un ledger truncado no da error: da
 * un saldo falso. Toda consulta cuyo resultado se vaya a sumar (dinero o stock)
 * tiene que pasar por aquí. Si la página falla, se lanza el error en vez de
 * devolver una suma incompleta.
 */
export async function fetchTodasLasFilas<T>(
  construirConsulta: () => ConsultaPaginable<T>,
  etiqueta: string
): Promise<T[]> {
  const filas: T[] = []

  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await construirConsulta().range(desde, desde + TAMANO_PAGINA - 1)

    if (error) {
      throw new Error(`${etiqueta}: ${error.message}`)
    }

    const pagina = data ?? []
    filas.push(...pagina)
    if (pagina.length < TAMANO_PAGINA) return filas
  }
}

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
  /** Mercancía en consignación pendiente de liquidar. Mismo número (y misma
   *  función) que "Saldo Pendiente" del directorio y del perfil. */
  saldoPendiente: number
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
  saldoPendiente: number
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

/** Ticket tal como lo lee el Liderazgo de Red (con condición y status). */
type TicketLiderazgo = {
  id_comprador: string | null
  monto_base_ingreso: number
  total_cobrado_real: number
  condicion_pago: string
  status: string | null
  fecha_transaccion: string
}

/** Fila de finanzas que ajusta un saldo de la red (abonos y cargos). */
type AjusteLiderazgo = {
  id_entidad_relacionada: string | null
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  fecha_movimiento: string
}

/** Fila del ledger tal como la leen los KPIs del Dashboard General. */
type MovimientoLedgerDashboard = {
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  fecha_movimiento: string
  id_cuenta_destino: string | null
  id_cuenta_origen: string | null
  status: string | null
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

/**
 * **Account_Firewall — única implementación del ERP.**
 *
 * Un movimiento entra en cualquier KPI de nivel Admin sólo si toca una cuenta
 * del ADMIN por **origen o por destino**. Antes vivía copiada cuatro veces
 * (dos aquí, una en `getDesgloseCategorias` y otra en `finanzas/page.tsx`), y
 * una de las copias fallaba abierta.
 */
export function movimientoTocaCuentaAdmin(
  mov: { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null },
  adminAccountSet: Set<string>
): boolean {
  return (
    Boolean(mov.id_cuenta_destino && adminAccountSet.has(mov.id_cuenta_destino)) ||
    Boolean(mov.id_cuenta_origen && adminAccountSet.has(mov.id_cuenta_origen))
  )
}

/**
 * Aplica el firewall a una lista. **Falla cerrada:** si no se pudo resolver
 * ninguna cuenta del ADMIN, devuelve vacío. Devolver la lista completa —lo que
 * hacía `finanzas/page.tsx:70`— era publicar el ledger de toda la red.
 */
export function filtrarMovimientosFirewallAdmin<
  T extends { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null }
>(movimientos: T[], adminAccountIds: string[]): T[] {
  if (adminAccountIds.length === 0) return []
  const adminAccountSet = new Set(adminAccountIds)
  return movimientos.filter((m) => movimientoTocaCuentaAdmin(m, adminAccountSet))
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
      movimientoTocaCuentaAdmin(mov, adminAccountSet)
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
  const supabase = await getSupabaseServer()
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

export async function getFinanzasDashboard(
  fechaInicio?: string,
  fechaFin?: string
): Promise<FinanzasDashboard> {
  try {
    const supabase = await getSupabaseServer()
    const adminIds = await fetchAdminCuentaIds()
    const adminSet = new Set(adminIds)

    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const movimientosRaw = await fetchTodasLasFilas<MovimientoLedgerDashboard>(() => {
      let query = supabase.from('finanzas_ledger')
        .select(
          'tipo_movimiento, monto, categoria, fecha_movimiento, id_cuenta_destino, id_cuenta_origen, status'
        )
        .in('status', ['APPROVED', 'ACTIVO'])

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'getFinanzasDashboard')

    const movimientos = filtrarMovimientosFirewallAdmin(movimientosRaw, adminIds)

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
    const supabase = await getSupabaseServer()
    const adminRows = await fetchAdminCuentasRows()
    const adminIds = adminRows.map((r) => r.id)

    const cuentaIdABucket = new Map<string, keyof LiquidezPorCuenta>()
    for (const row of adminRows) {
      const bucket = clasificarCuentaLiquidezPorNombre(row.nombre)
      if (bucket) cuentaIdABucket.set(row.id, bucket)
    }

    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const data = await fetchTodasLasFilas<MovimientoLedgerDashboard>(() => {
      let query = supabase
        .from('finanzas_ledger')
        .select('monto, tipo_movimiento, id_cuenta_destino, id_cuenta_origen, status, categoria, fecha_movimiento')
        .in('status', ['APPROVED', 'ACTIVO'])

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'getLiquidezPorCuenta')

    const tiposIngreso = new Set(['INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO'])
    const tiposEgreso = new Set([
      'GASTO_OPERATIVO',
      'CARGO_DEUDA',
      'SUBSIDIO_FISCAL',
      'COMPRA_INSUMOS',
      'EGRESO_TRASPASO'
    ])

    const filas = filtrarMovimientosFirewallAdmin(data, adminIds).filter((mov) =>
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
    const supabase = await getSupabaseServer()
    const { data: entidades, error: entidadesError } = await supabase
      .from('entidades')
      .select('id, nombre, rol, id_padre, id_nodo_padre')
      .neq('rol', 'ADMIN')

    if (entidadesError || !entidades) {
      console.error('Error fetching entidades:', entidadesError?.message, entidadesError?.details, entidadesError?.hint)
      return { nodosAlfa: [], subNodos: [] }
    }

    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const tickets = await fetchTodasLasFilas<TicketLiderazgo>(() => {
      let query = supabase
        .from('transacciones_tickets')
        .select(
          'id_comprador, monto_base_ingreso, total_cobrado_real, condicion_pago, status, fecha_transaccion'
        )

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_transaccion', desde).lt('fecha_transaccion', hastaExclusivo)
      }

      return query
    }, 'getLiderazgoRed tickets')

    const ledger = await fetchTodasLasFilas<AjusteLiderazgo>(() => {
      let query = supabase
        .from('finanzas_ledger')
        .select('id_entidad_relacionada, tipo_movimiento, monto, categoria, fecha_movimiento')
        .in('status', ['APPROVED', 'ACTIVO'])

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'getLiderazgoRed ledger')

    const entidadesConMetricas: EntidadLiderazgo[] = entidades.map(entidad => {
      const ticketsComprador = tickets.filter(t => t.id_comprador === entidad.id)
      const ticketsVivos = ticketsComprador.filter(t => (t.status ?? 'ACTIVO') !== 'ANULADO')
      const ajustesEntidad = ledger.filter(l => l.id_entidad_relacionada === entidad.id)
      const abonosEntidad = ajustesEntidad.filter(l => l.tipo_movimiento === 'ABONO_DEUDA')

      const ingresoNetoEmpresa = ticketsVivos.reduce((sum, t) => sum + (t.monto_base_ingreso || 0), 0)

      // Misma función que el perfil y que el directorio (`distribuidores-saldos`):
      // sólo mercancía en CONSIGNACIÓN viva, más CARGO_DEUDA, menos abonos ya
      // aprobados. Antes se sumaban aquí a mano TODOS los tickets del comprador
      // —incluidos los ANULADOS y los de CONTADO— y sólo se restaban abonos.
      const saldoPendiente = calcularSaldoPendienteInventarioConsignacion(
        { id: entidad.id, rol: entidad.rol as 'DST' | 'LOC' | 'SOCIO' },
        ticketsComprador,
        [entidad.id],
        ajustesEntidad
      )

      const ultimaActividadTicket = ticketsVivos.length > 0
        ? new Date(Math.max(...ticketsVivos.map(t => new Date(t.fecha_transaccion).getTime())))
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
        saldoPendiente,
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

/**
 * Alertas del panel derecho del Dashboard General.
 *
 * Recibe el liderazgo ya calculado: antes lo volvia a pedir aqui dentro, asi
 * que cada carga del General traia dos veces los tickets y el ledger completos.
 */
export async function getAspectosUrgentes(liderazgo: LiderazgoRed): Promise<AspectosUrgentes> {
  try {
    const supabase = await getSupabaseServer()
    const inventarioLedger = await fetchTodasLasFilas<{
      id_producto: string
      tipo_movimiento: string
      cantidad: number
      status: string | null
    }>(
      () => supabase.from('inventario_ledger').select('id_producto, tipo_movimiento, cantidad, status'),
      'getAspectosUrgentes inventario'
    )

    const { data: productos, error: productosError } = await supabase
      .from('catalogo_productos')
      .select('id, nombre, sku')

    if (productosError) {
      console.error('Error fetching productos:', productosError?.message, productosError?.details, productosError?.hint)
    }

    const alertasInventario: AlertaInventario[] = []

    if (productos) {
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

    const todasEntidades = [...liderazgo.nodosAlfa, ...liderazgo.subNodos]
    const aAlerta = (e: EntidadLiderazgo): SemaforoAlerta => ({
      id: e.id,
      nombre: e.nombre,
      diasSinActividad: e.diasSinActividad,
      saldoPendiente: e.saldoPendiente
    })

    const semaforosRojos: SemaforoAlerta[] = todasEntidades
      .filter(e => e.diasSinActividad > DIAS_SEMAFORO_ROJO)
      .map(aAlerta)

    const semaforosAmarillos: SemaforoAlerta[] = todasEntidades
      .filter(
        e => e.diasSinActividad >= DIAS_SEMAFORO_AMARILLO && e.diasSinActividad <= DIAS_SEMAFORO_ROJO
      )
      .map(aAlerta)

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

/** Tipos que no deben inflar totales de categoría (doblete con ABONO / venta). */
const TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS = new Set([
  'INGRESO_COMISION',
  'DEUDA_A_MATRIZ',
  'COMISION_PASIVA'
])

/** Tipos que cuentan como entrada de dinero en el desglose por categoria. */
const TIPOS_INGRESO_DESGLOSE = new Set([
  'INGRESO_VENTA',
  'ABONO_DEUDA',
  'INGRESO_TRASPASO',
  'INGRESO'
])

export type GrupoCategoria = 'INGRESO' | 'EGRESO'

export interface CategoriaDesglose {
  categoria: string
  monto: number
  porcentaje: number
  grupo: GrupoCategoria
}

/**
 * Desglose por categoria de la pantalla de Finanzas.
 *
 * Dos correcciones respecto de la version anterior:
 * 1. **Ingresos y egresos ya no comparten total.** Antes se sumaban en un mismo
 *    denominador, asi que un peso cobrado y un peso gastado se cancelaban en el
 *    porcentaje y el total no era ni la caja ni el gasto: era la suma de los dos.
 * 2. **Se aplica `movimientoContableEfectivo`**, igual que las tarjetas de
 *    arriba en esa misma pantalla, para no colar `ABONO_PENDIENTE`.
 */
export async function getDesgloseCategorias(
  fechaInicio?: string,
  fechaFin?: string,
  cuentaIdsAdmin?: string[]
): Promise<CategoriaDesglose[]> {
  try {
    const supabase = await getSupabaseServer()
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const data = await fetchTodasLasFilas<MovimientoLedgerDashboard>(() => {
      let query = supabase
        .from('finanzas_ledger')
        .select(
          'categoria, monto, tipo_movimiento, id_cuenta_destino, id_cuenta_origen, status, fecha_movimiento'
        )
        .in('status', ['APPROVED', 'ACTIVO'])

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'getDesgloseCategorias')

    let filtrados = data
      .filter((item) => movimientoContableEfectivo(item.status ?? '', item.categoria))
      .filter((item) => !TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS.has(String(item.tipo_movimiento ?? '')))

    if (cuentaIdsAdmin) {
      filtrados = filtrarMovimientosFirewallAdmin(filtrados, cuentaIdsAdmin)
    }

    const agrupar = (grupo: GrupoCategoria, filas: MovimientoLedgerDashboard[]): CategoriaDesglose[] => {
      const total = filas.reduce((sum, item) => sum + item.monto, 0)
      const porCategoria = new Map<string, number>()

      filas.forEach((item) => {
        const categoria = item.categoria || 'Sin Categoría'
        porCategoria.set(categoria, (porCategoria.get(categoria) || 0) + item.monto)
      })

      const etiqueta = grupo === 'INGRESO' ? 'Ingreso' : 'Egreso'
      return Array.from(porCategoria.entries())
        .map(([categoria, monto]) => ({
          categoria: `${etiqueta} · ${categoria}`,
          monto,
          porcentaje: total > 0 ? Math.round((monto / total) * 100) : 0,
          grupo
        }))
        .sort((a, b) => b.monto - a.monto)
    }

    const esIngreso = (item: MovimientoLedgerDashboard) =>
      TIPOS_INGRESO_DESGLOSE.has(String(item.tipo_movimiento ?? ''))

    return [
      ...agrupar('INGRESO', filtrados.filter(esIngreso)),
      ...agrupar('EGRESO', filtrados.filter((item) => !esIngreso(item)))
    ]
  } catch (error) {
    console.error('Error in getDesgloseCategorias:', error)
    return []
  }
}

export async function getFeedGlobal(): Promise<EventoFeed[]> {
  try {
    const supabase = await getSupabaseServer()
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
