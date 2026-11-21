/**
 * `/panel/regalos` — botellas regaladas (eventos, propaganda) y su cartera.
 * Escrito el 2026-11-20 por un ejecutor del Socio, por encargo de Norman (voz):
 * «que haya un contador, una cartera… Kevin regalo cinco grandes, cinco chicas
 * y dos minis… y que baje el inventario».
 *
 * - Ven la pagina: ADMIN, SOCIO y EMPLEADO_ADMIN (`exigirMatrizV2`).
 * - Capturan: ADMIN y EMPLEADO_ADMIN (`puedeCapturarMatriz`); la RPC lo vuelve a exigir.
 * - La cartera se lee de `v_regalo_lineas`: solo filas ACTIVO del ledger. Si un
 *   movimiento del regalo se anula en "Movimientos de inventario", deja de contar.
 * - Valor a COSTO de hoy, no a precio: un regalo no es venta. El costo es el
 *   costo completo del ERP (`v_costo_completo`, el de los margenes) y, si falta,
 *   el del catalogo. Lo que no tenga ninguno se cuenta aparte ("sin costo").
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { mxn, num } from '@/lib/v2/formato'
import { hoyMx, idMatriz, leerCartera, leerProductosRegalo, stocksDe } from '@/lib/regalos-servidor'
import type { Cartera, GrupoCartera, PresentacionCartera } from '@/lib/regalos'
import { FormRegalo, type ProductoForm } from '@/components/v2/regalos/FormRegalo'

export const dynamic = 'force-dynamic'

function corto(nombre: string): string {
  return nombre.replace(/^Destilado\s+/i, '')
}

function TablaGrupos({ titulo, grupos, pres, total, etiqueta }: {
  titulo: string
  grupos: GrupoCartera[]
  pres: PresentacionCartera[]
  total: GrupoCartera
  etiqueta: (clave: string) => string
}) {
  return (
    <section className="card">
      <div className="hd">
        <div>
          <h2>{titulo}</h2>
        </div>
      </div>
      <div className="inv-scroll" style={{ overflowX: 'auto' }}>
        <table className="t">
          <thead>
            <tr>
              <th />
              {pres.map((p) => (
                <th key={p.id_producto} className="r">
                  {corto(p.producto)}
                </th>
              ))}
              <th className="r">Piezas</th>
              <th className="r">A costo</th>
            </tr>
          </thead>
          <tbody>
            {grupos.map((g) => (
              <tr key={g.clave}>
                <td>{etiqueta(g.clave)}</td>
                {pres.map((p) => (
                  <td key={p.id_producto} className="r mono">
                    {num(g.piezasPorProducto[p.id_producto] ?? 0)}
                  </td>
                ))}
                <td className="r mono">{num(g.piezas)}</td>
                <td className="r mono">
                  {mxn(g.costo)}
                  {g.piezasSinCosto > 0 ? <small> + {num(g.piezasSinCosto)} sin costo</small> : null}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Total</b>
              </td>
              {pres.map((p) => (
                <td key={p.id_producto} className="r mono">
                  <b>{num(total.piezasPorProducto[p.id_producto] ?? 0)}</b>
                </td>
              ))}
              <td className="r mono">
                <b>{num(total.piezas)}</b>
              </td>
              <td className="r mono">
                <b>{mxn(total.costo)}</b>
                {total.piezasSinCosto > 0 ? <small> + {num(total.piezasSinCosto)} sin costo</small> : null}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** '2026-11' -> 'noviembre 2026'. */
function etiquetaMes(clave: string): string {
  const [a, m] = clave.split('-')
  const nombre = MESES[Number(m) - 1]
  return nombre ? `${nombre} ${a}` : clave
}

export default async function PaginaRegalos() {
  const usuario = await exigirMatrizV2()
  const supabase = await getServerSupabaseClient()
  const captura = puedeCapturarMatriz(usuario.rol)

  let cartera: Cartera | null = null
  let productos: ProductoForm[] = []
  let error: string | null = null
  try {
    const [c, prods, matriz] = await Promise.all([leerCartera(supabase), leerProductosRegalo(supabase), idMatriz(supabase)])
    cartera = c
    if (captura) {
      const stocks = await stocksDe(supabase, matriz.id, prods.map((p) => p.id))
      productos = prods
        .slice()
        .sort((a, b) => (Number(b.ml_por_unidad) || 0) - (Number(a.ml_por_unidad) || 0) || a.nombre.localeCompare(b.nombre))
        .map((p) => {
          const s = stocks.get(p.id) ?? { pagado: 0, consignado: 0 }
          return { id: p.id, nombre: p.nombre, hay: s.pagado + s.consignado }
        })
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <>
      <EncabezadoPagina
        titulo="Regalos"
        sub="Botellas regaladas en eventos y como propaganda: quién, cuántas, por qué. Bajan el inventario de la matriz y se valúan a costo."
      />
      {error || !cartera ? (
        <div className="msg mal">No se pudieron leer los regalos: {error}</div>
      ) : (
        <>
          {captura ? <FormRegalo productos={productos} hoy={hoyMx()} /> : null}
          {cartera.registros.length === 0 ? (
            <div className="msg info">Aún no hay regalos registrados.</div>
          ) : (
            <>
              <div className="kpis k3" style={{ marginBottom: 12 }}>
                <div className="kpi fuerte">
                  <span className="t">Piezas regaladas</span>
                  <span className="v">{num(cartera.total.piezas)}</span>
                </div>
                <div className="kpi">
                  <span className="t">Valor a costo</span>
                  <span className="v">{mxn(cartera.total.costo)}</span>
                  <small>costo completo del ERP (el de los márgenes)</small>
                </div>
                <div className="kpi">
                  <span className="t">Registros</span>
                  <span className="v">{num(cartera.registros.length)}</span>
                </div>
              </div>
              {cartera.total.piezasSinCosto > 0 ? (
                <div className="msg info">
                  {num(cartera.total.piezasSinCosto)} piezas son de productos sin costo en el ERP: no entran al valor a costo.
                </div>
              ) : null}
              <TablaGrupos titulo="Por persona" grupos={cartera.porPersona} pres={cartera.presentaciones} total={cartera.total} etiqueta={(c) => c} />
              <TablaGrupos titulo="Por mes" grupos={cartera.porMes} pres={cartera.presentaciones} total={cartera.total} etiqueta={etiquetaMes} />
              <section className="card" data-testid="lista-regalos">
                <div className="hd">
                  <div>
                    <h2>Registros</h2>
                    <div className="sub">El más reciente primero. Para corregir uno, anula sus movimientos en Inventario.</div>
                  </div>
                </div>
                <div className="inv-scroll" style={{ overflowX: 'auto' }}>
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Quién</th>
                        <th>Motivo</th>
                        <th>Piezas</th>
                        <th className="r">A costo</th>
                        <th>Capturó</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cartera.registros.map((r) => (
                        <tr key={r.id_regalo}>
                          <td className="mono">{r.fecha}</td>
                          <td>{r.quien_regalo}</td>
                          <td>{r.motivo}</td>
                          <td>
                            {cartera!.presentaciones
                              .filter((p) => (r.piezasPorProducto[p.id_producto] ?? 0) > 0)
                              .map((p) => `${num(r.piezasPorProducto[p.id_producto])} ${corto(p.producto)}`)
                              .join(' · ')}
                          </td>
                          <td className="r mono">
                            {mxn(r.costo)}
                            {r.piezasSinCosto > 0 ? <small> + {num(r.piezasSinCosto)} sin costo</small> : null}
                          </td>
                          <td>{r.usuario_creador ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="fuente">v_regalo_lineas (regalos + inventario_ledger MERMA con id_regalo, solo ACTIVO)</div>
              </section>
            </>
          )}
        </>
      )}
    </>
  )
}
