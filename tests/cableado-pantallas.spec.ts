import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

import {
  calcularSaldoPendienteInventarioConsignacion,
  calcularSaldoPorPagarEfectivo,
  type FinanzaSaldoInput,
  type TicketSaldoInput
} from '../lib/distribuidores-saldos'
import {
  construirCartera,
  totalesCartera,
  type EntidadCartera,
  type FinanzaCartera,
  type MovimientoInventarioCartera,
  type TicketCartera
} from '../lib/cartera-utils'
import { getStockPorCubetaPorEntidad } from '../lib/inventario-auditoria'
import { movimientoContableEfectivo } from '../lib/finance-utils'
import {
  calcularEgresosAdmin,
  calcularPasivosFiscalesAdmin,
  clasificarCuentaLiquidezPorNombre,
  esTipoEgresoAdmin,
  filtrarMovimientosFirewallAdmin,
  resolveCuentaEgresoAdmin,
  type LiquidezPorCuenta
} from '../lib/dashboard-utils'
import {
  leerCartera,
  leerMovimientosClasificados,
  leerPasivoFiscal,
  leerSaldoEntidad,
  leerSaldosEntidad,
  leerStockPorCubeta
} from '../lib/vistas'

import {
  correnLasDeEquivalencia,
  llaveServiceRole,
  motivoDeSalto,
  urlSupabase
} from './vistas-entorno'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA RED DEL CABLEADO — que ninguna cifra de pantalla se mueva.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `tests/vistas-equivalencia.spec.ts` compara VISTA contra FUNCION. Esta
 * compara **PANTALLA contra PANTALLA**: toma cada cifra que un ADMIN ve con el
 * rango "TODO" y la calcula por los dos caminos —el viejo, armando en
 * TypeScript lo que armaban las paginas antes del cableado, y el nuevo, leyendo
 * de las vistas— y exige que den lo mismo al centavo.
 *
 * Por que hace falta ademas de la de equivalencia: que una vista reproduzca a
 * su funcion **no** garantiza que la pantalla siga diciendo lo mismo. Entre la
 * funcion y el pixel hay filtros, universos de `status` y ambitos de entidad
 * que cada pagina ponia por su cuenta. El error posible de esta sesion no esta
 * en la aritmetica: esta en el cable.
 *
 * Rango "TODO" porque `calcularFechasPorRango('TODO')` devuelve las dos fechas
 * en `undefined` y `limitesRangoMX` no pone filtro. Asi la comparacion no
 * depende del dia en que se corra.
 *
 * Lee con SERVICE ROLE por la misma razon que la de equivalencia: las dos
 * mitades de la comparacion tienen que ver exactamente las mismas filas. Que el
 * RLS se respete lo comprueba el criterio 5, a mano y con sesion de DST.
 */

if (!correnLasDeEquivalencia()) {
  console.warn(`[playwright] Prueba de cableado de pantallas desactivada. ${motivoDeSalto()}`)
}

/** Fila cruda de `finanzas_ledger` con todo lo que miran los tableros. */
interface MovimientoCrudo {
  id: string
  tipo_movimiento: string
  monto: number
  categoria: string | null
  categoria_gasto: string | null
  descripcion: string | null
  status: string
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  id_entidad_relacionada: string | null
  fecha_movimiento: string
}

type LectorSuelto = {
  from(tabla: string): {
    select(columnas: string): {
      range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
    }
  }
}

test.describe('Cableado: la pantalla dice lo mismo leyendo de las vistas', () => {
  test.skip(!correnLasDeEquivalencia(), motivoDeSalto())
  test.setTimeout(120_000)

  /** Los dos nodos con nombre y apellido del prompt. */
  const DELIRIO_85 = 'Delirio 85'
  const DAVID_FLORES = 'David Flores'

  /** Dinero al centavo, sin que un 0.1 + 0.2 de coma flotante lo tumbe. */
  const centavos = (n: number): number => Math.round(n * 100)

  let db: SupabaseClient<Database>
  let crudo: LectorSuelto

  let entidades: { id: string; nombre: string; rol: string }[]
  let cuentas: { id: string; id_entidad: string | null; nombre: string | null }[]
  let cuentasAdmin: string[]
  let finanzasTodas: MovimientoCrudo[]
  let ticketsTodos: (TicketSaldoInput & { id: string; status: string | null })[]
  let inventarioTodo: MovimientoInventarioCartera[]

  async function traerTodo<T>(tabla: string, columnas: string): Promise<T[]> {
    const filas: T[] = []
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await crudo.from(tabla).select(columnas).range(desde, desde + 999)
      if (error) throw new Error(`${tabla}: ${error.message}`)
      const pagina = (data ?? []) as T[]
      filas.push(...pagina)
      if (pagina.length < 1000) return filas
    }
  }

  test.beforeAll(async () => {
    db = createClient<Database>(urlSupabase()!, llaveServiceRole()!, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    crudo = db as unknown as LectorSuelto

    entidades = await traerTodo('entidades', 'id, nombre, rol')
    cuentas = await traerTodo('cuentas_financieras', 'id, id_entidad, nombre')

    const idsAdmin = new Set(entidades.filter((e) => e.rol === 'ADMIN').map((e) => e.id))
    cuentasAdmin = cuentas.filter((c) => c.id_entidad && idsAdmin.has(c.id_entidad)).map((c) => c.id)

    finanzasTodas = await traerTodo(
      'finanzas_ledger',
      'id, tipo_movimiento, monto, categoria, categoria_gasto, descripcion, status, ' +
        'id_cuenta_origen, id_cuenta_destino, id_entidad_relacionada, fecha_movimiento'
    )

    ticketsTodos = await traerTodo(
      'transacciones_tickets',
      'id, condicion_pago, id_comprador, monto_base_ingreso, total_cobrado_real, status'
    )

    inventarioTodo = await traerTodo(
      'inventario_ledger',
      'tipo_movimiento, cantidad, status, id_entidad_origen, id_entidad_destino, fecha_movimiento'
    )
  })

  /** El `id` de una entidad por nombre. Falla si el nodo desaparecio. */
  const idDe = (nombre: string): string => {
    const encontrada = entidades.find((e) => e.nombre === nombre)
    expect(encontrada, `la entidad "${nombre}" tiene que existir`).toBeTruthy()
    return encontrada!.id
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Dashboard General · Ingresos y Egresos  (getFinanzasDashboard, TODO)
  // ══════════════════════════════════════════════════════════════════════════
  test('General: Ingresos y Egresos, del firewall en memoria a v_movimiento_clasificado', async () => {
    // ── ANTES: lo que hacia `getFinanzasDashboard` ────────────────────────────
    const universo = finanzasTodas.filter((m) => m.status === 'APPROVED' || m.status === 'ACTIVO')
    const conFirewall = filtrarMovimientosFirewallAdmin(universo, cuentasAdmin)
    const adminSet = new Set(cuentasAdmin)

    const ingresosAntes = conFirewall
      .filter(
        (m) =>
          ['INGRESO_VENTA', 'ABONO_DEUDA'].includes(m.tipo_movimiento) &&
          movimientoContableEfectivo(m.status, m.categoria)
      )
      .reduce((suma, m) => suma + Number(m.monto), 0)

    const egresosAntes = conFirewall
      .filter(
        (m) =>
          esTipoEgresoAdmin(m.tipo_movimiento) &&
          movimientoContableEfectivo(m.status, m.categoria) &&
          (() => {
            const cuenta = resolveCuentaEgresoAdmin(m)
            return cuenta != null && adminSet.has(cuenta)
          })()
      )
      .reduce((suma, m) => suma + Number(m.monto), 0)

    // ── DESPUES: las banderas ya calculadas por la vista ──────────────────────
    const clasificados = await leerMovimientosClasificados(db)
    const ingresosDespues = clasificados
      .filter((m) => m.es_ingreso_admin)
      .reduce((suma, m) => suma + Number(m.monto), 0)
    const egresosDespues = clasificados
      .filter((m) => m.es_egreso_admin)
      .reduce((suma, m) => suma + Number(m.monto), 0)

    console.log(
      `[cableado] General · Ingresos  antes ${ingresosAntes.toFixed(2)}  despues ${ingresosDespues.toFixed(2)}`
    )
    console.log(
      `[cableado] General · Egresos   antes ${egresosAntes.toFixed(2)}  despues ${egresosDespues.toFixed(2)}`
    )

    expect(centavos(ingresosDespues), 'Ingresos (rango TODO)').toBe(centavos(ingresosAntes))
    expect(centavos(egresosDespues), 'Egresos (rango TODO)').toBe(centavos(egresosAntes))
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Dashboard General · las tres tarjetas de liquidez
  // ══════════════════════════════════════════════════════════════════════════
  test('General: Liquidez Efectivo / Personal / Fresnillo', async () => {
    const cuentaIdABucket = new Map<string, keyof LiquidezPorCuenta>()
    for (const c of cuentas) {
      if (!c.id_entidad || !cuentasAdmin.includes(c.id)) continue
      const bucket = clasificarCuentaLiquidezPorNombre(c.nombre ?? '')
      if (bucket) cuentaIdABucket.set(c.id, bucket)
    }

    const TIPOS_INGRESO = new Set(['INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO'])
    const TIPOS_EGRESO = new Set([
      'GASTO_OPERATIVO',
      'CARGO_DEUDA',
      'SUBSIDIO_FISCAL',
      'COMPRA_INSUMOS',
      'EGRESO_TRASPASO'
    ])

    /** El mismo bucle de `getLiquidezPorCuenta`, sobre las filas que se le den. */
    const acumular = (
      filas: {
        monto: number
        tipo_movimiento: string | null
        id_cuenta_origen: string | null
        id_cuenta_destino: string | null
      }[]
    ): LiquidezPorCuenta => {
      const total: LiquidezPorCuenta = { EFECTIVO: 0, CUENTA_PERSONAL: 0, CUENTA_FRESNILLO: 0 }
      for (const mov of filas) {
        const monto = Number(mov.monto) || 0
        if (TIPOS_INGRESO.has(mov.tipo_movimiento ?? '') && mov.id_cuenta_destino) {
          const bucket = cuentaIdABucket.get(mov.id_cuenta_destino)
          if (bucket) total[bucket] += monto
        }
        if (TIPOS_EGRESO.has(mov.tipo_movimiento ?? '')) {
          const cuentaId = resolveCuentaEgresoAdmin({
            tipo_movimiento: mov.tipo_movimiento ?? '',
            id_cuenta_origen: mov.id_cuenta_origen,
            id_cuenta_destino: mov.id_cuenta_destino
          })
          if (!cuentaId) continue
          const bucket = cuentaIdABucket.get(cuentaId)
          if (bucket) total[bucket] -= monto
        }
      }
      return total
    }

    // ── ANTES ─────────────────────────────────────────────────────────────────
    const antes = acumular(
      filtrarMovimientosFirewallAdmin(
        finanzasTodas.filter((m) => m.status === 'APPROVED' || m.status === 'ACTIVO'),
        cuentasAdmin
      ).filter((m) => movimientoContableEfectivo(m.status, m.categoria))
    )

    // ── DESPUES: las dos banderas las pone la vista ───────────────────────────
    const clasificados = await leerMovimientosClasificados(db)
    const despues = acumular(clasificados.filter((m) => m.toca_cuenta_admin && m.es_contable_efectivo))

    for (const bucket of ['EFECTIVO', 'CUENTA_PERSONAL', 'CUENTA_FRESNILLO'] as const) {
      console.log(
        `[cableado] General · Liquidez ${bucket}  antes ${antes[bucket].toFixed(2)}  despues ${despues[bucket].toFixed(2)}`
      )
      expect(centavos(despues[bucket]), `Liquidez ${bucket}`).toBe(centavos(antes[bucket]))
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Dashboard General · la deuda de la red (columna "Saldo Pendiente")
  // ══════════════════════════════════════════════════════════════════════════
  test('General: deuda de la red, nodo por nodo y en total', async () => {
    const contables: FinanzaSaldoInput[] = finanzasTodas
      .filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')
      .map((f) => ({
        tipo_movimiento: f.tipo_movimiento,
        monto: Number(f.monto),
        id_entidad_relacionada: f.id_entidad_relacionada,
        categoria: f.categoria
      }))

    const vista = await leerSaldosEntidad(db)
    const porId = new Map(vista.map((f) => [f.id_entidad, f]))

    let sumaAntes = 0
    let sumaDespues = 0

    // `getLiderazgoRed` recorre todas las entidades que no son ADMIN.
    for (const entidad of entidades.filter((e) => e.rol !== 'ADMIN')) {
      const antes = calcularSaldoPendienteInventarioConsignacion(
        { id: entidad.id, rol: entidad.rol as 'DST' | 'LOC' | 'SOCIO' },
        ticketsTodos,
        [entidad.id],
        contables
      )
      const fila = porId.get(entidad.id)
      expect(fila, `v_saldo_entidad tiene que traer a ${entidad.nombre}`).toBeTruthy()

      expect(centavos(Number(fila!.saldo_pendiente_consignacion)), `saldo de ${entidad.nombre}`).toBe(
        centavos(antes)
      )

      sumaAntes += antes
      sumaDespues += Number(fila!.saldo_pendiente_consignacion)
    }

    console.log(
      `[cableado] General · Deuda de la red  antes ${sumaAntes.toFixed(2)}  despues ${sumaDespues.toFixed(2)}`
    )
    expect(centavos(sumaDespues), 'deuda de la red').toBe(centavos(sumaAntes))
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 3 bis. La UNICA diferencia semantica que introdujo el cableado.
  // ══════════════════════════════════════════════════════════════════════════
  test('General: el ultimo abono de la vista no mueve el semaforo de ningun nodo', async () => {
    // `getLiderazgoRed` tomaba la fecha del ultimo ABONO_DEUDA **sin** excluir
    // los de categoria ABONO_PENDIENTE. `v_saldo_entidad.ultimo_abono` si los
    // excluye. Es una diferencia real, y esta prueba es la que dice si hoy mueve
    // algun numero: si un dia falla, es que nacio un abono pendiente vivo y hay
    // que decidir a proposito cual de las dos fechas manda.
    const vista = await leerSaldosEntidad(db)
    const porId = new Map(vista.map((f) => [f.id_entidad, f]))

    const contables = finanzasTodas.filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')

    for (const entidad of entidades.filter((e) => e.rol !== 'ADMIN')) {
      // Lo que hacia el bucle viejo: todos los ABONO_DEUDA, pendientes incluidos.
      const abonos = contables.filter(
        (f) => f.tipo_movimiento === 'ABONO_DEUDA' && f.id_entidad_relacionada === entidad.id
      )
      const antes = abonos.length
        ? new Date(Math.max(...abonos.map((f) => new Date(f.fecha_movimiento).getTime()))).toISOString()
        : null

      const ultimoAbono = porId.get(entidad.id)?.ultimo_abono ?? null
      const despues = ultimoAbono ? new Date(ultimoAbono).toISOString() : null

      expect(despues, `ultimo abono de ${entidad.nombre}`).toBe(antes)
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Finanzas · Ingresos, Egresos y Balance
  // ══════════════════════════════════════════════════════════════════════════
  test('Finanzas: Ingresos, Egresos y Balance historico', async () => {
    // ── ANTES: `calcularResumen` sobre `movimientosHistoricosVista` ───────────
    const vistaAdmin = filtrarMovimientosFirewallAdmin(finanzasTodas, cuentasAdmin)
    const activos = vistaAdmin.filter((m) => movimientoContableEfectivo(m.status, m.categoria))
    const adminSet = new Set(cuentasAdmin)

    const ingresosAntes = activos
      .filter((m) => ['INGRESO_VENTA', 'ABONO_DEUDA'].includes(m.tipo_movimiento))
      .filter(
        (m) =>
          Boolean(m.id_cuenta_destino && adminSet.has(m.id_cuenta_destino)) ||
          Boolean(m.id_cuenta_origen && adminSet.has(m.id_cuenta_origen))
      )
      .reduce((suma, m) => suma + Number(m.monto), 0)
    const egresosAntes = calcularEgresosAdmin(activos, cuentasAdmin)
    const balanceAntes = ingresosAntes - egresosAntes

    // ── DESPUES ───────────────────────────────────────────────────────────────
    const clasificados = await leerMovimientosClasificados(db)
    const ingresosDespues = clasificados
      .filter((m) => m.es_ingreso_admin)
      .reduce((suma, m) => suma + Number(m.monto), 0)
    const egresosDespues = clasificados
      .filter((m) => m.es_egreso_admin)
      .reduce((suma, m) => suma + Number(m.monto), 0)
    const balanceDespues = ingresosDespues - egresosDespues

    console.log(
      `[cableado] Finanzas · Ingresos  antes ${ingresosAntes.toFixed(2)}  despues ${ingresosDespues.toFixed(2)}`
    )
    console.log(
      `[cableado] Finanzas · Egresos   antes ${egresosAntes.toFixed(2)}  despues ${egresosDespues.toFixed(2)}`
    )
    console.log(
      `[cableado] Finanzas · Balance   antes ${balanceAntes.toFixed(2)}  despues ${balanceDespues.toFixed(2)}`
    )

    expect(centavos(ingresosDespues), 'Finanzas · Ingresos').toBe(centavos(ingresosAntes))
    expect(centavos(egresosDespues), 'Finanzas · Egresos').toBe(centavos(egresosAntes))
    expect(centavos(balanceDespues), 'Finanzas · Balance').toBe(centavos(balanceAntes))
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Finanzas · IVA e IEPS por pagar
  // ══════════════════════════════════════════════════════════════════════════
  test('Finanzas: IVA e IEPS por pagar', async () => {
    const antes = calcularPasivosFiscalesAdmin(
      filtrarMovimientosFirewallAdmin(finanzasTodas, cuentasAdmin),
      cuentasAdmin
    )

    const despues = await leerPasivoFiscal(db)
    expect(despues, 'v_pasivo_fiscal tiene que devolver su unica fila').toBeTruthy()

    console.log(
      `[cableado] Finanzas · IVA por pagar   antes ${antes.ivaPorPagar.toFixed(2)}  despues ${Number(despues!.iva_por_pagar).toFixed(2)}`
    )
    console.log(
      `[cableado] Finanzas · IEPS por pagar  antes ${antes.iepsPorPagar.toFixed(2)}  despues ${Number(despues!.ieps_por_pagar).toFixed(2)}`
    )

    expect(centavos(Number(despues!.iva_por_pagar)), 'IVA por pagar').toBe(centavos(antes.ivaPorPagar))
    expect(centavos(Number(despues!.ieps_por_pagar)), 'IEPS por pagar').toBe(
      centavos(antes.iepsPorPagar)
    )
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Directorio de distribuidores · las dos columnas de saldo
  // ══════════════════════════════════════════════════════════════════════════
  test('Distribuidores: Saldo Pendiente y Saldo por Pagar, fila por fila', async () => {
    const contables: FinanzaSaldoInput[] = finanzasTodas
      .filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')
      .map((f) => ({
        tipo_movimiento: f.tipo_movimiento,
        monto: Number(f.monto),
        id_entidad_relacionada: f.id_entidad_relacionada,
        categoria: f.categoria
      }))

    const vista = await leerSaldosEntidad(db)
    const porId = new Map(vista.map((f) => [f.id_entidad, f]))

    // El directorio lista todo lo que no es ADMIN.
    for (const entidad of entidades.filter((e) => e.rol !== 'ADMIN')) {
      const pendienteAntes = calcularSaldoPendienteInventarioConsignacion(
        { id: entidad.id, rol: entidad.rol as 'DST' | 'LOC' | 'SOCIO' },
        ticketsTodos,
        [entidad.id],
        contables
      )
      const porPagarAntes = calcularSaldoPorPagarEfectivo(entidad.id, contables)
      const fila = porId.get(entidad.id)!

      expect(
        centavos(Number(fila.saldo_pendiente_consignacion)),
        `Saldo Pendiente de ${entidad.nombre}`
      ).toBe(centavos(pendienteAntes))
      expect(
        centavos(Number(fila.saldo_por_pagar_efectivo)),
        `Saldo por Pagar de ${entidad.nombre}`
      ).toBe(centavos(porPagarAntes))
    }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 7. Los dos nodos que el prompt nombra, y la confusion que ya paso una vez
  // ══════════════════════════════════════════════════════════════════════════
  test('Delirio 85 y David Flores: el bruto no se confunde con el neto', async () => {
    const delirio = await leerSaldoEntidad(db, idDe(DELIRIO_85))
    const david = await leerSaldoEntidad(db, idDe(DAVID_FLORES))

    console.log(
      `[cableado] Distribuidores · Delirio 85       ${Number(delirio!.saldo_pendiente_consignacion).toFixed(2)}`
    )
    console.log(
      `[cableado] Distribuidores · David Flores     ${Number(david!.saldo_pendiente_consignacion).toFixed(2)}` +
        ` (genero ${Number(david!.deuda_generada_tickets).toFixed(2)} en tickets)`
    )

    // ERP-78: lo que se prueba es que el NETO y el BRUTO son columnas distintas
    // y que cuadran entre si. Las cifras del 2026-09-02 quedan como piso: el
    // 2026-09-07 entro un ticket de concesion de David por $3,552.00, y con la
    // igualdad vieja una venta real tumbaba el push.
    const generadaDavid = Number(david!.deuda_generada_tickets)
    const abonosDavid = Number(david!.abonos_aprobados)
    const netoDavid = Number(david!.saldo_pendiente_consignacion)

    expect(centavos(netoDavid), 'generada - abonos = saldo').toBe(
      centavos(generadaDavid - abonosDavid)
    )
    expect(centavos(generadaDavid), 'el bruto no es el neto').toBeGreaterThan(centavos(netoDavid))
    expect(centavos(generadaDavid), 'lo generado no decrece').toBeGreaterThanOrEqual(centavos(58_000))
    expect(
      centavos(Number(delirio!.saldo_pendiente_consignacion)),
      'Delirio 85 no baja de su piso sin abonos'
    ).toBeGreaterThanOrEqual(centavos(19_476))
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Cartera · las 11 filas, columna por columna, y el pie de tabla
  // ══════════════════════════════════════════════════════════════════════════
  test('Cartera: las filas y los tres totales del encabezado', async () => {
    const hoy = new Date().toISOString()

    const antes = construirCartera({
      entidades: entidades as EntidadCartera[],
      inventario: inventarioTodo,
      tickets: ticketsTodos as TicketCartera[],
      finanzas: finanzasTodas as unknown as FinanzaCartera[],
      hoy
    })
    const despues = await leerCartera(db)

    console.log(`[cableado] Cartera · filas  antes ${antes.length}  despues ${despues.length}`)
    expect(despues.length, 'numero de filas de la cartera').toBe(antes.length)

    for (let i = 0; i < antes.length; i++) {
      const a = antes[i]
      const d = despues[i]
      expect(d.id_entidad, `fila ${i + 1}: mismo nodo y mismo orden`).toBe(a.id)
      expect(Number(d.recibidas), `${a.nombre} · recibidas`).toBe(a.recibidas)
      expect(Number(d.libro_dice), `${a.nombre} · libro dice`).toBe(a.libroDice)
      expect(Number(d.estimado_en_piso), `${a.nombre} · estimado en piso`).toBe(a.estimadoEnPiso)
      expect(centavos(Number(d.deuda)), `${a.nombre} · deuda`).toBe(centavos(a.deuda))
      expect(
        d.porcentaje_pagado === null ? null : Math.round(Number(d.porcentaje_pagado) * 1000),
        `${a.nombre} · % pagado`
      ).toBe(a.porcentajePagado === null ? null : Math.round(a.porcentajePagado * 1000))
      expect(d.dias_sin_abono, `${a.nombre} · dias sin abono`).toBe(a.diasSinAbono)
      expect(d.referencia_dias, `${a.nombre} · referencia de dias`).toBe(a.referenciaDias)
    }

    const totalesAntes = totalesCartera(antes)
    const totalesDespues = despues.reduce(
      (acc, f) => ({
        recibidas: acc.recibidas + Number(f.recibidas),
        libroDice: acc.libroDice + Number(f.libro_dice),
        estimadoEnPiso: acc.estimadoEnPiso + Number(f.estimado_en_piso),
        deuda: acc.deuda + Number(f.deuda)
      }),
      { recibidas: 0, libroDice: 0, estimadoEnPiso: 0, deuda: 0 }
    )

    console.log(
      `[cableado] Cartera · Total por cobrar  antes ${totalesAntes.deuda.toFixed(2)}  despues ${totalesDespues.deuda.toFixed(2)}`
    )
    console.log(
      `[cableado] Cartera · Libro dice  antes ${totalesAntes.libroDice}  despues ${totalesDespues.libroDice}` +
        ` · de ${totalesAntes.recibidas} recibidas`
    )
    console.log(
      `[cableado] Cartera · Estimado en piso  antes ${totalesAntes.estimadoEnPiso}  despues ${totalesDespues.estimadoEnPiso}`
    )

    expect(centavos(totalesDespues.deuda), 'Total por cobrar').toBe(centavos(totalesAntes.deuda))
    expect(totalesDespues.recibidas, 'recibidas').toBe(totalesAntes.recibidas)
    expect(totalesDespues.libroDice, 'el libro dice que hay fuera').toBe(totalesAntes.libroDice)
    expect(totalesDespues.estimadoEnPiso, 'estimado por dinero').toBe(totalesAntes.estimadoEnPiso)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 9. Perfil de entidad · los dos cubos de inventario
  // ══════════════════════════════════════════════════════════════════════════
  test('Perfil: stock PAGADO y CONSIGNADO, entidad por entidad', async () => {
    const vista = await leerStockPorCubeta(db)

    for (const entidad of entidades) {
      const antes = await getStockPorCubetaPorEntidad(entidad.id)
      const filas = vista.filter((f) => f.id_entidad === entidad.id)

      const comparar = (
        esperado: { idProducto: string; producto: string; stockEsperado: number }[],
        cubeta: 'PAGADO' | 'CONSIGNADO'
      ) => {
        const obtenido = filas.filter((f) => f.cubeta === cubeta)
        expect(obtenido.length, `${entidad.nombre} · productos en ${cubeta}`).toBe(esperado.length)
        for (const item of esperado) {
          const fila = obtenido.find((f) => f.id_producto === item.idProducto)
          expect(fila, `${entidad.nombre} · ${item.producto} en ${cubeta}`).toBeTruthy()
          expect(Number(fila!.stock), `${entidad.nombre} · ${item.producto} en ${cubeta}`).toBeCloseTo(
            item.stockEsperado,
            4
          )
        }
      }

      comparar(antes.stockPagado, 'PAGADO')
      comparar(antes.stockConsignado, 'CONSIGNADO')
    }
  })
})
