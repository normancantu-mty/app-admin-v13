/**
 * Front v2 — graficas SVG a mano (sin librerias, regla YAGNI del repo).
 * Escrito el 2026-10-29 por el ejecutor del Front v2. Componentes de servidor:
 * no llevan estado ni JS en el navegador.
 *
 * Los dos ejes aguantan negativos (correccion de la auditoria, 2026-10-29): una
 * perdida se pinta debajo del 0 y en rojo, nunca recortada a 0.
 */

import { mxnCorto, nombreMesCorto } from '@/lib/v2/formato'
import type { PasoCascada } from '@/lib/v2/dinero'

export interface Serie {
  nombre: string
  color: string
  /** color de los valores negativos (p. ej. una perdida en rojo); por omision, `color` */
  colorNegativo?: string
  valores: number[]
}

function techo(max: number): number {
  if (max <= 0) return 1000
  const p = Math.pow(10, Math.floor(Math.log10(max)))
  const pasos = [1, 2, 2.5, 5, 10]
  for (const s of pasos) if (s * p >= max) return s * p
  return 10 * p
}

const W = 640
const H = 260
const M = { l: 52, r: 12, t: 22, b: 34 }
const IH = H - M.t - M.b

/** Eje vertical: [min, max] siempre incluye el 0 y crece hacia abajo si hay negativos. */
function escala(lo: number, hi: number) {
  const max = hi > 0 ? techo(hi) : lo < 0 ? 0 : 1000
  const min = lo < 0 ? -techo(-lo) : 0
  const y = (v: number) => M.t + IH - ((v - min) / (max - min)) * IH
  const ticks = min < 0 ? [...new Set([min, min / 2, 0, max / 2, max])] : [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  return { y, ticks }
}

function Eje({ ticks, y, formato }: { ticks: number[]; y: (v: number) => number; formato: (n: number) => string }) {
  return (
    <>
      {ticks.map((t) => (
        <g key={t}>
          <line className="eje" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} style={t === 0 ? { stroke: '#8a7b77' } : undefined} />
          <text x={M.l - 6} y={y(t) + 4} textAnchor="end">
            {formato(t)}
          </text>
        </g>
      ))}
    </>
  )
}

export function Leyenda({ items }: { items: { nombre: string; color: string; linea?: boolean }[] }) {
  return (
    <div className="leyenda">
      {items.map((i) => (
        <span key={i.nombre}>
          <i style={{ background: i.color, height: i.linea ? 2 : 10, verticalAlign: i.linea ? 3 : -1 }} />
          {i.nombre}
        </span>
      ))}
    </div>
  )
}

/** Barras apiladas por mes (positivos hacia arriba, negativos hacia abajo), con una linea opcional. */
export function BarrasMes({
  meses,
  series,
  linea,
  enCurso,
  formato = mxnCorto
}: {
  meses: string[]
  series: Serie[]
  linea?: { nombre: string; valores: number[] }
  enCurso?: string
  formato?: (n: number) => string
}) {
  const pos = meses.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.valores[i] ?? 0), 0))
  const neg = meses.map((_, i) => series.reduce((a, s) => a + Math.min(0, s.valores[i] ?? 0), 0))
  const lin = linea?.valores ?? []
  const { y, ticks } = escala(Math.min(0, ...neg, ...lin), Math.max(0, ...pos, ...lin))
  const paso = (W - M.l - M.r) / Math.max(meses.length, 1)
  const bw = Math.min(56, paso * 0.55)

  return (
    <svg className="graf" viewBox={`0 0 ${W} ${H}`} role="img">
      <Eje ticks={ticks} y={y} formato={formato} />
      {meses.map((mes, i) => {
        const cx = M.l + paso * i + paso / 2
        let arriba = 0
        let abajo = 0
        const neto = pos[i] + neg[i]
        return (
          <g key={mes}>
            {series.map((s) => {
              const v = s.valores[i] ?? 0
              if (v === 0) return null
              const desde = v > 0 ? arriba : abajo
              const hasta = desde + v
              if (v > 0) arriba = hasta
              else abajo = hasta
              const top = y(Math.max(desde, hasta))
              const alto = Math.abs(y(desde) - y(hasta))
              return (
                <rect
                  key={s.nombre}
                  x={cx - bw / 2}
                  y={top}
                  width={bw}
                  height={Math.max(0, alto)}
                  fill={v < 0 ? s.colorNegativo ?? s.color : s.color}
                  rx={2}
                />
              )
            })}
            {(pos[i] !== 0 || neg[i] !== 0) && (
              <text
                className="val"
                x={cx}
                y={neto >= 0 ? y(pos[i]) - 6 : y(neg[i]) + 14}
                textAnchor="middle"
                style={neto < 0 ? { fill: 'var(--crit)' } : undefined}
              >
                {formato(neto)}
              </text>
            )}
            <text x={cx} y={H - M.b + 16} textAnchor="middle">
              {nombreMesCorto(mes)}
            </text>
            {enCurso === mes && (
              <text x={cx} y={H - M.b + 29} textAnchor="middle" style={{ fontSize: 10 }}>
                en curso
              </text>
            )}
          </g>
        )
      })}
      {linea && (
        <g>
          <polyline
            fill="none"
            stroke="#221816"
            strokeWidth={2}
            points={linea.valores.map((v, i) => `${M.l + paso * i + paso / 2},${y(v)}`).join(' ')}
          />
          {linea.valores.map((v, i) => (
            <circle key={i} cx={M.l + paso * i + paso / 2} cy={y(v)} r={3.5} fill="#fff" stroke="#221816" strokeWidth={2} />
          ))}
        </g>
      )}
    </svg>
  )
}

/** Cascada: Inicio, pasos que suman (verde) o restan (rojo), Final.
 *  Desde/hasta de cada barra de la cascada (funcion pura, fuera del render). */
function armarBarras(pasos: PasoCascada[]) {
  const out: (PasoCascada & { desde: number; hasta: number })[] = []
  let corriendo = 0
  for (const p of pasos) {
    if (p.tipo === 'inicio') {
      corriendo = p.valor
      out.push({ ...p, desde: 0, hasta: p.valor })
    } else if (p.tipo === 'final') {
      out.push({ ...p, desde: 0, hasta: p.valor })
    } else {
      out.push({ ...p, desde: corriendo, hasta: corriendo + p.valor })
      corriendo += p.valor
    }
  }
  return out
}

export function Cascada({ pasos }: { pasos: PasoCascada[] }) {
  const barras = armarBarras(pasos)
  const extremos = barras.flatMap((b) => [b.desde, b.hasta])
  const { y, ticks } = escala(Math.min(0, ...extremos), Math.max(0, ...extremos))
  const paso = (W - M.l - M.r) / Math.max(barras.length, 1)
  const bw = Math.min(64, paso * 0.6)

  return (
    <svg className="graf" viewBox={`0 0 ${W} ${H}`} role="img">
      <Eje ticks={ticks} y={y} formato={mxnCorto} />
      {barras.map((b, i) => {
        const cx = M.l + paso * i + paso / 2
        const top = y(Math.max(b.desde, b.hasta))
        const alto = Math.max(2, Math.abs(y(b.desde) - y(b.hasta)))
        const negativo = b.valor < 0
        const color = b.tipo === 'paso' ? (b.valor >= 0 ? 'var(--s4)' : 'var(--s1)') : negativo ? 'var(--crit)' : '#5a4a46'
        const etiqueta = b.tipo === 'paso' ? `${b.valor >= 0 ? '+' : ''}${mxnCorto(b.valor)}` : mxnCorto(b.valor)
        return (
          <g key={b.etiqueta + i}>
            <rect x={cx - bw / 2} y={top} width={bw} height={alto} fill={color} rx={2} />
            <text className="val" x={cx} y={top - 6} textAnchor="middle" style={negativo ? { fill: 'var(--crit)' } : undefined}>
              {etiqueta}
            </text>
            <text x={cx} y={H - M.b + 16} textAnchor="middle">
              {b.etiqueta.length > 18 ? b.etiqueta.slice(0, 17) + '…' : b.etiqueta}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
