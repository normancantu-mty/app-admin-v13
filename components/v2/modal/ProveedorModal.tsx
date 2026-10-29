'use client'

/**
 * Paridad v2 — estado de los modales del panel unico. Escrito el 2026-10-29 por el
 * ejecutor del Socio.
 *
 * /v2 es UNA pagina: todo lo demas se abre como modal en el slot `@modal`
 * (rutas `/v2/m/...`). Navegar a un modal es navegacion suave: el panel NO se
 * vuelve a pintar. Este proveedor recuerda dos cosas:
 *  - `pila`: cuantos modales se abrieron desde el panel (para cerrar con `back()`
 *    y que el boton Atras del navegador siga funcionando);
 *  - `cambio`: si algo se guardo. Si si, al cerrar se pide el panel con `?act=`
 *    (URL nueva -> el servidor vuelve a leer las cifras); si no, `back()` y el
 *    panel sale de la cache del router sin pedir nada.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'

type EstadoModal = {
  alAbrir: () => void
  marcarCambio: () => void
  hayCambio: () => boolean
  /** Cierra el modal. `padre` es a donde se vuelve si hubo cambios (por defecto el panel). */
  cerrar: (padre?: string) => void
  /** Va a otra ruta de modal o al panel tras guardar, refrescando los datos. */
  irTrasGuardar: (destino?: string) => void
  /** Vuelve a leer el modal abierto (misma ruta, `?act=` nuevo) y marca el cambio. */
  refrescar: () => void
  esqueletoVisto: { current: boolean }
}

const Ctx = createContext<EstadoModal | null>(null)

function conAct(ruta: string): string {
  const sep = ruta.includes('?') ? '&' : '?'
  return `${ruta}${sep}act=${Date.now()}`
}

export function ProveedorModal({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const pila = useRef(0)
  const cambio = useRef(false)
  const esqueletoVisto = useRef(false)

  useEffect(() => {
    if (pathname === '/v2') {
      pila.current = 0
      cambio.current = false
    }
  }, [pathname])

  useEffect(() => {
    const alVolver = () => {
      if (pila.current > 0) pila.current -= 1
    }
    window.addEventListener('popstate', alVolver)
    return () => window.removeEventListener('popstate', alVolver)
  }, [])

  const alAbrir = useCallback(() => {
    pila.current += 1
  }, [])
  const marcarCambio = useCallback(() => {
    cambio.current = true
  }, [])
  const hayCambio = useCallback(() => cambio.current, [])

  const cerrar = useCallback(
    (padre?: string) => {
      if (cambio.current) {
        // Con padre (modal anidado) se vuelve al padre ya refrescado; el cambio
        // sigue marcado para que al cerrar el padre tambien se refresque el panel.
        pila.current = 0
        router.replace(conAct(padre ?? '/v2'), { scroll: false })
        return
      }
      if (pila.current > 0) {
        router.back()
        return
      }
      router.replace(padre ?? '/v2', { scroll: false })
    },
    [router]
  )

  const irTrasGuardar = useCallback(
    (destino?: string) => {
      cambio.current = true
      pila.current = 0
      router.replace(conAct(destino ?? '/v2'), { scroll: false })
    },
    [router]
  )

  const refrescar = useCallback(() => {
    cambio.current = true
    const u = new URL(window.location.href)
    u.searchParams.delete('act')
    const q = u.searchParams.toString()
    router.replace(conAct(u.pathname + (q ? `?${q}` : '')), { scroll: false })
  }, [router])

  const valor = useMemo(
    () => ({ alAbrir, marcarCambio, hayCambio, cerrar, irTrasGuardar, refrescar, esqueletoVisto }),
    [alAbrir, marcarCambio, hayCambio, cerrar, irTrasGuardar, refrescar]
  )
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>
}

export function useModalV2(): EstadoModal {
  const v = useContext(Ctx)
  if (!v) throw new Error('useModalV2 fuera de ProveedorModal')
  return v
}
