'use client'
// Paridad v2: copia de app/dashboard/avisos/AccionesAviso.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.

import { useState, useTransition } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { ignorarAvisoAction, resolverAvisoAction } from '@/app/actions/avisos'

interface Props {
  idAviso: string
  /**
   * Hoy solo W4. El boton se dibuja IGUAL: no se esconde para que el usuario
   * vea el rechazo con su motivo en vez de preguntarse por que no hay boton.
   * El candado real esta en Postgres (`tg_avisos_vigilar_cierre`).
   */
  exigeAsignacion: boolean
}

export function AccionesAviso({ idAviso, exigeAsignacion }: Props) {
  const { refrescar } = useModalV2()
  const [pendiente, arrancar] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [pidiendoMotivo, setPidiendoMotivo] = useState(false)
  const [motivo, setMotivo] = useState('')

  const resolver = () => {
    setError(null)
    arrancar(async () => {
      const r = await resolverAvisoAction(idAviso)
      // `console.error` y no `alert`: esto es una accion iniciada por el usuario,
      // pero el mensaje del trigger es largo y hay que poder leerlo completo.
      if (!r.success) {
        setError(r.error)
        console.error('[avisos] No se pudo resolver:', r.error)
        return
      }
      refrescar()
    })
  }

  const ignorar = () => {
    setError(null)
    arrancar(async () => {
      const r = await ignorarAvisoAction(idAviso, motivo)
      if (!r.success) {
        setError(r.error)
        console.error('[avisos] No se pudo ignorar:', r.error)
        return
      }
      setPidiendoMotivo(false)
      setMotivo('')
      refrescar()
    })
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={resolver}
        disabled={pendiente}
        title={
          exigeAsignacion
            ? 'Este aviso no se cierra sin asignarle un comprador real a la venta.'
            : undefined
        }
        className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
      >
        {pendiente ? 'Guardando…' : 'Marcar resuelto'}
      </button>

      {pidiendoMotivo ? (
        <span className="flex flex-1 flex-wrap items-center gap-2">
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo para ignorarlo (una linea)"
            className="min-w-[16rem] flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={ignorar}
            disabled={pendiente || motivo.trim() === ''}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
          >
            Confirmar
          </button>
          <button
            type="button"
            onClick={() => {
              setPidiendoMotivo(false)
              setError(null)
            }}
            className="px-2 py-1.5 text-sm text-gray-500 hover:underline"
          >
            Cancelar
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setPidiendoMotivo(true)}
          disabled={pendiente}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
        >
          Ignorar
        </button>
      )}

      {exigeAsignacion ? (
        <span className="text-xs font-medium text-amber-700">
          Resolver = asignar comprador. Sin eso, la base lo rechaza.
        </span>
      ) : null}

      {error ? (
        <p className="w-full rounded bg-red-50 p-2 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  )
}
