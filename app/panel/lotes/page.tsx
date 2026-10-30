/**
 * Lotes v2 — `/panel/lotes`: el apartado completo de lotes. Escrito el 2026-10-30
 * por el ejecutor del Socio. Lista con estado (en fermentacion / terminado /
 * envasado), filtro por estado, clic en el codigo abre el detalle en modal, y
 * ADMIN tiene «Nuevo lote». ADMIN y SOCIO lo ven; SOCIO sin botones de captura.
 *
 * El rendimiento sale de `v_lote_rendimiento` (D-198). FALLA CERRADA: si la
 * lectura falla se dice, no se pinta una lista vacia.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import Link from 'next/link'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { fechaParaPersona } from '@/lib/fechas'
import { mxn } from '@/lib/v2/formato'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { EncabezadoPagina, VerTodo } from '@/components/v2/pagina/Encabezado'
import { cant, cant2 } from '@/components/v2/inventario/formato-inv'
import { leerLotes } from '@/components/v2/lotes/datos'
import { CHIP_ESTADO, ESTADOS_LOTE, ETIQUETA_ESTADO, esEstadoLote } from '@/components/v2/lotes/estado'

export const dynamic = 'force-dynamic'

export default async function LotesV2({ searchParams }: { searchParams: Promise<{ estado?: string | string[] }> }) {
  const usuario = await exigirMandoV2()
  const captura = puedeCapturarMatriz(usuario.rol)
  const sp = await searchParams
  const eq = Array.isArray(sp.estado) ? sp.estado[0] : sp.estado
  const estado = esEstadoLote(eq) ? eq : null

  const { lotes, error } = await leerLotes()
  const visibles = estado ? lotes.filter((l) => l.estado === estado) : lotes
  const cuenta = (e: string) => lotes.filter((l) => l.estado === e).length
  const suma = (xs: (number | null)[]) => xs.reduce<number>((a, x) => a + Number(x ?? 0), 0)
  const litros = suma(lotes.map((l) => l.litros_producidos))
  const botellas = suma(lotes.map((l) => l.botellas))
  const fermentando = lotes.filter((l) => l.estado === 'fermentacion')

  return (
    <>
      <EncabezadoPagina
        titulo="Lotes"
        sub="Fermentación, destilación y envasado por lote · rendimiento y costo de v_lote_rendimiento"
        acciones={
          <>
            {captura ? (
              <AbrirModal className="btn p" href={`${RUTA_BASE}/m/lote/nuevo`} titulo="Nuevo lote" tam="lg" data-testid="lotes-nuevo">
                + Nuevo lote
              </AbrirModal>
            ) : null}
            <VerTodo href={`${RUTA_BASE}/inventario`} className="btn">
              Inventario →
            </VerTodo>
          </>
        }
      />

      <section className="card">
        {error ? (
          <div className="msg mal">No se pudieron leer los lotes: {error}</div>
        ) : (
          <>
            <div className="kpis inv-kpis">
              <div className="kpi fuerte">
                <div className="t">Lotes</div>
                <div className="v">{lotes.length}</div>
                <div className="d">
                  <b>{cant2(litros)}</b> L destilados en total
                </div>
              </div>
              <div className="kpi">
                <div className="t">En fermentación</div>
                <div className="v">{cuenta('fermentacion')}</div>
                <div className="d">{fermentando.length ? <>el más viejo lleva <b>{Math.max(...fermentando.map((l) => l.dias))}</b> días</> : 'ninguno fermentando'}</div>
              </div>
              <div className="kpi">
                <div className="t">Terminados</div>
                <div className="v">{cuenta('terminado')}</div>
                <div className="d">destilados, sin botellas ligadas</div>
              </div>
              <div className="kpi">
                <div className="t">Envasados</div>
                <div className="v">{cuenta('envasado')}</div>
                <div className="d">
                  <b>{cant(botellas)}</b> botellas ligadas a lote
                </div>
              </div>
            </div>

            <div className="inv-filtros">
              <div className="seg" role="group" aria-label="Estado">
                {[{ v: null, l: 'Todos', n: lotes.length }, ...ESTADOS_LOTE.map((e) => ({ v: e, l: ETIQUETA_ESTADO[e], n: cuenta(e) }))].map((o) => (
                  <Link
                    key={o.v ?? 'todos'}
                    href={o.v ? `${RUTA_BASE}/lotes?estado=${o.v}` : `${RUTA_BASE}/lotes`}
                    replace
                    scroll={false}
                    className={estado === o.v ? 'on' : ''}
                    style={{ padding: '7px 12px', fontWeight: 600 }}
                  >
                    {o.l} <span className="inv-cuenta">{o.n}</span>
                  </Link>
                ))}
              </div>
            </div>

            {visibles.length === 0 ? (
              <div className="vacio" data-testid="lotes-vacio">
                <b>{lotes.length === 0 ? 'Aún no hay lotes registrados' : 'Ningún lote en este estado'}</b>
                {lotes.length === 0 ? 'Se registran por el bot o con «Nuevo lote».' : ''}
              </div>
            ) : (
              <div className="inv-scroll lote-scroll">
                <table className="t inv-t" data-testid="tabla-lotes-pagina">
                  <thead>
                    <tr>
                      <th>Lote</th>
                      <th>Estado</th>
                      <th className="r">Días</th>
                      <th className="r inv-opc">Chile kg</th>
                      <th className="r">Litros</th>
                      <th className="r inv-opc">Grado</th>
                      <th className="r inv-opc-lg">L/kg</th>
                      <th className="r inv-opc">Botellas</th>
                      <th className="r inv-opc-lg">Costo insumos</th>
                      <th className="r inv-opc-lg">$/ml</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibles.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <AbrirModal href={`${RUTA_BASE}/m/lote/${l.id}`} titulo={`Lote ${l.codigo_lote}`} tam="xl" className="enlace-pg">
                            <b>{l.codigo_lote}</b>
                          </AbrirModal>
                          <div className="inv-sub">Inicio {fechaParaPersona(l.fecha_inicio)}</div>
                          <div className="inv-sub inv-solo-chico">
                            {cant2(l.kg_chile)} kg · {l.grado_ponderado === null ? 'sin grado' : `${Number(l.grado_ponderado).toFixed(1)}°`} · {cant(l.botellas)} bot.
                          </div>
                        </td>
                        <td>
                          <span className={`chip ${CHIP_ESTADO[l.estado]}`}>{ETIQUETA_ESTADO[l.estado]}</span>
                          {l.faltan_costo ? <span className="chip warn" title={`Sin costo: ${l.faltan_costo}`}>costo incompleto</span> : null}
                        </td>
                        <td className="r">
                          {l.dias}
                          {l.diasEnCurso ? <span className="inv-sub"> en curso</span> : null}
                        </td>
                        <td className="r inv-opc">{cant2(l.kg_chile)}</td>
                        <td className="r">{cant2(l.litros_producidos)}</td>
                        <td className="r inv-opc">{l.grado_ponderado === null ? '—' : `${Number(l.grado_ponderado).toFixed(1)}°`}</td>
                        <td className="r inv-opc-lg">{l.litros_por_kg_chile === null ? '—' : Number(l.litros_por_kg_chile).toFixed(3)}</td>
                        <td className="r inv-opc">{cant(l.botellas)}</td>
                        <td className="r inv-opc-lg">{l.costo_insumos_conocido === null ? '—' : mxn(Number(l.costo_insumos_conocido))}</td>
                        <td className="r inv-opc-lg">{l.costo_por_ml === null ? '—' : `$${Number(l.costo_por_ml).toFixed(4)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="inv-pie">
              <span>
                Mostrando {visibles.length} de {lotes.length} · v_lote_rendimiento · el envasado diario (no ligado) vive en Inventario
              </span>
            </div>
          </>
        )}
      </section>
    </>
  )
}
