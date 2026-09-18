'use client'

/**
 * El documento termico, escrito UNA sola vez.
 *
 * Lo pintan dos rutas: /ticket/[id] (la venta que ya ocurrio) y /cotizacion
 * (la misma hoja ANTES de la venta). Norman lo pidio con esas palabras -- "el
 * mismo ticket nada mas que se llame cotizacion" -- y copiar el JSX era la
 * forma segura de que en tres meses dijeran cosas distintas.
 * tests/documento-termico.spec.ts vigila que nadie lo vuelva a copiar.
 *
 * Es PRESENTACIONAL: no lee la base, no escribe nada, no decide nada.
 * Quien lo llama trae los datos ya resueltos.
 */

export interface LineaDocumento {
  id: string
  nombre: string
  cantidad: number
  precioUnitario: number
}

export interface MovimientoDocumento {
  id: string
  fecha: string
  concepto: string
  monto: number
}

export interface DocumentoTermicoProps {
  /** La linea chica bajo el nombre de la empresa. Es lo unico que distingue un ticket de una cotizacion. */
  subtitulo: string
  fecha: string
  folio: string
  vendedor: string
  comprador: string
  lineas: LineaDocumento[]
  etiquetaTotal: string
  total: number
  /** Solo el ticket lo trae: una cotizacion no tiene estado de cuenta porque no movio nada. */
  movimientos?: MovimientoDocumento[]
  /** Renglones del pie, en orden. El primero va en negro; los demas en gris. */
  pie: string[]
}

export const NOMBRE_EMPRESA = 'FRESNILLO / DESTILADO DE CHILE'

export function formatFechaDocumento(dateString: string) {
  return new Date(dateString).toLocaleString('es-MX', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatFechaCorta(dateString: string) {
  return new Date(dateString).toLocaleDateString('es-MX', {
    day: '2-digit',
    month: '2-digit'
  })
}

export function formatMontoFirmado(amount: number) {
  const sign = amount < 0 ? '-' : '+'
  const formatted = new Intl.NumberFormat('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(amount))
  return `${sign}$${formatted}`
}

export default function DocumentoTermico({
  subtitulo,
  fecha,
  folio,
  vendedor,
  comprador,
  lineas,
  etiquetaTotal,
  total,
  movimientos = [],
  pie
}: DocumentoTermicoProps) {
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

      <div className="ticket-container bg-white p-6 shadow-lg font-mono text-sm text-gray-800">
        {/* Cabecera */}
        <div className="text-center mb-4">
          <h1 className="text-lg font-bold text-center mb-1">{NOMBRE_EMPRESA}</h1>
          <p className="text-xs">{subtitulo}</p>
          <div className="border-t border-dashed border-gray-400 my-3"></div>
          <p className="text-xs">Fecha: {formatFechaDocumento(fecha)}</p>
          <p className="text-xs">Folio: {folio}</p>
          <p className="text-xs mt-2">Vendedor: {vendedor}</p>
          <p className="text-xs">Comprador: {comprador}</p>
        </div>

        <div className="border-t border-dashed border-gray-400 my-3"></div>

        {/* Tabla de Productos */}
        <div className="mb-3">
          <div className="flex justify-between text-xs font-bold mb-2">
            <span className="w-12">Cant</span>
            <span className="flex-1">Concepto</span>
            <span className="w-20 text-right">Importe</span>
          </div>
          {lineas.map((linea) => (
            <div key={linea.id} className="mb-2">
              <div className="text-xs">
                <div className="flex justify-between">
                  <span>{linea.cantidad} - {linea.nombre}</span>
                </div>
                <div className="text-gray-600 ml-2">
                  [${linea.precioUnitario.toFixed(2)} c/u]
                </div>
                <div className="text-right font-medium">
                  SubTotal: ${(linea.precioUnitario * linea.cantidad).toFixed(2)}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-dashed border-gray-400 my-3"></div>

        {/* Totales */}
        <div className="text-xs space-y-1">
          <div className="border-t border-gray-800 my-2"></div>
          <div className="flex justify-between text-base font-bold">
            <span>{etiquetaTotal}</span>
            <span>${total.toFixed(2)}</span>
          </div>
        </div>

        {movimientos.length > 0 && (
          <div className="text-xs mt-3">
            <p className="text-gray-600">--------------------------------</p>
            <p className="font-bold mt-1">ULTIMOS 5 MOVIMIENTOS</p>
            <div className="mt-1 space-y-1">
              {movimientos.map((mov) => (
                <div key={mov.id} className="flex justify-between gap-2 items-start">
                  <span>{formatFechaCorta(mov.fecha)}</span>
                  <span className="flex-1 text-center text-xs whitespace-pre-line break-words px-1">
                    {mov.concepto}
                  </span>
                  <span className="shrink-0">{formatMontoFirmado(mov.monto)}</span>
                </div>
              ))}
            </div>
            <p className="text-gray-600 mt-1">--------------------------------</p>
          </div>
        )}

        <div className="border-t border-dashed border-gray-400 my-3"></div>

        {/* Pie */}
        <div className="text-center text-xs mt-4">
          {pie.map((renglon, i) => (
            <p key={renglon} className={i === 0 ? '' : 'mt-2 text-gray-600'}>
              {renglon}
            </p>
          ))}
        </div>
      </div>
    </>
  )
}
