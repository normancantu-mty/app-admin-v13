/**
 * Front v2 — graficas SVG a mano (sin librerias, regla YAGNI del repo).
 * Escrito el 2026-10-29 por el ejecutor del Front v2. Componentes de servidor:
 * no llevan estado ni JS en el navegador.
 */

import { mxnCorto, nombreMesCorto } from '@/lib/v2/formato'
import type { PasoCascada } from '@/lib/v2/dinero'

export interface Serie {
  nombre: string
  color: string
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

/** Barras apiladas por mes, con una linea opcional encima. */
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
  const totales = meses.map((_, i) => series.reduce((a, s) => a + Math.max(0, s.valores[i] ?? 0), 0))
  const max = techo(Math.max(...totales, ...(linea?.valores ?? [0])))
  const iw = W - M.l - M.r
  const ih = H - M.t - M.b
  const paso = iw / Math.max(meses.length, 1)
  const bw = Math.min(56, paso * 0.55)
  const y = (v: number) => M.t + ih - (v / max) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  return (
    <svg className="graf" viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line className="eje" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
          <text x={M.l - 6} y={y(t) + 4} textAnchor="end">
            {formato(t)}
          </text>
        </g>
      ))}
      {meses.map((mes, i) => {
        const cx = M.l + paso * i + paso / 2
        let base = 0
        return (
          <g key={mes}>
            {series.map((s) => {
              const v = Math.max(0, s.valores[i] ?? 0)
              const y0 = y(base)
              base += v
              const y1 = y(base)
              return v > 0 ? (
                <rect key={s.nombre} x={cx - bw / 2} y={y1} width={bw} height={Math.max(0, y0 - y1)} fill={s.color} rx={2} />
              ) : null
            })}
            {totales[i] > 0 && (
              <text className="val" x={cx} y={y(totales[i]) - 6} textAnchor="middle">
                {formato(totales[i])}
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
  const max = techo(Math.max(...barras.map((b) => Math.max(b.desde, b.hasta)), 1))
  const iw = W - M.l - M.r
  const ih = H - M.t - M.b
  const paso = iw / Math.max(barras.length, 1)
  const bw = Math.min(64, paso * 0.6)
  const y = (v: number) => M.t + ih - (v / max) * ih
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)

  return (
    <svg className="graf" viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line className="eje" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
          <text x={M.l - 6} y={y(t) + 4} textAnchor="end">
            {mxnCorto(t)}
          </text>
        </g>
      ))}
      {barras.map((b, i) => {
        const cx = M.l + paso * i + paso / 2
        const top = y(Math.max(b.desde, b.hasta))
        const alto = Math.max(2, Math.abs(y(b.desde) - y(b.hasta)))
        const color = b.tipo === 'paso' ? (b.valor >= 0 ? 'var(--s4)' : 'var(--s1)') : '#5a4a46'
        const etiqueta = b.tipo === 'paso' ? `${b.valor >= 0 ? '+' : ''}${mxnCorto(b.valor)}` : mxnCorto(b.valor)
        return (
          <g key={b.etiqueta + i}>
            <rect x={cx - bw / 2} y={top} width={bw} height={alto} fill={color} rx={2} />
            <text className="val" x={cx} y={top - 6} textAnchor="middle">
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
