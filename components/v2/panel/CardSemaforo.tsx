/**
 * Front v2 — la tarjeta "Semáforo" del panel de la matriz. Extraida de
 * `app/v2/_panel/PanelMando.tsx` el 2026-10-30 por un ejecutor del Socio (Norman:
 * "que muestre un poquito más de detalle, y que si está en números rojos también
 * lo muestre, que resalte más").
 *
 * Componente de servidor y puro: recibe los indicadores ya calculados por el
 * panel (no lee nada). Cada indicador muestra su cifra, la regla que lo dispara y
 * el enlace a donde se arregla. Los rojos van arriba, con fondo y borde rojo; un
 * conteo "N alertas rojas" en la cabecera. Una cifra negativa se pinta en rojo.
 */

import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import type { TamModal } from '@/components/v2/modal/Modal'

export type Luz = 'rojo' | 'ambar' | 'verde' | 'gris'

export interface IndicadorSemaforo {
  luz: Luz
  titulo: string
  /** La cifra grande del indicador, ya formateada. */
  cifra: string
  /** El valor numerico detras de la cifra, para pintar en rojo si es negativo. */
  valor?: number | null
  detalle: string
  /** Que lo pone en rojo/ambar, en una linea. */
  regla: string
  estado: string
  /** Donde se arregla (modal de la v2). */
  href?: string
  tituloModal?: string
  tam?: TamModal
  accion?: string
}

const ORDEN: Record<Luz, number> = { rojo: 0, ambar: 1, gris: 2, verde: 3 }
const CHIP: Record<Luz, string> = { rojo: 'crit', ambar: 'warn', verde: 'good', gris: '' }

export function CardSemaforo({ indicadores, fuente }: { indicadores: IndicadorSemaforo[]; fuente: string }) {
  // Rojo, ambar, sin dato, bien; dentro de cada luz, el orden del panel (sort estable).
  const lista = [...indicadores].sort((a, b) => ORDEN[a.luz] - ORDEN[b.luz])
  const n = (l: Luz) => indicadores.filter((s) => s.luz === l).length
  const rojos = n('rojo')

  return (
    <section className={`card sem-card${rojos ? ' sem-hay-rojo' : ''}`} data-testid="card-semaforo">
      <div className="hd">
        <div>
          <h2>Semáforo</h2>
          <div className="sub">
            {n('ambar')} en ámbar · {n('gris')} sin dato · {n('verde')} bien
          </div>
        </div>
        <span className={`sem-conteo${rojos ? ' rojo' : ''}`} data-testid="sem-conteo-rojo">
          {rojos ? `${rojos} ${rojos === 1 ? 'alerta roja' : 'alertas rojas'}` : 'Sin alertas rojas'}
        </span>
      </div>
      <div className="sem">
        {lista.map((s) => (
          <div className={`fila sem-fila ${s.luz}`} key={s.titulo} data-testid={`sem-${s.luz}`}>
            <span className={`luz ${s.luz}`}>
              <i />
              <i />
              <i />
            </span>
            <span className="tx">
              <b>{s.titulo}</b>
              <span className={`sem-cifra${s.valor !== null && s.valor !== undefined && s.valor < 0 ? ' neg' : ''}`}>{s.cifra}</span>
              <span>{s.detalle}</span>
              <small className="sem-regla">Regla: {s.regla}</small>
            </span>
            <span className="sem-der">
              <span className={`chip ${CHIP[s.luz]}`}>{s.estado}</span>
              {s.href && (
                <AbrirModal className="sem-ir" href={s.href} titulo={s.tituloModal ?? s.titulo} tam={s.tam}>
                  {s.accion ?? 'Ver'} ›
                </AbrirModal>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="fuente">{fuente}</div>
    </section>
  )
}
