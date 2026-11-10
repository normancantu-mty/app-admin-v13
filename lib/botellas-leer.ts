/**
 * Lectura de "botellas por cliente". Escrito el 2026-11-08 por un ejecutor del
 * Socio. **La UNICA puerta**: la tarjeta del panel y el comando `/botellas` del
 * bot llaman a esta funcion; ninguno arma su propio query. Si un dia cambia que
 * cuenta como botella, cambia aqui y en `lib/botellas-cliente.ts`, y las dos
 * salidas se mueven juntas.
 *
 * SOLO LECTURA y FALLA CERRADA: un permiso negado se lanza, nunca se pinta como
 * cero (el incidente del 2026-09-02).
 *
 * Tres consultas en paralelo: los tickets desde el inicio de la ventana mas
 * vieja (con su detalle embebido), las entidades y el catalogo. El estado del
 * ticket se trae entero —anulados incluidos— para que la funcion pura los
 * cuente como excluidos en vez de que desaparezcan sin rastro.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  armarBotellasPorCliente,
  desdeDondeLeer,
  periodosDe,
  type BotellasPorCliente,
  type EntidadBotellas,
  type ProductoBotellas,
  type TicketBotellas
} from '@/lib/botellas-cliente'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteLibre = SupabaseClient<any>

export async function leerBotellasPorCliente(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any>,
  ahora: Date = new Date()
): Promise<BotellasPorCliente> {
  const db = client as ClienteLibre
  const periodos = periodosDe(ahora)
  const desde = desdeDondeLeer(periodos)

  const [tickets, entidades, productos] = await Promise.all([
    fetchTodasLasFilas<TicketBotellas>(
      () =>
        db
          .from('transacciones_tickets')
          .select('id, fecha_transaccion, status, condicion_pago, id_comprador, id_vendedor, ticket_detalles(id_producto, cantidad, subtotal_linea)')
          .gte('fecha_transaccion', desde)
          .order('id', { ascending: true }),
      'transacciones_tickets (botellas por cliente)'
    ),
    (async () => {
      const { data, error } = await db.from('entidades').select('id, nombre, rol')
      if (error) throw new Error(`entidades (botellas por cliente): ${error.message}`)
      return (data ?? []) as EntidadBotellas[]
    })(),
    (async () => {
      const { data, error } = await db.from('catalogo_productos').select('id, nombre').eq('tipo', 'TERMINADO')
      if (error) throw new Error(`catalogo_productos (botellas por cliente): ${error.message}`)
      return (data ?? []) as ProductoBotellas[]
    })()
  ])

  return armarBotellasPorCliente(tickets, entidades, productos, periodos)
}
