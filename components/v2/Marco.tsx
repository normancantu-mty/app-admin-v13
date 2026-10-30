'use client'

/**
 * Paridad v2 — piezas cliente del marco: selector de tema (Claro / Oscuro /
 * Sistema, por defecto Sistema; lo guarda next-themes), boton Salir y el boton
 * de enviar con indicador de carga. Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { useFormStatus } from 'react-dom'
import { supabase } from '@/lib/supabase'

const OPCIONES = [
  { v: 'light', l: 'Claro' },
  { v: 'dark', l: 'Oscuro' },
  { v: 'system', l: 'Sistema' }
] as const

const sinSuscripcion = () => () => {}

export function TemaSelector() {
  const { theme, setTheme } = useTheme()
  // Montado en el cliente sin setState en un effect: false en el servidor y en la
  // hidratacion, true despues (el tema guardado solo existe en el navegador).
  const listo = useSyncExternalStore(sinSuscripcion, () => true, () => false)
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

/**
 * El apartado de sesion del encabezado: "nombre · rol" abre un menu con
 * "Cambiar de usuario" y "Cerrar sesion". Escrito el 2026-10-30 por el ejecutor
 * del Socio; sustituye al boton `Salir` suelto en `app/v2/layout.tsx`.
 *
 * - `data-testid="v2-usuario"` sigue en el texto del nombre (lo usan los E2E).
 * - "Saliendo…" se pinta en el mismo clic, antes de esperar a Supabase.
 * - `signOut({ scope: 'local' })`: cierra la sesion de ESTE navegador. El
 *   default de supabase-js es `global`, que tambien saca al usuario de su
 *   celular y de cualquier otra pestana — mal para "cambiar de usuario" en una
 *   compu compartida.
 * - "Cambiar de usuario" lleva a `/login?cambiar=1`: correo vacio y enfocado.
 */
export function SesionMenu({ nombre, rol }: { nombre: string; rol: string }) {
  const router = useRouter()
  const [abierto, setAbierto] = useState(false)
  const [saliendo, setSaliendo] = useState(false)
  const caja = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!abierto) return
    const fuera = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false)
    }
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAbierto(false)
    }
    document.addEventListener('mousedown', fuera)
    document.addEventListener('keydown', tecla)
    return () => {
      document.removeEventListener('mousedown', fuera)
      document.removeEventListener('keydown', tecla)
    }
  }, [abierto])

  const salir = async (destino: '/login' | '/login?cambiar=1') => {
    setAbierto(false)
    setSaliendo(true)
    try {
      await supabase.auth.signOut({ scope: 'local' })
    } finally {
      router.replace(destino)
      router.refresh()
    }
  }

  return (
    <div className="sesion" ref={caja}>
      <button
        type="button"
        className="sesion-btn"
        aria-haspopup="menu"
        aria-expanded={abierto}
        disabled={saliendo}
        onClick={() => setAbierto((v) => !v)}
      >
        <span className="quien" data-testid="v2-usuario">
          {nombre} · {rol}
        </span>
        {saliendo ? <span className="sesion-estado">Saliendo…</span> : <span aria-hidden className="sesion-flecha">▾</span>}
      </button>
      {abierto ? (
        <div className="sesion-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => salir('/login?cambiar=1')}>
            Cambiar de usuario
          </button>
          <button type="button" role="menuitem" className="peligro" onClick={() => salir('/login')}>
            Cerrar sesión
          </button>
        </div>
      ) : null}
    </div>
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
