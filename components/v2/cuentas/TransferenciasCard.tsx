'use client'
// Paridad v2: copia de components/dashboard/TransferenciasCard.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
/**
 * v2: metrica de transferencias + boton de conversion a efectivo.
 * Escrito el 2026-10-28 por el Socio (ejecutor), rama v2-arranque-limpio.
 *
 * Solo la pinta; los numeros vienen de `v_transferencias_resumen` y la conversion
 * la hace `public.convertir_transferencias` en una transaccion.
 */
import { useState, useTransition } from 'react'
import { convertirTransferenciasAction } from '@/app/actions/transferencias'
import type { TransferenciasResumen } from '@/lib/dashboard-utils'

const mxn = (n: number) =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(n)

export default function TransferenciasCard({
  resumen,
  canMutate
}: {
  resumen: TransferenciasResumen
  canMutate: boolean
}) {
  const { refrescar } = useModalV2()
  const [monto, setMonto] = useState('')
  const [mensaje, setMensaje] = useState<string | null>(null)
  const [pendiente, startTransition] = useTransition()

  const convertir = () => {
    const valor = Number(monto)
    if (!Number.isFinite(valor) || valor <= 0) {
      setMensaje('Escribe un monto mayor que 0.')
      return
    }
    startTransition(async () => {
      const r = await convertirTransferenciasAction(valor)
      if (r.success) {
        setMensaje(
          `Convertido ${mxn(r.monto)}: ${mxn(r.neto)} a Efectivo, comision ${mxn(r.comision)} (${r.pct}%).`
        )
        setMonto('')
        refrescar()
      } else {
        setMensaje(r.error)
      }
    })
  }

  return (
    <div
      data-testid="tarjeta-transferencias"
      className="bg-white rounded-lg border border-gray-200 shadow-sm p-4"
    >
      <p className="text-xs uppercase tracking-wide font-semibold text-gray-500">Transferencias</p>
      <div className="grid grid-cols-3 gap-3 mt-2 text-sm">
        <div>
          <p className="text-gray-500">Recibidas</p>
          <p className="font-bold" data-testid="transf-recibido">{mxn(resumen.recibidoMonto)}</p>
          <p className="text-xs text-gray-500">{resumen.recibidasN} transferencias</p>
        </div>
        <div>
          <p className="text-gray-500">Convertidas</p>
          <p className="font-bold" data-testid="transf-convertido">{mxn(resumen.convertidoMonto)}</p>
          <p className="text-xs text-gray-500">
            {resumen.conversionesN} conversiones · comision {mxn(resumen.comisionMonto)}
          </p>
        </div>
        <div>
          <p className="text-gray-500">Por convertir</p>
          <p className="font-bold" data-testid="transf-pendiente">{mxn(resumen.pendienteMonto)}</p>
          <p className="text-xs text-gray-500">{resumen.pendientesN} transferencias</p>
        </div>
      </div>
      {canMutate && (
        <div className="mt-3 flex gap-2 items-center">
          <input
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            placeholder="Monto a convertir"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
            data-testid="transf-monto"
            className="border border-gray-300 rounded px-2 py-1 text-sm w-40"
          />
          <button
            type="button"
            onClick={convertir}
            disabled={pendiente}
            data-testid="transf-convertir"
            className="bg-slate-800 text-white px-3 py-1 rounded text-sm disabled:opacity-50"
          >
            {pendiente ? 'Convirtiendo…' : 'Convertir a efectivo'}
          </button>
        </div>
      )}
      {mensaje && <p className="text-xs mt-2 text-gray-700" data-testid="transf-mensaje">{mensaje}</p>}
    </div>
  )
}
