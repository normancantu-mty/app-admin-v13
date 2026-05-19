'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fetchDesgloseTextoPorTicketId } from '@/lib/ticket-desglose'

interface TicketMaster {
  id: string
  fecha_transaccion: string
  id_vendedor: string | null
  id_comprador: string | null
  subtotal_catalogo: number
  total_cobrado_real: number
  monto_base_ingreso: number
  impuesto_iva_calculado: number
  impuesto_ieps_calculado: number
  vendedor: {
    nombre: string
  } | null
  comprador: {
    nombre: string
    rol: string
    comision_base: number
    comision_base_local: number
  } | null
}

interface TicketDetalle {
  id: string
  cantidad: number
  precio_unitario: number
  subtotal_linea: number
  producto: {
    nombre: string
  }
}

interface MiniMovimiento {
  id: string
  fecha: string
  concepto: string
  monto: number
  sortTs: number
}

interface TicketMovimientoRow {
  id: string
  fecha_transaccion: string | null
  id_comprador: string | null
  id_vendedor: string | null
  monto_base_ingreso: number | null
  total_cobrado_real: number | null
  condicion_pago: 'CONTADO' | 'CONCESION' | null
}

interface AbonoMovimientoRow {
  id: string
  fecha_movimiento: string | null
  monto: number
}

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const [ticket, setTicket] = useState<TicketMaster | null>(null)
  const [detalles, setDetalles] = useState<TicketDetalle[]>([])
  const [miniMovimientos, setMiniMovimientos] = useState<MiniMovimiento[]>([])
  const [targetEntidadId, setTargetEntidadId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const fetchTicket = async () => {
      try {
        const { data: ticketData, error: ticketError } = await supabase
          .from('transacciones_tickets')
          .select(`
            *,
            vendedor:entidades!id_vendedor(nombre),
            comprador:entidades!id_comprador(nombre, rol, comision_base, comision_base_local)
          `)
          .eq('id', resolvedParams.id)
          .single()

        if (ticketError) {
          console.error('Error fetching ticket:', ticketError)
          return
        }

        setTicket(ticketData)
        let entidadObjetivo = ticketData.id_comprador ?? null

        if (!entidadObjetivo) {
          const { data: abonoRelacion, error: abonoRelacionError } = await supabase
            .from('finanzas_ledger')
            .select('id_entidad_relacionada')
            .eq('id_ticket', resolvedParams.id)
            .eq('tipo_movimiento', 'ABONO_DEUDA')
            .order('fecha_movimiento', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (abonoRelacionError) {
            console.error('Error resolving target entity from finanzas_ledger:', abonoRelacionError)
          }

          entidadObjetivo = abonoRelacion?.id_entidad_relacionada ?? null
        }

        setTargetEntidadId(entidadObjetivo)

        const { data: detallesData, error: detallesError } = await supabase
          .from('ticket_detalles')
          .select(`
            *,
            producto:catalogo_productos(nombre)
          `)
          .eq('id_ticket', resolvedParams.id)

        if (detallesError) {
          console.error('Error fetching detalles:', detallesError)
          return
        }

        setDetalles(detallesData || [])

        if (!entidadObjetivo) {
          setMiniMovimientos([])
          return
        }

        const [ticketsResult, abonosResult] = await Promise.all([
          supabase
            .from('transacciones_tickets')
            .select('id, fecha_transaccion, id_comprador, id_vendedor, monto_base_ingreso, total_cobrado_real, condicion_pago')
            .or(`id_comprador.eq.${entidadObjetivo},id_vendedor.eq.${entidadObjetivo}`)
            .order('fecha_transaccion', { ascending: false })
            .limit(10),
          supabase
            .from('finanzas_ledger')
            .select('id, fecha_movimiento, monto')
            .in('status', ['ACTIVO', 'APPROVED'])
            .eq('tipo_movimiento', 'ABONO_DEUDA')
            .eq('id_entidad_relacionada', entidadObjetivo)
            .order('fecha_movimiento', { ascending: false })
            .limit(10)
        ])

        if (ticketsResult.error) {
          console.error('Error fetching mini statement tickets:', ticketsResult.error)
        }
        if (abonosResult.error) {
          console.error('Error fetching mini statement abonos:', abonosResult.error)
        }

        const filteredTicketRows = ((ticketsResult.data as TicketMovimientoRow[] | null) || []).filter(
          (row) => row.id !== resolvedParams.id
        )

        const ticketMovimientos: MiniMovimiento[] = filteredTicketRows
          .filter((row) => !!row.fecha_transaccion)
          .map((row) => {
            const fecha = row.fecha_transaccion as string
            const esCompra = row.id_comprador === entidadObjetivo
            const condicion = row.condicion_pago === 'CONCESION' ? 'CONCESION' : 'CONTADO'
            return {
              id: `ticket-${row.id}`,
              fecha,
              concepto: esCompra ? `VENTA (${condicion})` : 'VENTA REALIZADA',
              monto: esCompra
                ? (row.monto_base_ingreso ?? row.total_cobrado_real ?? 0)
                : (row.total_cobrado_real ?? row.monto_base_ingreso ?? 0),
              sortTs: new Date(fecha).getTime()
            }
          })

        const abonoMovimientos: MiniMovimiento[] = ((abonosResult.data as AbonoMovimientoRow[] | null) || [])
          .filter((row) => !!row.fecha_movimiento)
          .map((row) => {
            const fecha = row.fecha_movimiento as string
            return {
              id: `abono-${row.id}`,
              fecha,
              concepto: 'ABONO',
              monto: -Math.abs(row.monto || 0),
              sortTs: new Date(fecha).getTime()
            }
          })

        const miniSorted = [...ticketMovimientos, ...abonoMovimientos]
          .filter((row) => Number.isFinite(row.sortTs))
          .sort((a, b) => b.sortTs - a.sortTs)

        const miniSliced = miniSorted.slice(0, 5)

        const ticketIdsEnMini = miniSliced
          .filter((m) => m.id.startsWith('ticket-'))
          .map((m) => m.id.replace(/^ticket-/, ''))

        let miniFinal = miniSliced
        if (ticketIdsEnMini.length > 0) {
          const desgloseMap = await fetchDesgloseTextoPorTicketId(supabase, ticketIdsEnMini)
          miniFinal = miniSliced.map((m) => {
            if (!m.id.startsWith('ticket-')) return m
            const tid = m.id.replace(/^ticket-/, '')
            const texto = desgloseMap.get(tid)
            if (!texto) return m
            return { ...m, concepto: `${m.concepto}\n${texto}` }
          })
        }

        setMiniMovimientos(miniFinal)
      } catch (error) {
        console.error('Error in fetchTicket:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchTicket()
  }, [resolvedParams.id])

  const handlePrint = () => {
    window.print()
  }

  const handleShareWhatsApp = () => {
    if (!ticket) return
    
    const totalCobradoBruto = ticket.total_cobrado_real
    const totalDeudaNeta = ticket.monto_base_ingreso
    const esCompradorDST = ticket.comprador?.rol === 'DST'
    const totalPagar = esCompradorDST ? totalDeudaNeta : totalCobradoBruto
    
    const fecha = new Date(ticket.fecha_transaccion).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
    const folio = ticket.id.substring(0, 8).toUpperCase()
    const nombreVen = ticket.vendedor?.nombre || 'Desconocido'
    const nombreCom = ticket.comprador?.nombre || 'Público en General'
    
    const itemsString = detalles
      .map((d) => {
        const subtotalLinea = d.precio_unitario * d.cantidad
        return `${d.cantidad} - ${d.producto.nombre}\n[$${d.precio_unitario.toFixed(2)} c/u]\nSubTotal: $${subtotalLinea.toFixed(2)}`
      })
      .join('\n\n')
    const miniEstadoCuenta = miniMovimientos.length > 0
      ? `\n\n--------------------------------\n*ÚLTIMOS 5 MOVIMIENTOS*\n${miniMovimientos
          .map((mov) => `${formatMiniDate(mov.fecha)} | ${mov.concepto} | ${formatMiniAmount(mov.monto)}`)
          .join('\n')}\n--------------------------------`
      : ''
    
    const totalesString = esCompradorDST
      ? `*Total (Deuda Neta): $${totalPagar.toFixed(2)}*`
      : `*Total: $${totalPagar.toFixed(2)}*`
    
    const texto = encodeURIComponent(`*DESTILADO DE CHILE*\n*Comprobante de Venta Digital*\n\n*Vendedor:* ${nombreVen}\n*Comprador:* ${nombreCom}\n\n*Fecha:* ${fecha}\n*Folio:* ${folio}\n\n${itemsString}\n\n${totalesString}${miniEstadoCuenta}\n\nPuede consultar su recibo digital en el siguiente enlace:\n${window.location.href}`)
    window.open(`https://wa.me/?text=${texto}`, '_blank')
  }


  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('es-MX', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const formatMiniDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString('es-MX', {
      day: '2-digit',
      month: '2-digit'
    })
  }

  const formatMiniAmount = (amount: number) => {
    const sign = amount < 0 ? '-' : '+'
    const abs = Math.abs(amount)
    const formatted = new Intl.NumberFormat('es-MX', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(abs)
    return `${sign}$${formatted}`
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">⏳</div>
          <p className="text-gray-600">Cargando ticket...</p>
        </div>
      </div>
    )
  }

  if (!ticket) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4">❌</div>
          <p className="text-gray-600">Ticket no encontrado</p>
          <Link href="/pos" className="text-blue-600 hover:text-blue-800 mt-4 inline-block">
            ← Volver al POS
          </Link>
        </div>
      </div>
    )
  }

  return (
    <>
      <style jsx global>{`
        @media print {
          .no-print {
            display: none !important;
          }
          body {
            padding: 0;
            margin: 0;
            font-size: 12px;
          }
          .ticket-container {
            box-shadow: none !important;
            max-width: 100% !important;
          }
        }
      `}</style>

      <div className="min-h-screen bg-gray-100 py-8">
        <div className="max-w-sm mx-auto">
          {/* Botones de Acción */}
          <div className="no-print mb-6 flex gap-3">
            <button
              onClick={handlePrint}
              className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              🖨️ Imprimir
            </button>
            <button
              onClick={handleShareWhatsApp}
              className="flex-1 bg-green-600 text-white py-2 px-4 rounded-lg hover:bg-green-700 transition-colors font-medium"
            >
              💬 Compartir WhatsApp
            </button>
          </div>

          <div className="no-print flex gap-3 mb-4">
            <Link
              href="/pos"
              className="flex-1 bg-gray-200 text-black px-4 py-2 rounded text-center font-medium hover:bg-gray-300"
            >
              ← Nueva Venta
            </Link>
            <Link
              href="/dashboard/general" 
              className="flex-1 bg-blue-600 text-white px-4 py-2 rounded text-center font-medium hover:bg-blue-700"
            >
              ← Volver al Dashboard
            </Link>
          </div>

          {/* Ticket Térmico */}
          <div className="ticket-container bg-white p-6 shadow-lg font-mono text-sm text-gray-800">
            {/* Cabecera */}
            <div className="text-center mb-4">
              <h1 className="text-lg font-bold text-center mb-1">FRESNILLO / DESTILADO DE CHILE</h1>
              <p className="text-xs">Sistema de Punto de Venta</p>
              <div className="border-t border-dashed border-gray-400 my-3"></div>
              <p className="text-xs">Fecha: {formatDate(ticket.fecha_transaccion)}</p>
              <p className="text-xs">Folio: {ticket.id.slice(0, 8).toUpperCase()}</p>
              <p className="text-xs mt-2">Vendedor: {ticket.vendedor?.nombre || 'Desconocido'}</p>
              <p className="text-xs">Comprador: {ticket.comprador?.nombre || 'Público en General'}</p>
            </div>

            <div className="border-t border-dashed border-gray-400 my-3"></div>

            {/* Tabla de Productos */}
            <div className="mb-3">
              <div className="flex justify-between text-xs font-bold mb-2">
                <span className="w-12">Cant</span>
                <span className="flex-1">Concepto</span>
                <span className="w-20 text-right">Importe</span>
              </div>
              {detalles.map((detalle) => (
                <div key={detalle.id} className="mb-2">
                  <div className="text-xs">
                    <div className="flex justify-between">
                      <span>{detalle.cantidad} - {detalle.producto.nombre}</span>
                    </div>
                    <div className="text-gray-600 ml-2">
                      [${detalle.precio_unitario.toFixed(2)} c/u]
                    </div>
                    <div className="text-right font-medium">
                      SubTotal: ${(detalle.precio_unitario * detalle.cantidad).toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-dashed border-gray-400 my-3"></div>

            {/* Totales */}
            <div className="text-xs space-y-1">
              {(() => {
                const totalCobradoBruto = ticket.total_cobrado_real
                const totalDeudaNeta = ticket.monto_base_ingreso
                const esCompradorDST = ticket.comprador?.rol === 'DST'
                const totalPagar = esCompradorDST ? totalDeudaNeta : totalCobradoBruto
                return (
                  <>
                    <div className="border-t border-gray-800 my-2"></div>
                    <div className="flex justify-between text-base font-bold">
                      <span>{esCompradorDST ? 'Total (Deuda Neta):' : 'Total:'}</span>
                      <span>${totalPagar.toFixed(2)}</span>
                    </div>
                  </>
                )
              })()}
            </div>

            {targetEntidadId && miniMovimientos.length > 0 && (
              <div className="text-xs mt-3">
                <p className="text-gray-600">--------------------------------</p>
                <p className="font-bold mt-1">ÚLTIMOS 5 MOVIMIENTOS</p>
                <div className="mt-1 space-y-1">
                  {miniMovimientos.map((mov) => (
                    <div key={mov.id} className="flex justify-between gap-2 items-start">
                      <span>{formatMiniDate(mov.fecha)}</span>
                      <span className="flex-1 text-center text-xs whitespace-pre-line break-words px-1">
                        {mov.concepto}
                      </span>
                      <span className="shrink-0">{formatMiniAmount(mov.monto)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-gray-600 mt-1">--------------------------------</p>
              </div>
            )}

            <div className="border-t border-dashed border-gray-400 my-3"></div>

            {/* Footer */}
            <div className="text-center text-xs mt-4">
              <p>¡Gracias por su compra!</p>
              <p className="mt-2 text-gray-600">Este ticket es válido como comprobante</p>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
