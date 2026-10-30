/**
 * Cobranza v2 — la card "A quién cobrar" del panel de la matriz. Escrito el
 * 2026-10-30 por un ejecutor del Socio (encargo de Norman: "a quiénes falta
 * cobrarles y los saldos pendientes, con semáforo por tiempo sin abonar, y que
 * desde el panel se pueda entrar al detalle de cada distribuidor").
 *
 * Componente de servidor. Recibe `v_cartera` ya leida por el panel (no la vuelve
 * a pedir) y solo lee aparte el monto del ultimo abono.
 *
 * Decidido: la lista es la deuda CON LA MATRIZ (igual que "Por cobrar (matriz)").
 * La deuda de un local con su distribuidor no se suma ni se lista aqui: va en una
 * linea aparte que abre la vista completa en esa pestaña (la cobra el DST; sumarla
 * contaria dos veces, ver `esDeudaConLaMatriz`).
 */

import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { getServerSupabaseClient } from '@/lib/server-session'
import { esDeudaConLaMatriz, type FilaCarteraVista } from '@/lib/vistas'
import { fechaMx, mxn0 } from '@/lib/v2/formato'
import { armarFilasCobranza, leerMontosUltimoAbono } from './leer'
import { BANDAS, CHIP_BANDA, NOMBRE_BANDA, textoDias, totalesPorBanda } from './semaforo'

const ETIQUETA: Record<string, string> = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde', gris: 'Sin fecha' }

export async function CardCobranza({ cartera }: { cartera: FilaCarteraVista[] }) {
  const client = await getServerSupabaseClient()
  const matriz = cartera.filter((f) => esDeudaConLaMatriz(f))
  const montos = await leerMontosUltimoAbono(client, matriz)
  const filas = armarFilasCobranza(matriz, montos)
  const tot = totalesPorBanda(filas)
  const total = filas.reduce((a, f) => a + f.deuda, 0)
  const nunca = filas.filter((f) => f.referencia !== 'ABONO')
  const conDst = cartera.filter((f) => !esDeudaConLaMatriz(f) && Number(f.deuda) > 0)
  const deudaConDst = conDst.reduce((a, f) => a + Number(f.deuda), 0)

  return (
    <section className="card cobrar cob-card" data-testid="card-cobranza">
      <div className="hd">
        <div>
          <h2>A quién cobrar</h2>
          <div className="sub">Deuda con la matriz · orden del ERP: deuda × días sin abonar</div>
        </div>
      </div>

      <div className="cob-total">
        <span className="cob-total-v">{mxn0(total)}</span>
        <span className="muted">
          pendiente · {filas.length} {filas.length === 1 ? 'deudor' : 'deudores'}
          {nunca.length > 0 && <> · {nunca.length} nunca han abonado</>}
        </span>
      </div>

      <div className="cob-sem">
        {BANDAS.filter((b) => b !== 'gris' || tot.gris.n > 0).map((b) => (
          <AbrirModal
            key={b}
            href={`/v2/m/cobranza?banda=${b}`}
            titulo="Cobranza"
            tam="xl"
            className={`cob-banda ${b}${tot[b].n === 0 ? ' vacia' : ''}`}
            title={`${NOMBRE_BANDA[b]} sin abonar`}
            data-testid={`cob-banda-${b}`}
          >
            <span className="cob-banda-t">
              <i className={`cob-punto ${b}`} />
              {ETIQUETA[b]}
            </span>
            <span className="cob-banda-n">{tot[b].n}</span>
            <span className="cob-banda-m">{mxn0(tot[b].monto)}</span>
          </AbrirModal>
        ))}
      </div>

      {filas.length === 0 ? (
        <div className="vacio">
          <b>Nadie le debe a la matriz</b>
        </div>
      ) : (
        <div className="cob-lista" data-testid="cob-lista">
          {filas.map((f, i) => (
            <AbrirModal className={`cob-it ${f.banda}`} key={f.id} href={`/v2/m/nodo/${f.id}`} titulo={f.nombre}>
              <span className="cob-n">{i + 1}</span>
              <span className="cob-nom">
                <b>{f.nombre}</b>
                <span className="cob-meta">
                  <span className="chip">{f.rol}</span>
                  <span className={`chip ${CHIP_BANDA[f.banda]}`}>{textoDias(f)}</span>
                </span>
                <small className="muted">
                  {f.ultimoAbono
                    ? `Último abono ${fechaMx(f.ultimoAbono)}${f.ultimoAbonoMonto !== null ? ` · ${mxn0(f.ultimoAbonoMonto)}` : ''}`
                    : 'Nunca ha abonado'}
                </small>
              </span>
              <span className="cob-m">
                {mxn0(f.deuda)}
                <small>{f.pct === null ? '% pagado: Sin dato' : `${f.pct}% pagado`}</small>
                {f.pct !== null && (
                  <span className="barra">
                    <i style={{ width: `${Math.min(100, Math.max(0, f.pct))}%` }} />
                  </span>
                )}
              </span>
            </AbrirModal>
          ))}
        </div>
      )}

      {conDst.length > 0 && (
        <AbrirModal className="cob-dst" href="/v2/m/cobranza?alcance=dst" titulo="Cobranza" tam="xl">
          + {conDst.length} {conDst.length === 1 ? 'local le debe' : 'locales le deben'} {mxn0(deudaConDst)} a su distribuidor (no se suma) ›
        </AbrirModal>
      )}
      <AbrirModal className="vermas" href="/v2/m/cobranza" titulo="Cobranza" tam="xl" data-testid="cob-ver-todo">
        Cobranza completa: filtros y abonos →
      </AbrirModal>
      <div className="fuente">v_cartera (id_acreedor = matriz) · último abono: finanzas_ledger ABONO_DEUDA</div>
    </section>
  )
}
