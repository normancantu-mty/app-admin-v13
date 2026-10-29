/**
 * Front v2 — Cuentas de la matriz (el panel «Cuenta» del diseño, como pagina).
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 *
 * Una pestaña por cuenta: Efectivo, Cuenta Fresnillo, Cuenta Gilberto (LIBRE,
 * solo egresos) y Transferencias (95/5). Saldo de `saldo_cuenta()`, movimientos
 * de `finanzas_ledger` y una comprobacion en vivo: la suma de los movimientos
 * que se pintan tiene que dar el saldo de la base al centavo.
 *
 * Paridad v2 (2026-10-29): MODAL del panel unico (`/v2/m/cuenta/<clase>`). ADMIN
 * anula (fila o en bloque) y convierte transferencias aqui mismo; ya no manda a
 * /dashboard.
 */

import { CambiarModal } from '@/components/v2/modal/AbrirModal'
import { Modal } from '@/components/v2/modal/Modal'
import { BarraAnular, BotonAnular, CasillaAnular, ProveedorSeleccion } from '@/components/v2/anular/Anular'
import { notFound } from 'next/navigation'
import { getServerSupabaseClient } from '@/lib/server-session'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import {
  leerCategoriasEgreso,
  leerCuentasMatriz,
  leerMovimientosDeCuentas,
  leerNombresEntidades,
  leerResumenTransferencias,
  slugDeClase,
  SLUG_CLASE
} from '@/lib/v2/lecturas'
import {
  cuadra,
  dineroPorMes,
  cuentaParaSaldo,
  efectoEnCuenta,
  egresosPorCategoria,
  FUERA_DE_LISTA,
  indiceCategorias,
  saldoDesdeMovimientos
} from '@/lib/v2/dinero'
import { fechaHoraMx, mesMx, mxn, rangoMeses, tipoLegible } from '@/lib/v2/formato'
import { BarrasMes, Leyenda } from '@/components/v2/graficas'
import TransferenciasCard from '@/components/v2/cuentas/TransferenciasCard'

const NOMBRE: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  FISCAL: 'Cuenta Fresnillo',
  PERSONAL: 'Cuenta Gilberto',
  TRANSFERENCIAS: 'Transferencias'
}

const REGLA: Record<string, string> = {
  EFECTIVO: 'Caja de la matriz. LIBRE: las ventas que caen aquí no desglosan IVA ni IEPS.',
  FISCAL: 'Cuenta bancaria fiscal. FULL_TAX: una venta cobrada aquí desglosa IEPS 53% e IVA 16% (base = total / 1.7748).',
  PERSONAL:
    'LIBRE y SOLO EGRESOS: la base rechaza cualquier ingreso a esta cuenta (trigger trg_cuenta_solo_egresos). Sirve para registrar lo que se paga desde ella.',
  TRANSFERENCIAS:
    'Aquí caen los cobros por transferencia. Al convertirlos a efectivo, 95% pasa a Efectivo y 5% se registra como gasto «Financieros / Comisión por conversión de transferencias».'
}

/** Filas por tanda en «Cargar más» (ronda 2: no un tope fijo). */
const TANDA = 60

/** `?filas=N` -> cuantas filas mostrar: multiplo de TANDA, minimo una tanda. */
function filasPedidas(v: string | string[] | undefined): number {
  const n = Number.parseInt(Array.isArray(v) ? v[0] : v ?? '', 10)
  return Number.isFinite(n) && n > TANDA ? Math.ceil(n / TANDA) * TANDA : TANDA
}

export default async function CuentaV2({
  params,
  searchParams
}: {
  params: Promise<{ clase: string }>
  searchParams: Promise<{ filas?: string | string[] }>
}) {
  const usuario = await exigirMandoV2()
  const esAdmin = usuario.rol === 'ADMIN'
  const { clase: slug } = await params
  const filas = filasPedidas((await searchParams).filas)
  const clase = SLUG_CLASE[slug]
  if (!clase) notFound()

  const client = await getServerSupabaseClient()
  const [cuentas, nombres, transferencias, categorias] = await Promise.all([
    leerCuentasMatriz(client),
    leerNombresEntidades(client),
    leerResumenTransferencias(client),
    leerCategoriasEgreso(client)
  ])
  const idxCat = indiceCategorias(categorias)
  const cuenta = cuentas.find((c) => c.clase === clase)
  if (!cuenta) notFound()

  const movs = (await leerMovimientosDeCuentas(client, [cuenta.id])).map((m) => ({ ...m, efecto: efectoEnCuenta(m, cuenta.id) }))
  const reconstruido = saldoDesdeMovimientos(movs, cuenta.id)
  const ok = cuadra(reconstruido, cuenta.saldo)
  // El saldo de arranque es el punto de partida, no una entrada: va aparte.
  const arranque = movs.reduce((a, m) => a + (m.tipo_movimiento === 'SALDO_INICIAL' ? m.efecto : 0), 0)
  const entro = movs.reduce((a, m) => a + (m.efecto > 0 && m.tipo_movimiento !== 'SALDO_INICIAL' ? m.efecto : 0), 0)
  const salio = movs.reduce((a, m) => a + (m.efecto < 0 ? -m.efecto : 0), 0)
  const fechas = movs.map((m) => m.fecha_movimiento).filter((f): f is string => Boolean(f)).sort()
  const mesHoy = mesMx(new Date())
  const meses = rangoMeses(fechas[0] ? mesMx(fechas[0]) : mesHoy, mesHoy)
  const porMes = dineroPorMes(movs, new Set([cuenta.id]), meses, idxCat)
  const hayFlujo = porMes.some((m) => m.entro > 0 || m.salio > 0)
  const cats = egresosPorCategoria(movs, cuenta.id, idxCat)
  const totalEgresos = cats.reduce((a, c) => a + c.total, 0)
  // La suma que se compara con saldo_cuenta() es sobre TODOS los movimientos leidos
  // en el servidor (`movs`), no sobre la pagina que se muestra.
  const nCuentan = movs.filter((m) => cuentaParaSaldo(m)).length
  const visibles = movs.slice(0, filas)
  const hayMas = movs.length > visibles.length

  return (
    <Modal titulo={NOMBRE[clase] ?? cuenta.nombre} sub={REGLA[clase]} tam="xl">
      <div className="tabs" style={{ marginTop: 0 }}>
        {cuentas.map((c) => (
          <CambiarModal key={c.id} href={`/v2/m/cuenta/${slugDeClase(c.clase)}`} className={c.id === cuenta.id ? 'on' : ''}>
            {c.clase ? NOMBRE[c.clase] ?? c.nombre : c.nombre} · {mxn(c.saldo)}
          </CambiarModal>
        ))}
      </div>

      <div className="ph">
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="chip">{cuenta.tipo_fiscalidad ?? 'fiscalidad sin dato'}</span>
          {cuenta.solo_egresos && <span className="chip warn">solo egresos</span>}
          <span className="chip">clase {cuenta.clase}</span>
        </span>
      </div>

      <div className="cifras">
        <div>
          Saldo hoy<b>{mxn(cuenta.saldo)}</b>
        </div>
        <div>
          Saldo de arranque<b>{mxn(arranque)}</b>
        </div>
        <div>
          Entró desde el corte<b className="pos">{mxn(entro)}</b>
        </div>
        <div>
          Salió desde el corte<b className="neg">{mxn(salio)}</b>
        </div>
      </div>

      <div className={`check ${ok ? '' : 'mal'}`}>
        {ok
          ? `Cuadra: la suma de los ${nCuentan} movimientos que cuentan para el saldo (de ${movs.length} filas de la cuenta; la tabla muestra ${visibles.length}) da ${mxn(reconstruido)} = saldo_cuenta() de la base.`
          : `NO cuadra: los ${nCuentan} movimientos que cuentan para el saldo suman ${mxn(reconstruido)} y saldo_cuenta() dice ${mxn(cuenta.saldo)} (diferencia ${mxn(reconstruido - cuenta.saldo)}).`}
      </div>

      {clase === 'TRANSFERENCIAS' && transferencias && (
        <div style={{ marginBottom: 16 }}>
          {/* Paridad v2: ADMIN convierte aqui (convertir_transferencias, 95/5). */}
          <TransferenciasCard resumen={transferencias} canMutate={esAdmin} />
        </div>
      )}

      <div className="grid g2">
        <section className="card">
          <div className="hd">
            <div>
              <h2>Entró y salió por mes</h2>
              <div className="sub">Sin el saldo de arranque ni los traspasos entre cuentas.</div>
            </div>
          </div>
          {hayFlujo ? (
            <>
              <Leyenda
                items={[
                  { nombre: 'Entró', color: 'var(--s4)' },
                  { nombre: 'Salió', color: 'var(--s1)' }
                ]}
              />
              <BarrasMes
                meses={meses}
                enCurso={mesHoy}
                series={[
                  { nombre: 'Entró', color: 'var(--s4)', valores: porMes.map((m) => m.entro) },
                  { nombre: 'Salió', color: 'var(--s1)', valores: porMes.map((m) => m.salio) }
                ]}
              />
            </>
          ) : (
            <div className="vacio">
              <b>Sin entradas ni salidas desde el arranque</b>
              {nCuentan ? 'El único movimiento es el saldo de arranque del corte.' : 'La cuenta no tiene movimientos.'}
            </div>
          )}
          <div className="fuente">finanzas_ledger · id_cuenta = {cuenta.nombre}</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>En qué se fue el dinero</h2>
              <div className="sub">Egresos por categoría y subcategoría de la lista cerrada ({idxCat.nCategorias} categorías de egreso, en su orden). Lo que no casa con la lista va en «{FUERA_DE_LISTA}». Toca una para abrirla.</div>
            </div>
          </div>
          {cats.length === 0 ? (
            <div className="vacio">
              <b>Sin egresos desde el arranque</b>
              El primer gasto con categoría y subcategoría aparece aquí.
            </div>
          ) : (
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
                <span>{mxn(totalEgresos)}</span>
              </div>
            </div>
          )}
          <div className="fuente">finanzas_ledger.categoria / subcategoria agrupadas contra categorias_movimiento (EGRESO, activas, por orden)</div>
        </section>
      </div>

      <section className="card">
        <div className="hd">
          <div>
            <h2>Movimientos</h2>
            <div className="sub">Columnas del ERP (finanzas_ledger). Las filas atenuadas no cuentan para el saldo (anuladas, ABONO_PENDIENTE o que no mueven esta cuenta). Anular marca ANULADO, no borra.</div>
          </div>
        </div>
        <ProveedorSeleccion>
        {esAdmin && <BarraAnular tipo="finanzas" />}
        <div className="tabla-w">
          <table className="t">
            <thead>
              <tr>
                {esAdmin && <th />}
                <th>Fecha</th>
                <th>Concepto</th>
                <th>Categoría</th>
                <th>Asignado a</th>
                <th className="r">Monto</th>
                <th>Creado por</th>
                {esAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {visibles.map((m) => {
                const motivo = !cuentaParaSaldo(m)
                  ? m.status !== 'ACTIVO' && m.status !== 'APPROVED'
                    ? `${m.status.toLowerCase()} · no cuenta para el saldo`
                    : `${m.categoria} · no cuenta para el saldo`
                  : m.efecto === 0
                    ? 'no mueve el saldo de esta cuenta'
                    : null
                return (
                <tr key={m.id} style={motivo ? { opacity: 0.5 } : undefined}>
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
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={esAdmin ? 8 : 6} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                    Sin movimientos
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </ProveedorSeleccion>
        <div className="fuente">
          Mostrando {visibles.length} de {movs.length} filas ({nCuentan} cuentan para el saldo) · finanzas_ledger
        </div>
        {hayMas && (
          <div style={{ marginTop: 10 }}>
            <CambiarModal className="btn" href={`/v2/m/cuenta/${slug}?filas=${filas + TANDA}`}>
              Cargar más ({Math.min(TANDA, movs.length - visibles.length)} de {movs.length - visibles.length} restantes)
            </CambiarModal>
          </div>
        )}
      </section>
    </Modal>
  )
}

/** Se ofrece Anular en lo que sigue vivo; el servidor vuelve a decidir. */
function anulable(m: { status: string; tipo_movimiento: string }): boolean {
  return m.status !== 'ANULADO' && m.status !== 'CANCELADO' && m.tipo_movimiento !== 'SALDO_INICIAL'
}
