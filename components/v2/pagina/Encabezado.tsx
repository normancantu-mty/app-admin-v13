/**
 * Paginas v2 — el encabezado de una pagina completa de `/panel` (Finanzas, Red,
 * Catalogo, Inventario). Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Regla de Norman (2026-10-29): MODAL = accion rapida o vista general desde el
 * panel; PAGINA = ver TODO un apartado a detalle. La pagina no tiene menu ni
 * pestañas: «← Panel», el titulo y sus acciones. El selector de tema vive en la
 * barra superior del layout, la misma en el panel y en cada pagina. Las capturas
 * de una pagina se siguen abriendo como modal encima de ella (slot `@modal`).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import Link from 'next/link'
import type { ReactNode } from 'react'

export function EncabezadoPagina({
  titulo,
  sub,
  acciones,
  migas
}: {
  titulo: ReactNode
  sub?: ReactNode
  acciones?: ReactNode
  /** Pasos intermedios entre el panel y esta pagina (p. ej. Red en la ficha de un nodo). */
  migas?: { href: string; texto: string }[]
}) {
  return (
    <div className="pg-hd" data-testid="encabezado-pagina">
      <nav className="pg-migas" aria-label="Ruta">
        <Link href={RUTA_BASE} className="volver" data-testid="volver-panel">
          ← Panel
        </Link>
        {migas?.map((m) => (
          <span key={m.href} className="pg-miga">
            <span aria-hidden="true">›</span>
            <Link href={m.href} className="volver">
              {m.texto}
            </Link>
          </span>
        ))}
      </nav>
      <div className="ph" style={{ margin: 0 }}>
        <div>
          <h1>{titulo}</h1>
          {sub ? <p>{sub}</p> : null}
        </div>
        {acciones ? <div className="fila-acc">{acciones}</div> : null}
      </div>
    </div>
  )
}

/** «Ver todo →»: vive en `VerTodo.tsx` (componente cliente, prefetch por intencion). */
export { VerTodo } from './VerTodo'
