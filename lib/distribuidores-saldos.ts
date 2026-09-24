/**
 * Fuente única de verdad para saldos mostrados en tarjetas de cuenta y directorio.
 * Debe coincidir con la semántica de `calcularSaldos` / KPIs en la vista de detalle.
 */

import { esAbonoPendienteAprobacion, esEntregaDeEfectivo } from './finance-utils'

export type EntidadRolSaldo = 'DST' | 'LOC' | 'SOCIO'

export interface TicketSaldoInput {
  condicion_pago: string
  id_comprador: string | null
  monto_base_ingreso: number
  total_cobrado_real: number
}

export interface FinanzaSaldoInput {
  tipo_movimiento: string | null
  monto: number
  id_entidad_relacionada: string | null
  categoria?: string | null
  /** D112: la entrega de efectivo no paga concesion. */
  es_entrega_efectivo?: boolean | null
}

export function calcularSaldoPendienteInventarioConsignacion(
  entidad: Pick<{ id: string; rol: EntidadRolSaldo }, 'id' | 'rol'>,
  tickets: (TicketSaldoInput & { status?: string | null })[],
  debtBuyerEntityIds: readonly string[] | Set<string> = [entidad.id],
  ajustesFinanzas?: FinanzaSaldoInput[]
): number {
  const activos = tickets.filter((t) => (t.status ?? 'ACTIVO') !== 'ANULADO')

  const buyerSet = debtBuyerEntityIds instanceof Set ? debtBuyerEntityIds : new Set(debtBuyerEntityIds)

  const ticketsConcesion = activos.filter(
    (ticket) =>
      ticket.condicion_pago === 'CONCESION' &&
      Boolean(ticket.id_comprador && buyerSet.has(ticket.id_comprador))
  )

  const fromTickets = ticketsConcesion.reduce((sum, ticket) => {
    const buyerIsCurrentEntity = ticket.id_comprador === entidad.id
    const monto = buyerIsCurrentEntity
      ? entidad.rol === 'DST'
        ? ticket.monto_base_ingreso
        : ticket.total_cobrado_real
      : ticket.total_cobrado_real
    return sum + monto
  }, 0)

  if (!ajustesFinanzas?.length) {
    return fromTickets
  }

  const cargoDeuda = ajustesFinanzas
    .filter((m) => m.tipo_movimiento === 'CARGO_DEUDA' && m.id_entidad_relacionada === entidad.id)
    .reduce((sum, m) => sum + (m.monto || 0), 0)

  const abonos = ajustesFinanzas
    .filter(
      (m) =>
        m.tipo_movimiento === 'ABONO_DEUDA' &&
        m.id_entidad_relacionada === entidad.id &&
        !esAbonoPendienteAprobacion(m.categoria) &&
        // D112: la entrega de efectivo no paga concesion (si resta abajo, en efectivo).
        !esEntregaDeEfectivo(m)
    )
    .reduce((sum, m) => sum + (m.monto || 0), 0)

  return fromTickets + cargoDeuda - abonos
}

export function calcularSaldoPorPagarEfectivo(entidadId: string, finanzas: FinanzaSaldoInput[]): number {
  const byType = (tipo: string) =>
    finanzas
      .filter(
        (m) =>
          m.tipo_movimiento === tipo &&
          m.id_entidad_relacionada === entidadId &&
          !esAbonoPendienteAprobacion(m.categoria)
      )
      .reduce((sum, m) => sum + (m.monto || 0), 0)

  // DEUDA_A_MATRIZ ya incorpora el neto post-comisión en servidor; no doble-restado de comisiones.
  return byType('DEUDA_A_MATRIZ') + byType('CARGO_DEUDA') - byType('ABONO_DEUDA')
}
