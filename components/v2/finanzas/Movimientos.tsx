/**
 * Paginas v2 — piezas de dinero compartidas por el modal de cuenta
 * (`/v2/m/cuenta/<clase>`) y la pagina completa `/v2/finanzas`. Escrito el
 * 2026-10-29 por el ejecutor del Socio: se sacaron tal cual del modal de cuenta
 * para no duplicar la tabla de movimientos ni el desglose de egresos.
 *
 * Componentes de servidor. Anular (fila o en bloque) son piezas cliente de
 * `components/v2/anular/Anular.tsx`; el servidor vuelve a decidir.
 */

import type { ReactNode } from 'react'
import { BarraAnular, BotonAnular, CasillaAnular, ProveedorSeleccion } from '@/components/v2/anular/Anular'
import { cuentaParaSaldo, type CategoriaEgreso, type MovimientoDinero } from '@/lib/v2/dinero'
import { fechaHoraMx, mxn, tipoLegible } from '@/lib/v2/formato'

/** Filas por tanda en «Cargar más» (ronda 2: no un tope fijo). */
export const TANDA = 60

/** `?filas=N` -> cuantas filas mostrar: multiplo de TANDA, minimo una tanda. */
export function filasPedidas(v: string | string[] | undefined): number {
  const n = Number.parseInt(Array.isArray(v) ? v[0] : v ?? '', 10)
  return Number.isFinite(n) && n > TANDA ? Math.ceil(n / TANDA) * TANDA : TANDA
}

export type MovimientoConEfecto = MovimientoDinero & { efecto: number }

/** Se ofrece Anular en lo que sigue vivo; el servidor vuelve a decidir. */
export function anulable(m: { status: string; tipo_movimiento: string }): boolean {
  return m.status !== 'ANULADO' && m.status !== 'CANCELADO' && m.tipo_movimiento !== 'SALDO_INICIAL'
}

/** Por que una fila va atenuada (o null si cuenta y mueve el saldo). */
function motivoAtenuada(m: MovimientoConEfecto): string | null {
  if (!cuentaParaSaldo(m)) {
    return m.status !== 'ACTIVO' && m.status !== 'APPROVED' ? `${m.status.toLowerCase()} · no cuenta para el saldo` : `${m.categoria} · no cuenta para el saldo`
  }
  return m.efecto === 0 ? 'no mueve el saldo de esta cuenta' : null
}

export function TablaMovimientos({
  movs,
  nombres,
  esAdmin,
  cuentas,
  marcada,
  pie
}: {
  movs: MovimientoConEfecto[]
  nombres: Map<string, { nombre: string; rol: string }>
  esAdmin: boolean
  /** Con varias cuentas a la vista: id -> nombre, y se pinta la columna «Cuenta». */
  cuentas?: Map<string, string>
  /** Con varias cuentas: id de la cuenta que se esta viendo; sus filas llevan una marca a la izquierda. */
  marcada?: string
  pie?: ReactNode
}) {
  const conCuenta = Boolean(cuentas)
  const columnas = 6 + (esAdmin ? 2 : 0) + (conCuenta ? 1 : 0)
  const nombreCuenta = (id: string | null) => (id && cuentas?.get(id)) || null
  return (
    <ProveedorSeleccion>
      {esAdmin && <BarraAnular tipo="finanzas" />}
      <div className="tabla-w">
        <table className="t">
          <thead>
            <tr>
              {esAdmin && <th />}
              <th>Fecha</th>
              <th>Concepto</th>
              {conCuenta && <th>Cuenta</th>}
              <th>Categoría</th>
              <th>Asignado a</th>
              <th className="r">Monto</th>
              <th>Creado por</th>
              {esAdmin && <th />}
            </tr>
          </thead>
          <tbody>
            {movs.map((m) => {
              const motivo = motivoAtenuada(m)
              const origen = nombreCuenta(m.id_cuenta_origen)
              const destino = nombreCuenta(m.id_cuenta_destino)
              return (
                <tr
                  key={m.id}
                  className={marcada && (m.id_cuenta_origen === marcada || m.id_cuenta_destino === marcada) ? 'vs-mov-on' : undefined}
                  style={motivo ? { opacity: 0.5 } : undefined}
                >
                  {esAdmin && <td>{anulable(m) ? <CasillaAnular id={m.id} /> : null}</td>}
                  <td style={{ whiteSpace: 'nowrap' }}>{fechaHoraMx(m.fecha_movimiento)}</td>
                  <td>
                    <b>{tipoLegible(m.tipo_movimiento)}</b>
                    {motivo && (
                      <div>
                        <span className="chip">{motivo}</span>
                      </div>
                    )}
                    {m.descripcion && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{m.descripcion}</div>}
                  </td>
                  {conCuenta && <td>{origen && destino ? `${origen} → ${destino}` : destino ?? origen ?? '—'}</td>}
                  <td>
                    {m.categoria ?? '—'}
                    {m.subcategoria && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{m.subcategoria}</div>}
                  </td>
                  <td>{(m.id_entidad_relacionada && nombres.get(m.id_entidad_relacionada)?.nombre) ?? 'Matriz'}</td>
                  <td className={`r ${m.efecto > 0 ? 'pos' : m.efecto < 0 ? 'neg' : ''}`}>
                    {m.efecto > 0 ? '+' : m.efecto < 0 ? '−' : ''}
                    {mxn(Math.abs(m.efecto || m.monto))}
                  </td>
                  <td className="mono">{m.usuario_creador ?? 'sin dato'}</td>
                  {esAdmin && <td>{anulable(m) ? <BotonAnular id={m.id} tipo="finanzas" /> : null}</td>}
                </tr>
              )
            })}
            {movs.length === 0 && (
              <tr>
                <td colSpan={columnas} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                  Sin movimientos
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {pie}
    </ProveedorSeleccion>
  )
}

/** «En qué se fue el dinero»: egresos por categoria y subcategoria de la lista cerrada. */
export function EgresosPorCategoria({ cats, vacio = 'Sin egresos desde el arranque' }: { cats: CategoriaEgreso[]; vacio?: string }) {
  const total = cats.reduce((a, c) => a + c.total, 0)
  if (cats.length === 0) {
    return (
      <div className="vacio">
        <b>{vacio}</b>
        El primer gasto con categoría y subcategoría aparece aquí.
      </div>
    )
  }
  return (
    <div>
      {cats.map((c) => (
        <details className="cat" key={c.categoria} open={c.fuera}>
          <summary>
            <span className={c.fuera ? 'neg' : undefined}>
              {c.categoria} <small style={{ color: 'var(--muted)', fontWeight: 500 }}>({c.movimientos} mov.)</small>
            </span>
            <span>{mxn(c.total)}</span>
          </summary>
          {c.subcategorias.map((s) => (
            <div className="subl" key={s.subcategoria}>
              <span>{s.subcategoria}</span>
              <span>{mxn(s.total)}</span>
            </div>
          ))}
        </details>
      ))}
      <div className="subl" style={{ paddingLeft: 0, fontWeight: 800, color: 'var(--ink)' }}>
        <span>Total de egresos</span>
        <span>{mxn(total)}</span>
      </div>
    </div>
  )
}
