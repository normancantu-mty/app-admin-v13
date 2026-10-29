'use client'

/**
 * Paridad v2 — acciones por nodo en Cartera y Red: «Seguimiento» (registra el
 * toque CRM y pone en 0 los dias) y «Editar» (porcentajes y datos, con la misma
 * accion de servidor que la v1). Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import { useState, useTransition } from 'react'
import { registrarSeguimientoAction } from '@/app/actions/distribuidores'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import type { FilaRed } from '@/lib/v2/red-tipos'
// Mismos umbrales que lib/dashboard-utils.ts (no se importa: ese modulo es de servidor).
const DIAS_SEMAFORO_AMARILLO = 7
const DIAS_SEMAFORO_ROJO = 14
import EditarEntidad from './EditarEntidad'

export function BotonSeguimiento({ id }: { id: string }) {
  const { refrescar } = useModalV2()
  const [pend, iniciar] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className="btn mini"
        disabled={pend}
        data-testid={`seguimiento-${id}`}
        title="Registrar toque CRM (pone los días de seguimiento en 0)"
        onClick={() =>
          iniciar(async () => {
            setError(null)
            try {
              await registrarSeguimientoAction(id)
              refrescar()
            } catch (e) {
              setError(e instanceof Error ? e.message : 'No se pudo registrar el seguimiento.')
            }
          })
        }
      >
        {pend ? <i className="giro" /> : '📞'} Seguimiento
      </button>
      {error ? <span className="neg" style={{ fontSize: 12 }}>{error}</span> : null}
    </>
  )
}

export function BotonEditar({ fila, puedeEliminar = false }: { fila: FilaRed; puedeEliminar?: boolean }) {
  const [abierto, setAbierto] = useState(false)
  return (
    <>
      <button type="button" className="btn mini" onClick={() => setAbierto(true)} data-testid={`editar-${fila.id}`}>
        ✎ Editar
      </button>
      {abierto ? <EditarEntidad row={fila} isOpen onClose={() => setAbierto(false)} canDeleteEntity={puedeEliminar} /> : null}
    </>
  )
}

export function DiasSeguimiento({ dias }: { dias: number | null }) {
  if (dias === null) return <span className="chip">Sin contacto</span>
  // Mismo semaforo que la v1 (getSemaforoMovimiento).
  const nivel = dias < DIAS_SEMAFORO_AMARILLO ? 'good' : dias <= DIAS_SEMAFORO_ROJO ? 'warn' : 'crit'
  return <span className={`chip ${nivel}`}>{dias} d</span>
}
