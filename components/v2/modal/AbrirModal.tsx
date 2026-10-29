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
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModalV2 } from './ProveedorModal'
import { EsqueletoModal } from './Esqueleto'
import type { TamModal } from './Modal'

const sinSuscripcion = () => () => {}
/** El nodo del portal; null en el servidor y en la hidratacion (sin setState en un effect). */
const nodoPortal = () => document.getElementById('v2-portal') ?? document.body
const sinPortal = () => null

function Pendiente({ titulo, tam }: { titulo?: string; tam?: TamModal }) {
  const { pending } = useLinkStatus()
  const { marcarEsqueletoVisto } = useModalV2()
  const destino = useSyncExternalStore(sinSuscripcion, nodoPortal, sinPortal)
  useEffect(() => {
    if (pending) marcarEsqueletoVisto()
  }, [pending, marcarEsqueletoVisto])
  if (!pending || !destino) return null
  return createPortal(<EsqueletoModal titulo={titulo} tam={tam} />, destino)
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
  const { alAbrir } = useModalV2()
  return (
    <Link href={href} scroll={false} prefetch={false} className={className} onClick={alAbrir} title={title} data-testid={testId}>
      {children}
      <Pendiente titulo={titulo} tam={tam} />
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
