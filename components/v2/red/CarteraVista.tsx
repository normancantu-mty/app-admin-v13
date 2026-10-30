/**
 * Paginas v2 — el cuerpo de la «Cartera completa»: quien debe, cuanto y desde
 * cuando, con «Seguimiento» y «Editar» por nodo. Sacado tal cual del modal
 * `/panel/m/cartera` el 2026-10-29 por el ejecutor del Socio para que la pagina
 * `/panel/red` lo muestre sin duplicarlo. Ver la cabecera de ese modal (T6: la
 * cartera de la matriz no suma la deuda de un local con su distribuidor).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import Link from 'next/link'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { BotonEditar, BotonSeguimiento, DiasSeguimiento } from '@/components/v2/red/AccionesNodo'
import { leerRed } from '@/lib/v2/red'
import { getServerSupabaseClient } from '@/lib/server-session'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { leerCartera, esDeudaConLaMatriz, totalesCarteraVista, type FilaCarteraVista } from '@/lib/vistas'
import { leerNombresEntidades } from '@/lib/v2/lecturas'
import { redondear } from '@/lib/v2/dinero'
import { fechaMx, mxn, num } from '@/lib/v2/formato'

function Dias({ f }: { f: FilaCarteraVista }) {
  const d = f.dias_sin_abono
  if (d === null || d === undefined) return <span className="chip">sin referencia</span>
  const nivel = d > 60 ? 'crit' : d > 30 ? 'warn' : ''
  return (
    <span className={`chip ${nivel}`} title={f.referencia_dias === 'ENTREGA' ? 'Contados desde la entrega: aún no hay abonos' : 'Desde el último abono'}>
      {d} d{f.referencia_dias === 'ENTREGA' ? ' · desde entrega' : ''}
    </span>
  )
}

/** Cartera completa (cuerpo). La usan el modal `/panel/m/cartera` y la pagina `/panel/red`. Exige mando. */
export async function CarteraVista({ fichaEnPagina = false }: { fichaEnPagina?: boolean } = {}) {
  const usuario = await exigirMandoV2()
  const client = await getServerSupabaseClient()
  const [cartera, nombres, red] = await Promise.all([leerCartera(client), leerNombresEntidades(client), leerRed(client, usuario)])
  const filaRed = new Map(red.map((r) => [r.id, r]))
  const puedeEditar = usuario.rol === 'ADMIN'
  const tot = totalesCarteraVista(cartera)
  const matriz = cartera.filter((f) => esDeudaConLaMatriz(f))
  const conDst = cartera.filter((f) => !esDeudaConLaMatriz(f))
  const totalRed = redondear(tot.deuda + tot.deudaConDistribuidor)
  const abonadoMatriz = matriz.reduce((a, f) => a + Number(f.abonado), 0)
  const generadoMatriz = matriz.reduce((a, f) => a + Number(f.generado), 0)
  const enPisoMatriz = matriz.reduce((a, f) => a + Number(f.estimado_en_piso), 0)
  const enPisoDst = conDst.reduce((a, f) => a + Number(f.estimado_en_piso), 0)
  const calculado = cartera[0]?.calculado_en ?? null

  return (
    <>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Orden del ERP: deuda × días sin abonar · v_cartera · calculado {fechaMx(calculado)}
      </p>

      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi fuerte">
          <span className="t">Por cobrar · matriz</span>
          <span className="v">{mxn(tot.deuda)}</span>
          <span className="d">{matriz.filter((f) => Number(f.deuda) > 0).length} nodos le deben a la matriz</span>
        </div>
        <div className="kpi">
          <span className="t">Locales → su distribuidor</span>
          <span className="v">{mxn(tot.deudaConDistribuidor)}</span>
          <span className="d">{tot.nodosConDistribuidor} locales · no se suma a la matriz</span>
        </div>
        <div className="kpi">
          <span className="t">Total de la red</span>
          <span className="v">{mxn(totalRed)}</span>
          <span className="d">matriz + locales con su distribuidor</span>
        </div>
        <div className="kpi">
          <span className="t">Botellas en la red</span>
          <span className="v">{num(tot.estimadoEnPiso)}</span>
          <span className="d">
            estimado en piso · {num(enPisoMatriz)} de la matriz · {num(enPisoDst)} de locales de DST
          </span>
        </div>
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="hd">
          <div>
            <h2>Le deben a la matriz</h2>
            <div className="sub">
              Generado {mxn(generadoMatriz)} · abonado {mxn(abonadoMatriz)} · toca un nombre para abrir su ficha
            </div>
          </div>
        </div>
        <div className="tabla-w">
          <table className="t">
            <thead>
              <tr>
                <th>#</th>
                <th>Nodo</th>
                <th className="r">Deuda</th>
                <th>Sin abonar</th>
                <th className="r">En piso</th>
                <th className="r">Recibidas</th>
                <th className="r">Abonado</th>
                <th>Seguimiento</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {matriz.map((f, i) => {
                // Ronda 2, A7: sin columna «% pagado»; va en gris debajo de la deuda. Nulo = «Sin dato», no 0.
                // La vista trae FRACCION 0-1 (E-243): x100 (corregido 2026-10-30, ejecutor de cobranza).
                const pct = f.porcentaje_pagado === null || f.porcentaje_pagado === undefined ? null : Math.round(Number(f.porcentaje_pagado) * 100)
                return (
                  <tr key={f.id_entidad}>
                    <td className="mono">{i + 1}</td>
                    <td>
                      <Nombre id={f.id_entidad} nombre={f.nombre} />{' '}
                      <span className="chip">{f.rol === 'DST' ? 'Distribuidor' : 'Local'}</span>
                    </td>
                    <td className="r">
                      <b>{mxn(Number(f.deuda))}</b>
                      <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>
                        {pct === null ? '% pagado: Sin dato' : `${pct}% pagado`}
                      </div>
                    </td>
                    <td>
                      <Dias f={f} />
                    </td>
                    <td className="r">{num(Number(f.estimado_en_piso))}</td>
                    <td className="r">{num(Number(f.recibidas))}</td>
                    <td className="r">{mxn(Number(f.abonado))}</td>
                    <td>
                      <DiasSeguimiento dias={filaRed.get(f.id_entidad)?.diasSeguimiento ?? null} />
                    </td>
                    <td>
                      <Acciones id={f.id_entidad} />
                    </td>
                  </tr>
                )
              })}
              <tr className="tot">
                <td />
                <td>Total matriz</td>
                <td className="r">{mxn(tot.deuda)}</td>
                <td />
                <td className="r">{num(enPisoMatriz)}</td>
                <td />
                <td className="r">{mxn(abonadoMatriz)}</td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </div>
        <div className="fuente">v_cartera donde id_acreedor es nulo (deuda con la matriz)</div>
      </section>

      <section className="card">
        <div className="hd">
          <div>
            <h2>Locales que le deben a su distribuidor</h2>
            <div className="sub">
              Deuda del local con el DST que lo surte. La cobra el distribuidor; la matriz la ve, pero no la suma.
            </div>
          </div>
        </div>
        {conDst.length === 0 ? (
          <div className="vacio">
            <b>Ningún local con deuda a un distribuidor</b>
          </div>
        ) : (
          <div className="tabla-w">
            <table className="t">
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Le debe a</th>
                  <th className="r">Deuda</th>
                  <th>Sin abonar</th>
                  <th className="r">En piso</th>
                  <th>Seguimiento</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {conDst.map((f) => (
                  <tr key={f.id_entidad}>
                    <td>
                      <Nombre id={f.id_entidad} nombre={f.nombre} />
                    </td>
                    <td>{(f.id_acreedor && nombres.get(f.id_acreedor)?.nombre) ?? 'sin dato'}</td>
                    <td className="r">
                      <b>{mxn(Number(f.deuda))}</b>
                    </td>
                    <td>
                      <Dias f={f} />
                    </td>
                    <td className="r">{num(Number(f.estimado_en_piso))}</td>
                    <td>
                      <DiasSeguimiento dias={filaRed.get(f.id_entidad)?.diasSeguimiento ?? null} />
                    </td>
                    <td>
                      <Acciones id={f.id_entidad} />
                    </td>
                  </tr>
                ))}
                <tr className="tot">
                  <td>Total locales → distribuidor</td>
                  <td />
                  <td className="r">{mxn(tot.deudaConDistribuidor)}</td>
                  <td />
                  <td className="r">{num(enPisoDst)}</td>
                  <td />
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <div className="fuente">v_cartera donde id_acreedor = COALESCE(id_nodo_padre, id_padre)</div>
      </section>
    </>
  )

  /** En el modal, el nombre abre la ficha en otro modal; en la pagina `/panel/red`, lleva a la ficha completa. */
  function Nombre({ id, nombre }: { id: string; nombre: string }) {
    return fichaEnPagina ? (
      <Link href={`${RUTA_BASE}/red/${id}`} className="enlace-pg">
        {nombre}
      </Link>
    ) : (
      <AbrirModal href={`${RUTA_BASE}/m/nodo/${id}`} titulo={nombre}>
        {nombre}
      </AbrirModal>
    )
  }

  function Acciones({ id }: { id: string }) {
    const fila = filaRed.get(id)
    if (!puedeEditar || !fila) return null
    return (
      <div className="fila-acc">
        <BotonSeguimiento id={id} />
        <BotonEditar fila={fila} />
      </div>
    )
  }
}
