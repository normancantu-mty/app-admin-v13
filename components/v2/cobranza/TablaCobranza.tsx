'use client'

/**
 * Cobranza v2 — tabla con filtros (banda del semaforo, a quien se le debe) y
 * busqueda por nombre. Escrito el 2026-10-30 por un ejecutor del Socio.
 * Filtra en el cliente: las filas ya vienen completas y ordenadas del servidor.
 */

import { useMemo, useState } from 'react'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { BotonEditar, BotonSeguimiento, DiasSeguimiento } from '@/components/v2/red/AccionesNodo'
import { fechaMx, mxn, num } from '@/lib/v2/formato'
import type { FilaRed } from '@/lib/v2/red-tipos'
import { BANDAS, CHIP_BANDA, NOMBRE_BANDA, textoDias, totalesPorBanda, type Banda, type FilaCobranza } from './semaforo'

export type Alcance = 'matriz' | 'dst'

const ETIQUETA: Record<Banda, string> = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde', gris: 'Sin fecha' }

/** Minusculas y sin acentos: "Dulcería" casa con "dulceria". */
function normal(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export default function TablaCobranza({
  filas,
  seguimiento,
  filasRed,
  puedeOperar,
  bandaInicial,
  alcanceInicial
}: {
  filas: FilaCobranza[]
  seguimiento: Record<string, number | null>
  filasRed: Record<string, FilaRed>
  puedeOperar: boolean
  bandaInicial: Banda | 'todas'
  alcanceInicial: Alcance
}) {
  const [alcance, setAlcance] = useState<Alcance>(alcanceInicial)
  const [banda, setBanda] = useState<Banda | 'todas'>(bandaInicial)
  const [q, setQ] = useState('')

  const deMatriz = useMemo(() => filas.filter((f) => f.acreedor === null), [filas])
  const deDst = useMemo(() => filas.filter((f) => f.acreedor !== null), [filas])
  const base = alcance === 'matriz' ? deMatriz : deDst
  const tot = useMemo(() => totalesPorBanda(base), [base])
  const total = base.reduce((a, f) => a + f.deuda, 0)
  const nunca = base.filter((f) => f.referencia !== 'ABONO')
  const visibles = useMemo(() => {
    const nq = normal(q.trim())
    return base.filter((f) => (banda === 'todas' || f.banda === banda) && (!nq || normal(f.nombre).includes(nq) || (f.acreedor && normal(f.acreedor).includes(nq))))
  }, [base, banda, q])
  const suma = (k: 'deuda' | 'generado' | 'abonado' | 'enPiso') => visibles.reduce((a, f) => a + f[k], 0)
  const esDst = alcance === 'dst'

  return (
    <>
      <div className="cob-filtros">
        <div className="tabs" role="tablist" aria-label="A quién se le debe">
          <button type="button" role="tab" aria-selected={!esDst} className={!esDst ? 'on' : ''} onClick={() => setAlcance('matriz')}>
            Le deben a la matriz · {deMatriz.length}
          </button>
          <button type="button" role="tab" aria-selected={esDst} className={esDst ? 'on' : ''} onClick={() => setAlcance('dst')} data-testid="cob-alcance-dst">
            Locales → su distribuidor · {deDst.length}
          </button>
        </div>
        <input
          className="in"
          type="search"
          placeholder="Buscar por nombre…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Buscar por nombre"
          data-testid="cob-buscar"
        />
      </div>

      <div className="cob-sem">
        <button type="button" className={`cob-banda${banda === 'todas' ? ' on' : ''}`} onClick={() => setBanda('todas')} aria-pressed={banda === 'todas'}>
          <span className="cob-banda-t">Todas</span>
          <span className="cob-banda-n">{base.length}</span>
          <span className="cob-banda-m">{mxn(total)}</span>
          <span className="cob-banda-d">{nunca.length ? `${nunca.length} nunca han abonado` : esDst ? 'no se suma a la matriz' : 'por cobrar de la matriz'}</span>
        </button>
        {BANDAS.filter((b) => b !== 'gris' || tot.gris.n > 0).map((b) => (
          <button
            type="button"
            key={b}
            className={`cob-banda ${b}${banda === b ? ' on' : ''}${tot[b].n === 0 ? ' vacia' : ''}`}
            onClick={() => setBanda(banda === b ? 'todas' : b)}
            aria-pressed={banda === b}
            data-testid={`cob-filtro-${b}`}
          >
            <span className="cob-banda-t">
              <i className={`cob-punto ${b}`} />
              {ETIQUETA[b]}
            </span>
            <span className="cob-banda-n">{tot[b].n}</span>
            <span className="cob-banda-m">{mxn(tot[b].monto)}</span>
            <span className="cob-banda-d">
              {NOMBRE_BANDA[b]}
              {total > 0 ? ` · ${Math.round((tot[b].monto / total) * 100)}%` : ''}
            </span>
          </button>
        ))}
      </div>

      {visibles.length === 0 ? (
        <div className="vacio">
          <b>{base.length === 0 ? (esDst ? 'Ningún local le debe a un distribuidor' : 'Nadie le debe a la matriz') : 'Nadie con ese filtro'}</b>
          {base.length > 0 && 'Cambia la banda o la búsqueda.'}
        </div>
      ) : (
        <div className="tabla-w">
          <table className="t cob-tabla" data-testid="cob-tabla">
            <thead>
              <tr>
                <th>#</th>
                <th>Nodo</th>
                {esDst && <th>Le debe a</th>}
                <th className="r">Deuda</th>
                <th>Sin abonar</th>
                <th>Último abono</th>
                <th className="r">Generado</th>
                <th className="r">Abonado</th>
                <th className="r">En piso</th>
                <th>Seguimiento</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibles.map((f, i) => (
                <tr key={f.id} className={f.banda}>
                  <td className="mono">{i + 1}</td>
                  <td className="cob-nombre">
                    <AbrirModal href={`/v2/m/nodo/${f.id}`} titulo={f.nombre}>
                      {f.nombre}
                    </AbrirModal>{' '}
                    <span className="chip">{f.rol === 'DST' ? 'Distribuidor' : 'Local'}</span>
                    {f.referencia !== 'ABONO' && (
                      <>
                        {' '}
                        <span className="chip">nunca abonó</span>
                      </>
                    )}
                  </td>
                  {esDst && <td>{f.acreedor}</td>}
                  <td className="r">
                    <b>{mxn(f.deuda)}</b>
                    <div className="cob-sub">{f.pct === null ? '% pagado: Sin dato' : `${f.pct}% pagado`}</div>
                    {f.pct !== null && (
                      <span className="barra">
                        <i style={{ width: `${Math.min(100, Math.max(0, f.pct))}%` }} />
                      </span>
                    )}
                  </td>
                  <td>
                    <span
                      className={`chip ${CHIP_BANDA[f.banda]}`}
                      title={f.referencia === 'ENTREGA' ? 'Contados desde la última entrega: aún no hay abonos' : 'Desde el último abono'}
                    >
                      {textoDias(f)}
                    </span>
                  </td>
                  <td>
                    {f.ultimoAbono ? (
                      <>
                        {fechaMx(f.ultimoAbono)}
                        <div className="cob-sub">{f.ultimoAbonoMonto !== null ? mxn(f.ultimoAbonoMonto) : 'monto sin dato'}</div>
                      </>
                    ) : (
                      <span className="muted">Nunca</span>
                    )}
                  </td>
                  <td className="r">{mxn(f.generado)}</td>
                  <td className="r">{mxn(f.abonado)}</td>
                  <td className="r">{num(f.enPiso)}</td>
                  <td>
                    <DiasSeguimiento dias={seguimiento[f.id] ?? null} />
                  </td>
                  <td>
                    <div className="cob-acc">
                      <AbrirModal className="btn mini" href={`/v2/m/nodo/${f.id}`} titulo={f.nombre}>
                        Ficha
                      </AbrirModal>
                      {puedeOperar && (
                        <AbrirModal className="btn mini p" href={`/v2/m/nodo/${f.id}/abono`} titulo="Registrar abono" tam="md" data-testid={`cob-abono-${f.id}`}>
                          Abono
                        </AbrirModal>
                      )}
                      {puedeOperar && filasRed[f.id] && (
                        <>
                          <BotonSeguimiento id={f.id} />
                          <BotonEditar fila={filasRed[f.id]} />
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="tot">
                <td />
                <td>
                  {visibles.length === base.length ? 'Total' : `Total filtrado (${visibles.length} de ${base.length})`}
                </td>
                {esDst && <td />}
                <td className="r">{mxn(suma('deuda'))}</td>
                <td />
                <td />
                <td className="r">{mxn(suma('generado'))}</td>
                <td className="r">{mxn(suma('abonado'))}</td>
                <td className="r">{num(suma('enPiso'))}</td>
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div className="fuente" style={{ marginTop: 10 }}>
        {esDst
          ? 'v_cartera donde id_acreedor = COALESCE(id_nodo_padre, id_padre): la cobra el distribuidor, la matriz no la suma'
          : 'v_cartera donde id_acreedor es nulo (deuda con la matriz)'}{' '}
        · último abono: finanzas_ledger ABONO_DEUDA (mismo filtro que la vista)
      </div>
    </>
  )
}
