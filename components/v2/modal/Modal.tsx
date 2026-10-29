'use client'

/**
 * Paridad v2 — el marco de todo modal. Escrito el 2026-10-29 por el ejecutor del Socio.
 * Cierra con la X, con Esc y con clic en el fondo. Bloquea el scroll del panel
 * mientras esta abierto. Si el esqueleto ya se vio, no repite la animacion.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useModalV2 } from './ProveedorModal'

export type TamModal = 'sm' | 'md' | 'lg' | 'xl'

export function Modal({
  titulo,
  sub,
  acciones,
  tam = 'lg',
  padre,
  children
}: {
  titulo: ReactNode
  sub?: ReactNode
  acciones?: ReactNode
  tam?: TamModal
  /** Ruta del modal padre (anidado). Sin padre, cerrar vuelve al panel. */
  padre?: string
  children: ReactNode
}) {
  const { cerrar, esqueletoVisto } = useModalV2()
  const [sinAnim] = useState(() => {
    const v = esqueletoVisto.current
    esqueletoVisto.current = false
    return v
  })
  const caja = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cerrar(padre)
    }
    window.addEventListener('keydown', alTecla)
    caja.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previo
      window.removeEventListener('keydown', alTecla)
    }
  }, [cerrar, padre])

  return (
    <div
      className={`m-fondo${sinAnim ? ' sin-anim' : ''}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cerrar(padre)
      }}
    >
      <div
        ref={caja}
        tabIndex={-1}
        className={`m-caja ${tam}${sinAnim ? ' sin-anim' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={typeof titulo === 'string' ? titulo : undefined}
        data-modal-v2
      >
        <div className="m-hd">
          <div className="m-tit">
            <h2>{titulo}</h2>
            {sub ? <div className="m-sub">{sub}</div> : null}
          </div>
          {acciones ? <div className="m-acc">{acciones}</div> : null}
          <button type="button" className="m-cerrar" aria-label="Cerrar" onClick={() => cerrar(padre)}>
            ×
          </button>
        </div>
        <div className="m-bd">{children}</div>
      </div>
    </div>
  )
}
