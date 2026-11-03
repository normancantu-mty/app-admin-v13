/**
 * Paginas v2 — `/panel/finanzas`: TODO el apartado de Finanzas en una pagina.
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Regla de Norman (2026-10-29): el modal de cuenta es la vista rapida desde el
 * panel; esta pagina es para ver el apartado entero: las 4 cuentas, los
 * movimientos de todas (o de una) con filtros, «Cargar más» y Anular, los
 * egresos por categoria, transferencias por convertir, IVA/IEPS y aprobaciones.
 * Las capturas (+ Gasto) se abren como modal encima de esta pagina.
 *
 * Solo ADMIN y SOCIO (el dinero de la matriz). SOCIO lee: sin Anular, sin
 * convertir, sin aprobaciones. Reusa las lecturas de `lib/v2` y las piezas de
 * `components/v2/finanzas/Movimientos.tsx` que tambien usa el modal de cuenta.
 *
 * Saldos «Individual | Sumado» (2026-10-30, ejecutor de saldos del Socio): en
 * Sumado, la fila de tarjetas se cambia por «Todo junto» (total de las cuentas y
 * lo que aporta cada una). Las dos vistas se pintan; el CSS esconde una.
 *
 * Enfoque (2026-10-30, Norman): con `?cuenta=x` esa cuenta es la protagonista
 * (cabecera con su color y su saldo grande); las demas tarjetas van chicas y
 * atenuadas, y en Sumado el total es contexto con la cuenta resaltada. Sin
 * cuenta elegida, todo queda como estaba. Solo jerarquia: ninguna cifra cambio.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import Form from 'next/form'
import Link from 'next/link'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { getServerSupabaseClient } from '@/lib/server-session'
import {
  leerCategoriasEgreso,
  leerCuentasYMovimientos,
  leerNombresEntidades,
  leerResumenTransferencias,
  slugDeClase,
  SLUG_CLASE
} from '@/lib/v2/lecturas'
import { leerPasivoFiscal } from '@/lib/vistas'
import {
  cuadra,
  cuentaParaSaldo,
  dineroPorMes,
  efectoEnCuenta,
  efectoEnCuentas,
  egresosPorCategoriaVarias,
  FUERA_DE_LISTA,
  indiceCategorias,
  redondear,
  saldoDesdeMovimientos
} from '@/lib/v2/dinero'
import { fechaMx, mesMx, mxn, nombreMesCorto, rangoMeses } from '@/lib/v2/formato'
import { AbrirModal, CambiarModal } from '@/components/v2/modal/AbrirModal'
import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { TodoJunto } from '@/components/v2/saldos/TodoJunto'
import { CabeceraCuenta, TituloCuenta } from '@/components/v2/saldos/CabeceraCuenta'
import { EgresosPorCategoria, filasPedidas, TablaMovimientos, TANDA } from '@/components/v2/finanzas/Movimientos'
import { BarrasMes, Leyenda } from '@/components/v2/graficas'
import TransferenciasCard from '@/components/v2/cuentas/TransferenciasCard'
import Aprobaciones from '@/components/v2/finanzas/Aprobaciones'

export const dynamic = 'force-dynamic'

const NOMBRE: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  FISCAL: 'Cuenta Fresnillo',
  PERSONAL: 'Cuenta Gilberto',
  TRANSFERENCIAS: 'Transferencias'
}

type Sp = { cuenta?: string | string[]; sentido?: string | string[]; cat?: string | string[]; mes?: string | string[]; q?: string | string[]; filas?: string | string[] }
const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

export default async function FinanzasV2({ searchParams }: { searchParams: Promise<Sp> }) {
  const usuario = await exigirMandoV2()
  const esAdmin = usuario.rol === 'ADMIN'
  const sp = await searchParams
  const slug = SLUG_CLASE[uno(sp.cuenta)] ? uno(sp.cuenta) : 'todas'
  const sentido = uno(sp.sentido) === 'entro' || uno(sp.sentido) === 'salio' ? uno(sp.sentido) : ''
  const cat = uno(sp.cat)
  const mes = /^\d{4}-\d{2}$/.test(uno(sp.mes)) ? uno(sp.mes) : ''
  const q = uno(sp.q).trim()
  const filas = filasPedidas(sp.filas)

  const client = await getServerSupabaseClient()
  // Perf 2026-10-30: los movimientos salen con la lista de cuentas, en la misma
  // tanda que los saldos y lo demas (antes esperaban a que llegaran los saldos).
  const { cuentas: cuentasP, movimientos: movimientosP } = leerCuentasYMovimientos(client)
  const [cuentas, todos, nombres, transferencias, categorias, pasivo] = await Promise.all([
    cuentasP,
    movimientosP,
    leerNombresEntidades(client),
    leerResumenTransferencias(client),
    leerCategoriasEgreso(client),
    leerPasivoFiscal(client)
  ])
  const idxCat = indiceCategorias(categorias)
  const cuenta = slug === 'todas' ? null : cuentas.find((c) => c.clase === SLUG_CLASE[slug]) ?? null
  const ids = cuenta ? [cuenta.id] : cuentas.map((c) => c.id)
  const idsSet = new Set(ids)
  const nombreCuenta = new Map(cuentas.map((c) => [c.id, (c.clase && NOMBRE[c.clase]) || c.nombre]))

  // Alcance: los movimientos que tocan la cuenta elegida (o cualquiera de la matriz).
  const movs = todos
    .filter((m) => !cuenta || m.id_cuenta_origen === cuenta.id || m.id_cuenta_destino === cuenta.id)
    .map((m) => ({ ...m, efecto: cuenta ? efectoEnCuenta(m, cuenta.id) : efectoEnCuentas(m, idsSet) }))

  // Comprobacion en vivo, sobre TODO el alcance (no sobre lo filtrado).
  const saldoBase = redondear(cuentas.filter((c) => idsSet.has(c.id)).reduce((a, c) => a + c.saldo, 0))
  const reconstruido = redondear(ids.reduce((a, id) => a + saldoDesdeMovimientos(todos, id), 0))
  const ok = cuadra(reconstruido, saldoBase)
  const nCuentan = movs.filter((m) => cuentaParaSaldo(m)).length

  // Graficas y egresos del alcance.
  const fechas = movs.map((m) => m.fecha_movimiento).filter((f): f is string => Boolean(f)).sort()
  const mesHoy = mesMx(new Date())
  const meses = rangoMeses(fechas[0] ? mesMx(fechas[0]) : mesHoy, mesHoy)
  const porMes = dineroPorMes(movs, idsSet, meses, idxCat)
  const hayFlujo = porMes.some((m) => m.entro > 0 || m.salio > 0)
  const cats = egresosPorCategoriaVarias(movs, ids, idxCat)

  // Filtros de la tabla.
  const opcionesCat = [...new Set(movs.map((m) => m.categoria).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, 'es'))
  const opcionesMes = [...meses].reverse()
  const texto = q.toLowerCase()
  const filtrados = movs.filter(
    (m) =>
      (!sentido || (sentido === 'entro' ? m.efecto > 0 : m.efecto < 0)) &&
      (!cat || m.categoria === cat) &&
      (!mes || (m.fecha_movimiento && mesMx(m.fecha_movimiento) === mes)) &&
      (!texto || [m.descripcion, m.tipo_movimiento, m.subcategoria, m.usuario_creador].some((v) => v?.toLowerCase().includes(texto)))
  )
  const visibles = filtrados.slice(0, filas)
  const hayMas = filtrados.length > visibles.length
  const hayFiltro = Boolean(sentido || cat || mes || q)

  const query = (cambios: Record<string, string | number | null>) => {
    const u = new URLSearchParams()
    const base: Record<string, string | number | null> = { cuenta: slug === 'todas' ? null : slug, sentido, cat, mes, q, ...cambios }
    for (const [k, v] of Object.entries(base)) if (v !== null && v !== '') u.set(k, String(v))
    const s = u.toString()
    return `${RUTA_BASE}/finanzas${s ? `?${s}` : ''}`
  }

  const iva = pasivo ? Number(pasivo.iva_por_pagar) : null
  const ieps = pasivo ? Number(pasivo.ieps_por_pagar) : null
  const totalCuentas = redondear(cuentas.reduce((a, c) => a + c.saldo, 0))
  // Presentacion: lo que la cuenta elegida aporta al total (misma regla que «Todo junto»).
  const pctDelTotal = cuenta && totalCuentas > 0 && cuenta.saldo >= 0 ? Math.round((cuenta.saldo / totalCuentas) * 1000) / 10 : null

  return (
    <>
      <EncabezadoPagina
        titulo="Finanzas"
        sub="Cuentas de la matriz, movimientos, egresos, impuestos y aprobaciones"
        acciones={
          esAdmin ? (
            <>
              <AbrirModal className="btn p" href={`${RUTA_BASE}/m/gasto`} titulo="Registrar gasto" tam="md">
                + Gasto
              </AbrirModal>
              <AbrirModal className="btn" href={`${RUTA_BASE}/m/categorias`} titulo="Categorías" tam="md">
                Categorías
              </AbrirModal>
            </>
          ) : null
        }
      />

      <section className="saldos">
        <div className="hd">
          <h2>Cuentas</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            Toca una para ver solo sus movimientos y egresos.
          </span>
        </div>
        {cuenta && (
          <div className="vs-foco-fin">
            <h3 className="vs-foco-nom">
              <TituloCuenta clase={cuenta.clase}>{nombreCuenta.get(cuenta.id)}</TituloCuenta>
            </h3>
            <CabeceraCuenta
              clase={cuenta.clase}
              saldo={cuenta.saldo}
              chips={
                <>
                  <span className="chip">{cuenta.tipo_fiscalidad ?? 'fiscalidad sin dato'}</span>
                  {cuenta.solo_egresos && <span className="chip warn">solo egresos</span>}
                  {cuenta.clase === 'TRANSFERENCIAS' && transferencias ? (
                    <span className="chip">por convertir {mxn(transferencias.pendienteMonto)}</span>
                  ) : null}
                </>
              }
            >
              <div className="vs-aporta">
                {pctDelTotal === null ? (
                  <>de un total de <b>{mxn(totalCuentas)}</b> en las {cuentas.length} cuentas</>
                ) : (
                  <>
                    <b>{pctDelTotal}%</b> de <b>{mxn(totalCuentas)}</b>, el total de las {cuentas.length} cuentas
                  </>
                )}
              </div>
            </CabeceraCuenta>
          </div>
        )}
        <div className="vs-sum" data-clase={cuenta?.clase ?? undefined}>
          <TodoJunto
            enlace="cambiar"
            marcada={cuenta?.id}
            total={totalCuentas}
            cuadraConMovimientos={cuenta ? null : ok}
            pendienteTransferencias={transferencias?.pendienteMonto ?? null}
            filas={cuentas.map((c) => ({
              id: c.id,
              nombre: nombreCuenta.get(c.id) ?? c.nombre,
              saldo: c.saldo,
              href: query({ cuenta: slugDeClase(c.clase), filas: null }),
              chip: c.solo_egresos ? 'solo egresos' : undefined,
              nota: c.tipo_fiscalidad ?? undefined,
              clase: c.clase
            }))}
          />
          {cuenta && (
            <p className="vs-nota" style={{ marginTop: 8 }}>
              La tabla de abajo muestra solo {nombreCuenta.get(cuenta.id)}.{' '}
              <Link href={query({ cuenta: null, filas: null })} replace scroll={false} className="enlace-pg">
                Ver los movimientos de todas juntas →
              </Link>
            </p>
          )}
        </div>
        <div className={`kpis vs-ind${cuenta ? ' vs-kpis-foco' : ''}`}>
          <Link href={query({ cuenta: null, filas: null })} replace scroll={false} className={`kpi ${slug === 'todas' ? 'on' : ''}`} data-testid="fin-cuenta-todas">
            <span className="t">Todas las cuentas</span>
            <span className="v">{mxn(totalCuentas)}</span>
            <span className="d">{cuentas.length} cuentas de la matriz</span>
          </Link>
          {cuentas.map((c) => {
            const s = slugDeClase(c.clase)
            return (
              <Link key={c.id} href={query({ cuenta: s, filas: null })} replace scroll={false} className={`kpi ${cuenta?.id === c.id ? 'on' : ''}`} data-clase={c.clase ?? undefined} data-testid={`fin-cuenta-${s}`}>
                <span className="t">{nombreCuenta.get(c.id)}</span>
                <span className="v">{mxn(c.saldo)}</span>
                <span className="d">
                  {c.solo_egresos ? <span className="chip warn">solo egresos</span> : (c.tipo_fiscalidad ?? 'sin fiscalidad')}
                  {c.clase === 'TRANSFERENCIAS' && transferencias ? <> · por convertir <b>{mxn(transferencias.pendienteMonto)}</b></> : null}
                </span>
              </Link>
            )
          })}
          <div className="kpi">
            <span className="t">Impuestos por pagar</span>
            <span className="v">{iva !== null && ieps !== null ? mxn(redondear(iva + ieps)) : 'Sin dato'}</span>
            <span className="d">IVA {iva === null ? 'Sin dato' : mxn(iva)} · IEPS {ieps === null ? 'Sin dato' : mxn(ieps)}</span>
          </div>
        </div>
      </section>

      <div className={`check ${ok ? '' : 'mal'}`}>
        {ok
          ? `Cuadra: los ${nCuentan} movimientos que cuentan para el saldo de ${cuenta ? nombreCuenta.get(cuenta.id) : 'las cuentas'} dan ${mxn(reconstruido)} = saldo_cuenta() de la base.`
          : `NO cuadra: los movimientos suman ${mxn(reconstruido)} y saldo_cuenta() dice ${mxn(saldoBase)} (diferencia ${mxn(redondear(reconstruido - saldoBase))}).`}
      </div>

      <div className="grid g2">
        <section className="card">
          <div className="hd">
            <div>
              <h2>Transferencias por convertir</h2>
              <div className="sub">Al convertir, 95% pasa a Efectivo y 5% se registra como gasto «Financieros / Comisión por conversión de transferencias».</div>
            </div>
          </div>
          {transferencias ? (
            <div className="v1">
              <TransferenciasCard resumen={transferencias} canMutate={esAdmin} />
            </div>
          ) : (
            <div className="vacio">
              <b>Sin resumen de transferencias</b>
              v_transferencias_resumen no devolvió fila.
            </div>
          )}
          <div className="fuente">v_transferencias_resumen · convertir_transferencias()</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>IVA e IEPS</h2>
              <div className="sub">Pasivo fiscal acumulado menos lo pagado. Sin fila es «Sin dato», no cero.</div>
            </div>
          </div>
          {pasivo ? (
            <div className="tabla-w">
              <table className="t">
                <thead>
                  <tr>
                    <th>Impuesto</th>
                    <th className="r">Acumulado</th>
                    <th className="r">Pagado</th>
                    <th className="r">Por pagar</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>IVA 16%</td>
                    <td className="r">{mxn(Number(pasivo.pasivo_iva_acumulado))}</td>
                    <td className="r">{mxn(Number(pasivo.pagos_iva))}</td>
                    <td className="r">
                      <b>{mxn(Number(pasivo.iva_por_pagar))}</b>
                    </td>
                  </tr>
                  <tr>
                    <td>IEPS 53%</td>
                    <td className="r">{mxn(Number(pasivo.pasivo_ieps_acumulado))}</td>
                    <td className="r">{mxn(Number(pasivo.pagos_ieps))}</td>
                    <td className="r">
                      <b>{mxn(Number(pasivo.ieps_por_pagar))}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <div className="vacio">
              <b>Sin dato</b>
              v_pasivo_fiscal no devolvió fila.
            </div>
          )}
          <div className="fuente">v_pasivo_fiscal{pasivo ? ` · calculado ${fechaMx(pasivo.calculado_en)}` : ''}</div>
        </section>
      </div>

      {esAdmin && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="hd">
            <div>
              <h2>Aprobaciones</h2>
              <div className="sub">Los abonos no impactan el balance hasta aprobarse.</div>
            </div>
          </div>
          <div className="v1">
            <Aprobaciones isSubAdmin={false} />
          </div>
        </section>
      )}

      <div className="grid g2">
        <section className="card">
          <div className="hd">
            <div>
              <h2>Entró y salió por mes</h2>
              <div className="sub">{cuenta ? nombreCuenta.get(cuenta.id) : 'Todas las cuentas'} · sin el saldo de arranque ni los traspasos entre cuentas.</div>
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
            </div>
          )}
          <div className="fuente">finanzas_ledger</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>Egresos por categoría</h2>
              <div className="sub">
                Lista cerrada ({idxCat.nCategorias} categorías de egreso, en su orden). Lo que no casa va en «{FUERA_DE_LISTA}». Toca una para abrirla.
              </div>
            </div>
          </div>
          <EgresosPorCategoria cats={cats} />
          <div className="fuente">finanzas_ledger.categoria / subcategoria contra categorias_movimiento</div>
        </section>
      </div>

      <section className="card" data-testid="fin-movimientos">
        <div className="hd">
          <div>
            <h2>Movimientos · {cuenta ? nombreCuenta.get(cuenta.id) : 'todas las cuentas'}</h2>
            <div className="sub">Las filas atenuadas no cuentan para el saldo (anuladas, ABONO_PENDIENTE o que no mueven esta cuenta). Anular marca ANULADO, no borra.</div>
          </div>
        </div>

        <Form action={`${RUTA_BASE}/finanzas`} replace scroll={false} className="fila-acc" style={{ alignItems: 'flex-end', marginBottom: 12 }} data-testid="fin-filtros">
          {slug !== 'todas' && <input type="hidden" name="cuenta" value={slug} />}
          <label className="campo" style={{ marginBottom: 0 }}>
            <span className="lbl">Sentido</span>
            <select name="sentido" defaultValue={sentido}>
              <option value="">Entradas y salidas</option>
              <option value="entro">Solo entradas</option>
              <option value="salio">Solo salidas</option>
            </select>
          </label>
          <label className="campo" style={{ marginBottom: 0 }}>
            <span className="lbl">Categoría</span>
            <select name="cat" defaultValue={cat}>
              <option value="">Todas</option>
              {opcionesCat.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="campo" style={{ marginBottom: 0 }}>
            <span className="lbl">Mes</span>
            <select name="mes" defaultValue={mes}>
              <option value="">Todos</option>
              {opcionesMes.map((m) => (
                <option key={m} value={m}>
                  {nombreMesCorto(m)} {m.slice(0, 4)}
                </option>
              ))}
            </select>
          </label>
          <label className="campo" style={{ marginBottom: 0, minWidth: 200 }}>
            <span className="lbl">Buscar</span>
            <input name="q" defaultValue={q} placeholder="Concepto, descripción, usuario" />
          </label>
          <button type="submit" className="btn p">
            Filtrar
          </button>
          {hayFiltro && (
            <Link href={query({ sentido: null, cat: null, mes: null, q: null })} replace scroll={false} className="btn">
              Quitar filtros
            </Link>
          )}
        </Form>

        <TablaMovimientos movs={visibles} nombres={nombres} esAdmin={esAdmin} cuentas={cuenta ? undefined : nombreCuenta} />
        <div className="fuente">
          Mostrando {visibles.length} de {filtrados.length} filas{hayFiltro ? ` filtradas (de ${movs.length})` : ''} · finanzas_ledger
        </div>
        {hayMas && (
          <div style={{ marginTop: 10 }}>
            <CambiarModal className="btn" href={query({ filas: filas + TANDA })}>
              Cargar más ({Math.min(TANDA, filtrados.length - visibles.length)} de {filtrados.length - visibles.length} restantes)
            </CambiarModal>
          </div>
        )}
      </section>
    </>
  )
}
