/**
 * Lotes v2 — detalle de un lote (Server Component). Escrito el 2026-10-30 por el
 * ejecutor del Socio. Todo lo derivado (kg de chile, litros, grado ponderado,
 * L/kg, costo, $/ml, merma, litros al grado objetivo) sale de `v_lote_rendimiento`
 * (D-198): aqui no se recalcula nada, solo se muestra. Lo crudo (insumos, tandas,
 * envasado, etapas) sale de sus tablas.
 */

import { fechaHoraParaPersona, fechaParaPersona } from '@/lib/fechas'
import { mxn } from '@/lib/v2/formato'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { cant, cant2 } from '@/components/v2/inventario/formato-inv'
import type { DetalleLote as Detalle } from './datos'
import { CHIP_ESTADO, ETIQUETA_ESTADO } from './estado'

const n = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v))
const grado = (v: number | null | undefined) => (n(v) === null ? '—' : `${n(v)!.toFixed(1)}°`)
const pesos4 = (v: number | null | undefined) => (n(v) === null ? '—' : `$${n(v)!.toFixed(4)}`)
const pct = (v: number | null | undefined) => (n(v) === null ? '—' : `${(n(v)! * 100).toFixed(1)}%`)

const ETAPA: Record<string, string> = { aditivo_2: 'Segundo aditivo', destilacion: 'Destilación', muestra: 'Muestra' }

function resumenDatos(datos: Record<string, unknown> | null): string {
  if (!datos) return ''
  return Object.entries(datos)
    .filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object')
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${String(v)}`)
    .join(' · ')
}

export default function DetalleLote({ lote, puedeEditar }: { lote: Detalle; puedeEditar: boolean }) {
  const { cabecera: c, resumen: r, entradas, salidas, envasado, etapas, errores } = lote
  const avisos: string[] = []
  if (r?.faltan_costo) avisos.push(`Sin costo en el catálogo: ${r.faltan_costo}. El costo del lote está incompleto.`)
  if (n(r?.tandas_sin_grado)) avisos.push(`${n(r?.tandas_sin_grado)} tanda(s) sin grado: el rendimiento y el $/ml no las cuentan.`)
  if (r?.alcanza_el_grado_diluyendo === false) avisos.push(`El grado ponderado no alcanza el objetivo de ${grado(r.grado_objetivo)} ni diluyendo.`)

  return (
    <div className="lote-detalle" data-testid="lote-detalle">
      <div className="inv-barra">
        <div className="fila-acc">
          {r ? <span className={`chip ${CHIP_ESTADO[r.estado]}`}>{ETIQUETA_ESTADO[r.estado]}</span> : null}
          <span className="inv-sub">
            Inicio <b>{fechaParaPersona(c.fecha_inicio)}</b>
            {c.fecha_fin_fermentacion ? (
              <>
                {' '}· fin <b>{fechaParaPersona(c.fecha_fin_fermentacion)}</b>
              </>
            ) : null}
            {r ? (
              <>
                {' '}· <b>{r.dias}</b> días{r.diasEnCurso ? ' (en curso)' : ''}
              </>
            ) : null}
            {n(c.horas_fermentacion) !== null ? ` · ${cant2(c.horas_fermentacion)} h` : ''}
            {n(c.brix_chile) !== null ? ` · Brix chile ${cant2(c.brix_chile)}` : ''}
            {n(c.brix_final) !== null ? ` · Brix final ${cant2(c.brix_final)}` : ''}
          </span>
        </div>
        {puedeEditar ? (
          <AbrirModal href={`/v2/m/lote/${c.id}/editar`} titulo={`Editar ${c.codigo_lote}`} tam="lg" className="btn p" data-testid="lote-editar">
            Editar lote
          </AbrirModal>
        ) : null}
      </div>

      {errores.length > 0 && <div className="msg mal">Parte del lote no se pudo leer: {errores.join(' · ')}</div>}
      {avisos.map((a) => (
        <div key={a} className="msg info">
          {a}
        </div>
      ))}

      {r ? (
        <div className="kpis lote-kpis">
          <div className="kpi fuerte">
            <div className="t">Chile</div>
            <div className="v">{cant2(r.kg_chile)} kg</div>
            <div className="d">{n(r.litros_por_kg_chile) === null ? 'L/kg —' : <><b>{n(r.litros_por_kg_chile)!.toFixed(3)}</b> L por kg</>}</div>
          </div>
          <div className="kpi">
            <div className="t">Litros</div>
            <div className="v">{cant2(r.litros_producidos)} L</div>
            <div className="d"><b>{cant(r.tandas)}</b> tanda(s)</div>
          </div>
          <div className="kpi">
            <div className="t">Grado ponderado</div>
            <div className="v">{grado(r.grado_ponderado)}</div>
            <div className="d">{n(r.alcohol_absoluto_l) === null ? 'alcohol absoluto —' : <><b>{cant2(r.alcohol_absoluto_l)}</b> L de alcohol absoluto</>}</div>
          </div>
          <div className="kpi">
            <div className="t">Al grado objetivo</div>
            <div className="v">{n(r.litros_al_grado_objetivo) === null ? '—' : `${cant2(r.litros_al_grado_objetivo)} L`}</div>
            <div className="d">a {grado(r.grado_objetivo)} · <b>{cant(r.botellas_750_teoricas)}</b> botellas de 750 ml teóricas</div>
          </div>
          <div className="kpi">
            <div className="t">Costo de insumos</div>
            <div className="v">{n(r.costo_insumos_conocido) === null ? '—' : mxn(n(r.costo_insumos_conocido)!)}</div>
            <div className="d">{n(r.insumos_sin_costo) ? <><b>{n(r.insumos_sin_costo)}</b> insumo(s) sin costo</> : 'costo del catálogo'}</div>
          </div>
          <div className="kpi">
            <div className="t">Costo por ml</div>
            <div className="v">{pesos4(r.costo_por_ml)}</div>
            <div className="d">al grado objetivo <b>{pesos4(r.costo_por_ml_al_grado_objetivo)}</b></div>
          </div>
          <div className="kpi">
            <div className="t">Botellas</div>
            <div className="v">{cant(r.botellas)}</div>
            <div className="d"><b>{cant2(n(r.ml_envasados) === null ? null : n(r.ml_envasados)! / 1000)}</b> L envasados</div>
          </div>
          <div className="kpi">
            <div className="t">Merma de envasado</div>
            <div className="v">{pct(r.merma_envasado)}</div>
            <div className="d">litros destilados contra envasados</div>
          </div>
        </div>
      ) : (
        <div className="msg info">Este lote no tiene fila en v_lote_rendimiento: sin rendimiento que mostrar.</div>
      )}

      <div className="grid g2 lote-tablas">
        <div>
          <h4 className="lote-h">Insumos</h4>
          {entradas.length === 0 ? (
            <div className="vacio"><b>Sin insumos</b></div>
          ) : (
            <div className="inv-scroll">
              <table className="t inv-t">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="r">Cantidad</th>
                    <th className="r inv-opc">Costo</th>
                  </tr>
                </thead>
                <tbody>
                  {entradas.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <b>{e.nombre}</b>
                        {e.sku ? <div className="inv-sub mono">{e.sku}</div> : null}
                      </td>
                      <td className="r">
                        {cant(e.cantidad)} <span className="inv-sub">{e.unidad}</span>
                      </td>
                      <td className="r inv-opc">{e.costo_unitario === null ? <span className="chip warn">sin costo</span> : mxn(e.costo_unitario * e.cantidad)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h4 className="lote-h">Tandas</h4>
          {salidas.length === 0 ? (
            <div className="vacio"><b>Sin tandas</b>El lote sigue fermentando o no se ha destilado.</div>
          ) : (
            <div className="inv-scroll">
              <table className="t inv-t">
                <thead>
                  <tr>
                    <th>#</th>
                    <th className="r">Litros</th>
                    <th className="r">Grado</th>
                    <th className="r inv-opc">Peso kg</th>
                    <th className="inv-opc-lg">Notas</th>
                  </tr>
                </thead>
                <tbody>
                  {salidas.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.numero_tanda}</td>
                      <td className="r">{cant2(s.litros)}</td>
                      <td className="r">{s.grado_alcohol === null ? <span className="chip warn">sin grado</span> : grado(s.grado_alcohol)}</td>
                      <td className="r inv-opc">{cant2(s.peso_kg)}</td>
                      <td className="inv-opc-lg inv-sub">{s.notas ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {(envasado.length > 0 || etapas.length > 0) && (
        <div className="grid g2 lote-tablas">
          <div>
            <h4 className="lote-h">Envasado ligado al lote</h4>
            {envasado.length === 0 ? (
              <div className="vacio"><b>Sin envasado ligado</b>El envasado diario se registra con «Envasar».</div>
            ) : (
              <div className="inv-scroll">
                <table className="t inv-t">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Producto</th>
                      <th className="r">Botellas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {envasado.map((v) => (
                      <tr key={v.id}>
                        <td className="inv-fecha">{fechaParaPersona(v.fecha)}</td>
                        <td>
                          {v.nombre}
                          {v.ml_por_unidad ? <span className="inv-sub"> · {v.ml_por_unidad} ml</span> : null}
                        </td>
                        <td className="r">{cant(v.botellas)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h4 className="lote-h">Etapas (bot)</h4>
            {etapas.length === 0 ? (
              <div className="vacio"><b>Sin etapas</b>Las registra el bot (segundo aditivo, destilación, muestras).</div>
            ) : (
              <div className="inv-scroll">
                <table className="t inv-t">
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Etapa</th>
                      <th className="inv-opc">Datos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {etapas.map((e) => (
                      <tr key={e.id}>
                        <td className="inv-fecha">{fechaParaPersona(e.fecha)}</td>
                        <td>
                          <b>{ETAPA[e.etapa] ?? e.etapa}</b>
                          <div className="inv-sub">{e.registrado_por}</div>
                        </td>
                        <td className="inv-opc inv-sub">{resumenDatos(e.datos)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {c.notas ? <div className="msg info">Notas: {c.notas}</div> : null}
      <div className="inv-pie">
        <span>
          Creado por {c.usuario_creador} · {fechaHoraParaPersona(c.creado_en)} · v_lote_rendimiento
        </span>
      </div>
    </div>
  )
}
