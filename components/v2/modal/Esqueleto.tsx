'use client'

/**
 * Paridad v2 — esqueleto dentro del modal mientras llegan los datos.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * 2026-10-30 (ejecutor del Socio): el esqueleto de modal se puede CERRAR mientras
 * carga — X, Esc y clic al fondo llaman `alCerrar` (cancela la apertura). Antes la
 * X era un <span> decorativo y no habia forma de salir de un modal atorado.
 */

import { useEffect } from 'react'
import type { TamModal } from './Modal'

export function EsqueletoCuerpo({ filas = 6 }: { filas?: number }) {
  return (
    <div aria-hidden="true">
      <div className="esq-l g" />
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="esq-l" style={{ width: `${92 - ((i * 13) % 35)}%` }} />
      ))}
    </div>
  )
}

export function EsqueletoModal({ titulo, tam = 'lg', alCerrar }: { titulo?: string; tam?: TamModal; alCerrar?: () => void }) {
  useEffect(() => {
    if (!alCerrar) return
    // Fase de captura en window: corre ANTES que el Esc del modal padre (si el
    // esqueleto se abrio desde otro modal) y lo detiene, para no cerrar los dos.
    const alTecla = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      alCerrar()
    }
    window.addEventListener('keydown', alTecla, true)
    return () => window.removeEventListener('keydown', alTecla, true)
  }, [alCerrar])

  return (
    <div
      className="m-fondo esq"
      data-esqueleto-v2
      // El esqueleto vive en un portal DENTRO del <Link> que lo abrio: en React los
      // eventos del portal suben por el arbol de React, no por el DOM. Sin esto, un
      // clic en la X volveria a disparar el <Link> (y el fondo del modal padre).
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        if (e.target === e.currentTarget) alCerrar?.()
      }}
    >
      <div className={`m-caja ${tam}`} role="dialog" aria-busy="true" aria-label={titulo ?? 'Cargando'}>
        <div className="m-hd">
          <div className="m-tit">
            <h2>{titulo ?? 'Cargando'}</h2>
            <div className="m-sub">
              <span className="cargando">
                <i className="giro" /> Cargando…
              </span>
            </div>
          </div>
          <button type="button" className="m-cerrar" aria-label="Cerrar" data-testid="v2-esqueleto-cerrar" onClick={() => alCerrar?.()}>
            ×
          </button>
        </div>
        <div className="m-bd">
          <EsqueletoCuerpo />
        </div>
      </div>
    </div>
  )
}
