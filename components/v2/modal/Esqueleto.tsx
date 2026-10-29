/**
 * Paridad v2 — esqueleto dentro del modal mientras llegan los datos.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 */

import type { TamModal } from './Modal'

export function EsqueletoCuerpo({ filas = 6 }: { filas?: number }) {
  return (
    <div aria-hidden="true">
      <div className="esq-l g" />
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="esq-l" style={{ width: `${92 - ((i * 13) % 35)}%` }} />
      ))}
    </div>
  )
}

export function EsqueletoModal({ titulo, tam = 'lg' }: { titulo?: string; tam?: TamModal }) {
  return (
    <div className="m-fondo esq" data-esqueleto-v2>
      <div className={`m-caja ${tam}`} role="dialog" aria-busy="true" aria-label={titulo ?? 'Cargando'}>
        <div className="m-hd">
          <div className="m-tit">
            <h2>{titulo ?? 'Cargando'}</h2>
            <div className="m-sub">
              <span className="cargando">
                <i className="giro" /> Cargando…
              </span>
            </div>
          </div>
          <span className="m-cerrar" aria-hidden="true">
            ×
          </span>
        </div>
        <div className="m-bd">
          <EsqueletoCuerpo />
        </div>
      </div>
    </div>
  )
}
