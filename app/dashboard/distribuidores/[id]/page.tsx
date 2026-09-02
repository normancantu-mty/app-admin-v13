export const dynamic = 'force-dynamic'

import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth-utils'
import { cookies } from 'next/headers'
import { calcularFechasPorRango } from '@/lib/dashboard-utils'
import { getStockPorCubetaPorEntidad } from '@/lib/inventario-auditoria'
import BotonReportarMerma from '@/app/dashboard/inventario/BotonReportarMerma'
import {
  calcularSaldoPendienteInventarioConsignacion,
  calcularSaldoPorPagarEfectivo
} from '@/lib/distribuidores-saldos'
import HistorialActividadTableClient from './HistorialActividadTableClient'
import { fetchDesgloseTextoPorTicketId } from '@/lib/ticket-desglose'

interface Entidad {
  id: string
  nombre: string
  rol: 'DST' | 'LOC' | 'SOCIO'
  id_cuenta: string | null
  zona: string
  telefono: string | null
  id_nodo_padre?: string | null
  id_padre?: string | null
}

interface TransaccionTicket {
  id: string
  fecha_transaccion: string | null
  monto_base_ingreso: number
  total_cobrado_real: number
  id_vendedor: string | null
  id_comprador: string | null
  condicion_pago: 'CONTADO' | 'CONCESION'
  status?: string | null
  usuario_creador?: string | null
}

interface FinanzaLedger {
  id: string
  id_entidad_relacionada: string | null
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  id_ticket: string | null
  fecha_movimiento: string | null
  status: string | null
  tipo_movimiento: string | null
  monto: number
  categoria_gasto: string | null
  categoria?: string | null
  usuario_creador?: string | null
  cuenta_origen: { nombre: string } | null
  cuenta_destino: { nombre: string } | null
}

interface ActividadUnificada {
  fecha: string
  tipo: string
  monto: number
  referencia: string
  cuentaContexto?: string
  condicionPago?: 'CONTADO' | 'CONCESION'
  esVentaComoVendedor?: boolean
  usuario_creador?: string | null
  /** Estado operativo del movimiento (p. ej. ANULADO). */
  movementStatus?: string | null
  /** ISO timestamp para política de anulación (fecha_movimiento o fecha_transaccion). */
  policyTimestamp: string | null
  annulTarget?: { kind: 'LEDGER'; id: string } | { kind: 'TICKET'; id: string }
  annulDisabled?: boolean
  annulDisabledReason?: string
}

interface FinanzaLedgerQueryRow extends Omit<FinanzaLedger, 'cuenta_origen' | 'cuenta_destino'> {
  cuenta_origen: { nombre: string } | { nombre: string }[] | null
  cuenta_destino: { nombre: string } | { nombre: string }[] | null
}

interface ConsolidationScope {
  entityIds: string[]
  accountIds: string[]
  ownAccountIds: string[]
  localIds: string[]
  localAccountIds: string[]
  localsCount: number
}

type SessionRole = 'ADMIN' | 'DST' | 'LOC' | 'SOCIO' | 'SUB-ADMIN' | 'TRABAJADOR'

function isValidDateString(value?: string): boolean {
  if (!value) return false
  return !Number.isNaN(Date.parse(value))
}

function shouldApplyDateFilter(fechaInicio?: string, fechaFin?: string): boolean {
  return isValidDateString(fechaInicio) && isValidDateString(fechaFin)
}

async function getServerSupabaseClient(): Promise<SupabaseClient<Database>> {
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

function getServiceRoleSupabaseClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

function canReadTargetEntity(
  sessionRole: SessionRole | null | undefined,
  currentUserEntityId: string | null | undefined,
  targetEntity: Pick<Entidad, 'id' | 'id_nodo_padre' | 'id_padre'>
): boolean {
  if (!sessionRole || !currentUserEntityId) return false
  if (sessionRole === 'ADMIN') return true

  if (sessionRole !== 'DST') return false

  const targetParentId = targetEntity.id_nodo_padre ?? targetEntity.id_padre
  return targetEntity.id === currentUserEntityId || targetParentId === currentUserEntityId
}

async function getEntidad(
  supabaseClient: SupabaseClient<Database>,
  id: string
): Promise<Entidad | null> {
  try {
    const { data, error } = await supabaseClient
      .from('entidades')
      .select('id, nombre, rol, zona, telefono, id_nodo_padre, id_padre')
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching entidad:', error)
      return null
    }

    const { data: cuentaData, error: cuentaError } = await supabaseClient
      .from('cuentas_financieras')
      .select('id')
      .eq('id_entidad', id)
      .limit(1)
      .maybeSingle()

    if (cuentaError) {
      console.error('Error fetching cuenta for entidad:', cuentaError)
    }

    return {
      ...data,
      id_cuenta: cuentaData?.id ?? null,
      rol: data.rol as Entidad['rol']
    }
  } catch (error) {
    console.error('Error in getEntidad:', error)
    return null
  }
}

async function getTransaccionesTickets(
  serviceRoleClient: SupabaseClient<Database>,
  entityIds: string[],
  fechaInicio?: string,
  fechaFin?: string
): Promise<TransaccionTicket[]> {
  if (entityIds.length === 0) {
    return []
  }

  try {
    // Service role: no pasa por RLS del cliente SSR; fallos aquí suelen ser columnas/select o env.
    let query = serviceRoleClient
      .from('transacciones_tickets')
      .select('id, fecha_transaccion, monto_base_ingreso, total_cobrado_real, id_vendedor, id_comprador, condicion_pago, status, usuario_creador')
      .or(`id_comprador.in.(${entityIds.join(',')}),id_vendedor.in.(${entityIds.join(',')})`)
      .order('fecha_transaccion', { ascending: false })
      .limit(1000)

    if (shouldApplyDateFilter(fechaInicio, fechaFin)) {
      query = query
        .gte('fecha_transaccion', fechaInicio!)
        .lte('fecha_transaccion', fechaFin!)
    }

    const { data, error } = await query

    if (error) {
      console.error(
        'Error fetching transacciones_tickets:',
        JSON.stringify(error, null, 2),
        JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2),
        error.message,
        error.details,
        error.hint
      )
      return []
    }

    const rows = data || []
    return rows.map((row) => ({
      ...row,
      status: row.status ?? 'ACTIVO',
      condicion_pago: row.condicion_pago === 'CONCESION' ? 'CONCESION' : 'CONTADO'
    })) as TransaccionTicket[]
  } catch (error) {
    console.error(
      'Error in getTransaccionesTickets:',
      error instanceof Error ? error.stack : JSON.stringify(error, Object.getOwnPropertyNames(Object(error)), 2),
      error instanceof Error ? error.message : undefined
    )
    return []
  }
}

async function getFinanzasLedger(
  serviceRoleClient: SupabaseClient<Database>,
  entityIds: string[],
  accountIds: string[],
  idEntidadRelacionada: string | undefined,
  adminLegacyAccountId: string | null,
  fechaInicio?: string,
  fechaFin?: string
): Promise<FinanzaLedger[]> {
  if (accountIds.length === 0 && !idEntidadRelacionada) {
    return []
  }

  try {
    let query = serviceRoleClient
      .from('finanzas_ledger')
      .select(`
        id,
        id_entidad_relacionada,
        id_cuenta_origen,
        id_cuenta_destino,
        id_ticket,
        fecha_movimiento,
        status,
        tipo_movimiento,
        monto,
        categoria_gasto,
        categoria,
        usuario_creador,
        cuenta_origen:cuentas_financieras!finanzas_ledger_id_cuenta_origen_fkey(nombre),
        cuenta_destino:cuentas_financieras!finanzas_ledger_id_cuenta_destino_fkey(nombre)
      `)
      .in('status', ['ACTIVO', 'APPROVED', 'ANULADO'])
      .order('fecha_movimiento', { ascending: false })
      .limit(1000)

    if (accountIds.length > 0 && idEntidadRelacionada) {
      const joinedAccountIds = accountIds.join(',')
      query = query.or(
        `id_cuenta_origen.in.(${joinedAccountIds}),id_cuenta_destino.in.(${joinedAccountIds}),id_entidad_relacionada.eq.${idEntidadRelacionada}`
      )
    } else if (accountIds.length > 0) {
      const joinedAccountIds = accountIds.join(',')
      query = query.or(
        `id_cuenta_origen.in.(${joinedAccountIds}),id_cuenta_destino.in.(${joinedAccountIds})`
      )
    } else if (idEntidadRelacionada) {
      query = query.eq('id_entidad_relacionada', idEntidadRelacionada)
    }

    if (shouldApplyDateFilter(fechaInicio, fechaFin)) {
      query = query
        .gte('fecha_movimiento', fechaInicio!)
        .lte('fecha_movimiento', fechaFin!)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching finanzas_ledger:', error)
      return []
    }

    const finanzas = ((data as FinanzaLedgerQueryRow[] | null) || []).map((row) => ({
      ...row,
      cuenta_origen: Array.isArray(row.cuenta_origen)
        ? (row.cuenta_origen[0] ?? null)
        : (row.cuenta_origen ?? null),
      cuenta_destino: Array.isArray(row.cuenta_destino)
        ? (row.cuenta_destino[0] ?? null)
        : (row.cuenta_destino ?? null)
    }))
    const cuentaPropiaMovimientos = finanzas.filter((movimiento) => {
      if (!movimiento.id_cuenta_destino) return false
      return accountIds.includes(movimiento.id_cuenta_destino)
    })
    if (accountIds.length === 0 || cuentaPropiaMovimientos.length > 0 || !adminLegacyAccountId) {
      return finanzas
    }

    let legacyQuery = serviceRoleClient
      .from('finanzas_ledger')
      .select(`
        id,
        id_entidad_relacionada,
        id_cuenta_origen,
        id_cuenta_destino,
        id_ticket,
        fecha_movimiento,
        status,
        tipo_movimiento,
        monto,
        categoria_gasto,
        categoria,
        usuario_creador,
        cuenta_origen:cuentas_financieras!finanzas_ledger_id_cuenta_origen_fkey(nombre),
        cuenta_destino:cuentas_financieras!finanzas_ledger_id_cuenta_destino_fkey(nombre)
      `)
      .in('status', ['ACTIVO', 'APPROVED', 'ANULADO'])
      .in('id_entidad_relacionada', entityIds)
      .eq('id_cuenta_destino', adminLegacyAccountId)
      .order('fecha_movimiento', { ascending: false })
      .limit(1000)

    if (shouldApplyDateFilter(fechaInicio, fechaFin)) {
      legacyQuery = legacyQuery
        .gte('fecha_movimiento', fechaInicio!)
        .lte('fecha_movimiento', fechaFin!)
    }

    const { data: legacyData, error: legacyError } = await legacyQuery

    if (legacyError) {
      console.error('Error fetching legacy admin bridge rows:', legacyError)
      return finanzas
    }

    const legacyFinanzas = ((legacyData as FinanzaLedgerQueryRow[] | null) || []).map((row) => ({
      ...row,
      cuenta_origen: Array.isArray(row.cuenta_origen)
        ? (row.cuenta_origen[0] ?? null)
        : (row.cuenta_origen ?? null),
      cuenta_destino: Array.isArray(row.cuenta_destino)
        ? (row.cuenta_destino[0] ?? null)
        : (row.cuenta_destino ?? null)
    }))

    const merged = [...finanzas, ...legacyFinanzas].filter(
      (row, index, allRows) => allRows.findIndex((candidate) => candidate.id === row.id) === index
    )

    return merged
  } catch (error) {
    console.error('Error in getFinanzasLedger:', error)
    return []
  }
}

async function getAdminLegacyAccountId(
  serviceRoleClient: SupabaseClient<Database>
): Promise<string | null> {
  const { data: adminEntity, error: adminError } = await serviceRoleClient
    .from('entidades')
    .select('id')
    .eq('rol', 'ADMIN')
    .limit(1)
    .maybeSingle()

  if (adminError || !adminEntity?.id) {
    if (adminError) {
      console.error('Error fetching ADMIN entity for legacy bridge:', adminError)
    }
    return null
  }

  const { data: adminAccount, error: accountError } = await serviceRoleClient
    .from('cuentas_financieras')
    .select('id')
    .eq('id_entidad', adminEntity.id)
    .limit(1)
    .maybeSingle()

  if (accountError) {
    console.error('Error fetching ADMIN account for legacy bridge:', accountError)
    return null
  }

  return adminAccount?.id ?? null
}

async function getConsolidationScope(
  serviceRoleClient: SupabaseClient<Database>,
  entidad: Pick<Entidad, 'id' | 'rol'>
): Promise<ConsolidationScope> {
  const localIds: string[] = []

  if (entidad.rol === 'DST') {
    const { data: localRows, error: localsError } = await serviceRoleClient
      .from('entidades')
      .select('id')
      .eq('rol', 'LOC')
      .or(`id_nodo_padre.eq.${entidad.id},id_padre.eq.${entidad.id}`)

    if (localsError) {
      console.error('Error fetching locals for DST consolidation:', localsError)
    } else {
      localIds.push(...(localRows || []).map((local) => local.id))
    }
  }

  const entityIds = Array.from(new Set([entidad.id, ...localIds]))
  let accountIds: string[] = []
  let ownAccountIds: string[] = []
  let localAccountIds: string[] = []

  if (entityIds.length > 0) {
    const { data: accountRows, error: accountsError } = await serviceRoleClient
      .from('cuentas_financieras')
      .select('id, id_entidad')
      .in('id_entidad', entityIds)

    if (accountsError) {
      console.error('Error fetching accounts for consolidated scope:', accountsError)
    } else {
      accountIds = (accountRows || []).map((account) => account.id)
      ownAccountIds = (accountRows || [])
        .filter((account) => account.id_entidad === entidad.id)
        .map((account) => account.id)
      localAccountIds = (accountRows || [])
        .filter((account) => Boolean(account.id_entidad) && localIds.includes(account.id_entidad as string))
        .map((account) => account.id)
    }
  }

  return {
    entityIds,
    accountIds,
    ownAccountIds,
    localIds,
    localAccountIds,
    localsCount: localIds.length
  }
}

async function getTotalMermasEntidad(
  serviceRoleClient: SupabaseClient<Database>,
  sessionRole: SessionRole | null | undefined,
  currentUserEntityId: string | null | undefined,
  targetEntity: Pick<Entidad, 'id' | 'id_nodo_padre' | 'id_padre'>,
  idEntidad: string
): Promise<number> {
  if (!canReadTargetEntity(sessionRole, currentUserEntityId, targetEntity)) {
    return 0
  }

  const { data, error } = await serviceRoleClient
    .from('inventario_ledger')
    .select('cantidad, id_entidad_origen, id_entidad_destino')
    .in('status', ['ACTIVO', 'APPROVED'])
    .eq('tipo_movimiento', 'MERMA')
    .or(`id_entidad_origen.eq.${idEntidad},id_entidad_destino.eq.${idEntidad}`)

  if (error) {
    console.error('Error fetching total mermas por entidad:', error)
    return 0
  }

  return (data || []).reduce((acc, mov) => acc + Math.abs(Number(mov.cantidad) || 0), 0)
}

async function dstPuedeOperarPerfilDetallePage(
  supabase: SupabaseClient<Database>,
  dstEntityId: string,
  perfilEntidadId: string
): Promise<boolean> {
  if (perfilEntidadId === dstEntityId) return true
  const { data } = await supabase
    .from('entidades')
    .select('id_nodo_padre, id_padre, rol')
    .eq('id', perfilEntidadId)
    .maybeSingle()
  if (!data || data.rol !== 'LOC') return false
  const padre = data.id_nodo_padre ?? data.id_padre
  return padre === dstEntityId
}

function enrichActividadesAnulacionUi(
  rows: ActividadUnificada[],
  sessionRole: SessionRole | null,
  dstAnnulScopeOk: boolean,
  actorEntityId: string | null
): ActividadUnificada[] {
  return rows.map((row) => {
    if ((row.movementStatus ?? 'ACTIVO') === 'ANULADO') {
      return {
        ...row,
        annulTarget: undefined,
        annulDisabled: true,
        annulDisabledReason: 'Movimiento anulado.'
      }
    }

    if (!row.annulTarget) return row

    if (sessionRole === 'ADMIN') {
      return { ...row, annulDisabled: false }
    }

    if (sessionRole === 'DST') {
      if (!actorEntityId || !dstAnnulScopeOk) {
        return {
          ...row,
          annulDisabled: true,
          annulDisabledReason:
            'No puedes anular movimientos fuera de tu cuenta o la de tus locales.'
        }
      }

      const tsMs = row.policyTimestamp ? Date.parse(row.policyTimestamp) : NaN
      if (!Number.isFinite(tsMs) || Date.now() - tsMs > 6 * 60 * 60 * 1000) {
        return {
          ...row,
          annulDisabled: true,
          annulDisabledReason: 'Ventana de anulación expirada (máximo 6 horas).'
        }
      }

      return { ...row, annulDisabled: false }
    }

    return {
      ...row,
      annulDisabled: true,
      annulDisabledReason: 'Solo el administrador o tu distribuidor pueden anular registros.'
    }
  })
}

function calcularSaldos(
  tickets: TransaccionTicket[],
  finanzas: FinanzaLedger[],
  entidad: Pick<Entidad, 'id' | 'nombre' | 'rol'>,
  consolidationScope: Pick<ConsolidationScope, 'entityIds' | 'accountIds' | 'localsCount'>,
  options?: {
    fechaInicio?: string
    fechaFin?: string
    debtBuyerEntityIds?: string[]
  }
) {
  const finanzasContables = finanzas.filter((f) => (f.status ?? 'ACTIVO') !== 'ANULADO')
  const consolidatedEntityIds = new Set(consolidationScope.entityIds)
  const consolidatedAccountIds = new Set(consolidationScope.accountIds)
  const debtBuyerEntityIdsList = options?.debtBuyerEntityIds ?? [entidad.id]
  const fechaInicio = options?.fechaInicio
  const fechaFin = options?.fechaFin
  const aplicarFiltroFecha = shouldApplyDateFilter(fechaInicio, fechaFin)

  const estaEnPeriodo = (fecha?: string | null): boolean => {
    if (!aplicarFiltroFecha || !fecha) return true
    const fechaMovimiento = new Date(fecha)
    const fechaInicioBase = new Date(fechaInicio!)
    const fechaFinBase = new Date(fechaFin!)
    if (
      Number.isNaN(fechaMovimiento.getTime()) ||
      Number.isNaN(fechaInicioBase.getTime()) ||
      Number.isNaN(fechaFinBase.getTime())
    ) {
      return false
    }

    const inicioLocal = new Date(
      fechaInicioBase.getFullYear(),
      fechaInicioBase.getMonth(),
      fechaInicioBase.getDate(),
      0,
      0,
      0,
      0
    )
    const finLocal = new Date(
      fechaFinBase.getFullYear(),
      fechaFinBase.getMonth(),
      fechaFinBase.getDate(),
      23,
      59,
      59,
      999
    )

    return fechaMovimiento.getTime() >= inicioLocal.getTime() && fechaMovimiento.getTime() <= finLocal.getTime()
  }

  const saldoPendiente = calcularSaldoPendienteInventarioConsignacion(
    entidad,
    tickets,
    debtBuyerEntityIdsList,
    finanzasContables.map((f) => ({
      tipo_movimiento: f.tipo_movimiento,
      monto: f.monto,
      id_entidad_relacionada: f.id_entidad_relacionada
    }))
  )

  const movimientosEntidad = finanzasContables.filter((f) => f.id_entidad_relacionada && consolidatedEntityIds.has(f.id_entidad_relacionada))
  const movimientosCuenta = finanzasContables.filter((f) => {
    if (!f.id_cuenta_destino) return false
    return consolidatedAccountIds.has(f.id_cuenta_destino)
  })
  const movimientosRelevantes = [...movimientosEntidad, ...movimientosCuenta].filter(
    (row, index, allRows) => allRows.findIndex((candidate) => candidate.id === row.id) === index
  )

  // ─── Earned commissions KPI (for "Total Ganado" display card) ────────────────
  const comisionCuentaEstadoOperativo = (f: FinanzaLedger) => {
    const st = f.status ?? 'ACTIVO'
    return st === 'APPROVED' || st === 'ACTIVO'
  }
  const totalGanadoHistorico = movimientosRelevantes
    .filter((f) => {
      if (!comisionCuentaEstadoOperativo(f)) return false
      if (!f.tipo_movimiento) return false
      if (!['INGRESO_COMISION', 'COMISION_PASIVA'].includes(f.tipo_movimiento)) return false
      if (f.id_entidad_relacionada !== entidad.id) return false
      return true
    })
    .reduce((sum, f) => sum + f.monto, 0)
  const totalGanadoPeriodoFiltrado = movimientosRelevantes
    .filter((f) => {
      if (!comisionCuentaEstadoOperativo(f)) return false
      if (!f.tipo_movimiento) return false
      if (!['INGRESO_COMISION', 'COMISION_PASIVA'].includes(f.tipo_movimiento)) return false
      if (f.id_entidad_relacionada !== entidad.id) return false
      return estaEnPeriodo(f.fecha_movimiento)
    })
    .reduce((sum, f) => sum + f.monto, 0)

  return {
    totalGenerado: saldoPendiente,
    totalGanadoHistorico,
    totalGanadoPeriodo: totalGanadoPeriodoFiltrado,
    saldoPendiente
  }
}

function unificarActividades(
  tickets: TransaccionTicket[],
  finanzas: FinanzaLedger[],
  idEntidad: string,
  rolEntidad: Entidad['rol'],
  desglosePorTicketId: Map<string, string>
): ActividadUnificada[] {
  const actividades: ActividadUnificada[] = []
  const getCuentaLabel = (
    cuenta: { nombre: string } | null,
    cuentaId: string | null | undefined
  ): string => {
    if (cuenta?.nombre) return cuenta.nombre
    return cuentaId ? 'N/A' : 'Cuenta Matriz'
  }
  const getReferenciaFinanza = (finanza: FinanzaLedger): string => {
    const ticketRef = finanza.id_ticket ? ` - Ticket #${finanza.id_ticket.slice(0, 8).toUpperCase()}` : ''
    const desgloseExtra = finanza.id_ticket ? desglosePorTicketId.get(finanza.id_ticket) : undefined
    const sufijoDesglose = desgloseExtra ? `\n${desgloseExtra}` : ''
    switch (finanza.tipo_movimiento) {
      case 'INGRESO_COMISION':
        return `Comisión ganada${ticketRef}${sufijoDesglose}`
      case 'COMISION_PASIVA':
        return `Comisión ganada${ticketRef}${sufijoDesglose}`
      case 'ABONO_DEUDA':
        return finanza.id_ticket && desgloseExtra
          ? `Abono aplicado a deuda${ticketRef}${sufijoDesglose}`
          : 'Abono aplicado a deuda'
      case 'DEUDA_A_MATRIZ':
        return 'Cargo de deuda hacia matriz'
      default:
        return finanza.categoria_gasto || 'Movimiento financiero'
    }
  }

  const getTipoFinanza = (tipo?: string | null): string => {
    if (!tipo) return 'MOVIMIENTO FINANCIERO'
    return tipo.replaceAll('_', ' ')
  }

  const ticketIdsReciboCobro = new Set(
    finanzas
      .filter((finanza) =>
        (finanza.status ?? 'ACTIVO') !== 'ANULADO' &&
        Boolean(finanza.id_ticket) &&
        (finanza.tipo_movimiento === 'INGRESO_COMISION' || finanza.tipo_movimiento === 'ABONO_DEUDA')
      )
      .map((finanza) => finanza.id_ticket as string)
  )
  const ticketsEntidad = tickets.filter(
    (ticket) =>
      (ticket.id_comprador === idEntidad || ticket.id_vendedor === idEntidad) &&
      !ticketIdsReciboCobro.has(ticket.id)
  )
  const finanzasEntidad = finanzas.filter((finanza) => finanza.id_entidad_relacionada === idEntidad)

  ticketsEntidad.forEach(ticket => {
    if (!ticket.fecha_transaccion) return
    const esConcesion = ticket.condicion_pago === 'CONCESION'
    const esCompra = ticket.id_comprador === idEntidad
    const esVentaComoVendedor = ticket.id_vendedor === idEntidad
    const statusTicket = ticket.status ?? 'ACTIVO'
    const esAnulado = statusTicket === 'ANULADO'
    const baseReferencia = esCompra
      ? (esConcesion ? 'Carga de stock (Compra a Concesión)' : 'Compra liquidada al contado')
      : (esConcesion ? 'Venta realizada a concesión' : 'Venta liquidada al contado')
    const desgloseTicket = desglosePorTicketId.get(ticket.id)
    const referencia = desgloseTicket ? `${baseReferencia}\n${desgloseTicket}` : baseReferencia
    actividades.push({
      fecha: ticket.fecha_transaccion,
      tipo: 'VENTA',
      monto: esCompra
        ? (rolEntidad === 'DST' ? ticket.monto_base_ingreso : ticket.total_cobrado_real)
        : ticket.monto_base_ingreso,
      referencia,
      condicionPago: ticket.condicion_pago,
      esVentaComoVendedor,
      usuario_creador: ticket.usuario_creador ?? null,
      movementStatus: statusTicket,
      policyTimestamp: ticket.fecha_transaccion,
      ...(esAnulado ? {} : { annulTarget: { kind: 'TICKET' as const, id: ticket.id } })
    })
  })

  finanzasEntidad
    .filter(f => !!f.fecha_movimiento)
    .forEach(finanza => {
      const cuentaOrigenLabel = getCuentaLabel(finanza.cuenta_origen, finanza.id_cuenta_origen)
      const cuentaDestinoLabel = getCuentaLabel(finanza.cuenta_destino, finanza.id_cuenta_destino)
      const st = finanza.status ?? 'ACTIVO'
      const esAnulado = st === 'ANULADO'
      actividades.push({
        fecha: finanza.fecha_movimiento!,
        tipo: getTipoFinanza(finanza.tipo_movimiento),
        monto: finanza.monto,
        referencia: getReferenciaFinanza(finanza),
        cuentaContexto: `${cuentaOrigenLabel} -> ${cuentaDestinoLabel}`,
        usuario_creador: finanza.usuario_creador ?? null,
        movementStatus: st,
        policyTimestamp: finanza.fecha_movimiento ?? null,
        ...(esAnulado ? {} : { annulTarget: { kind: 'LEDGER' as const, id: finanza.id } })
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

export default async function EstadoCuentaPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    fechaInicio?: string | string[]
    fechaFin?: string | string[]
  }>
}) {
  const resolvedParams = await params
  const resolvedSearchParams = await searchParams
  const supabaseClient = await getServerSupabaseClient()
  const serviceRoleClient = getServiceRoleSupabaseClient()
  const currentUser = await getCurrentUser()
  const sessionRole = (currentUser?.rol ?? null) as SessionRole | null
  const currentUserEntityId = currentUser?.id ?? null
  const entidad = await getEntidad(supabaseClient, resolvedParams.id)

  if (!entidad) {
    notFound()
  }

  const canReadProfile = canReadTargetEntity(sessionRole, currentUserEntityId, entidad)
  if (!canReadProfile) {
    notFound()
  }

  const fechaInicioFromUrl = Array.isArray(resolvedSearchParams.fechaInicio)
    ? resolvedSearchParams.fechaInicio[0]
    : resolvedSearchParams.fechaInicio
  const fechaFinFromUrl = Array.isArray(resolvedSearchParams.fechaFin)
    ? resolvedSearchParams.fechaFin[0]
    : resolvedSearchParams.fechaFin
  const usaRangoUrl = shouldApplyDateFilter(fechaInicioFromUrl, fechaFinFromUrl)
  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio: fechaInicioCookie, fechaFin: fechaFinCookie } = calcularFechasPorRango(rango)
  const fechaInicio = usaRangoUrl ? fechaInicioFromUrl : fechaInicioCookie
  const fechaFin = usaRangoUrl ? fechaFinFromUrl : fechaFinCookie
  const adminLegacyAccountId = await getAdminLegacyAccountId(serviceRoleClient)
  const consolidationScope = await getConsolidationScope(serviceRoleClient, entidad)

  const [ticketsHistoricosSaldo, finanzasHistoricasSaldo, totalMermas] = await Promise.all([
    getTransaccionesTickets(serviceRoleClient, consolidationScope.entityIds),
    getFinanzasLedger(
      serviceRoleClient,
      consolidationScope.entityIds,
      consolidationScope.accountIds,
      entidad.id,
      adminLegacyAccountId
    ),
    getTotalMermasEntidad(serviceRoleClient, sessionRole, currentUserEntityId, entidad, resolvedParams.id)
  ])

  const ticketIdsHistorial = Array.from(new Set(ticketsHistoricosSaldo.map((t) => t.id)))
  const desglosePorTicketId = await fetchDesgloseTextoPorTicketId(serviceRoleClient, ticketIdsHistorial)

  const saldos = calcularSaldos(
    ticketsHistoricosSaldo,
    finanzasHistoricasSaldo,
    entidad,
    consolidationScope,
    { fechaInicio, fechaFin, debtBuyerEntityIds: [entidad.id] }
  )
  const comisionesTotales = saldos?.totalGanadoPeriodo || 0

  // ─── Saldo por Pagar = efectivo pendiente de remisión (sin doble ajuste por comisión) ───
  // DEUDA_A_MATRIZ (+) y CARGO_DEUDA (+) ya reflejan netos de caja respecto a Admin; no restar INGRESO_COMISION / COMISION_PASIVA.
  // ABONO_DEUDA (-) pagos efectivos a Admin.
  // Positivo → nodo debe efectivo a Admin. Negativo → saldo a favor (Admin debe al nodo).
  const saldoPorPagar = calcularSaldoPorPagarEfectivo(
    entidad.id,
    finanzasHistoricasSaldo
      .filter((f) => (f.status ?? 'ACTIVO') !== 'ANULADO')
      .map((f) => ({
        tipo_movimiento: f.tipo_movimiento || null,
        monto: f.monto,
        id_entidad_relacionada: f.id_entidad_relacionada || null,
        categoria: f.categoria || null
      }))
  )

  // Historial de actividad sin recorte temporal para evitar vacíos por desajuste de zona horaria/rango.
  const actividades = unificarActividades(
    ticketsHistoricosSaldo,
    finanzasHistoricasSaldo,
    resolvedParams.id,
    entidad.rol,
    desglosePorTicketId
  )
  const dstAnnulScopeOk =
    sessionRole === 'DST' && currentUserEntityId
      ? await dstPuedeOperarPerfilDetallePage(supabaseClient, currentUserEntityId, resolvedParams.id)
      : false
  const actividadesHistorial = enrichActividadesAnulacionUi(
    actividades,
    sessionRole,
    dstAnnulScopeOk,
    currentUserEntityId
  )
  const inventarioBuckets = await getStockPorCubetaPorEntidad(resolvedParams.id)
    .catch((error) => {
      console.error('Error fetching stock por cubeta en perfil de entidad:', error)
      return { stockPagado: [], stockConsignado: [] }
    })
  const inventarioPagado = inventarioBuckets.stockPagado
  const inventarioConsignado = inventarioBuckets.stockConsignado
  const productosReportablesMap = new Map<string, { id: string; idProducto: string; nombre: string }>()
  for (const row of [...inventarioPagado, ...inventarioConsignado]) {
    productosReportablesMap.set(row.idProducto, { id: row.idProducto, idProducto: row.idProducto, nombre: row.producto })
  }
  const productosReportables = Array.from(productosReportablesMap.values())
  const canMutate = currentUser?.rol !== 'SOCIO'
  const showComisionYsaldoEfectivo = entidad.rol !== 'LOC'
  const viewingLocalFromMyNetwork = sessionRole === 'DST' &&
    entidad.rol === 'LOC' &&
    (entidad.id_nodo_padre ?? entidad.id_padre) === currentUserEntityId

  return (
    <div className="p-8 space-y-6">
      {/* HEADER CON PANEL DE MANDO - Jerarquía de Acción Implementada */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <Link 
            href="/dashboard/distribuidores"
            className="text-blue-600 hover:text-blue-800 mb-2 inline-block"
          >
            {viewingLocalFromMyNetwork ? '← Volver a mi Red' : '← Volver a Distribuidores'}
          </Link>
          <div className="flex flex-wrap items-center gap-2 gap-y-1">
            <h1 className="text-2xl font-bold text-gray-800 sm:text-3xl">{entidad.nombre}</h1>
            <span className={`inline-flex px-3 py-1 text-sm font-semibold rounded-full ${
              entidad.rol === 'DST' 
                ? 'bg-blue-100 text-blue-800' 
                : 'bg-purple-100 text-purple-800'
            }`}>
              {entidad.rol}
            </span>
          </div>
          {viewingLocalFromMyNetwork && (
            <p className="text-sm text-blue-700 mt-1 font-medium">Local de mi Red</p>
          )}
          <p className="text-gray-600 mt-1">{entidad.zona} • {entidad.telefono || 'Sin teléfono'}</p>
        </div>
        
        {/* PANEL DE MANDO - 3 Botones con Jerarquía de Acción */}
        {canMutate && (
          <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end md:gap-3">
            {/* Botón 1: Nueva Venta - Color secundario/neutro - Query params pre-configurados */}
            <Link
              href={`/pos?vendedor=${resolvedParams.id}`}
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center gap-2 rounded-lg bg-slate-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 sm:w-auto sm:flex-none md:px-5"
            >
              <span>📦</span>
              <span>Nueva Venta</span>
            </Link>

            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}/cobranza`}
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center gap-2 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-amber-700 sm:w-auto sm:flex-none md:px-5"
            >
              <span>📦</span>
              <span className="text-center">Cobrar, contar inventario</span>
            </Link>
            
            {/* Botón 2: Registrar Abono - Color verde/destacado - Acción primaria */}
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}/abono`}
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-green-700 sm:w-auto sm:flex-none md:px-5"
            >
              <span>💵</span>
              <span>Registrar Abono</span>
            </Link>
            
            {/* Botón 3: Devolución - Color outline/advertencia */}
            <Link
              href={`/dashboard/distribuidores/${resolvedParams.id}/devolucion`}
              className="inline-flex w-full min-w-[9rem] flex-1 items-center justify-center gap-2 rounded-lg border-2 border-orange-500 px-4 py-2.5 text-sm font-medium text-orange-600 transition-colors hover:bg-orange-50 sm:w-auto sm:flex-none md:px-5"
            >
              <span>🔄</span>
              <span>Devolución</span>
            </Link>
          </div>
        )}
      </div>

      <div
        className={`grid grid-cols-1 gap-6 ${
          showComisionYsaldoEfectivo ? 'md:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-2'
        }`}
      >
        {showComisionYsaldoEfectivo ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Total Ganado</p>
                <p className="text-3xl font-bold text-purple-600 mt-2">{formatCurrency(comisionesTotales)}</p>
              </div>
              <div className="bg-purple-100 p-3 rounded-full">
                <span className="text-2xl">💰</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">Comisiones del periodo</p>
          </div>
        ) : null}

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">
                {saldos.saldoPendiente < 0 ? 'Saldo a Favor' : 'Saldo Pendiente'}
              </p>
              <p className={`text-3xl font-bold mt-2 ${saldos.saldoPendiente < 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(Math.abs(saldos.saldoPendiente))}
              </p>
            </div>
            <div className={`p-3 rounded-full ${saldos.saldoPendiente < 0 ? 'bg-green-100' : 'bg-red-100'}`}>
              <span className="text-2xl">{saldos.saldoPendiente < 0 ? '✅' : '⏳'}</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {saldos.saldoPendiente < 0
              ? 'Admin le debe a este distribuidor'
              : 'Deuda neta del distribuidor hacia Admin'}
          </p>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-orange-200 p-6 dark:bg-gray-800 dark:border-orange-900 dark:text-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-600">Total Mermas</p>
              <p className="text-3xl font-bold text-orange-600 mt-2">{Number(totalMermas).toFixed(4)} Botellas</p>
            </div>
            <div className="bg-orange-100 p-3 rounded-full">
              <span className="text-2xl">⚠️</span>
            </div>
          </div>
          <p className="text-xs text-gray-500 mt-2">Botellas históricas reportadas como merma</p>
        </div>

        {showComisionYsaldoEfectivo ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Saldo por Pagar (Efectivo)</p>
                <p className={`text-3xl font-bold mt-2 ${saldoPorPagar < 0 ? 'text-green-600' : 'text-red-600'}`}>
                  {formatCurrency(saldoPorPagar)}
                </p>
              </div>
              <div className={`p-3 rounded-full ${saldoPorPagar < 0 ? 'bg-green-100' : 'bg-red-100'}`}>
                <span className="text-2xl">{saldoPorPagar < 0 ? '✅' : '💸'}</span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {saldoPorPagar < 0
                ? 'Saldo a favor: Admin le debe efectivo al distribuidor'
                : 'Efectivo cobrado pendiente de remitir a Admin'}
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-4">
        {canMutate && (
          <div className="flex flex-wrap justify-stretch gap-2 sm:justify-end">
            <BotonReportarMerma
              entidades={[]}
              entidadFijaId={entidad.id}
              entidadFijaNombre={entidad.nombre}
              productos={productosReportables}
            />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Inventario Propio (Pagado)</h2>
              <p className="text-sm text-gray-600 mt-1">Stock teórico pagado de producto terminado</p>
            </div>
            {inventarioPagado.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-sm text-gray-500">0 botellas en esta cubeta.</p>
              </div>
            ) : (
              <>
                <div className="hidden w-full overflow-x-auto md:block">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Producto
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Cantidad
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                      {inventarioPagado.map((row) => (
                        <tr key={`pagado-${row.idProducto}`} className="hover:bg-gray-50">
                          <td className="px-6 py-4 text-sm text-gray-900">{row.producto}</td>
                          <td className="px-6 py-4 text-sm font-semibold text-right text-gray-800">
                            {row.stockEsperado.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-1 gap-3 p-4 md:hidden">
                  {inventarioPagado.map((row) => (
                    <div key={`pagado-mobile-${row.idProducto}`} className="space-y-2 rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
                      <p>
                        <span className="text-sm font-medium text-gray-500">Producto: </span>
                        <span className="text-sm font-semibold text-gray-900">{row.producto}</span>
                      </p>
                      <p className="flex justify-between gap-2 text-sm">
                        <span className="font-medium text-gray-500">Cantidad:</span>
                        <span className="font-semibold text-gray-800">{row.stockEsperado.toFixed(4)}</span>
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-800">Inventario a Concesión (Deuda)</h2>
              <p className="text-sm text-gray-600 mt-1">Stock teórico consignado de producto terminado</p>
            </div>
            {inventarioConsignado.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="text-sm text-gray-500">0 botellas en esta cubeta.</p>
              </div>
            ) : (
              <>
                <div className="hidden w-full overflow-x-auto md:block">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Producto
                        </th>
                        <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                          Cantidad
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200 dark:bg-gray-800 dark:divide-gray-700">
                      {inventarioConsignado.map((row) => (
                        <tr key={`consignado-${row.idProducto}`} className="hover:bg-gray-50">
                          <td className="px-6 py-4 text-sm text-gray-900">{row.producto}</td>
                          <td className="px-6 py-4 text-sm font-semibold text-right text-gray-800">
                            {row.stockEsperado.toFixed(4)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="grid grid-cols-1 gap-3 p-4 md:hidden">
                  {inventarioConsignado.map((row) => (
                    <div key={`consignado-mobile-${row.idProducto}`} className="space-y-2 rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
                      <p>
                        <span className="text-sm font-medium text-gray-500">Producto: </span>
                        <span className="text-sm font-semibold text-gray-900">{row.producto}</span>
                      </p>
                      <p className="flex justify-between gap-2 text-sm">
                        <span className="font-medium text-gray-500">Cantidad:</span>
                        <span className="font-semibold text-gray-800">{row.stockEsperado.toFixed(4)}</span>
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-800">Historial de Actividad</h2>
          <p className="text-sm text-gray-600 mt-1">Registro cronológico de ventas y abonos</p>
        </div>
        <HistorialActividadTableClient
          actividades={actividadesHistorial}
          perfilEntidadId={resolvedParams.id}
          mostrarCreadoPor={entidad.rol === 'DST'}
        />
      </div>
    </div>
  )
}
