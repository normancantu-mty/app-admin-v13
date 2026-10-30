/**
 * Front v2 — lectura de la tarjeta "Vendido y cobrado por mes". Escrito el
 * 2026-10-30 por un ejecutor del Socio. SOLO LECTURA, y FALLA CERRADA: todo error
 * se lanza (nunca se pinta un cero por un permiso negado).
 *
 * Dos consultas, en paralelo entre si y con `leerTablero` (el panel las lanza en el
 * mismo `Promise.all`): ninguna espera a otra.
 *  1. `transacciones_tickets` ACTIVO con su detalle embebido (`ticket_detalles` y el
 *     nombre de `catalogo_productos`): un solo viaje para tickets + lineas.
 *  2. `finanzas_ledger` de tipo INGRESO_VENTA / ABONO_DEUDA (lo cobrado). El filtro a
 *     las cuentas de la matriz y el de ABONO_PENDIENTE van en `armarVentasCobros`,
 *     que recibe las cuentas que el panel ya leyo.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { STATUS_QUE_CUENTAN } from '@/lib/v2/dinero'
import type { CobroCrudo, TicketCrudo } from '@/lib/v2/ventas-cobros'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteLibre = SupabaseClient<any>

export interface VentasCobrosCrudo {
  tickets: TicketCrudo[]
  cobros: CobroCrudo[]
}

export async function leerVentasCobros(client: SupabaseClient<Database>): Promise<VentasCobrosCrudo> {
  const db = client as unknown as ClienteLibre
  const [tickets, cobros] = await Promise.all([
    fetchTodasLasFilas<TicketCrudo>(
      () =>
        db
          .from('transacciones_tickets')
          .select(
            'id, fecha_transaccion, condicion_pago, id_comprador, id_vendedor, total_cobrado_real, ticket_detalles(id_producto, cantidad, subtotal_linea, catalogo_productos(nombre))'
          )
          .eq('status', 'ACTIVO')
          .order('id', { ascending: true }),
      'transacciones_tickets (ventas por mes)'
    ),
    fetchTodasLasFilas<CobroCrudo>(
      () =>
        db
          .from('finanzas_ledger')
          .select('monto, fecha_movimiento, tipo_movimiento, status, categoria, id_ticket, id_entidad_relacionada, id_cuenta_destino')
          .in('tipo_movimiento', ['INGRESO_VENTA', 'ABONO_DEUDA'])
          .in('status', [...STATUS_QUE_CUENTAN])
          .order('id', { ascending: true }),
      'finanzas_ledger (cobrado por mes)'
    )
  ])
  return { tickets, cobros }
}
