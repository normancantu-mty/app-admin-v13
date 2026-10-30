/**
 * Cobranza v2 — la card "A quién cobrar" del panel de la matriz. Escrito el
 * 2026-10-30 por un ejecutor del Socio (encargo de Norman: "a quiénes falta
 * cobrarles y los saldos pendientes, con semáforo por tiempo sin abonar, y que
 * desde el panel se pueda entrar al detalle de cada distribuidor").
 *
 * 2026-10-30 (mismo dia, otro ejecutor del Socio; Norman: "que muestre un poquito
 * más de detalle, y que si está en números rojos también lo muestre, que resalte
 * más"): reparto del total por banda (barra apilada + % y deudores por banda),
 * fila expandible con el detalle del deudor (ultimo abono, ultima entrega,
 * generado vs abonado, piezas en piso, antiguedad) y el rojo resaltado: aviso en
 * la cabecera, banda roja con fondo, filas rojas con fondo y borde, monto en rojo.
 * Bandas, umbrales y orden: sin cambio.
 *
 * Componente de servidor. Recibe `v_cartera` ya leida por el panel (no la vuelve
 * a pedir) y lee aparte, EN PARALELO, el monto del ultimo abono y la fecha de la
 * ultima entrega.
 *
 * Decidido: la lista es la deuda CON LA MATRIZ (igual que "Por cobrar (matriz)").
 * La deuda de un local con su distribuidor no se suma ni se lista aqui: va en una
 * linea aparte que abre la vista completa en esa pestaña (la cobra el DST; sumarla
 * contaria dos veces, ver `esDeudaConLaMatriz`).
 */

import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { getServerSupabaseClient } from '@/lib/server-session'
import { esDeudaConLaMatriz, type FilaCarteraVista } from '@/lib/vistas'
import { fechaMx, mxn0, num } from '@/lib/v2/formato'
import { armarFilasCobranza, leerMontosUltimoAbono, leerUltimasEntregas } from './leer'
import { BANDAS, CHIP_BANDA, NOMBRE_BANDA, pctPorBanda, textoDias, totalesPorBanda } from './semaforo'

const ETIQUETA: Record<string, string> = { rojo: 'Rojo', amarillo: 'Amarillo', verde: 'Verde', gris: 'Sin fecha' }

/** Una cifra negativa se pinta en rojo. */
const neg = (n: number | null | undefined) => (n !== null && n !== undefined && n < 0 ? ' neg' : '')

const deudores = (n: number) => `${n} ${n === 1 ? 'deudor' : 'deudores'}`

export async function CardCobranza({ cartera }: { cartera: FilaCarteraVista[] }) {
  const client = await getServerSupabaseClient()
  const matriz = cartera.filter((f) => esDeudaConLaMatriz(f))
  const ids = matriz.filter((f) => Number(f.deuda) > 0).map((f) => f.id_entidad)
  const [montos, entregas] = await Promise.all([leerMontosUltimoAbono(client, matriz), leerUltimasEntregas(client, ids)])
  const filas = armarFilasCobranza(matriz, montos, undefined, entregas)
  const tot = totalesPorBanda(filas)
  const pct = pctPorBanda(tot)
  const total = filas.reduce((a, f) => a + f.deuda, 0)
  const nunca = filas.filter((f) => f.referencia !== 'ABONO')
  const conDst = cartera.filter((f) => !esDeudaConLaMatriz(f) && Number(f.deuda) > 0)
  const deudaConDst = conDst.reduce((a, f) => a + Number(f.deuda), 0)
  const bandas = BANDAS.filter((b) => b !== 'gris' || tot.gris.n > 0)
  const hayRojo = tot.rojo.n > 0

  return (
    <section className={`card cobrar cob-card${hayRojo ? ' cob-hay-rojo' : ''}`} data-testid="card-cobranza">
      <div className="hd">
        <div>
          <h2>A quién cobrar</h2>
          <div className="sub">Deuda con la matriz · orden del ERP: deuda × días sin abonar</div>
        </div>
        {hayRojo && (
          <AbrirModal
            className="cob-alerta"
            href="/v2/m/cobranza?banda=rojo"
            titulo="Cobranza"
            tam="xl"
            title={`${NOMBRE_BANDA.rojo} sin abonar`}
            data-testid="cob-alerta-rojo"
          >
            <i className="cob-punto rojo" />
            {tot.rojo.n} en rojo · {mxn0(tot.rojo.monto)}
          </AbrirModal>
        )}
      </div>

      <div className="cob-total">
        <span className={`cob-total-v${neg(total)}`}>{mxn0(total)}</span>
        <span className="muted">
          pendiente · {deudores(filas.length)}
          {nunca.length > 0 && <> · {nunca.length} nunca han abonado</>}
        </span>
      </div>

      {total > 0 && (
        <div className="cob-reparto" role="img" aria-label={bandas.map((b) => `${ETIQUETA[b]} ${Math.round(pct[b])}%`).join(', ')}>
          {bandas
            .filter((b) => tot[b].monto > 0)
            .map((b) => (
              <i key={b} className={b} style={{ width: `${pct[b]}%` }} title={`${ETIQUETA[b]}: ${mxn0(tot[b].monto)} (${Math.round(pct[b])}%)`} />
            ))}
        </div>
      )}

      <div className="cob-sem">
        {bandas.map((b) => (
          <AbrirModal
            key={b}
            href={`/v2/m/cobranza?banda=${b}`}
            titulo="Cobranza"
            tam="xl"
            className={`cob-banda ${b}${tot[b].n === 0 ? ' vacia' : ''}${b === 'rojo' && tot[b].n > 0 ? ' alerta' : ''}`}
            title={`${NOMBRE_BANDA[b]} sin abonar`}
            data-testid={`cob-banda-${b}`}
          >
            <span className="cob-banda-t">
              <i className={`cob-punto ${b}`} />
              {ETIQUETA[b]}
            </span>
            <span className="cob-banda-n">{tot[b].n}</span>
            <span className="cob-banda-m">{mxn0(tot[b].monto)}</span>
            <span className="cob-banda-p">{Math.round(pct[b])}% del total</span>
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
            <details className={`cob-fila ${f.banda}`} key={f.id} data-testid={`cob-fila-${f.banda}`}>
              <summary className={`cob-it ${f.banda}`}>
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
                <span className={`cob-m${neg(f.deuda)}`}>
                  {mxn0(f.deuda)}
                  <small>{f.pct === null ? '% pagado: Sin dato' : `${f.pct}% pagado`}</small>
                  {f.pct !== null && (
                    <span className="barra">
                      <i style={{ width: `${Math.min(100, Math.max(0, f.pct))}%` }} />
                    </span>
                  )}
                </span>
              </summary>
              <div className="cob-det">
                <dl>
                  <div>
                    <dt>Último abono</dt>
                    <dd>
                      {f.ultimoAbono ? (
                        <>
                          {fechaMx(f.ultimoAbono)}
                          {f.ultimoAbonoMonto !== null && <b className={neg(f.ultimoAbonoMonto)}> · {mxn0(f.ultimoAbonoMonto)}</b>}
                        </>
                      ) : (
                        'Nunca'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Última entrega</dt>
                    <dd>{f.ultimaEntrega ? fechaMx(f.ultimaEntrega) : 'Sin entregas a concesión'}</dd>
                  </div>
                  <div>
                    <dt>Generado · abonado</dt>
                    <dd>
                      <span className={neg(f.generado)}>{mxn0(f.generado)}</span> · <span className={neg(f.abonado)}>{mxn0(f.abonado)}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Piezas en piso</dt>
                    <dd>
                      <span className={neg(f.enPiso)}>{num(f.enPiso)}</span> de {num(f.recibidas)} recibidas
                    </dd>
                  </div>
                  <div>
                    <dt>Antigüedad</dt>
                    <dd>
                      {f.dias === null ? 'Sin fecha de referencia' : `${f.dias} días ${f.referencia === 'ABONO' ? 'desde el último abono' : 'desde la última entrega'}`}
                      <span className={`chip ${CHIP_BANDA[f.banda]}`}>{ETIQUETA[f.banda]}</span>
                    </dd>
                  </div>
                </dl>
                <AbrirModal className="cob-ficha-l" href={`/v2/m/nodo/${f.id}`} titulo={f.nombre}>
                  Abrir ficha de {f.nombre} ›
                </AbrirModal>
              </div>
            </details>
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
      <div className="fuente">v_cartera (id_acreedor = matriz) · último abono: finanzas_ledger ABONO_DEUDA · última entrega: inventario_ledger ENTRADA_CONCESION</div>
    </section>
  )
}
