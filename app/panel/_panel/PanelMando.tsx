/**
 * Front v2 — Inicio (tablero de la matriz). Escrito el 2026-10-29 por el ejecutor
 * del Front v2 (lanzado por el Socio). Diseño: ronda 3 (artefacto
 * 1cyDAQie7R52SbJnUvTSJg), con las cifras REALES de la base.
 *
 * Lo decidido gana al diseño: 4 cuentas (Efectivo, Cuenta Fresnillo, Cuenta
 * Gilberto LIBRE solo egresos, Transferencias 95/5) y la cartera de la matriz sin
 * la deuda de los locales con su distribuidor.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { getServerSupabaseClient } from '@/lib/server-session'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { leerTablero, slugDeClase } from '@/lib/v2/lecturas'
import {
  cascadaDeCaja,
  corteDeArranque,
  cuadra,
  dineroPorMes,
  FUERA_DE_LISTA,
  gastosDesdeCorte,
  indiceCategorias,
  redondear
} from '@/lib/v2/dinero'
import { fechaHoraMx, mesMx, mxn, mxn0, num, rangoMeses } from '@/lib/v2/formato'
import { esDeudaConLaMatriz, totalesCarteraVista } from '@/lib/vistas'
import { diasDesde } from '@/lib/actividad'
import { BarrasMes, Cascada, Leyenda } from '@/components/v2/graficas'
import { CardCobranza } from '@/components/v2/cobranza/CardCobranza'
import { leerCrudoCobranzaPanel } from '@/components/v2/cobranza/leer'
import { DIAS_ROJO } from '@/components/v2/cobranza/semaforo'
import { CardSemaforo, type IndicadorSemaforo } from '@/components/v2/panel/CardSemaforo'
import { TodoJunto } from '@/components/v2/saldos/TodoJunto'
import { CardVentasCobros } from '@/components/v2/ventas/CardVentasCobros'
import { leerVentasCobros } from '@/components/v2/ventas/leerVentasCobros'
import { armarVentasCobros } from '@/lib/v2/ventas-cobros'

const NOMBRE_CLASE: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  FISCAL: 'Cuenta Fresnillo',
  PERSONAL: 'Cuenta Gilberto',
  TRANSFERENCIAS: 'Transferencias'
}

function Vacio({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div className="vacio">
      <b>{titulo}</b>
      {children}
    </div>
  )
}

/** El panel de la matriz (ADMIN y SOCIO). Lo pinta /panel y su default.tsx. */
export async function PanelMando() {
  const usuario = await exigirMandoV2()
  const client = await getServerSupabaseClient()
  // La tarjeta de ventas y cobros lee aparte, en la MISMA tanda (sin viaje en serie).
  const [d, crudoVC, crudoCob] = await Promise.all([leerTablero(client), leerVentasCobros(client), leerCrudoCobranzaPanel(client)])
  const puedeCapturar = usuario.rol === 'ADMIN'
  const ahora = new Date()

  // ── Saldos ──
  const cuentas = d.cuentas
  const idsMatriz = new Set(cuentas.map((c) => c.id))
  const totalCuentas = redondear(cuentas.reduce((a, c) => a + c.saldo, 0))
  const cart = totalesCarteraVista(d.cartera)
  const totalRed = redondear(cart.deuda + cart.deudaConDistribuidor)
  const deudoresMatriz = d.cartera.filter((f) => esDeudaConLaMatriz(f) && Number(f.deuda) > 0)
  const botellas = new Map<string, number>()
  for (const s of d.stockMatriz) botellas.set(s.producto, (botellas.get(s.producto) ?? 0) + Number(s.stock))
  const totalBotellas = [...botellas.values()].reduce((a, b) => a + b, 0)
  // Sin fila en v_pasivo_fiscal (o con el campo nulo) es «Sin dato», no 0.
  const aNumero = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
  const iva = aNumero(d.pasivo?.iva_por_pagar)
  const ieps = aNumero(d.pasivo?.ieps_por_pagar)
  const impuestos = iva !== null && ieps !== null ? redondear(iva + ieps) : null
  const oSinDato = (n: number | null) => (n === null ? 'Sin dato' : mxn(n))

  // ── Corte y meses ──
  // El corte sale de la base: el SALDO_INICIAL mas antiguo de las cuentas de la matriz.
  const corte = corteDeArranque(d.movimientos)
  const mesHoy = mesMx(ahora)
  const meses = rangoMeses(corte ? mesMx(corte) : mesHoy, mesHoy)
  // Hechos agregados (mes x producto x cliente x canal) para la tarjeta dinamica; el navegador filtra.
  const datosVC = armarVentasCobros(crudoVC.tickets, crudoVC.cobros, idsMatriz, d.nombres)
  // Categorias: la lista cerrada de categorias_movimiento; lo que no casa va a «Fuera de la lista».
  const idxCat = indiceCategorias(d.categorias)
  const porMes = dineroPorMes(d.movimientos, idsMatriz, meses, idxCat)
  const ventas = meses.map((mes) => d.ventasPorMes.find((v) => String(v.mes).slice(0, 7) === mes))
  const hayVentas = ventas.some((v) => v && Number(v.vendido) > 0)
  const hayEgresos = porMes.some((m) => m.salio > 0)
  const hayCaja = porMes.some((m) => m.entro > 0 || m.salio > 0)

  // ── Cascada del mes en curso (México es UTC-6 sin horario de verano) ──
  const desde = new Date(`${mesHoy}-01T00:00:00-06:00`)
  const pasos = cascadaDeCaja(d.movimientos, idsMatriz, desde, new Date(ahora.getTime() + 60_000), idxCat)
  const final = pasos[pasos.length - 1]?.valor ?? 0
  const cascadaCuadra = cuadra(final, totalCuentas)

  // ── Egresos por categoría (las 4 mayores de la lista + otros; «Fuera de la lista» siempre aparte) ──
  const totCat = new Map<string, number>()
  for (const m of porMes) for (const [k, v] of Object.entries(m.egresoPorCategoria)) totCat.set(k, (totCat.get(k) ?? 0) + v)
  const topCat = [...totCat.entries()]
    .filter(([k]) => k !== FUERA_DE_LISTA)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k)
  const colores = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--cobre)', 'var(--otros-graf)']
  const seriesEgreso = [
    ...topCat.map((cat, i) => ({ nombre: cat, color: colores[i], valores: porMes.map((m) => m.egresoPorCategoria[cat] ?? 0) })),
    {
      nombre: 'Otros',
      color: colores[4],
      valores: porMes.map((m) =>
        Object.entries(m.egresoPorCategoria)
          .filter(([k]) => !topCat.includes(k) && k !== FUERA_DE_LISTA)
          .reduce((a, [, v]) => a + v, 0)
      )
    },
    { nombre: FUERA_DE_LISTA, color: 'var(--fuera-graf)', valores: porMes.map((m) => m.egresoPorCategoria[FUERA_DE_LISTA] ?? 0) }
  ].filter((s) => s.valores.some((v) => v > 0))

  // ── Producción por mes ──
  const nombreProd = new Map(d.stockMatriz.map((s) => [s.id_producto, s.producto]))
  const prodPorMes = new Map<string, Map<string, number>>()
  for (const e of d.envasado) {
    const mes = mesMx(e.fecha)
    const p = nombreProd.get(e.id_producto) ?? 'Otro'
    const fila = prodPorMes.get(mes) ?? new Map<string, number>()
    fila.set(p, (fila.get(p) ?? 0) + Number(e.botellas))
    prodPorMes.set(mes, fila)
  }
  const productos = [...new Set(d.envasado.map((e) => nombreProd.get(e.id_producto) ?? 'Otro'))]

  // ── Semáforo ──
  const vencida = deudoresMatriz.filter((f) => (f.dias_sin_abono ?? 0) > DIAS_ROJO)
  const montoVencido = vencida.reduce((a, f) => a + Number(f.deuda), 0)
  const enPiso = d.cartera.reduce((a, f) => a + Number(f.estimado_en_piso), 0)
  // Desde el corte y con el filtro de saldo_cuenta (ACTIVO/APPROVED, sin ABONO_PENDIENTE).
  const gastosCorte = corte ? gastosDesdeCorte(d.movimientos, corte) : null
  // Dias de calendario en hora de Mexico: la misma regla que `v_cartera` y `lib/actividad.ts`.
  const diasDesdeCorte = corte ? diasDesde(corte, ahora) : null
  const semaforo: IndicadorSemaforo[] = [
    {
      luz: vencida.length ? 'rojo' : 'verde',
      titulo: 'Cobranza vencida',
      cifra: mxn0(montoVencido),
      valor: montoVencido,
      detalle: vencida.length
        ? `${vencida.length} ${vencida.length === 1 ? 'deudor' : 'deudores'}: ${vencida
            .slice(0, 3)
            .map((f) => `${f.nombre} ${f.dias_sin_abono} d`)
            .join(' · ')}${vencida.length > 3 ? ` y ${vencida.length - 3} más` : ''}`
        : `Nadie con +${DIAS_ROJO} días sin abonar (${deudoresMatriz.length} deudores de la matriz)`,
      regla: `rojo si alguien le debe a la matriz y lleva más de ${DIAS_ROJO} días sin abonar`,
      estado: vencida.length ? 'Atender' : 'Bien',
      href: vencida.length ? `${RUTA_BASE}/m/cobranza?banda=rojo` : `${RUTA_BASE}/m/cobranza`,
      tituloModal: 'Cobranza',
      tam: 'xl',
      accion: vencida.length ? 'Cobrar' : 'Cobranza'
    },
    {
      luz: d.insumosEnNegativo ? 'rojo' : 'verde',
      titulo: 'Insumos en negativo',
      cifra: `${num(d.insumosEnNegativo)} ${d.insumosEnNegativo === 1 ? 'insumo' : 'insumos'}`,
      detalle: d.insumosEnNegativo ? 'Se consumió más de lo que entró: falta capturar una compra o hay un consumo de más' : 'Ningún insumo con existencia menor que 0',
      regla: 'rojo si algún insumo tiene existencia menor que 0',
      estado: d.insumosEnNegativo ? 'Atender' : 'Bien',
      href: `${RUTA_BASE}/m/inventario`,
      tituloModal: 'Inventario',
      accion: 'Inventario'
    },
    {
      luz: hayVentas ? 'verde' : 'gris',
      titulo: 'Producto para vender',
      cifra: `${num(totalBotellas)} pzas`,
      valor: totalBotellas,
      detalle: `${[...botellas.entries()].map(([p, n]) => `${p.replace('Destilado Plata ', '')} ${num(n)}`).join(' · ') || 'Sin producto en la matriz'}${hayVentas ? '' : ' · sin ventas para calcular meses'}`,
      regla: 'sin dato mientras no haya ventas para calcular cuántos meses alcanza',
      estado: hayVentas ? 'Bien' : 'Sin dato',
      href: `${RUTA_BASE}/m/inventario`,
      tituloModal: 'Inventario',
      accion: 'Inventario'
    },
    gastosCorte === null
      ? {
          luz: 'gris',
          titulo: 'Gastos capturados',
          cifra: 'Sin dato',
          detalle: 'Sin fecha de corte: la base no trae SALDO_INICIAL',
          regla: 'ámbar si no hay ningún gasto capturado desde el corte',
          estado: 'Sin dato'
        }
      : {
          luz: gastosCorte ? 'verde' : 'ambar',
          titulo: 'Gastos capturados',
          cifra: `${num(gastosCorte)} ${gastosCorte === 1 ? 'gasto' : 'gastos'}`,
          detalle: `desde el corte, hace ${diasDesdeCorte} d`,
          regla: 'ámbar si no hay ningún gasto capturado desde el corte',
          estado: gastosCorte ? 'Bien' : 'Revisar',
          ...(puedeCapturar
            ? { href: `${RUTA_BASE}/m/gasto`, tituloModal: 'Registrar gasto', tam: 'md' as const, accion: '+ Gasto' }
            : { href: `${RUTA_BASE}/m/cuenta/efectivo`, tituloModal: 'Movimientos de dinero', accion: 'Movimientos' })
        },
    {
      luz: 'gris',
      titulo: 'Caja sin conciliar',
      cifra: mxn0(totalCuentas),
      valor: totalCuentas,
      detalle: `según el sistema, en ${cuentas.length} cuentas · el ERP aún no guarda conciliaciones`,
      regla: 'sin dato hasta que el ERP guarde conciliaciones contra el banco y la caja',
      estado: 'Sin dato',
      href: `${RUTA_BASE}/m/cuenta/efectivo`,
      tituloModal: 'Movimientos de dinero',
      accion: 'Movimientos'
    },
    {
      luz: d.conteosFisicos ? 'verde' : 'ambar',
      titulo: 'Concesión sin conteo',
      cifra: d.conteosFisicos ? `${num(d.conteosFisicos)} conteos` : `${num(enPiso)} pzas sin contar`,
      valor: d.conteosFisicos ? d.conteosFisicos : enPiso,
      detalle: d.conteosFisicos ? `${num(enPiso)} pzas en la red` : `en ${d.cartera.length} nodos, 0 conteos físicos`,
      regla: 'ámbar si no hay ningún conteo físico de la concesión',
      estado: d.conteosFisicos ? 'Bien' : 'Revisar',
      href: `${RUTA_BASE}/m/cartera`,
      tituloModal: 'Cartera completa',
      accion: 'Cartera'
    }
  ]

  // ── Alertas ──
  const alertas: { nivel: 'crit' | 'warn' | 'info'; texto: string; href: string }[] = []
  for (const f of vencida) alertas.push({ nivel: 'crit', texto: `${f.nombre}: ${f.dias_sin_abono} días sin abonar`, href: `${RUTA_BASE}/m/nodo/${f.id_entidad}` })
  if (d.insumosEnNegativo) alertas.push({ nivel: 'crit', texto: `${d.insumosEnNegativo} insumos en negativo`, href: `${RUTA_BASE}/m/inventario` })
  if (d.transferencias && d.transferencias.pendienteMonto > 0)
    alertas.push({
      nivel: 'warn',
      texto: `${d.transferencias.pendientesN} transferencia(s) por convertir: ${mxn(d.transferencias.pendienteMonto)}`,
      href: `${RUTA_BASE}/m/cuenta/transferencias`
    })
  if (!d.conteosFisicos) alertas.push({ nivel: 'warn', texto: `Concesión sin contar: ${num(enPiso)} pzas en ${d.cartera.length} nodos`, href: `${RUTA_BASE}/m/cartera` })
  if (gastosCorte === 0) alertas.push({ nivel: 'warn', texto: 'Sin gastos capturados desde el corte', href: `${RUTA_BASE}/m/gasto` })
  if (cart.deudaConDistribuidor > 0)
    alertas.push({
      nivel: 'info',
      texto: `${cart.nodosConDistribuidor} locales deben ${mxn0(cart.deudaConDistribuidor)} a su distribuidor (fuera de la cartera de la matriz)`,
      href: `${RUTA_BASE}/m/cartera`
    })

  return (
    <>
      <div className="aviso">
        <span className="chip info">ERP v2 · local</span>
        <b>Datos reales de la base local, carga conciliada{corte ? ` (corte ${fechaHoraMx(corte)})` : ''}.</b>
        <span className="muted">Leído {fechaHoraMx(ahora.toISOString())}. Todo se abre aquí mismo, en ventanas.</span>
      </div>

      <section className="saldos">
        <div className="hd">
          <h2>Saldos al día</h2>
          <span className="chip chile">Saldo de hoy</span>
          <span className={`chip ${cascadaCuadra ? 'good' : 'crit'}`}>
            {cascadaCuadra ? 'saldo_cuenta() = suma de movimientos' : 'NO cuadra con los movimientos'}
          </span>
          <VerTodo href={`${RUTA_BASE}/finanzas`} className="vertodo-l">Toda Finanzas →</VerTodo>
        </div>
        {/* Vista «Sumado» (selector del encabezado): todo junto. «Individual» es la fila de KPIs de abajo. */}
        <div className="vs-sum">
          <TodoJunto
            total={totalCuentas}
            cuadraConMovimientos={cascadaCuadra}
            pendienteTransferencias={d.transferencias?.pendienteMonto ?? null}
            filas={cuentas.map((c) => ({
              id: c.id,
              nombre: c.clase ? NOMBRE_CLASE[c.clase] ?? c.nombre : c.nombre,
              saldo: c.saldo,
              href: `${RUTA_BASE}/m/cuenta/${slugDeClase(c.clase)}`,
              chip: c.clase === 'PERSONAL' ? 'LIBRE · solo egresos' : undefined,
              nota: c.tipo_fiscalidad ?? undefined
            }))}
            foto={{
              porCobrar: cart.deuda,
              nodosPorCobrar: deudoresMatriz.length,
              impuestos,
              iva,
              ieps,
              deudaConDistribuidor: cart.deudaConDistribuidor,
              nodosConDistribuidor: cart.nodosConDistribuidor,
              botellasMatriz: totalBotellas,
              piezasEnPiso: enPiso
            }}
          />
        </div>
        <div className="kpis vs-ind">
          {cuentas.map((c) => (
            <AbrirModal key={c.id} titulo={c.clase ? NOMBRE_CLASE[c.clase] ?? c.nombre : c.nombre} href={`${RUTA_BASE}/m/cuenta/${slugDeClase(c.clase)}`} className={`kpi ${c.clase === 'EFECTIVO' || c.clase === 'FISCAL' ? 'fuerte' : ''}`}>
              <span className="t">
                {c.clase ? NOMBRE_CLASE[c.clase] ?? c.nombre : c.nombre} <span>›</span>
              </span>
              <span className="v">{mxn(c.saldo)}</span>
              <span className="d">
                {c.clase === 'PERSONAL' && (
                  <span className="chip warn">LIBRE · solo egresos</span>
                )}
                {c.clase === 'TRANSFERENCIAS' && d.transferencias && (
                  <>por convertir <b>{mxn(d.transferencias.pendienteMonto)}</b> · 95/5</>
                )}
                {c.clase === 'FISCAL' && <>{c.tipo_fiscalidad ?? 'sin fiscalidad'} · IVA e IEPS</>}
                {c.clase === 'EFECTIVO' && <>{c.tipo_fiscalidad ?? ''} · caja</>}
              </span>
            </AbrirModal>
          ))}
          <div className="kpi">
            <span className="t">Total en cuentas</span>
            <span className="v">{mxn(totalCuentas)}</span>
            {cascadaCuadra ? (
              <span className="d">{cuentas.length} cuentas · cuadra con la suma de movimientos</span>
            ) : (
              <span className="d neg">
                {cuentas.length} cuentas · NO cuadra: los movimientos dan {mxn(final)}, diferencia {mxn(redondear(final - totalCuentas))}
              </span>
            )}
          </div>
          <div className="kpi">
            <span className="t">Impuestos por pagar</span>
            <span className="v">{oSinDato(impuestos)}</span>
            <span className="d">
              IVA {oSinDato(iva)} · IEPS {oSinDato(ieps)}
              {d.pasivo === null && ' · v_pasivo_fiscal sin fila'}
            </span>
          </div>
          <AbrirModal href={`${RUTA_BASE}/m/cartera`} titulo="Cartera completa" className="kpi">
            <span className="t">
              Por cobrar (matriz) <span>›</span>
            </span>
            <span className="v">{mxn(cart.deuda)}</span>
            <span className="d">
              {deudoresMatriz.length} nodos · red total <b>{mxn(totalRed)}</b>
            </span>
          </AbrirModal>
          <div className="kpi">
            <span className="t">Botellas en la matriz</span>
            <span className="v">
              {num(totalBotellas)} <small style={{ fontSize: 12, fontWeight: 600 }}>pzas</small>
            </span>
            <span className="d">
              {[...botellas.entries()].map(([p, n]) => `${p.replace('Destilado Plata ', '')} ${num(n)}`).join(' · ')}
            </span>
          </div>
        </div>
      </section>

      {puedeCapturar && (
        <div className="acciones">
          <span className="lbl">CAPTURAR</span>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/venta`} titulo="Nueva venta" tam="xl" data-testid="abrir-venta">+ Venta</AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/envasado`} titulo="Registrar envasado" tam="md">+ Envasado</AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/gasto`} titulo="Registrar gasto" tam="md">+ Gasto</AbrirModal>
          <AbrirModal className="btn p" href={`${RUTA_BASE}/m/compra`} titulo="Comprar insumos" tam="md">Comprar insumos</AbrirModal>
        </div>
      )}
      <div className="acciones">
        <span className="lbl">ABRIR</span>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/cuenta/efectivo`} titulo="Movimientos de dinero">Movimientos de dinero</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/inventario`} titulo="Inventario">Movimientos de inventario</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/cartera`} titulo="Cartera completa">Cartera completa</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/red`} titulo="Red de distribución">Red</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/precios`} titulo="Catálogo y precios">Catálogo y precios</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/lotes`} titulo="Lotes">Ver lotes</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/aprobaciones`} titulo="Aprobaciones" tam="md">Aprobaciones</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/avisos`} titulo="Avisos" tam="md">Avisos</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/actividad`} titulo="Actividad">Actividad</AbrirModal>
        <AbrirModal className="btn" href={`${RUTA_BASE}/m/ventas`} titulo="Ventas">Ventas</AbrirModal>
      </div>
      {/* Paginas v2 (2026-10-29): los apartados completos son paginas; lo de arriba sigue en modal. */}
      <div className="acciones" data-testid="panel-ver-todo">
        <span className="lbl">VER TODO</span>
        <VerTodo href={`${RUTA_BASE}/finanzas`}>Finanzas →</VerTodo>
        <VerTodo href={`${RUTA_BASE}/red`}>Red y cartera →</VerTodo>
        <VerTodo href={`${RUTA_BASE}/catalogo`}>Catálogo →</VerTodo>
        <VerTodo href={`${RUTA_BASE}/inventario`}>Inventario →</VerTodo>
        <VerTodo href={`${RUTA_BASE}/lotes`}>Lotes →</VerTodo>
      </div>

      <div className="grid g336">
        <CardSemaforo
          indicadores={semaforo}
          fuente="v_cartera · v_insumos_en_negativo · conteos_fisicos · finanzas_ledger · v_stock_por_cubeta"
        />

        <section className="card">
          <div className="hd">
            <div>
              <h2>Alertas</h2>
              <div className="sub">
                {alertas.filter((a) => a.nivel === 'crit').length} urgentes · {alertas.length} en total
              </div>
            </div>
          </div>
          <div className="alertas">
            {alertas.length === 0 && <Vacio titulo="Sin alertas">Todo en orden.</Vacio>}
            {alertas.map((a) => (
              <div className={`a ${a.nivel}`} key={a.texto}>
                <span className="tx">{a.texto}</span>
                <AbrirModal href={a.href}>Ver</AbrirModal>
              </div>
            ))}
          </div>
          <div className="fuente">v_cartera · v_transferencias_resumen · conteos_fisicos · finanzas_ledger</div>
        </section>

        <CardVentasCobros datos={datosVC} mesHoy={mesHoy} mesCorte={corte ? mesMx(corte) : null} />
      </div>

      <div className="grid g363">
        <CardCobranza cartera={d.cartera} crudo={crudoCob} />

        <section className="card">
          <div className="hd">
            <div>
              <h2>Cascada de caja</h2>
              <div className="sub">De dónde vino y a dónde se fue el dinero en el mes. Verde suma, rojo resta.</div>
            </div>
            <span className="chip">Mes en curso</span>
          </div>
          <p className="lead">
            Empezó el mes en <b>{mxn(pasos[0]?.valor ?? 0)}</b> y va en <b>{mxn(final)}</b>.{' '}
            {cascadaCuadra ? (
              <span className="chip good">Final = Total en cuentas</span>
            ) : (
              <span className="chip crit">Final ≠ Total en cuentas ({mxn(totalCuentas)})</span>
            )}
          </p>
          <Cascada pasos={pasos} />
          <div className="nota">
            El saldo de arranque es lo que había en las 4 cuentas al corte; desde ahí todo sale del libro. Los traspasos
            internos (incluida la conversión 95/5 de Transferencias) se netean; la comisión del 5% aparece como gasto
            «Financieros».
          </div>
          <div className="fuente">finanzas_ledger · regla de saldo_cuenta()</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>Utilidad de caja por mes</h2>
              <div className="sub">Entró − salió de caja. No es utilidad contable. Una pérdida va negativa, en rojo.</div>
            </div>
          </div>
          {hayCaja ? (
            <BarrasMes
              meses={meses}
              enCurso={mesHoy}
              series={[
                {
                  nombre: 'Utilidad',
                  color: 'var(--s4)',
                  colorNegativo: 'var(--crit)',
                  valores: porMes.map((m) => redondear(m.entro - m.salio))
                }
              ]}
            />
          ) : (
            <Vacio titulo="Sin movimientos de caja desde el arranque">Se calcula con la primera entrada o salida.</Vacio>
          )}
          <div className="fuente">finanzas_ledger por mes</div>
        </section>
      </div>

      <div className="grid g2">
        <section className="card">
          <div className="hd">
            <div>
              <h2>Egresos por mes</h2>
              <div className="sub">Lo que salió de caja, por categoría de la lista cerrada ({idxCat.nCategorias} de egreso); las 4 mayores + otros. Lo que no casa con la lista va en «{FUERA_DE_LISTA}».</div>
            </div>
          </div>
          {hayEgresos ? (
            <>
              <Leyenda items={seriesEgreso.map((s) => ({ nombre: s.nombre, color: s.color }))} />
              <BarrasMes meses={meses} enCurso={mesHoy} series={seriesEgreso} />
            </>
          ) : (
            <Vacio titulo="Sin egresos desde el arranque">El primer gasto con categoría y subcategoría aparece aquí.</Vacio>
          )}
          <div className="fuente">finanzas_ledger.categoria agrupada contra categorias_movimiento (EGRESO, activas, por orden)</div>
        </section>

        <section className="card">
          <div className="hd">
            <div>
              <h2>Producción por mes</h2>
              <div className="sub">Botellas envasadas, por presentación.</div>
            </div>
            <span className={`chip ${d.lotes ? '' : 'warn'}`}>{d.lotes} lotes registrados</span>
          </div>
          {d.envasado.length ? (
            <BarrasMes
              meses={meses}
              enCurso={mesHoy}
              formato={(n) => num(n)}
              series={productos.map((p, i) => ({
                nombre: p,
                color: colores[i % colores.length],
                valores: meses.map((mes) => prodPorMes.get(mes)?.get(p) ?? 0)
              }))}
            />
          ) : (
            <Vacio titulo="Sin envasado desde el arranque">
              El inventario de la matriz arrancó con {num(totalBotellas)} botellas contadas; la producción se registra por lote.
            </Vacio>
          )}
          <div className="fuente">lote_envasado · lotes</div>
        </section>
      </div>
    </>
  )
}
