/**
 * Paridad v2 — el panel de un DST o un LOC (Q16: aterrizan en SU vista de /panel,
 * no en /dashboard). Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Es su propia ficha (las tres cifras, la concesion, sus movimientos y sus
 * capturas) mas, para un DST, sus locales con sus cifras: tocar uno abre su ficha
 * en un modal (T72: «da click y se abre el panel con la info del local»). «Lo que
 * he ganado» reemplaza a «Piezas según el sistema» (T72).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { getServerSupabaseClient } from '@/lib/server-session'
import { leerFichaNodo } from '@/lib/v2/nodo'
import { leerRed } from '@/lib/v2/red'
import { mxn } from '@/lib/v2/formato'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { FichaVista } from '@/components/v2/nodo/FichaVista'
import { DiasSeguimiento } from '@/components/v2/red/AccionesNodo'

export async function PanelNodo() {
  const usuario = await exigirSesionV2()
  const ficha = await leerFichaNodo(usuario.id, usuario)
  if (!ficha) {
    return (
      <div className="vacio" style={{ marginTop: 24 }}>
        <b>Tu rol ({usuario.rol}) no tiene una vista en este panel.</b>
        Pide a la matriz que revise tu acceso.
      </div>
    )
  }
  const esDst = usuario.rol === 'DST'
  const locales = esDst ? (await leerRed(await getServerSupabaseClient(), usuario)).filter((f) => f.rol === 'LOC') : []

  return (
    <>
      <div className="ph">
        <div>
          <h1>{ficha.entidad.nombre}</h1>
          <p>{esDst ? 'Tu panel de distribuidor' : 'Tu panel'}</p>
        </div>
      </div>

      <div className="acciones">
        <span className="lbl">ABRIR</span>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/precios`} titulo="Precios para mí">
          Precios para mí
        </AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/ventas`} titulo="Mis ventas">
          Mis ventas
        </AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/avisos`} titulo="Avisos" tam="md">
          Avisos
        </AbrirModal>
      </div>
      {/* Paginas v2 (2026-10-29): el apartado completo, como pagina. */}
      <div className="acciones" data-testid="panel-ver-todo">
        <span className="lbl">VER TODO</span>
        {esDst && <VerTodo href={`${RUTA_BASE}/red`}>Mi red →</VerTodo>}
        <VerTodo href={`${RUTA_BASE}/catalogo`}>Mis precios →</VerTodo>
      </div>

      <FichaVista ficha={ficha} usuario={usuario} propia />

      {esDst && (
        <section className="card" style={{ marginTop: 16 }} data-testid="mis-locales">
          <div className="hd">
            <div>
              <h2>Mis locales</h2>
              <div className="sub">Toca uno para abrir su ficha: cifras, concesión y movimientos.</div>
            </div>
          </div>
          {locales.length === 0 ? (
            <div className="vacio">
              <b>Aún no tienes locales</b>
              Da de alta el primero con «+ Alta de local».
            </div>
          ) : (
            <div className="tabla-w">
              <table className="t">
                <thead>
                  <tr>
                    <th>Local</th>
                    <th>Zona</th>
                    <th className="r">Saldo pendiente</th>
                    <th className="r">Por pagar (efectivo)</th>
                    <th>Seguimiento</th>
                  </tr>
                </thead>
                <tbody>
                  {locales.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <AbrirModal href={`${RUTA_BASE}/m/nodo/${l.id}`} titulo={l.nombre} className="enlace">
                          <b style={{ color: 'var(--chile)' }}>{l.nombre}</b>
                        </AbrirModal>
                      </td>
                      <td>{l.zona}</td>
                      <td className="r">{mxn(l.saldoPendiente)}</td>
                      <td className="r">{mxn(l.saldoPorPagar)}</td>
                      <td>
                        <DiasSeguimiento dias={l.diasSeguimiento} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  )
}
