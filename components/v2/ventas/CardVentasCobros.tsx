'use client'

/**
 * Front v2 — la tarjeta "Vendido y cobrado por mes" del panel, dinamica. Escrito el
 * 2026-10-30 por un ejecutor del Socio (encargo de Norman: una vista con la grafica
 * de lo vendido y lo cobrado por mes, y aparte botones para verlo por mas tiempo y
 * por cosas especificas).
 *
 * Los datos llegan del servidor YA agregados (mes x producto x cliente x canal, ver
 * `lib/v2/ventas-cobros.ts`); aqui solo se filtra y agrupa. Cambiar un boton no hace
 * ningun viaje a la red. Las graficas llevan `className="graf"`: el modo privado las
 * difumina, y el motor de cifras tapa los montos escritos.
 */

import { useState } from 'react'
import { BarrasMes, BarrasRanking, Leyenda } from '@/components/v2/graficas'
import { mxn0, num } from '@/lib/v2/formato'
import {
  apiladoPorMes,
  filtrar,
  mesesDelPeriodo,
  ranking,
  serieGeneral,
  totales,
  type Alcance,
  type DatosVentasCobros,
  type Grupo,
  type Metrica,
  type Periodo
} from '@/lib/v2/ventas-cobros'

type Vista = 'total' | 'mes'

const PERIODOS: { v: Periodo; t: string }[] = [
  { v: '3m', t: '3 meses' },
  { v: '6m', t: '6 meses' },
  { v: '12m', t: '12 meses' },
  { v: 'anio', t: 'Año en curso' },
  { v: 'todo', t: 'Todo' }
]
const GRUPOS: { v: Grupo; t: string }[] = [
  { v: 'general', t: 'General' },
  { v: 'producto', t: 'Producto' },
  { v: 'cliente', t: 'Cliente' },
  { v: 'canal', t: 'Canal' }
]
const METRICAS: { v: Metrica; t: string }[] = [
  { v: 'pesos', t: 'Pesos' },
  { v: 'piezas', t: 'Piezas' }
]
const VISTAS: { v: Vista; t: string }[] = [
  { v: 'total', t: 'Ranking' },
  { v: 'mes', t: 'Por mes' }
]
const ALCANCES: { v: Alcance; t: string }[] = [
  { v: 'matriz', t: 'Vendió la matriz' },
  { v: 'red', t: 'Toda la red' }
]
const COLORES = ['var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s1)', 'var(--otros-graf)']

function Seg<T extends string>({
  etiqueta,
  opciones,
  valor,
  onCambio
}: {
  etiqueta: string
  opciones: { v: T; t: string }[]
  valor: T
  onCambio: (v: T) => void
}) {
  return (
    <div className="seg vc-seg" role="group" aria-label={etiqueta}>
      {opciones.map((o) => (
        <button key={o.v} type="button" className={o.v === valor ? 'on' : ''} aria-pressed={o.v === valor} onClick={() => onCambio(o.v)}>
          {o.t}
        </button>
      ))}
    </div>
  )
}

const SUB: Record<Grupo, string> = {
  general: 'Barras: lo vendido (contado + concesión). Línea: lo que entró a las cuentas de la matriz (contado + abonos).',
  producto: 'Lo vendido por producto. El cobro no se reparte por producto: un abono no dice qué paga.',
  cliente: 'Por distribuidor o local que compró. Barra delgada: lo que ese cliente pagó a la matriz.',
  canal: 'Venta de contado contra concesión. Los abonos sin ticket cuentan como concesión.'
}

export function CardVentasCobros({ datos, mesHoy, mesCorte }: { datos: DatosVentasCobros; mesHoy: string; mesCorte: string | null }) {
  const [periodo, setPeriodo] = useState<Periodo>('6m')
  const [grupo, setGrupo] = useState<Grupo>('general')
  const [metrica, setMetrica] = useState<Metrica>('pesos')
  const [vista, setVista] = useState<Vista>('total')
  const [alcance, setAlcance] = useState<Alcance>('matriz')

  const meses = mesesDelPeriodo(periodo, mesHoy, datos, mesCorte)
  const f = filtrar(datos, meses, alcance)
  const tot = totales(f, metrica, alcance)
  const fmt = metrica === 'pesos' ? mxn0 : (x: number) => `${num(x)} pzas`
  const fmtCorto = metrica === 'pesos' ? undefined : (x: number) => num(x)
  const vacio = f.ventas.length === 0 && (metrica === 'piezas' || f.cobros.length === 0)

  let grafica: React.ReactNode = null
  if (!vacio && grupo === 'general') {
    const s = serieGeneral(meses, f, metrica)
    grafica = (
      <>
        <Leyenda
          items={[
            { nombre: 'Contado', color: 'var(--s2)' },
            { nombre: 'Concesión', color: 'var(--s3)' },
            ...(metrica === 'pesos' ? [{ nombre: 'Cobrado', color: 'var(--linea-graf)', linea: true }] : [])
          ]}
        />
        <BarrasMes
          meses={meses}
          enCurso={mesHoy}
          formato={fmtCorto}
          series={[
            { nombre: 'Contado', color: 'var(--s2)', valores: s.contado },
            { nombre: 'Concesión', color: 'var(--s3)', valores: s.concesion }
          ]}
          linea={metrica === 'pesos' ? { nombre: 'Cobrado', valores: s.cobrado } : undefined}
        />
      </>
    )
  } else if (!vacio && vista === 'mes') {
    const series = apiladoPorMes(grupo as Exclude<Grupo, 'general'>, meses, f, metrica, datos)
    grafica = series.length ? (
      <>
        <Leyenda items={series.map((s, i) => ({ nombre: s.nombre, color: s.clave === '_otros' ? COLORES[4] : COLORES[i % 4] }))} />
        <BarrasMes
          meses={meses}
          enCurso={mesHoy}
          formato={fmtCorto}
          series={series.map((s, i) => ({ nombre: s.nombre, color: s.clave === '_otros' ? COLORES[4] : COLORES[i % 4], valores: s.valores }))}
        />
      </>
    ) : (
      <div className="vacio">
        <b>Sin ventas en el periodo</b>Hay cobros, pero ninguna venta que repartir por mes.
      </div>
    )
  } else if (!vacio) {
    const filas = ranking(grupo as Exclude<Grupo, 'general'>, f, metrica, datos)
    const hayCobro = filas.some((x) => x.cobrado !== null)
    grafica = (
      <>
        <Leyenda
          items={[
            { nombre: 'Vendido', color: 'var(--s2)' },
            ...(hayCobro ? [{ nombre: 'Cobrado', color: 'var(--s4)' }] : [])
          ]}
        />
        <BarrasRanking filas={filas.map((x) => ({ clave: x.clave, nombre: x.nombre, valor: x.vendido, cobrado: x.cobrado }))} formato={fmtCorto} />
      </>
    )
  }

  return (
    <section className="card vc-card" data-testid="card-ventas-cobros">
      <div className="hd">
        <div>
          <h2>Vendido y cobrado por mes</h2>
          <div className="sub">{SUB[grupo]}</div>
        </div>
      </div>

      <div className="vc-ctls">
        <Seg etiqueta="Periodo" opciones={PERIODOS} valor={periodo} onCambio={setPeriodo} />
        <Seg etiqueta="Agrupar por" opciones={GRUPOS} valor={grupo} onCambio={setGrupo} />
        <div className="vc-fila">
          <Seg etiqueta="Métrica" opciones={METRICAS} valor={metrica} onCambio={setMetrica} />
          {grupo !== 'general' && <Seg etiqueta="Vista" opciones={VISTAS} valor={vista} onCambio={setVista} />}
          <Seg etiqueta="Quién vendió" opciones={ALCANCES} valor={alcance} onCambio={setAlcance} />
        </div>
      </div>

      <div className="vc-tot" data-testid="vc-totales">
        <div>
          <span className="vc-t">Vendido</span>
          <span className="vc-v">{fmt(tot.vendido)}</span>
        </div>
        <div>
          <span className="vc-t">Cobrado</span>
          <span className="vc-v">{tot.cobrado === null ? '—' : mxn0(tot.cobrado)}</span>
        </div>
        <div>
          <span className="vc-t">% cobrado</span>
          <span className="vc-v">{tot.pct === null ? '—' : `${tot.pct.toLocaleString('es-MX')}%`}</span>
        </div>
      </div>
      {(metrica === 'piezas' || alcance === 'red') && (
        <div className="vc-nota">
          {metrica === 'piezas'
            ? 'En piezas no hay cobrado: el dinero no se cuenta en botellas.'
            : 'Cobrado es solo lo que entró a la matriz; el % se calcula con «Vendió la matriz» (la red contaría dos veces la botella que pasa por un distribuidor).'}
        </div>
      )}

      {vacio ? (
        <div className="vacio">
          <b>Sin ventas en el periodo</b>
          {datos.ventas.length || datos.cobros.length
            ? 'Prueba con un periodo más largo o con «Toda la red».'
            : 'La gráfica se llena con la primera venta o abono.'}
        </div>
      ) : (
        grafica
      )}
      <div className="fuente">transacciones_tickets + ticket_detalles (ACTIVO) · finanzas_ledger INGRESO_VENTA/ABONO_DEUDA a cuentas de la matriz</div>
    </section>
  )
}
