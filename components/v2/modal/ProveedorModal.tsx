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
 *
 * Paginas v2 (2026-10-29, ejecutor del Socio): ademas del panel hay paginas
 * completas (`/v2/finanzas`, `/v2/red`, `/v2/red/<id>`, `/v2/catalogo`,
 * `/v2/inventario`) y sus capturas se abren como modal ENCIMA de la pagina. Por
 * eso el proveedor recuerda la `base`: la ultima ruta que no es modal (con su
 * query). «Volver al panel» (`/v2` o sin destino) significa volver a la base.
 * Si se abrio el modal desde una pagina, un destino de modal que el usuario no
 * recorrio (p. ej. Compra -> `/v2/m/inventario`) tambien vuelve a la base: el
 * usuario ya esta viendo el apartado completo. El ticket tras una venta se
 * respeta. Desde el panel el comportamiento es el de siempre.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'

type EstadoModal = {
  alAbrir: () => void
  /** Cancela una apertura que aun carga (X/Esc/fondo del esqueleto). No pide nada al servidor. */
  cancelarApertura: () => void
  marcarCambio: () => void
  hayCambio: () => boolean
  /** Cierra el modal. `padre` es a donde se vuelve si hubo cambios (por defecto el panel). */
  cerrar: (padre?: string) => void
  /** Va a otra ruta de modal o al panel tras guardar, refrescando los datos. */
  irTrasGuardar: (destino?: string) => void
  /** Vuelve a leer el modal abierto (misma ruta, `?act=` nuevo) y marca el cambio. */
  refrescar: () => void
  /** El esqueleto de AbrirModal se pinto (el modal real no repite la animacion). */
  marcarEsqueletoVisto: () => void
  /** Lee si el esqueleto se vio, sin cambiar nada (se puede llamar en render). */
  leerEsqueletoVisto: () => boolean
  /** Olvida el esqueleto ya consumido (en un effect, no en render). */
  olvidarEsqueleto: () => void
}

const Ctx = createContext<EstadoModal | null>(null)

const PREFIJO_MODAL = '/v2/m/'
const esModal = (ruta: string) => ruta.startsWith(PREFIJO_MODAL)
const sinQuery = (ruta: string) => ruta.split('?')[0]

/** La URL actual sin `act` (la base a la que se vuelve). */
function rutaActualSinAct(): string {
  const u = new URL(window.location.href)
  u.searchParams.delete('act')
  const q = u.searchParams.toString()
  return u.pathname + (q ? `?${q}` : '')
}

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
  /** Ultima ruta que no es modal: el panel o una pagina completa. */
  const base = useRef('/v2')
  /** Rutas de modal recorridas desde la base (padres reales de un modal anidado). */
  const visitados = useRef(new Set<string>())

  useEffect(() => {
    if (!esModal(pathname)) {
      pila.current = 0
      cambio.current = false
      visitados.current.clear()
      base.current = rutaActualSinAct()
    } else {
      visitados.current.add(pathname)
    }
  }, [pathname])

  /** A donde se va de verdad cuando un modal pide `destino`. */
  const resolver = useCallback((destino?: string): string => {
    if (!destino || destino === '/v2') return base.current
    if (base.current === '/v2' || !esModal(destino)) return destino
    if (destino.startsWith('/v2/m/ticket/') || visitados.current.has(sinQuery(destino))) return destino
    return base.current
  }, [])

  useEffect(() => {
    const alVolver = () => {
      if (pila.current > 0) pila.current -= 1
    }
    window.addEventListener('popstate', alVolver)
    return () => window.removeEventListener('popstate', alVolver)
  }, [])

  const alAbrir = useCallback(() => {
    // Abrir desde una pagina con filtros: la base guarda tambien su query.
    if (!esModal(window.location.pathname)) base.current = rutaActualSinAct()
    pila.current += 1
  }, [])
  const cancelarApertura = useCallback(() => {
    if (pila.current > 0) pila.current -= 1
    esqueletoVisto.current = false
    // 2026-10-30: el router de Next descarta la navegacion pendiente cuando llega
    // otra navegacion o un RESTORE. `history.replaceState` con la URL ACTUAL es un
    // RESTORE (Next parcha `history`): descarta la apertura sin pedir nada al
    // servidor y sin repintar el panel (un `router.replace` a la misma URL volveria
    // a leer toda la pagina dinamica). Si la respuesta llega despues, se ignora.
    window.history.replaceState(null, '', window.location.href)
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
        router.replace(conAct(resolver(padre)), { scroll: false })
        return
      }
      if (pila.current > 0) {
        router.back()
        return
      }
      router.replace(resolver(padre), { scroll: false })
    },
    [router, resolver]
  )

  const irTrasGuardar = useCallback(
    (destino?: string) => {
      cambio.current = true
      pila.current = 0
      router.replace(conAct(resolver(destino)), { scroll: false })
    },
    [router, resolver]
  )

  const refrescar = useCallback(() => {
    cambio.current = true
    router.replace(conAct(rutaActualSinAct()), { scroll: false })
  }, [router])

  const marcarEsqueletoVisto = useCallback(() => {
    esqueletoVisto.current = true
  }, [])
  const leerEsqueletoVisto = useCallback(() => esqueletoVisto.current, [])
  const olvidarEsqueleto = useCallback(() => {
    esqueletoVisto.current = false
  }, [])

  const valor = useMemo(
    () => ({
      alAbrir,
      cancelarApertura,
      marcarCambio,
      hayCambio,
      cerrar,
      irTrasGuardar,
      refrescar,
      marcarEsqueletoVisto,
      leerEsqueletoVisto,
      olvidarEsqueleto
    }),
    [alAbrir, cancelarApertura, marcarCambio, hayCambio, cerrar, irTrasGuardar, refrescar, marcarEsqueletoVisto, leerEsqueletoVisto, olvidarEsqueleto]
  )
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>
}

export function useModalV2(): EstadoModal {
  const v = useContext(Ctx)
  if (!v) throw new Error('useModalV2 fuera de ProveedorModal')
  return v
}
