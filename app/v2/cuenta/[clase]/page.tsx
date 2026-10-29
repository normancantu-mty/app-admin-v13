/**
 * Front v2 — Cuentas de la matriz (el panel «Cuenta» del diseño, como pagina).
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 *
 * Una pestaña por cuenta: Efectivo, Cuenta Fresnillo, Cuenta Gilberto (LIBRE,
 * solo egresos) y Transferencias (95/5). Saldo de `saldo_cuenta()`, movimientos
 * de `finanzas_ledger` y una comprobacion en vivo: la suma de los movimientos
 * que se pintan tiene que dar el saldo de la base al centavo.
 */

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getServerSupabaseClient } from '@/lib/server-session'
import {
  leerCuentasMatriz,
  leerMovimientosDeCuentas,
  leerNombresEntidades,
  leerResumenTransferencias,
  slugDeClase,
  SLUG_CLASE
} from '@/lib/v2/lecturas'
import { cuadra, dineroPorMes, efectoEnCuenta, egresosPorCategoria, saldoDesdeMovimientos } from '@/lib/v2/dinero'
import { fechaHoraMx, mesMx, mxn, rangoMeses, tipoLegible } from '@/lib/v2/formato'
import { BarrasMes, Leyenda } from '@/components/v2/graficas'
import TransferenciasCard from '@/components/dashboard/TransferenciasCard'

export const dynamic = 'force-dynamic'

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

const LIMITE = 60

export default async function CuentaV2({ params }: { params: Promise<{ clase: string }> }) {
  const { clase: slug } = await params
  const clase = SLUG_CLASE[slug]
  if (!clase) notFound()

  const client = await getServerSupabaseClient()
  const [cuentas, nombres, transferencias] = await Promise.all([
    leerCuentasMatriz(client),
    leerNombresEntidades(client),
    leerResumenTransferencias(client)
  ])
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
  const porMes = dineroPorMes(movs, new Set([cuenta.id]), meses)
  const hayFlujo = porMes.some((m) => m.entro > 0 || m.salio > 0)
  const cats = egresosPorCategoria(movs, cuenta.id)
  const totalEgresos = cats.reduce((a, c) => a + c.total, 0)
  const visibles = movs.filter((m) => m.status === 'ACTIVO' || m.status === 'APPROVED').slice(0, LIMITE)
  const nActivos = movs.filter((m) => m.status === 'ACTIVO' || m.status === 'APPROVED').length

  return (
    <>
      <div className="tabs">
        {cuentas.map((c) => (
          <Link key={c.id} href={`/v2/cuenta/${slugDeClase(c.clase)}`} className={c.id === cuenta.id ? 'on' : ''}>
            {c.clase ? NOMBRE[c.clase] ?? c.nombre : c.nombre} · {mxn(c.saldo)}
          </Link>
        ))}
      </div>

      <div className="ph">
        <div>
          <h1>{NOMBRE[clase] ?? cuenta.nombre}</h1>
          <p>{REGLA[clase]}</p>
        </div>
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
          ? `Cuadra: la suma de los ${nActivos} movimientos de abajo da ${mxn(reconstruido)} = saldo_cuenta() de la base.`
          : `NO cuadra: los movimientos suman ${mxn(reconstruido)} y saldo_cuenta() dice ${mxn(cuenta.saldo)}.`}
      </div>

      {clase === 'TRANSFERENCIAS' && transferencias && (
        <div style={{ marginBottom: 16 }}>
          {/* /v2 es de SOLO LECTURA: la tarjeta se monta sin el boton que escribe. */}
          <TransferenciasCard resumen={transferencias} canMutate={false} />
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            La conversión a efectivo se hace en el ERP actual:{' '}
            <Link href="/dashboard/general">Panel general → Transferencias</Link>.
          </p>
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
              {nActivos ? 'El único movimiento es el saldo de arranque del corte.' : 'La cuenta no tiene movimientos.'}
            </div>
          )}
          <div className="fuente">finanzas_ledger · id_cuenta = {cuenta.nombre}</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>En qué se fue el dinero</h2>
              <div className="sub">Egresos por categoría y subcategoría (lista cerrada: 14 categorías). Toca una para abrirla.</div>
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
                <details className="cat" key={c.categoria}>
                  <summary>
                    <span>
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
          <div className="fuente">finanzas_ledger.categoria / subcategoria · categorias_movimiento</div>
        </section>
      </div>

      <section className="card">
        <div className="hd">
          <div>
            <h2>Movimientos</h2>
            <div className="sub">Columnas del ERP (finanzas_ledger). Anular se hace en el ERP actual: marca ANULADO, no borra.</div>
          </div>
          <Link className="btn" href="/dashboard/finanzas">
            Abrir en Finanzas
          </Link>
        </div>
        <div className="tabla-w">
          <table className="t">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Concepto</th>
                <th>Categoría</th>
                <th>Asignado a</th>
                <th className="r">Monto</th>
                <th>Creado por</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((m) => (
                <tr key={m.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fechaHoraMx(m.fecha_movimiento)}</td>
                  <td>
                    <b>{tipoLegible(m.tipo_movimiento)}</b>
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
                </tr>
              ))}
              {visibles.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>
                    Sin movimientos
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="fuente">
          Mostrando {visibles.length} de {nActivos} · finanzas_ledger
        </div>
      </section>
    </>
  )
}
