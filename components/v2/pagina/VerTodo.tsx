'use client'

/**
 * Paginas v2 — «Ver todo →»: de un resumen (panel o modal) a la pagina completa
 * del apartado. Escrito el 2026-10-29 por el ejecutor del Socio; vivia en
 * `Encabezado.tsx` (que lo re-exporta).
 *
 * Perf 2026-10-30 (otro ejecutor del Socio): prefetch por INTENCION, como
 * `AbrirModal`. Con el <Link> por defecto, el panel prefetcheaba en cada carga las
 * paginas completas de sus «Ver todo» (Finanzas, Red, Catalogo, Inventario,
 * Lotes): cada una es un render con lecturas a Supabase que casi nunca se usa.
 * Ahora se pide la ruta COMPLETA (`PrefetchKind.FULL`) solo al pasar el mouse
 * (tras 80 ms), al enfocar o al tocar.
 */

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { PrefetchKind } from 'next/dist/client/components/router-reducer/router-reducer-types'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'

export function VerTodo({ href, children = 'Ver todo →', className = 'btn vertodo' }: { href: string; children?: ReactNode; className?: string }) {
  const router = useRouter()
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
  return (
    <Link
      href={href}
      prefetch={false}
      className={className}
      onMouseEnter={alEntrar}
      onMouseLeave={alSalir}
      onFocus={prefetch}
      onTouchStart={prefetch}
      data-testid={`ver-todo-${href.split('/').filter(Boolean).slice(1).join('-')}`}
    >
      {children}
    </Link>
  )
}
