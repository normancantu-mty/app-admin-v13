/**
 * Formato único para desglose de líneas en historial y tickets térmicos.
 * Patrón: "3x Nombre ($350 c/u)"
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export function formatPrecioCobradoUnitario(precio: number): string {
  const n = Number(precio)
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 100) / 100
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

export function formatLineaProductoTicket(
  cantidad: number,
  nombreProducto: string,
  precioUnitario: number
): string {
  return `${cantidad}x ${nombreProducto} ($${formatPrecioCobradoUnitario(precioUnitario)} c/u)`
}

export function concatenarDesgloseLineas(lineas: string[], separador: '\n' | ', ' = '\n'): string {
  return lineas.filter(Boolean).join(separador)
}

type DetalleRow = {
  id_ticket: string | null
  cantidad: number
  precio_unitario: number
  producto: { nombre: string } | { nombre: string }[] | null
}

export async function fetchDesgloseTextoPorTicketId(
  client: SupabaseClient<Database>,
  ticketIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (ticketIds.length === 0) return map

  const { data, error } = await client
    .from('ticket_detalles')
    .select(
      `
      id_ticket,
      cantidad,
      precio_unitario,
      producto:catalogo_productos(nombre)
    `
    )
    .in('id_ticket', ticketIds)

  if (error) {
    console.error('Error fetching ticket_detalles for desglose:', error)
    return map
  }

  const byTicket = new Map<string, DetalleRow[]>()
  for (const row of (data || []) as DetalleRow[]) {
    const tid = row.id_ticket
    if (!tid) continue
    const list = byTicket.get(tid) ?? []
    list.push(row)
    byTicket.set(tid, list)
  }

  for (const [tid, rows] of byTicket) {
    const lineas = rows.map((r) => {
      const prod = r.producto
      const nombre =
        Array.isArray(prod) ? (prod[0]?.nombre ?? 'Producto') : (prod?.nombre ?? 'Producto')
      return formatLineaProductoTicket(r.cantidad, nombre, r.precio_unitario)
    })
    map.set(tid, concatenarDesgloseLineas(lineas, '\n'))
  }

  return map
}
