/**
 * Front v2 — Cuentas de la matriz (el panel «Cuenta» del diseño, como pagina).
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 *
 * Una pestaña por cuenta: Efectivo, Cuenta Fresnillo, Cuenta Gilberto (LIBRE,
 * solo egresos) y Transferencias (95/5). Saldo de `saldo_cuenta()`, movimientos
 * de `finanzas_ledger` y una comprobacion en vivo: la suma de los movimientos
 * que se pintan tiene que dar el saldo de la base al centavo.
 *
 * Paridad v2 (2026-10-29): MODAL del panel unico (`/panel/m/cuenta/<clase>`). ADMIN
 * anula (fila o en bloque) y convierte transferencias aqui mismo; ya no manda a
 * /dashboard.
 *
 * Paginas v2 (2026-10-29): la tabla y el desglose de egresos viven en
 * `components/v2/finanzas/Movimientos.tsx` (los comparte `/panel/finanzas`), y el
 * encabezado lleva «Toda Finanzas →» a la pagina completa.
 *
 * Saldos «Individual | Sumado» (2026-10-30, ejecutor de saldos del Socio): el
 * servidor pinta las DOS vistas y la pildora del encabezado esconde una (CSS
 * `.vs-ind` / `.vs-sum`, sin ir al servidor). Sumado = el total de las cuentas de
 * la matriz con lo que aporta cada una, sus cifras juntas y los movimientos de
 * todas con columna «Cuenta». Se lee UNA vez todo y se filtra la cuenta aqui.
 *
 * Enfoque (2026-10-30, Norman): el modal es de SU cuenta. Cabecera con el color de
 * la clase y el saldo grande (`CabeceraCuenta`); las demas cuentas en una linea
 * chica y atenuada (Individual) o como desglose atenuado con la cuenta abierta
 * resaltada (Sumado). En Sumado el total es una franja de contexto, la cuenta
 * conserva sus graficas y sus movimientos, y la tabla de todas va plegada.
 * Solo jerarquia visual: ninguna cifra ni calculo cambio.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { CambiarModal } from '@/components/v2/modal/AbrirModal'
import { TodoJunto } from '@/components/v2/saldos/TodoJunto'
import { CabeceraCuenta, OtrasCuentas, TituloCuenta } from '@/components/v2/saldos/CabeceraCuenta'
import { VistaSaldos } from '@/components/v2/VistaSaldos'
import { Modal } from '@/components/v2/modal/Modal'
import { EgresosPorCategoria, filasPedidas, TablaMovimientos, TANDA } from '@/components/v2/finanzas/Movimientos'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { notFound } from 'next/navigation'
import { getServerSupabaseClient } from '@/lib/server-session'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import {
  leerCategoriasEgreso,
  leerCuentasYMovimientos,
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
  efectoEnCuentas,
  egresosPorCategoria,
  FUERA_DE_LISTA,
  indiceCategorias,
  redondear,
  saldoDesdeMovimientos
} from '@/lib/v2/dinero'
import { mesMx, mxn, rangoMeses } from '@/lib/v2/formato'
import { BarrasMes, Leyenda } from '@/components/v2/graficas'
import TransferenciasCard from '@/components/v2/cuentas/TransferenciasCard'

const NOMBRE: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  FISCAL: 'Cuenta Fresnillo',
  PERSONAL: 'Cuenta Gilberto',
  CUENTA_G: 'Cuenta G',
  TRANSFERENCIAS: 'Transferencias'
}

const REGLA: Record<string, string> = {
  EFECTIVO: 'Caja de la matriz. LIBRE: las ventas que caen aquí no desglosan IVA ni IEPS.',
  FISCAL: 'Cuenta bancaria fiscal. FULL_TAX: una venta cobrada aquí desglosa IEPS 53% e IVA 16% (base = total / 1.7748).',
  PERSONAL:
    'LIBRE y SOLO EGRESOS: la base rechaza cualquier ingreso a esta cuenta (trigger trg_cuenta_solo_egresos). Sirve para registrar lo que se paga desde ella.',
  CUENTA_G: 'Cuenta LIBRE de la matriz: recibe ingresos y egresos, sin desglose de IVA ni IEPS.',
  TRANSFERENCIAS:
    'Aquí caen los cobros por transferencia. Al convertirlos a efectivo, 95% pasa a Efectivo y 5% se registra como gasto «Financieros / Comisión por conversión de transferencias».'
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
  // Perf 2026-10-30: una sola lectura de las cuentas de la matriz y sus movimientos,
  // sin cascada (los movimientos salen con la lista de cuentas, junto con los saldos).
  // La cuenta se filtra aqui (mismas filas que pedir solo esa cuenta) y la vista
  // Sumado usa todas.
  const { cuentas: cuentasP, movimientos: movimientosP } = leerCuentasYMovimientos(client)
  const [cuentas, todos, nombres, transferencias, categorias] = await Promise.all([
    cuentasP,
    movimientosP,
    leerNombresEntidades(client),
    leerResumenTransferencias(client),
    leerCategoriasEgreso(client)
  ])
  const idxCat = indiceCategorias(categorias)
  const cuenta = cuentas.find((c) => c.clase === clase)
  if (!cuenta) notFound()

  const movs = todos
    .filter((m) => m.id_cuenta_origen === cuenta.id || m.id_cuenta_destino === cuenta.id)
    .map((m) => ({ ...m, efecto: efectoEnCuenta(m, cuenta.id) }))
  const reconstruido = saldoDesdeMovimientos(movs, cuenta.id)
  const ok = cuadra(reconstruido, cuenta.saldo)
  // El saldo de arranque es el punto de partida, no una entrada: va aparte.
  const arranque = movs.reduce((a, m) => a + (m.tipo_movimiento === 'SALDO_INICIAL' ? m.efecto : 0), 0)
  // AJUSTE_SALDO (2026-11-03): correccion del ADMIN. Tampoco es dinero que entro o salio
  // (mismo criterio que dineroPorMes): va en su propia linea, solo si existe.
  const esAjuste = (t: string) => t === 'AJUSTE_SALDO'
  const ajustes = movs.reduce((a, m) => a + (esAjuste(m.tipo_movimiento) ? m.efecto : 0), 0)
  const entro = movs.reduce((a, m) => a + (m.efecto > 0 && m.tipo_movimiento !== 'SALDO_INICIAL' && !esAjuste(m.tipo_movimiento) ? m.efecto : 0), 0)
  const salio = movs.reduce((a, m) => a + (m.efecto < 0 && !esAjuste(m.tipo_movimiento) ? -m.efecto : 0), 0)
  const fechas = movs.map((m) => m.fecha_movimiento).filter((f): f is string => Boolean(f)).sort()
  const mesHoy = mesMx(new Date())
  const meses = rangoMeses(fechas[0] ? mesMx(fechas[0]) : mesHoy, mesHoy)
  const porMes = dineroPorMes(movs, new Set([cuenta.id]), meses, idxCat)
  const hayFlujo = porMes.some((m) => m.entro > 0 || m.salio > 0)
  const cats = egresosPorCategoria(movs, cuenta.id, idxCat)
  // La suma que se compara con saldo_cuenta() es sobre TODOS los movimientos leidos
  // en el servidor (`movs`), no sobre la pagina que se muestra.
  const nCuentan = movs.filter((m) => cuentaParaSaldo(m)).length
  const visibles = movs.slice(0, filas)
  const hayMas = movs.length > visibles.length

  // ── Vista Sumado: todas las cuentas de la matriz juntas ──
  const idsTodas = new Set(cuentas.map((c) => c.id))
  const nombreCuenta = new Map(cuentas.map((c) => [c.id, (c.clase && NOMBRE[c.clase]) || c.nombre]))
  const movsTodas = todos.map((m) => ({ ...m, efecto: efectoEnCuentas(m, idsTodas) }))
  const totalTodas = redondear(cuentas.reduce((a, c) => a + c.saldo, 0))
  const okTodas = cuadra(redondear(movsTodas.reduce((a, m) => a + m.efecto, 0)), totalTodas)
  const esTraspaso = (t: string) => t === 'INGRESO_TRASPASO' || t === 'EGRESO_TRASPASO'
  const sumaSi = (f: (m: (typeof movsTodas)[number]) => boolean) => redondear(movsTodas.reduce((a, m) => a + (f(m) ? m.efecto : 0), 0))
  const arranqueTodas = sumaSi((m) => m.tipo_movimiento === 'SALDO_INICIAL')
  const ajustesTodas = sumaSi((m) => esAjuste(m.tipo_movimiento))
  const entroTodas = sumaSi((m) => m.efecto > 0 && m.tipo_movimiento !== 'SALDO_INICIAL' && !esTraspaso(m.tipo_movimiento) && !esAjuste(m.tipo_movimiento))
  const salioTodas = -sumaSi((m) => m.efecto < 0 && !esTraspaso(m.tipo_movimiento) && !esAjuste(m.tipo_movimiento))
  const traspasosTodas = sumaSi((m) => esTraspaso(m.tipo_movimiento))
  const visiblesTodas = movsTodas.slice(0, filas)
  const hayMasTodas = movsTodas.length > visiblesTodas.length

  const nombreActual = NOMBRE[clase] ?? cuenta.nombre
  // Presentacion: lo que la cuenta abierta aporta al total (misma regla que «Todo junto»).
  const pctDelTotal = totalTodas > 0 && cuenta.saldo >= 0 ? Math.round((cuenta.saldo / totalTodas) * 1000) / 10 : null

  return (
    <Modal titulo={<TituloCuenta clase={cuenta.clase}>{nombreActual}</TituloCuenta>} sub={REGLA[clase]} tam="xl" acciones={
        <>
          {/* El modal tapa el encabezado: aqui va la misma pildora (estado compartido). */}
          <VistaSaldos rol={usuario.rol} />
          <VerTodo href={`${RUTA_BASE}/finanzas?cuenta=${slug}`}>Toda Finanzas →</VerTodo>
        </>
      }>
      {/* Enfoque (Norman, 2026-10-30): la cuenta abierta es la protagonista. Las demas
          cuentas y el total van chicos y atenuados, como contexto. */}
      <CabeceraCuenta
        clase={cuenta.clase}
        saldo={cuenta.saldo}
        chips={
          <>
            <span className="chip">{cuenta.tipo_fiscalidad ?? 'fiscalidad sin dato'}</span>
            {cuenta.solo_egresos && <span className="chip warn">solo egresos</span>}
            <span className="chip">clase {cuenta.clase}</span>
          </>
        }
      >
        <div className="cifras vs-chicas">
          <div>
            Saldo de arranque<b>{mxn(arranque)}</b>
          </div>
          <div>
            Entró desde el corte<b className="pos">{mxn(entro)}</b>
          </div>
          <div>
            Salió desde el corte<b className="neg">{mxn(salio)}</b>
          </div>
          {redondear(ajustes) !== 0 && (
            <div>
              Ajustes ADMIN (neto)<b>{mxn(ajustes)}</b>
            </div>
          )}
        </div>
        <div className="vs-sum vs-aporta">
          {pctDelTotal === null ? (
            <>de un total de <b>{mxn(totalTodas)}</b> en las {cuentas.length} cuentas</>
          ) : (
            <>
              <b>{pctDelTotal}%</b> de <b>{mxn(totalTodas)}</b>, el total de las {cuentas.length} cuentas
            </>
          )}
        </div>
      </CabeceraCuenta>

      <div className="vs-ind">
        <OtrasCuentas
          como="cambiar"
          cuentas={cuentas
            .filter((c) => c.id !== cuenta.id)
            .map((c) => ({
              id: c.id,
              nombre: nombreCuenta.get(c.id) ?? c.nombre,
              saldo: c.saldo,
              href: `${RUTA_BASE}/m/cuenta/${slugDeClase(c.clase)}`,
              clase: c.clase
            }))}
        />
      </div>

      <div className={`check ${ok ? '' : 'mal'}`}>
        {ok
          ? `Cuadra: la suma de los ${nCuentan} movimientos que cuentan para el saldo (de ${movs.length} filas de la cuenta; la tabla muestra ${visibles.length}) da ${mxn(reconstruido)} = saldo_cuenta() de la base.`
          : `NO cuadra: los ${nCuentan} movimientos que cuentan para el saldo suman ${mxn(reconstruido)} y saldo_cuenta() dice ${mxn(cuenta.saldo)} (diferencia ${mxn(reconstruido - cuenta.saldo)}).`}
      </div>

      {/* Vista Sumado: el total y las demas cuentas como CONTEXTO (franja chica, la
          cuenta abierta resaltada en el desglose); lo de todas juntas, plegado. */}
      <div className="vs-sum vs-cuenta vs-contexto" data-clase={cuenta.clase ?? undefined}>
        <TodoJunto
          enlace="cambiar"
          marcada={cuenta.id}
          total={totalTodas}
          cuadraConMovimientos={okTodas}
          pendienteTransferencias={transferencias?.pendienteMonto ?? null}
          filas={cuentas.map((c) => ({
            id: c.id,
            nombre: nombreCuenta.get(c.id) ?? c.nombre,
            saldo: c.saldo,
            href: `${RUTA_BASE}/m/cuenta/${slugDeClase(c.clase)}`,
            chip: c.solo_egresos ? 'solo egresos' : undefined,
            nota: c.tipo_fiscalidad ?? undefined,
            clase: c.clase
          }))}
        />
        <details className="vs-plegable">
          <summary>
            Movimientos de las {cuentas.length} cuentas juntas <span className="muted">({movsTodas.length} filas · arranque, entró, salió y traspasos de todas)</span>
          </summary>
          <div className="cifras vs-chicas" style={{ marginTop: 10 }}>
            <div>
              Saldo de arranque<b>{mxn(arranqueTodas)}</b>
            </div>
            <div>
              Entró desde el corte<b className="pos">{mxn(entroTodas)}</b>
            </div>
            <div>
              Salió desde el corte<b className="neg">{mxn(salioTodas)}</b>
            </div>
            <div>
              Traspasos entre cuentas (neto)<b>{mxn(traspasosTodas)}</b>
            </div>
            {ajustesTodas !== 0 && (
              <div>
                Ajustes ADMIN (neto)<b>{mxn(ajustesTodas)}</b>
              </div>
            )}
          </div>
          <div className="sub muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Un traspaso entre dos cuentas de la matriz sale y entra: junto, se netea. Las filas de {nombreActual} llevan la marca de color a la izquierda; las atenuadas no cuentan para el saldo.
          </div>
          <TablaMovimientos movs={visiblesTodas} nombres={nombres} esAdmin={esAdmin} cuentas={nombreCuenta} marcada={cuenta.id} />
          <div className="fuente">
            Mostrando {visiblesTodas.length} de {movsTodas.length} filas · finanzas_ledger (cuentas de la matriz)
          </div>
          {hayMasTodas && (
            <div style={{ marginTop: 10 }}>
              <CambiarModal className="btn" href={`${RUTA_BASE}/m/cuenta/${slug}?filas=${filas + TANDA}`}>
                Cargar más ({Math.min(TANDA, movsTodas.length - visiblesTodas.length)} de {movsTodas.length - visiblesTodas.length} restantes)
              </CambiarModal>
            </div>
          )}
        </details>
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
          <EgresosPorCategoria cats={cats} />
          <div className="fuente">finanzas_ledger.categoria / subcategoria agrupadas contra categorias_movimiento (EGRESO, activas, por orden)</div>
        </section>
      </div>

      <section className="card">
        <div className="hd">
          <div>
            <h2>Movimientos · {nombreActual}</h2>
            <div className="sub">Columnas del ERP (finanzas_ledger). Las filas atenuadas no cuentan para el saldo (anuladas, ABONO_PENDIENTE o que no mueven esta cuenta). Anular marca ANULADO, no borra.</div>
          </div>
        </div>
        <TablaMovimientos movs={visibles} nombres={nombres} esAdmin={esAdmin} />
        <div className="fuente">
          Mostrando {visibles.length} de {movs.length} filas ({nCuentan} cuentan para el saldo) · finanzas_ledger
        </div>
        {hayMas && (
          <div style={{ marginTop: 10 }}>
            <CambiarModal className="btn" href={`${RUTA_BASE}/m/cuenta/${slug}?filas=${filas + TANDA}`}>
              Cargar más ({Math.min(TANDA, movs.length - visibles.length)} de {movs.length - visibles.length} restantes)
            </CambiarModal>
          </div>
        )}
      </section>
    </Modal>
  )
}

