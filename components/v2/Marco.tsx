'use client'

/**
 * Paridad v2 — piezas cliente del marco: selector de tema (Claro / Oscuro /
 * Sistema, por defecto Sistema; lo guarda next-themes), boton Salir y el boton
 * de enviar con indicador de carga. Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useFormStatus } from 'react-dom'
import { supabase } from '@/lib/supabase'

const OPCIONES = [
  { v: 'light', l: 'Claro' },
  { v: 'dark', l: 'Oscuro' },
  { v: 'system', l: 'Sistema' }
] as const

export function TemaSelector() {
  const { theme, setTheme } = useTheme()
  const [listo, setListo] = useState(false)
  useEffect(() => setListo(true), [])
  const actual = listo ? (theme ?? 'system') : 'system'
  return (
    <div className="tema" role="radiogroup" aria-label="Tema">
      {OPCIONES.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={actual === o.v}
          className={actual === o.v ? 'on' : ''}
          onClick={() => setTheme(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

export function Salir() {
  const router = useRouter()
  const [saliendo, setSaliendo] = useState(false)
  return (
    <button
      type="button"
      className="salir"
      disabled={saliendo}
      onClick={async () => {
        setSaliendo(true)
        await supabase.auth.signOut()
        router.replace('/login')
        router.refresh()
      }}
    >
      {saliendo ? 'Saliendo…' : 'Salir'}
    </button>
  )
}

/** Boton de envio para <form action={...}>: muestra el giro mientras la accion corre. */
export function BotonEnviar({ children, className = 'btn p', disabled }: { children: ReactNode; className?: string; disabled?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className={className} disabled={pending || disabled} aria-busy={pending}>
      {pending ? <i className="giro" /> : null}
      {children}
    </button>
  )
}

/** Boton con estado de carga explicito (para handlers async fuera de <form>). */
export function BotonCarga({
  cargando,
  children,
  className = 'btn p',
  disabled,
  onClick,
  type = 'button',
  testId
}: {
  cargando: boolean
  children: ReactNode
  className?: string
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
  testId?: string
}) {
  return (
    <button type={type} className={className} disabled={cargando || disabled} aria-busy={cargando} onClick={onClick} data-testid={testId}>
      {cargando ? <i className="giro" /> : null}
      {children}
    </button>
  )
}
