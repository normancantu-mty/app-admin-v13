/**
 * «Regalos» en la ficha de un distribuidor o local: cuantas botellas le hemos
 * dado, de cuales, y cada regalo con su fecha, quien lo capturo, a que hora y por
 * que. Escrito el 2026-11-25 por el ejecutor de regalos v2 del Socio. Norman:
 * «dentro de cada una de las metricas de los distribuidores y locales debe venir
 * uno que se llame Regalos y que ahi se defina cuantos regalos les hemos dado y de
 * cuantas y de cuales».
 *
 * - Cuenta por DESTINO (`regalos.id_entidad_destino`). Cero tambien se ensena.
 * - Solo botellas, sin dinero. No toca su consignacion ni su deuda: salen de la matriz.
 * - Lo monta la ficha solo para la matriz; ademas lee con la sesion (RLS).
 * - Si la lectura falla, o falta el SQL, lo dice. La ficha no se cae y no ensena un 0 falso.
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { num } from '@/lib/v2/formato'
import { capturoTexto, desglosePorTamano, horaCapturaMx, type Cartera } from '@/lib/regalos'
import { leerRegalosDeNodo } from '@/lib/regalos-servidor'
import { esEntidadReal } from '@/lib/regalos-quien'

export function RegalosVista({ cartera, error }: { cartera: Cartera | null; error: string | null }) {
  const corto = (nombre: string) => nombre.replace(/^Destilado\s+/i, '')
  return (
    <section className="card" style={{ marginBottom: 16 }} data-testid="ficha-regalos">
      <div className="hd">
        <div>
          <h2>Regalos</h2>
          <div className="sub">Botellas que le hemos dado. Salen de la matriz: no cambian su inventario a concesión ni su deuda.</div>
        </div>
      </div>
      {error !== null || cartera === null ? (
        <div className="msg mal">No se pudieron leer los regalos: {error}</div>
      ) : !cartera.hayDestinos ? (
        <div className="msg info">Todavía no se puede contar: falta correr el SQL del destino de los regalos en la base.</div>
      ) : (
        <>
          <div className="kpis" style={{ marginBottom: 12 }}>
            <div className="kpi fuerte" data-testid="regalos-total">
              <span className="t">Regalos</span>
              <span className="v">
                {num(cartera.total.piezas)} <small style={{ fontSize: 12, fontWeight: 600 }}>{cartera.total.piezas === 1 ? 'botella' : 'botellas'}</small>
              </span>
              <span className="d">
                {num(cartera.registros.length)} {cartera.registros.length === 1 ? 'regalo' : 'regalos'}
              </span>
            </div>
            {desglosePorTamano(cartera).map((d) => (
              <div className="kpi" key={d.etiqueta}>
                <span className="t">{d.etiqueta}</span>
                <span className="v">{num(d.piezas)}</span>
              </div>
            ))}
          </div>
          {cartera.registros.length === 0 ? (
            <div className="vacio">
              <b>0 regalos</b>
            </div>
          ) : (
            <div className="tabla-w">
              <table className="t">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Piezas</th>
                    <th>Motivo</th>
                    <th>Lo regaló</th>
                    <th>Lo capturó</th>
                    <th>Capturado el (hora de México)</th>
                  </tr>
                </thead>
                <tbody>
                  {cartera.registros.map((r) => (
                    <tr key={r.id_regalo}>
                      <td className="mono">{r.fecha}</td>
                      <td>
                        {cartera.presentaciones
                          .filter((p) => (r.piezasPorProducto[p.id_producto] ?? 0) > 0)
                          .map((p) => `${num(r.piezasPorProducto[p.id_producto])} ${corto(p.producto)}`)
                          .join(' · ')}
                      </td>
                      <td>{r.motivo}</td>
                      <td>{r.quien_regalo}</td>
                      <td>{capturoTexto(r.usuario_creador) || '—'}</td>
                      <td className="mono">{horaCapturaMx(r.creado_en) || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export async function RegalosNodo({ id, nombre }: { id: string; nombre: string }) {
  // "Descuento del 30%" y "Venta mayoreo" tienen ficha pero no son un local: no llevan Regalos.
  if (!esEntidadReal(nombre)) return null
  let cartera: Cartera | null = null
  let error: string | null = null
  try {
    cartera = await leerRegalosDeNodo(await getServerSupabaseClient(), id)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  return <RegalosVista cartera={cartera} error={error} />
}
