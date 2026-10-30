'use client'

/**
 * Paridad v2 — el enlace que abre un modal AL INSTANTE. Escrito el 2026-10-29 por
 * el ejecutor del Socio.
 *
 * Es un <Link> normal (navegacion suave al slot @modal). Mientras el servidor
 * contesta, `useLinkStatus().pending` pinta un esqueleto de modal en un portal
 * (#v2-portal): el usuario ve la ventana abrirse en el mismo clic, sin esperar
 * datos y sin el retraso de 300 ms de un Suspense de pagina.
 */

import Link, { useLinkStatus } from 'next/link'
import { useRouter } from 'next/navigation'
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalV2 } from './ProveedorModal'
import { EsqueletoModal } from './Esqueleto'
import type { TamModal } from './Modal'

const sinSuscripcion = () => () => {}
/** El nodo del portal; null en el servidor y en la hidratacion (sin setState en un effect). */
const nodoPortal = () => document.getElementById('v2-portal') ?? document.body
const sinPortal = () => null

function Pendiente({ titulo, tam, cancelado, alCancelar }: { titulo?: string; tam?: TamModal; cancelado: boolean; alCancelar: () => void }) {
  const { pending } = useLinkStatus()
  const { marcarEsqueletoVisto } = useModalV2()
  const destino = useSyncExternalStore(sinSuscripcion, nodoPortal, sinPortal)
  useEffect(() => {
    if (pending && !cancelado) marcarEsqueletoVisto()
  }, [pending, cancelado, marcarEsqueletoVisto])
  // `cancelado` oculta el esqueleto en el MISMO frame del clic en la X, sin
  // esperar a que el router suelte `pending`.
  if (!pending || cancelado || !destino) return null
  return createPortal(<EsqueletoModal titulo={titulo} tam={tam} alCerrar={alCancelar} />, destino)
}

export function AbrirModal({
  href,
  className,
  titulo,
  tam,
  children,
  title,
  'data-testid': testId
}: {
  href: string
  className?: string
  /** Titulo que muestra el esqueleto mientras carga. */
  titulo?: string
  tam?: TamModal
  children: ReactNode
  title?: string
  'data-testid'?: string
}) {
  const { alAbrir, cancelarApertura } = useModalV2()
  const router = useRouter()
  // Prefetch por INTENCION (2026-10-30): al pasar el mouse (tras 80 ms, para no
  // disparar lecturas al cruzar el panel), al enfocar o al tocar, se pide la ruta
  // COMPLETA (`PrefetchKind.FULL`). En Next 16 un prefetch AUTO de una ruta
  // dinamica sin `loading.tsx` solo trae el arbol de rutas, no los datos; y un
  // `loading.tsx` en @modal reemplazaria el modal entero por el esqueleto en cada
  // cambio de pestana (`CambiarModal`). No va en viewport: son decenas de enlaces
  // dinamicos y cada uno es un render con lecturas a Supabase. En dev, ademas,
  // compila la ruta antes del clic. Tras guardar, la server action revalida y
  // Next vacia este cache del cliente, asi que no sirve datos viejos.
  const espera = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prefetch = useCallback(() => {
    if (espera.current) clearTimeout(espera.current)
    espera.current = null
    router.prefetch(href, { kind: PrefetchKind.FULL })
  }, [router, href])
  const alEntrar = () => {
    if (espera.current) clearTimeout(espera.current)
    espera.current = setTimeout(prefetch, 80)
  }
  const alSalir = () => {
    if (espera.current) clearTimeout(espera.current)
    espera.current = null
  }
  useEffect(() => alSalir, [])
  // Cada clic es un intento; cancelar marca ESE intento. Un clic nuevo vuelve a
  // mostrar el esqueleto aunque el anterior se haya cancelado.
  const [intento, setIntento] = useState(0)
  const [cancelado, setCancelado] = useState(-1)
  const alClic = () => {
    setIntento((i) => i + 1)
    alAbrir()
  }
  const alCancelar = useCallback(() => {
    setCancelado(intento)
    cancelarApertura()
  }, [intento, cancelarApertura])
  return (
    <Link
      href={href}
      scroll={false}
      prefetch={false}
      className={className}
      onClick={alClic}
      onMouseEnter={alEntrar}
      onMouseLeave={alSalir}
      onFocus={prefetch}
      onTouchStart={prefetch}
      title={title}
      data-testid={testId}
    >
      {children}
      <Pendiente titulo={titulo} tam={tam} cancelado={cancelado === intento} alCancelar={alCancelar} />
    </Link>
  )
}

function GiroPendiente() {
  const { pending } = useLinkStatus()
  return pending ? <i className="giro" style={{ marginLeft: 6 }} /> : null
}

/**
 * Cambia el contenido del modal abierto (pestañas, «Cargar más», filtros) sin
 * abrir otro: `replace`, sin tocar la pila. Muestra un giro mientras carga.
 */
export function CambiarModal({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} replace scroll={false} prefetch={false} className={className}>
      {children}
      <GiroPendiente />
    </Link>
  )
}
