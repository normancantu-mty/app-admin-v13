/**
 * Lectura del "Pulso" (cobertura de producto terminado + dias sin surtir).
 * Escrito el 2026-11-08 por un ejecutor del Socio. **La UNICA puerta**: la
 * tarjeta del panel y el comando `/pulso` del bot llaman a esta funcion; ninguno
 * arma su propio query.
 *
 * SOLO LECTURA y FALLA CERRADA: un permiso negado se lanza, nunca se pinta como
 * cero (el incidente del 2026-09-02).
 *
 * Seis consultas en paralelo. Los tickets se leen TODOS (no solo 4 semanas):
 * "dias sin surtir" necesita la ultima compra de cada cliente aunque sea vieja.
 * Hoy son 2 filas; si un dia pesa, se acota aqui y en ningun otro lado.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import type { EntidadBotellas, ProductoBotellas, TicketBotellas } from '@/lib/botellas-cliente'
import { armarPulso, type EntregaPulso, type Pulso, type StockPulso } from '@/lib/pulso'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteLibre = SupabaseClient<any>

export async function leerPulso(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: SupabaseClient<any>,
  ahora: Date = new Date()
): Promise<Pulso> {
  const db = client as ClienteLibre

  const [tickets, entidades, productos, stock, entregas, corte] = await Promise.all([
    fetchTodasLasFilas<TicketBotellas>(
      () =>
        db
          .from('transacciones_tickets')
          .select('id, fecha_transaccion, status, condicion_pago, id_comprador, id_vendedor, ticket_detalles(id_producto, cantidad, subtotal_linea)')
          .order('id', { ascending: true }),
      'transacciones_tickets (pulso)'
    ),
    (async () => {
      const { data, error } = await db.from('entidades').select('id, nombre, rol')
      if (error) throw new Error(`entidades (pulso): ${error.message}`)
      return (data ?? []) as EntidadBotellas[]
    })(),
    (async () => {
      const { data, error } = await db.from('catalogo_productos').select('id, nombre').eq('tipo', 'TERMINADO')
      if (error) throw new Error(`catalogo_productos (pulso): ${error.message}`)
      return (data ?? []) as ProductoBotellas[]
    })(),
    fetchTodasLasFilas<StockPulso>(
      () =>
        db
          .from('v_stock_por_cubeta')
          .select('id_entidad, id_producto, producto, cubeta, stock')
          .order('id_entidad')
          .order('id_producto')
          .order('cubeta'),
      'v_stock_por_cubeta (pulso)'
    ),
    fetchTodasLasFilas<EntregaPulso>(
      () =>
        db
          .from('inventario_ledger')
          .select('id_entidad_destino, id_producto, fecha_movimiento, status')
          .eq('tipo_movimiento', 'ENTRADA_CONCESION')
          .order('id', { ascending: true }),
      'inventario_ledger (pulso)'
    ),
    (async () => {
      // El arranque: el SALDO_INICIAL mas viejo, la misma regla que `corteDeArranque` del panel.
      const { data, error } = await db
        .from('finanzas_ledger')
        .select('fecha_movimiento')
        .eq('tipo_movimiento', 'SALDO_INICIAL')
        .order('fecha_movimiento', { ascending: true })
        .limit(1)
      if (error) throw new Error(`finanzas_ledger (pulso): ${error.message}`)
      return ((data ?? [])[0]?.fecha_movimiento as string | undefined) ?? null
    })()
  ])

  return armarPulso({ tickets, entidades, productos, stock, entregas, corte }, ahora)
}
