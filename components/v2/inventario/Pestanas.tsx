'use client'

/**
 * Inventario v2 compacto — pestañas del detalle (stock, movimientos, compras,
 * lotes). Escrito el 2026-10-30 por el ejecutor del Socio (inventario compacto).
 *
 * Todo el contenido llega ya pintado por el servidor; la pestaña solo decide cual
 * se ve (`hidden`), asi que cambiar de pestaña no pide nada al servidor. La
 * pestaña inicial la elige el servidor (`?ver=` en la pagina) y al cambiarla se
 * escribe en la URL con `replaceState`, para que recargar no la pierda.
 */

import { useState, type ReactNode } from 'react'

export type Pestana = { id: string; titulo: ReactNode; cuenta?: ReactNode; contenido: ReactNode }

export function PestanasInv({ pestanas, inicial, enUrl = false }: { pestanas: Pestana[]; inicial?: string; enUrl?: boolean }) {
  const valida = (id?: string) => (id && pestanas.some((p) => p.id === id) ? id : pestanas[0]?.id)
  const [activa, setActiva] = useState(() => valida(inicial))
  const elegir = (id: string) => {
    setActiva(id)
    if (!enUrl) return
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('ver', id)
      u.hash = ''
      window.history.replaceState(window.history.state, '', u.pathname + u.search)
    } catch {
      /* sin URL no pasa nada: la pestaña ya cambio */
    }
  }
  return (
    <div className="inv-pest">
      <div className="inv-tabs" role="tablist" aria-label="Detalle">
        {pestanas.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            id={`inv-tab-${p.id}`}
            aria-selected={activa === p.id}
            aria-controls={`inv-panel-${p.id}`}
            className={activa === p.id ? 'on' : ''}
            onClick={() => elegir(p.id)}
            data-testid={`inv-tab-${p.id}`}
          >
            {p.titulo}
            {p.cuenta !== undefined && p.cuenta !== null ? <span className="inv-cuenta">{p.cuenta}</span> : null}
          </button>
        ))}
      </div>
      {pestanas.map((p) => (
        <div key={p.id} role="tabpanel" id={`inv-panel-${p.id}`} aria-labelledby={`inv-tab-${p.id}`} hidden={activa !== p.id}>
          {p.contenido}
        </div>
      ))}
    </div>
  )
}
