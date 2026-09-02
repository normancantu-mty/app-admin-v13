/**
 * Piezas puras del registro de abonos: catalogo de metodos de pago y el reparto
 * FIFO de un abono contra los pedidos abiertos de una entidad.
 *
 * Vive fuera de `app/actions/abonos.ts` porque un archivo `'use server'` solo
 * puede exportar funciones async: las constantes y los tipos tienen que estar
 * aqui para que el formulario cliente tambien pueda importarlos.
 *
 * Todo el reparto trabaja en CENTAVOS enteros. Con floats, tres aplicaciones
 * parciales sobre un mismo abono dejan residuos de 0.01 que descuadran el
 * ledger contra el monto capturado.
 */

export const METODOS_PAGO = ['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'CHEQUE', 'OTRO'] as const

export type MetodoPago = (typeof METODOS_PAGO)[number]

export function esMetodoPagoValido(valor: unknown): valor is MetodoPago {
  return typeof valor === 'string' && (METODOS_PAGO as readonly string[]).includes(valor)
}

export function aCentavos(monto: number): number {
  return Math.round(monto * 100)
}

export function aPesos(centavos: number): number {
  return Number((centavos / 100).toFixed(2))
}

export interface TicketPendienteCentavos {
  id_ticket: string
  saldo_centavos: number
}

export interface AplicacionCentavos {
  id_ticket: string
  centavos: number
}

/**
 * Consume `montoCentavos` contra los tickets recibidos, en el orden en que
 * vienen (el llamador los ordena del mas antiguo al mas nuevo). Lo que sobra
 * despues de agotar todos los saldos queda como "a cuenta", sin ticket.
 */
export function repartirAbonoFifo(
  tickets: readonly TicketPendienteCentavos[],
  montoCentavos: number
): { aplicaciones: AplicacionCentavos[]; sobranteCentavos: number } {
  const aplicaciones: AplicacionCentavos[] = []
  let restante = Math.max(0, montoCentavos)

  for (const ticket of tickets) {
    if (restante <= 0) break
    if (ticket.saldo_centavos <= 0) continue
    const centavos = Math.min(restante, ticket.saldo_centavos)
    aplicaciones.push({ id_ticket: ticket.id_ticket, centavos })
    restante -= centavos
  }

  return { aplicaciones, sobranteCentavos: restante }
}
