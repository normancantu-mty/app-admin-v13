'use client'

/**
 * Paridad v2 — el marco de todo modal. Escrito el 2026-10-29 por el ejecutor del Socio.
 * Cierra con la X, con Esc y con clic en el fondo. Bloquea el scroll del panel
 * mientras esta abierto. Si el esqueleto ya se vio, no repite la animacion.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CerrarLocal, useModalV2 } from './ProveedorModal'

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
  const { cerrar, leerEsqueletoVisto, olvidarEsqueleto } = useModalV2()
  // Render puro: solo LEE si el esqueleto se vio; el reinicio va en un effect
  // (en StrictMode el inicializador corre dos veces y no debe mutar nada).
  const [sinAnim] = useState(leerEsqueletoVisto)
  useEffect(() => {
    olvidarEsqueleto()
  }, [olvidarEsqueleto])
  const caja = useRef<HTMLDivElement>(null)
  // Cierre optimista (2026-10-30): el modal se oculta en el MISMO frame de la
  // X/Esc/fondo y la navegacion corre detras. Oculto (no desmontado): si la
  // navegacion se descarta, el formulario no pierde lo escrito. Una vez oculto ya
  // no escucha Esc: un segundo Esc no dispara otro `back()`.
  const [oculto, setOculto] = useState(false)
  const cerrarOptimista = useCallback(
    (destino?: string) => {
      setOculto(true)
      cerrar(destino)
    },
    [cerrar]
  )
  const salir = useCallback(() => cerrarOptimista(padre), [cerrarOptimista, padre])

  useEffect(() => {
    if (oculto) return
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') salir()
    }
    window.addEventListener('keydown', alTecla)
    caja.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previo
      window.removeEventListener('keydown', alTecla)
    }
  }, [salir, oculto])

  return (
    <CerrarLocal cerrar={cerrarOptimista}>
      <div
        className={`m-fondo${sinAnim ? ' sin-anim' : ''}`}
        hidden={oculto}
        style={oculto ? { display: 'none' } : undefined}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) salir()
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
            <button type="button" className="m-cerrar" aria-label="Cerrar" onClick={salir}>
              ×
            </button>
          </div>
          <div className="m-bd">{children}</div>
        </div>
      </div>
    </CerrarLocal>
  )
}
