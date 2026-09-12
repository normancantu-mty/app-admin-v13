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

/**
 * Aplica a los pedidos MAS VIEJOS el dinero que se cobro sin decir de que pedido
 * era (`id_ticket` NULL en `finanzas_ledger`).
 *
 * ─── POR QUE EXISTE ─────────────────────────────────────────────────────────
 * Hasta el 2026-09-12, un abono "a cuenta" bajaba el saldo de la cartera pero
 * **no bajaba el de ningun pedido**. Resultado medido ese dia: el reparto creia
 * que Delirio 85 tenia $68,708 de pedidos abiertos cuando la cartera decia
 * $7,992, y lo mismo en 7 de los 9 deudores. El total siempre cuadraba \u2014el
 * dinero nunca se perdio\u2014 pero **a QUE pedido se atribuia el pago no era de
 * fiar**, y el aviso de sobrante no saltaba nunca (E-246).
 *
 * ─── POR QUE A LOS MAS VIEJOS ───────────────────────────────────────────────
 * **Decision de Norman, 2026-09-12:** *"Lo ideal es que se vaya a los pedidos
 * mas viejos, porque esa es la realidad"*. Y un pago puede partirse entre dos
 * pedidos \u2014 *"muchas veces puede ser la mezcla de 2"\u2014, que es justo lo que
 * `repartirAbonoFifo` ya hacia.
 *
 * ─── LO QUE NO HACE, Y HAY QUE SABERLO ──────────────────────────────────────
 * **No mueve ni una botella de CONSIGNADO a PAGADO.** `v_stock_por_cubeta` lee
 * `inventario_ledger`, no `finanzas_ledger`, y no existe ningun tipo de
 * movimiento que reclasifique una botella por haberse pagado. Medido el
 * 2026-09-12. Pagar y vender son dos cosas distintas en este ERP.
 *
 * ─── NO ESCRIBE NADA ────────────────────────────────────────────────────────
 * Es una correccion **de lectura**: las filas historicas conservan su
 * `id_ticket` NULL. Por eso es idempotente y no necesita migracion \u2014 y por eso
 * se puede quitar revirtiendo un commit [DOC02 \u2014 YAGNI].
 */
export function netearAbonosSinPedido(
  tickets: readonly TicketPendienteCentavos[],
  aCuentaCentavos: number
): TicketPendienteCentavos[] {
  let restante = Math.max(0, Math.round(aCuentaCentavos))
  const salida: TicketPendienteCentavos[] = []

  for (const ticket of tickets) {
    if (restante <= 0) {
      salida.push(ticket)
      continue
    }
    const consumido = Math.min(restante, Math.max(0, ticket.saldo_centavos))
    restante -= consumido
    salida.push({ ...ticket, saldo_centavos: ticket.saldo_centavos - consumido })
  }

  return salida
}
