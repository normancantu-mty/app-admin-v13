/**
 * Paridad v2 — la ficha de un nodo (DST o LOC) para el modal `/v2/m/nodo/[id]` y
 * para el panel de un DST/LOC. Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Las funciones de lectura son COPIA LITERAL de
 * `app/dashboard/distribuidores/[id]/page.tsx` (lineas 18-753): mismas consultas,
 * mismo alcance consolidado, mismo Total Ganado, mismas mermas, mismo historial
 * unificado y la misma regla de quien puede anular. La v1 queda intacta; cuando
 * se borre /dashboard esto sigue funcionando solo.
 */

import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { cookies } from 'next/headers'
import type { CurrentUser } from '@/lib/auth-utils'
import { VENTANA_EDICION_ERROR, VENTANA_EDICION_MS } from '@/lib/constants'
import { calcularFechasPorRango, fetchTodasLasFilas, limitesRangoMX } from '@/lib/dashboard-utils'
import { leerSaldoEntidad, leerStockPorCubeta } from '@/lib/vistas'
import { fetchDesgloseTextoPorTicketId } from '@/lib/ticket-desglose'
import type { ActividadHistorialRow } from '@/components/v2/nodo/Historial'

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

/** Fila cruda del ticket antes de normalizar `condicion_pago` / `status`. */
type TransaccionTicketRow = Omit<TransaccionTicket, 'condicion_pago' | 'status'> & {
  condicion_pago: string | null
  status: string | null
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
  // Paridad v2 (decision del ejecutor): SOCIO ve la ficha en solo lectura (es de
  // mando y la cartera la enlaza) y un LOC ve SU ficha (Q16: aterriza en su vista).
  // En la v1 ambos recibian 404.
  if (sessionRole === 'SOCIO') return true
  if (sessionRole === 'LOC') return targetEntity.id === currentUserEntityId

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
    // Paginado y sin `.limit(1000)`: de estos tickets sale el saldo del perfil.
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const rows = await fetchTodasLasFilas<TransaccionTicketRow>(() => {
      let query = serviceRoleClient
        .from('transacciones_tickets')
        .select('id, fecha_transaccion, monto_base_ingreso, total_cobrado_real, id_vendedor, id_comprador, condicion_pago, status, usuario_creador')
        .or(`id_comprador.in.(${entityIds.join(',')}),id_vendedor.in.(${entityIds.join(',')})`)
        .order('fecha_transaccion', { ascending: false })

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_transaccion', desde).lt('fecha_transaccion', hastaExclusivo)
      }

      return query
    }, 'perfil getTransaccionesTickets')

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
    // Paginado y sin `.limit(1000)`: de estas filas salen los saldos del perfil.
    const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

    const data = await fetchTodasLasFilas<FinanzaLedgerQueryRow>(() => {
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

      if (desde && hastaExclusivo) {
        query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return query
    }, 'perfil getFinanzasLedger')

    const finanzas = data.map((row) => ({
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

    const legacyData = await fetchTodasLasFilas<FinanzaLedgerQueryRow>(() => {
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

      if (desde && hastaExclusivo) {
        legacyQuery = legacyQuery.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
      }

      return legacyQuery
    }, 'perfil getFinanzasLedger legacy')

    const legacyFinanzas = legacyData.map((row) => ({
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

  // ERP-25: paginado. Es un `reduce` sobre filas de ledger, o sea exactamente
  // la forma que PostgREST trunca en silencio. Hoy las mermas son pocas; el
  // argumento "son pocas" es el que hace que nadie lo revise el dia que dejan
  // de serlo. Si una pagina falla, `fetchTodasLasFilas` lanza — y el `catch`
  // de abajo conserva el comportamiento anterior: el perfil no revienta, el
  // total sale 0 y el error queda en el log.
  try {
    const filas = await fetchTodasLasFilas<{ cantidad: number | null }>(
      () =>
        serviceRoleClient
          .from('inventario_ledger')
          .select('cantidad, id_entidad_origen, id_entidad_destino')
          .in('status', ['ACTIVO', 'APPROVED'])
          .eq('tipo_movimiento', 'MERMA')
          .or(`id_entidad_origen.eq.${idEntidad},id_entidad_destino.eq.${idEntidad}`),
      'getTotalMermasEntidad'
    )

    return filas.reduce((acc, mov) => acc + Math.abs(Number(mov.cantidad) || 0), 0)
  } catch (error) {
    console.error('Error fetching total mermas por entidad:', error)
    return 0
  }
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

      // Espejo exacto de la ventana del servidor (`VENTANA_EDICION_MS`): si aqui
      // dijera otro numero, el boton se veria habilitado y la accion fallaria.
      const tsMs = row.policyTimestamp ? Date.parse(row.policyTimestamp) : NaN
      if (!Number.isFinite(tsMs) || Date.now() - tsMs > VENTANA_EDICION_MS) {
        return {
          ...row,
          annulDisabled: true,
          annulDisabledReason: VENTANA_EDICION_ERROR
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

/**
 * "Total Ganado" del periodo — **lo unico de esta pantalla que ninguna vista
 * puede dar hoy.**
 *
 * `v_saldo_entidad` trae la comision HISTORICA (`total_ganado_comisiones`), sin
 * recorte de fechas, porque una vista sin filtro sirve a todos los periodos. La
 * tarjeta de arriba, en cambio, muestra lo ganado en el rango que el usuario
 * eligio, y ese recorte se sigue haciendo aqui. Queda anotado como el hueco de
 * la sesion: si algun dia hace falta, seria una vista con `fecha_movimiento`
 * expuesta, no mas aritmetica en TypeScript.
 *
 * El saldo pendiente y el saldo por pagar que esta funcion calculaba **ya no
 * salen de aqui**: vienen de `v_saldo_entidad`.
 */
function calcularTotalGanadoPeriodo(
  finanzas: FinanzaLedger[],
  entidad: Pick<Entidad, 'id' | 'nombre' | 'rol'>,
  consolidationScope: Pick<ConsolidationScope, 'entityIds' | 'accountIds'>,
  options?: {
    fechaInicio?: string
    fechaFin?: string
  }
): number {
  const finanzasContables = finanzas.filter((f) => (f.status ?? 'ACTIVO') !== 'ANULADO')
  const consolidatedEntityIds = new Set(consolidationScope.entityIds)
  const consolidatedAccountIds = new Set(consolidationScope.accountIds)
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
  // El historico que esta funcion tambien devolvia no lo pintaba nadie, y hoy
  // ademas vive en `v_saldo_entidad.total_ganado_comisiones`.
  return movimientosRelevantes
    .filter((f) => {
      if (!comisionCuentaEstadoOperativo(f)) return false
      if (!f.tipo_movimiento) return false
      if (!['INGRESO_COMISION', 'COMISION_PASIVA'].includes(f.tipo_movimiento)) return false
      if (f.id_entidad_relacionada !== entidad.id) return false
      return estaEnPeriodo(f.fecha_movimiento)
    })
    .reduce((sum, f) => sum + f.monto, 0)
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


export interface FichaNodo {
  entidad: Entidad
  totalGanado: number
  mostrarTotalGanado: boolean
  saldoPendiente: number
  saldoPorPagar: number
  totalMermas: number
  inventarioConsignado: { idProducto: string; producto: string; stockEsperado: number }[]
  inventarioPagado: { idProducto: string; producto: string; stockEsperado: number }[]
  productosReportables: { id: string; idProducto: string; nombre: string }[]
  actividades: ActividadHistorialRow[]
  puedeOperar: boolean
  localDeMiRed: boolean
}

/**
 * Lo mismo que calcula `EstadoCuentaPage` de la v1, sin pintar. `null` = no existe
 * o la sesion no puede verlo (el modal responde notFound()).
 */
export async function leerFichaNodo(id: string, usuario: CurrentUser): Promise<FichaNodo | null> {
  const supabaseClient = await getServerSupabaseClient()
  const serviceRoleClient = getServiceRoleSupabaseClient()
  const sessionRole = usuario.rol as SessionRole
  const currentUserEntityId = usuario.id
  const entidad = await getEntidad(supabaseClient, id)
  if (!entidad) return null
  if (!canReadTargetEntity(sessionRole, currentUserEntityId, entidad)) return null

  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)
  const [adminLegacyAccountId, consolidationScope] = await Promise.all([
    getAdminLegacyAccountId(serviceRoleClient),
    getConsolidationScope(serviceRoleClient, entidad)
  ])

  const [ticketsHistoricosSaldo, finanzasHistoricasSaldo, totalMermas, saldoDelNodo, filasStock, dstAnnulScopeOk] = await Promise.all([
    getTransaccionesTickets(serviceRoleClient, consolidationScope.entityIds),
    getFinanzasLedger(serviceRoleClient, consolidationScope.entityIds, consolidationScope.accountIds, entidad.id, adminLegacyAccountId),
    getTotalMermasEntidad(serviceRoleClient, sessionRole, currentUserEntityId, entidad, id),
    leerSaldoEntidad(supabaseClient, entidad.id),
    leerStockPorCubeta(supabaseClient, id).catch(() => []),
    sessionRole === 'DST' ? dstPuedeOperarPerfilDetallePage(supabaseClient, currentUserEntityId, id) : Promise.resolve(false)
  ])

  const ticketIds = Array.from(new Set(ticketsHistoricosSaldo.map((t) => t.id)))
  const desglosePorTicketId = await fetchDesgloseTextoPorTicketId(serviceRoleClient, ticketIds)
  const totalGanado = calcularTotalGanadoPeriodo(finanzasHistoricasSaldo, entidad, consolidationScope, { fechaInicio, fechaFin })
  const actividades = enrichActividadesAnulacionUi(
    unificarActividades(ticketsHistoricosSaldo, finanzasHistoricasSaldo, id, entidad.rol, desglosePorTicketId),
    sessionRole,
    dstAnnulScopeOk,
    currentUserEntityId
  )
  const aFila = (cubeta: 'PAGADO' | 'CONSIGNADO') =>
    filasStock
      .filter((f) => f.cubeta === cubeta)
      .map((f) => ({ idProducto: f.id_producto, producto: f.producto, stockEsperado: Number(f.stock) }))
  const inventarioPagado = aFila('PAGADO')
  const inventarioConsignado = aFila('CONSIGNADO')
  const prod = new Map<string, { id: string; idProducto: string; nombre: string }>()
  for (const r of [...inventarioPagado, ...inventarioConsignado]) prod.set(r.idProducto, { id: r.idProducto, idProducto: r.idProducto, nombre: r.producto })

  return {
    entidad,
    totalGanado,
    mostrarTotalGanado: entidad.rol !== 'LOC',
    saldoPendiente: Number(saldoDelNodo?.saldo_pendiente_consignacion ?? 0),
    saldoPorPagar: Number(saldoDelNodo?.saldo_por_pagar_efectivo ?? 0),
    totalMermas: Number(totalMermas),
    inventarioConsignado,
    inventarioPagado,
    productosReportables: [...prod.values()],
    actividades: actividades as unknown as ActividadHistorialRow[],
    puedeOperar: sessionRole === 'ADMIN' || (sessionRole === 'DST' && (dstAnnulScopeOk || entidad.id === currentUserEntityId)),
    localDeMiRed: sessionRole === 'DST' && entidad.rol === 'LOC' && (entidad.id_nodo_padre ?? entidad.id_padre) === currentUserEntityId
  }
}

/** Comprobacion ligera para los modales anidados (abono, cobranza, devolucion, conteo). */
export async function leerNodoVisible(id: string, usuario: CurrentUser): Promise<Entidad | null> {
  const client = await getServerSupabaseClient()
  const e = await getEntidad(client, id)
  if (!e) return null
  return canReadTargetEntity(usuario.rol as SessionRole, usuario.id, e) ? e : null
}

/** A donde vuelve un modal anidado: al panel si es la ficha propia, si no a la ficha. */
export function padreDeNodo(id: string, usuario: CurrentUser): string {
  return id === usuario.id ? '/v2' : `/v2/m/nodo/${id}`
}
