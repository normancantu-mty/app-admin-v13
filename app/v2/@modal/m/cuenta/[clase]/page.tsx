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
 *
 * Paginas v2 (2026-10-29): la tabla y el desglose de egresos viven en
 * `components/v2/finanzas/Movimientos.tsx` (los comparte `/v2/finanzas`), y el
 * encabezado lleva «Toda Finanzas →» a la pagina completa.
 *
 * Saldos «Individual | Sumado» (2026-10-30, ejecutor de saldos del Socio): el
 * servidor pinta las DOS vistas y la pildora del encabezado esconde una (CSS
 * `.vs-ind` / `.vs-sum`, sin ir al servidor). Sumado = el total de las cuentas de
 * la matriz con lo que aporta cada una, sus cifras juntas y los movimientos de
 * todas con columna «Cuenta». Se lee UNA vez todo y se filtra la cuenta aqui.
 */

import { CambiarModal } from '@/components/v2/modal/AbrirModal'
import { TodoJunto } from '@/components/v2/saldos/TodoJunto'
import { VistaSaldos } from '@/components/v2/VistaSaldos'
import { Modal } from '@/components/v2/modal/Modal'
import { EgresosPorCategoria, filasPedidas, TablaMovimientos, TANDA } from '@/components/v2/finanzas/Movimientos'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
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

  // Una sola lectura de las cuentas de la matriz: la cuenta se filtra aqui (mismas
  // filas que pedir solo esa cuenta) y la vista Sumado usa todas.
  const todos = await leerMovimientosDeCuentas(
    client,
    cuentas.map((c) => c.id)
  )
  const movs = todos
    .filter((m) => m.id_cuenta_origen === cuenta.id || m.id_cuenta_destino === cuenta.id)
    .map((m) => ({ ...m, efecto: efectoEnCuenta(m, cuenta.id) }))
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
  const entroTodas = sumaSi((m) => m.efecto > 0 && m.tipo_movimiento !== 'SALDO_INICIAL' && !esTraspaso(m.tipo_movimiento))
  const salioTodas = -sumaSi((m) => m.efecto < 0 && !esTraspaso(m.tipo_movimiento))
  const traspasosTodas = sumaSi((m) => esTraspaso(m.tipo_movimiento))
  const visiblesTodas = movsTodas.slice(0, filas)
  const hayMasTodas = movsTodas.length > visiblesTodas.length

  return (
    <Modal titulo={NOMBRE[clase] ?? cuenta.nombre} sub={REGLA[clase]} tam="xl" acciones={
        <>
          {/* El modal tapa el encabezado: aqui va la misma pildora (estado compartido). */}
          <VistaSaldos rol={usuario.rol} />
          <VerTodo href={`/v2/finanzas?cuenta=${slug}`}>Toda Finanzas →</VerTodo>
        </>
      }>
      <div className="tabs" style={{ marginTop: 0 }}>
        {cuentas.map((c) => (
          <CambiarModal key={c.id} href={`/v2/m/cuenta/${slugDeClase(c.clase)}`} className={c.id === cuenta.id ? 'on' : ''}>
            {c.clase ? NOMBRE[c.clase] ?? c.nombre : c.nombre} · {mxn(c.saldo)}
          </CambiarModal>
        ))}
      </div>

      <div className="vs-sum vs-cuenta">
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
            href: `/v2/m/cuenta/${slugDeClase(c.clase)}`,
            chip: c.solo_egresos ? 'solo egresos' : undefined,
            nota: c.tipo_fiscalidad ?? undefined
          }))}
        />
        <div className="cifras" style={{ marginTop: 12 }}>
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
        </div>
        <section className="card">
          <div className="hd">
            <div>
              <h2>Movimientos · todas las cuentas</h2>
              <div className="sub">Los de las {cuentas.length} cuentas juntos, con su cuenta. Un traspaso entre dos cuentas de la matriz sale y entra: junto, se netea. Las filas atenuadas no cuentan para el saldo.</div>
            </div>
          </div>
          <TablaMovimientos movs={visiblesTodas} nombres={nombres} esAdmin={esAdmin} cuentas={nombreCuenta} />
          <div className="fuente">
            Mostrando {visiblesTodas.length} de {movsTodas.length} filas · finanzas_ledger (cuentas de la matriz)
          </div>
          {hayMasTodas && (
            <div style={{ marginTop: 10 }}>
              <CambiarModal className="btn" href={`/v2/m/cuenta/${slug}?filas=${filas + TANDA}`}>
                Cargar más ({Math.min(TANDA, movsTodas.length - visiblesTodas.length)} de {movsTodas.length - visiblesTodas.length} restantes)
              </CambiarModal>
            </div>
          )}
        </section>
      </div>

      <div className="vs-ind">
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
      </div>

      {clase === 'TRANSFERENCIAS' && transferencias && (
        <div style={{ marginBottom: 16 }}>
          {/* Paridad v2: ADMIN convierte aqui (convertir_transferencias, 95/5). */}
          <TransferenciasCard resumen={transferencias} canMutate={esAdmin} />
        </div>
      )}

      <div className="vs-ind">
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
            <h2>Movimientos</h2>
            <div className="sub">Columnas del ERP (finanzas_ledger). Las filas atenuadas no cuentan para el saldo (anuladas, ABONO_PENDIENTE o que no mueven esta cuenta). Anular marca ANULADO, no borra.</div>
          </div>
        </div>
        <TablaMovimientos movs={visibles} nombres={nombres} esAdmin={esAdmin} />
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
      </div>
    </Modal>
  )
}

