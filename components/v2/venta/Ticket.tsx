'use client'
// Paridad v2: copia de app/ticket/[id]/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

/**
 * El ticket de una venta ya ocurrida.
 *
 * Esta pagina ya NO resuelve sus datos: los pide a `armarDocumentoDeTicket`,
 * que es la misma funcion que alimenta la imagen PNG que el bot manda por
 * Telegram. Si alguna vez esta pantalla y esa imagen dijeran cifras distintas,
 * el cliente tendria dos comprobantes que no cuadran. Por eso el dato es uno.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { useState, useEffect } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { supabase } from '@/lib/supabase'
import { armarDocumentoDeTicket, type DocumentoDatos } from '@/lib/documento'
import DocumentoTermico, {
  NOMBRE_EMPRESA,
  formatFechaDocumento,
  formatFechaCorta,
  formatMontoFirmado
} from '@/components/DocumentoTermico'

export default function Ticket({ id }: { id: string }) {
  const { cerrar } = useModalV2()
  const [datos, setDatos] = useState<DocumentoDatos | null>(null)
  const [cargando, setCargando] = useState(true)

  useEffect(() => {
    let vigente = true
    armarDocumentoDeTicket(supabase, id)
      .then((d) => {
        if (vigente) setDatos(d)
      })
      .catch((error) => {
        console.error('Error armando el ticket:', error)
      })
      .finally(() => {
        if (vigente) setCargando(false)
      })
    return () => {
      vigente = false
    }
  }, [id])

  const handlePrint = () => {
    window.print()
  }

  const handleShareWhatsApp = () => {
    if (!datos) return

    const items = datos.lineas
      .map((l) =>
        `${l.cantidad} - ${l.nombre}\n[$${l.precioUnitario.toFixed(2)} c/u]\nSubTotal: $${(l.precioUnitario * l.cantidad).toFixed(2)}`
      )
      .join('\n\n')

    const estadoCuenta = datos.movimientos.length > 0
      ? `\n\n--------------------------------\n*ULTIMOS 5 MOVIMIENTOS*\n${datos.movimientos
          .map((m) => `${formatFechaCorta(m.fecha)} | ${m.concepto} | ${formatMontoFirmado(m.monto)}`)
          .join('\n')}\n--------------------------------`
      : ''

    const texto = encodeURIComponent(
      `*${NOMBRE_EMPRESA}*\n*Comprobante de Venta Digital*\n\n` +
      `*Vendedor:* ${datos.vendedor}\n*Comprador:* ${datos.comprador}\n\n` +
      `*Fecha:* ${formatFechaDocumento(datos.fecha)}\n*Folio:* ${datos.folio}\n\n` +
      `${items}\n\n*${datos.etiquetaTotal} $${datos.total.toFixed(2)}*${estadoCuenta}\n\n` +
      `Puede consultar su recibo digital en el siguiente enlace:\n${window.location.href}`
    )
    window.open(`https://wa.me/?text=${texto}`, '_blank')
  }

  if (cargando) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="text-center">
          <div className="text-4xl mb-4">⏳</div>
          <p className="text-gray-600">Cargando ticket...</p>
        </div>
      </div>
    )
  }

  if (!datos) {
    return (
      <div className="flex items-center justify-center py-10">
        <div className="text-center">
          <div className="text-4xl mb-4">❌</div>
          <p className="text-gray-600">Ticket no encontrado</p>
          <button type="button" onClick={() => cerrar()} className="text-blue-600 hover:text-blue-800 mt-4 inline-block">
            ← Cerrar
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="py-2">
      <div className="max-w-sm mx-auto">
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
          {/* La imagen PNG (/api/documento/[id]/imagen) es del bot: pide su token y
              responde 401 a una sesion de navegador. Aqui: imprimir y WhatsApp, como la v1. */}
          <AbrirModal
            href={`${RUTA_BASE}/m/venta`}
            titulo="Nueva venta"
            tam="xl"
            className="flex-1 bg-gray-200 text-gray-900 px-4 py-2 rounded text-center font-medium hover:bg-gray-300"
          >
            + Nueva venta
          </AbrirModal>
        </div>

        <DocumentoTermico {...datos} />
      </div>
    </div>
  )
}
