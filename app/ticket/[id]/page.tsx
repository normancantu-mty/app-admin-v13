'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

interface TicketMaster {
  id: string
  fecha_transaccion: string
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

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const resolvedParams = use(params)
  const router = useRouter()
  const [ticket, setTicket] = useState<TicketMaster | null>(null)
  const [detalles, setDetalles] = useState<TicketDetalle[]>([])
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
    
    const subtotal = ticket.subtotal_catalogo
    const totalPagar = ticket.total_cobrado_real
    const montoDescuento = subtotal - totalPagar
    const porcentajeReal = subtotal > 0 && montoDescuento > 0 ? Math.round((montoDescuento / subtotal) * 100) : 0
    
    const fecha = new Date(ticket.fecha_transaccion).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })
    const folio = ticket.id.substring(0, 8).toUpperCase()
    const nombreVen = ticket.vendedor?.nombre || 'Desconocido'
    const nombreCom = ticket.comprador?.nombre || 'Público en General'
    
    const itemsString = detalles.map(d => `${d.cantidad} - ${d.producto.nombre}\n[$${(d.subtotal_linea / d.cantidad).toFixed(2)} c/u]\nSubTotal: $${d.subtotal_linea.toFixed(2)}`).join('\n\n')
    
    let totalesString = `*Total: $${totalPagar.toFixed(2)}*`
    if (montoDescuento > 0) {
      totalesString = `SubTotal: $${subtotal.toFixed(2)}\n*Descuento Mayorista (${porcentajeReal}%): -$${montoDescuento.toFixed(2)}*\n*Total a Pagar: $${totalPagar.toFixed(2)}*`
    }
    
    const texto = encodeURIComponent(`*DESTILADO DE CHILE*\n*Comprobante de Venta Digital*\n\n*Vendedor:* ${nombreVen}\n*Comprador:* ${nombreCom}\n\n*Fecha:* ${fecha}\n*Folio:* ${folio}\n\n${itemsString}\n\n${totalesString}\n\nPuede consultar su recibo digital en el siguiente enlace:\n${window.location.href}`)
    window.open(`https://wa.me/?text=${texto}`, '_blank')
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(amount)
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
              <h1 className="text-lg font-bold mb-1">DESTILADO DIGITAL</h1>
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
                      [${(detalle.subtotal_linea / detalle.cantidad).toFixed(2)} c/u]
                    </div>
                    <div className="text-right font-medium">
                      SubTotal: ${detalle.subtotal_linea.toFixed(2)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-dashed border-gray-400 my-3"></div>

            {/* Totales */}
            <div className="text-xs space-y-1">
              {(() => {
                const subtotal = ticket.subtotal_catalogo
                const totalPagar = ticket.total_cobrado_real
                const montoDescuento = subtotal - totalPagar
                const porcentajeReal = subtotal > 0 && montoDescuento > 0 ? Math.round((montoDescuento / subtotal) * 100) : 0
                
                if (montoDescuento > 0) {
                  return (
                    <>
                      <div className="flex justify-between">
                        <span>Subtotal:</span>
                        <span>${subtotal.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-green-700">
                        <span>Descuento Mayorista ({porcentajeReal}%):</span>
                        <span>-${montoDescuento.toFixed(2)}</span>
                      </div>
                      <div className="border-t border-gray-800 my-2"></div>
                      <div className="flex justify-between text-base font-bold">
                        <span>Total a Pagar:</span>
                        <span>${totalPagar.toFixed(2)}</span>
                      </div>
                    </>
                  )
                } else {
                  return (
                    <>
                      <div className="border-t border-gray-800 my-2"></div>
                      <div className="flex justify-between text-base font-bold">
                        <span>Total:</span>
                        <span>${totalPagar.toFixed(2)}</span>
                      </div>
                    </>
                  )
                }
              })()}
            </div>

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
