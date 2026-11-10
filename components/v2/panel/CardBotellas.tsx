/**
 * Tarjeta "Botellas por cliente" — arriba del panel de la matriz. Escrito el
 * 2026-11-08 por un ejecutor del Socio (encargo de Norman: que sea MUY visible
 * cuantas botellas lleva cada local y distribuidor por semana y por mes).
 *
 * Solo pinta: el calculo es `armarBotellasPorCliente` (`lib/botellas-cliente.ts`)
 * y la lectura `leerBotellasPorCliente` (`lib/botellas-leer.ts`), las mismas que
 * usa el comando `/botellas` del bot. Server Component, sin JS de cliente: el
 * desglose por presentacion es un `<details>` nativo.
 */

import {
  cambio,
  LEYENDA_EXCLUSIONES,
  rotuloMes,
  rotuloSemana,
  SIN_CLIENTE,
  sinMovimiento,
  type BotellasPorCliente,
  type Conteo
} from '@/lib/botellas-cliente'
import { num } from '@/lib/v2/formato'

function Delta({ actual, anterior }: { actual: number; anterior: number }) {
  const { dif, pct } = cambio(actual, anterior)
  if (dif === 0) return <span className="muted">= {num(anterior)}</span>
  return (
    <span className={dif > 0 ? 'pos' : 'neg'} title={`antes ${num(anterior)}`}>
      {dif > 0 ? '▲' : '▼'} {dif > 0 ? '+' : '−'}
      {num(Math.abs(dif))}
      {pct !== null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}
    </span>
  )
}

function Celda({ c, anterior }: { c: Conteo; anterior: Conteo }) {
  return (
    <td className="r">
      <b style={{ fontSize: 16 }}>{num(c.botellas)}</b>
      <div style={{ fontSize: 11.5 }}>
        <Delta actual={c.botellas} anterior={anterior.botellas} /> <span className="muted">vs {num(anterior.botellas)}</span>
      </div>
      {c.concesion > 0 && <div className="muted" style={{ fontSize: 11 }}>{num(c.concesion)} en concesión</div>}
    </td>
  )
}

/**
 * `datos = null` con `error`: la lectura fallo. La tarjeta pinta el aviso y el
 * resto del panel sigue en pie (PanelMando atrapa el error de esta lectura sola).
 */
export function CardBotellas({ datos, error }: { datos: BotellasPorCliente | null; error?: string }) {
  if (!datos) {
    return (
      <section className="card" data-testid="card-botellas" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Botellas por cliente</h2>
          </div>
        </div>
        <div className="aviso" data-testid="card-botellas-error">
          <b>No se pudo leer las botellas por cliente.</b>
          <span className="muted">{error || 'Error desconocido'}. El resto del panel no depende de esta tarjeta; /botellas en el bot usa la misma lectura.</span>
        </div>
      </section>
    )
  }
  const { semana, semanaAnterior, mes, mesAnterior } = datos.periodos
  const activos = datos.filas.filter((f) => !sinMovimiento(f))
  const quietos = datos.filas.filter((f) => sinMovimiento(f) && f.clave !== SIN_CLIENTE)
  const cortesiasMes = datos.filas.reduce((a, f) => a + f.periodos.mes.cortesias, 0)
  const anuladosMes = datos.excluidas.mes.anulados
  const P = datos.presentaciones

  return (
    <section className="card" data-testid="card-botellas" style={{ marginBottom: 16 }}>
      <div className="hd">
        <div>
          <h2>Botellas por cliente</h2>
          <div className="sub">
            Semana {rotuloSemana(semana)} (lun–dom) y {rotuloMes(mes)}, contra la semana y el mes anteriores. Piezas que salieron en
            ticket al cliente, de contado o en concesión. El periodo actual va en curso.
          </div>
          <div className="sub" data-testid="card-botellas-exclusiones">{LEYENDA_EXCLUSIONES}</div>
        </div>
        <span className="chip chile">
          Matriz: {num(datos.totalMatriz.semana)} sem · {num(datos.totalMatriz.mes)} mes
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="t">
          <thead>
            <tr>
              <th>Cliente</th>
              <th className="r">Semana {rotuloSemana(semana)}</th>
              <th className="r">Mes {rotuloMes(mes)}</th>
            </tr>
          </thead>
          <tbody>
            {activos.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Ningún local ni distribuidor tiene botellas en estas semanas ni en estos meses.
                </td>
              </tr>
            )}
            {activos.map((f) => (
              <tr key={f.clave}>
                <td>
                  <b>{f.nombre}</b> {f.rol && <span className="chip">{f.rol === 'LOC' ? 'Local' : 'Distribuidor'}</span>}
                </td>
                <Celda c={f.periodos.semana} anterior={f.periodos.semanaAnterior} />
                <Celda c={f.periodos.mes} anterior={f.periodos.mesAnterior} />
              </tr>
            ))}
            <tr className="tot">
              <td>Total que salió de la matriz</td>
              <td className="r">
                {num(datos.totalMatriz.semana)}{' '}
                <span style={{ fontSize: 11.5 }}>
                  <Delta actual={datos.totalMatriz.semana} anterior={datos.totalMatriz.semanaAnterior} />
                </span>
              </td>
              <td className="r">
                {num(datos.totalMatriz.mes)}{' '}
                <span style={{ fontSize: 11.5 }}>
                  <Delta actual={datos.totalMatriz.mes} anterior={datos.totalMatriz.mesAnterior} />
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {quietos.length > 0 && (
        <p className="lead" style={{ marginTop: 10 }}>
          <b>Sin botellas en las cuatro ventanas ({quietos.length}):</b> {quietos.map((f) => f.nombre).join(' · ')}
        </p>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Desglose por presentación</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="t" data-testid="botellas-desglose">
            <thead>
              <tr>
                <th>Cliente</th>
                {P.map((p) => (
                  <th key={`s${p}`} className="r">
                    Sem {p} ml
                  </th>
                ))}
                {P.map((p) => (
                  <th key={`m${p}`} className="r">
                    Mes {p} ml
                  </th>
                ))}
                <th className="r">Mes ant.</th>
                <th className="r">Sem ant.</th>
              </tr>
            </thead>
            <tbody>
              {activos.map((f) => (
                <tr key={f.clave}>
                  <td>{f.nombre}</td>
                  {P.map((p) => (
                    <td key={`s${p}`} className="r">
                      {num(f.periodos.semana.porPresentacion[p] ?? 0)}
                    </td>
                  ))}
                  {P.map((p) => (
                    <td key={`m${p}`} className="r">
                      {num(f.periodos.mes.porPresentacion[p] ?? 0)}
                    </td>
                  ))}
                  <td className="r">{num(f.periodos.mesAnterior.botellas)}</td>
                  <td className="r">{num(f.periodos.semanaAnterior.botellas)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="nota">
          Mide <b>sell-in</b>: lo que la matriz (o un distribuidor) le vendió o entregó en concesión al cliente. <b>No</b> mide lo que
          el local le vendió al público: eso solo lo da un conteo físico. La carga inicial de inventario del 28/10 no es venta y no
          aparece. Semana anterior {rotuloSemana(semanaAnterior)}; mes anterior {rotuloMes(mesAnterior)}.
          {cortesiasMes > 0 && ` Cortesías del mes, aparte: ${num(cortesiasMes)}.`}
          {anuladosMes > 0 && ` Tickets anulados del mes, fuera: ${num(anuladosMes)}.`}
          {datos.totalEntreNodos.mes > 0 &&
            ` De distribuidor a sus locales este mes: ${num(datos.totalEntreNodos.mes)} (ya contadas al salir de la matriz; no se suman al total).`}
        </div>
      </details>
      <div className="fuente">transacciones_tickets ACTIVO · ticket_detalles · hora de México · mismo cálculo que /botellas del bot</div>
    </section>
  )
}
