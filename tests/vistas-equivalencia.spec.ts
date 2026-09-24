import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'

import {
  calcularSaldoPendienteInventarioConsignacion,
  calcularSaldoPorPagarEfectivo,
  type EntidadRolSaldo,
  type FinanzaSaldoInput,
  type TicketSaldoInput
} from '../lib/distribuidores-saldos'
import { construirCartera, type FilaCartera } from '../lib/cartera-utils'
import { getStockPorCubetaPorEntidad } from '../lib/inventario-auditoria'
import {
  esPagoImpuestoIeps,
  esPagoImpuestoIva,
  movimientoContableEfectivo
} from '../lib/finance-utils'
import {
  calcularPasivosFiscalesAdmin,
  esTipoEgresoAdmin,
  filtrarMovimientosFirewallAdmin,
  movimientoTocaCuentaAdmin,
  resolveCuentaEgresoAdmin
} from '../lib/dashboard-utils'
import {
  leerCartera,
  leerMovimientosClasificados,
  leerPasivoFiscal,
  leerSaldosEntidad,
  leerStockPorCubeta
} from '../lib/vistas'

import {
  avisar,
  avisoPasivoFiscal,
  centavos,
  violacionesCarteraSinAbonos,
  violacionesDiasSinAbonar,
  violacionesSaldo
} from './invariantes-vistas'
import {
  correnLasDeEquivalencia,
  llaveServiceRole,
  motivoDeSalto,
  urlSupabase
} from './vistas-entorno'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * LA PRUEBA DE EQUIVALENCIA — la entrega principal de las vistas canonicas.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Cada vista de `supabase/migrations/20260902230000_vistas_canonicas.sql` se
 * compara contra la funcion de TypeScript que dice reproducir, **sobre los
 * datos reales de hoy**, entidad por entidad y al centavo.
 *
 * LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO: la funcion de TypeScript es la
 * REFERENCIA. Si una vista no coincide, **la vista esta mal**. Estas pruebas no
 * juzgan si el TypeScript es correcto —hay rarezas ahi que nadie ha escrito en
 * ningun lado, y estan anotadas como [OJO] en la migracion—; juzgan si la
 * aritmetica sobrevivio intacta al cambio de lugar.
 *
 * Las vistas se leen por `lib/vistas.ts`, que es el modulo tipado que creo esta
 * misma sesion. Ninguna pantalla lo importa todavia; esta prueba si, para que
 * no nazca como codigo muerto que nadie ejecuta.
 *
 * Por que no es pura, por que lee con service role y por que vive en su propio
 * proyecto de Playwright: ver `tests/vistas-entorno.ts`.
 *
 * Sin credenciales se salta DICIENDO CUAL FALTA, nunca en rojo: el CI publico
 * no tiene ni base ni llaves.
 */

if (!correnLasDeEquivalencia()) {
  console.warn(`[playwright] Prueba de equivalencia de vistas desactivada. ${motivoDeSalto()}`)
}

/** Fila cruda de `finanzas_ledger`, con todo lo que necesitan las banderas. */
interface MovimientoCrudo {
  id: string
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  categoria_gasto: string | null
  descripcion: string | null
  status: string
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  id_entidad_relacionada: string | null
  fecha_movimiento: string | null
  /** D112: solo existe despues de aplicar la migracion `d112`. */
  es_entrega_efectivo?: boolean | null
}

/**
 * Superficie minima para leer una tabla cualquiera por nombre. `Database` tipa
 * `.from()` con la union de sus nueve tablas, y aqui hace falta pasarle el
 * nombre como variable para no repetir el paginado cuatro veces.
 */
type LectorSuelto = {
  from(tabla: string): {
    select(columnas: string): {
      range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
    }
  }
}

test.describe('Vistas canonicas: equivalencia con el TypeScript', () => {
  test.skip(!correnLasDeEquivalencia(), motivoDeSalto())

  // El ledger completo se relee varias veces; 30 s no alcanzan.
  test.setTimeout(120_000)

  // ─── Cifras de control del README ─────────────────────────────────────────
  // ACTUALIZADAS EL 2026-09-05, de 84 / 468 / 61 / 386_201 a las de abajo.
  //
  // No se movieron por ningun cambio de codigo: entro **una venta real** el
  // 2026-09-03 15:55 UTC — CEO Admin -> Aeropuerto, $8,832.00 CONTADO, ticket
  // 408465a4, capturada por normancantu@gmail.com. Cuadra exactamente:
  // 386,201 + 8,832 = 395,033, y con ella +1 ticket, +1 fila de finanzas y
  // +6 de inventario.
  //
  // Estas constantes son la linea base de una prueba, no la verdad del negocio:
  // cada venta nueva las mueve. Cuando `npm run verificar` falle aqui, lo
  // primero es comprobar que la diferencia sea explicable por ventas reales
  // (`SELECT ... FROM transacciones_tickets ORDER BY fecha_transaccion DESC`)
  // ANTES de actualizarlas. Subirlas sin mirar convierte esta prueba en un
  // sello de goma.
  const PISO_FINANZAS_FILAS = 120
  const PISO_INVENTARIO_FILAS = 474
  const PISO_TICKETS_FILAS = 62
  const PISO_VENTAS_ACUMULADAS = 395_033

  // ─── Casos con nombre y apellido ──────────────────────────────────────────
  const DELIRIO_85 = 'Delirio 85'
  const DAVID_FLORES = 'David Flores'
  const AEROPUERTO = 'Aeropuerto'
  const MARTIN_REYES = 'Martin Reyes'

  // `centavos` y la aritmetica de fechas en hora de Mexico viven en
  // `tests/invariantes-vistas.ts` (Fase 7, D58): las usa tambien la prueba pura
  // de eventos, y una regla escrita dos veces se desincroniza.

  let db: SupabaseClient<Database>
  let crudo: LectorSuelto

  // Filas crudas: la ENTRADA de las funciones de TypeScript.
  let entidades: { id: string; nombre: string; rol: string }[]
  let ticketsTodos: (TicketSaldoInput & { id: string; status: string | null })[]
  let finanzasTodas: MovimientoCrudo[]
  let inventarioTodo: {
    tipo_movimiento: string | null
    cantidad: number | null
    status: string | null
    id_entidad_origen: string | null
    id_entidad_destino: string | null
    fecha_movimiento: string | null
  }[]
  let cuentasAdmin: string[]

  /**
   * Paginado a mano: PostgREST corta en 1000 filas sin avisar y un ledger
   * truncado no da error, da una cifra falsa. Es la misma razon por la que
   * existe `fetchTodasLasFilas` en `lib/dashboard-utils.ts`.
   */
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

    ticketsTodos = await traerTodo(
      'transacciones_tickets',
      'id, condicion_pago, id_comprador, monto_base_ingreso, total_cobrado_real, status'
    )

    // FASE 11 (D112): `*` y no una lista, a proposito. `es_entrega_efectivo`
    // decide si un ABONO_DEUDA paga concesion; con la lista vieja, el dia que
    // entre la primera entrega la vista la excluiria y `construirCartera` no la
    // veria -> divergencia. Con `*` la columna llega cuando exista y antes no rompe.
    finanzasTodas = await traerTodo('finanzas_ledger', '*')

    inventarioTodo = await traerTodo(
      'inventario_ledger',
      'tipo_movimiento, cantidad, status, id_entidad_origen, id_entidad_destino, fecha_movimiento'
    )

    // Las cuentas del ADMIN: el `adminAccountSet` del Account_Firewall,
    // resuelto igual que `fetchAdminCuentasRows` en lib/dashboard-utils.ts.
    const idsAdmin = new Set(entidades.filter((e) => e.rol === 'ADMIN').map((e) => e.id))
    const cuentas = await traerTodo<{ id: string; id_entidad: string | null }>(
      'cuentas_financieras',
      'id, id_entidad'
    )
    cuentasAdmin = cuentas.filter((c) => c.id_entidad && idsAdmin.has(c.id_entidad)).map((c) => c.id)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 0. Las cifras de control. Si estas se movieron, nada de lo de abajo
  //    significa nada: se estaria comparando contra una base distinta.
  // ══════════════════════════════════════════════════════════════════════════
  test('pisos de control: los contadores no decrecen (append-only)', () => {
    const ventasAcumuladas = ticketsTodos.reduce(
      (suma, t) => suma + Number(t.total_cobrado_real || 0),
      0
    )

    expect(finanzasTodas.length, 'filas totales en finanzas_ledger').toBeGreaterThanOrEqual(
      PISO_FINANZAS_FILAS
    )
    expect(inventarioTodo.length, 'filas totales en inventario_ledger').toBeGreaterThanOrEqual(
      PISO_INVENTARIO_FILAS
    )
    expect(ticketsTodos.length, 'tickets totales').toBeGreaterThanOrEqual(PISO_TICKETS_FILAS)
    expect(
      centavos(ventasAcumuladas),
      'ventas acumuladas, anulados incluidos'
    ).toBeGreaterThanOrEqual(centavos(PISO_VENTAS_ACUMULADAS))

    // Lo que crecio desde el piso, dicho en voz alta. No falla la prueba: es el
    // dato con el que se decide si vale la pena subir el piso.
    console.log(
      `[pisos] finanzas ${finanzasTodas.length}/${PISO_FINANZAS_FILAS} · ` +
        `inventario ${inventarioTodo.length}/${PISO_INVENTARIO_FILAS} · ` +
        `tickets ${ticketsTodos.length}/${PISO_TICKETS_FILAS} · ` +
        `ventas ${ventasAcumuladas.toFixed(2)}/${PISO_VENTAS_ACUMULADAS.toFixed(2)}`
    )
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 1. v_saldo_entidad  vs  lib/distribuidores-saldos.ts
  // ══════════════════════════════════════════════════════════════════════════
  test.describe('v_saldo_entidad', () => {
    /**
     * El universo de finanzas del directorio y del perfil:
     * `status IN ('ACTIVO','APPROVED')`.
     * (distribuidores/page.tsx:209 · distribuidores/[id]/page.tsx:272 + filtro)
     */
    const contables = (): FinanzaSaldoInput[] =>
      finanzasTodas
        .filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')
        .map((f) => ({
          tipo_movimiento: f.tipo_movimiento,
          monto: Number(f.monto),
          id_entidad_relacionada: f.id_entidad_relacionada,
          categoria: f.categoria
        }))

    /**
     * Transcripcion del KPI "Total Ganado" de `calcularSaldos`
     * (app/dashboard/distribuidores/[id]/page.tsx:625-645). **No se importa
     * porque esa funcion no se exporta**: vive dentro del componente de pagina.
     * Es la unica pieza de estas pruebas que se copia en vez de llamarse, y
     * queda anotada como tal en el resumen de la sesion.
     */
    const totalGanadoComoEnElPerfil = (idEntidad: string): number =>
      finanzasTodas
        .filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')
        .filter(
          (f) => f.tipo_movimiento === 'INGRESO_COMISION' || f.tipo_movimiento === 'COMISION_PASIVA'
        )
        .filter((f) => f.id_entidad_relacionada === idEntidad)
        .reduce((suma, f) => suma + Number(f.monto), 0)

    test('una fila por entidad, y coincide al centavo con el TypeScript', async () => {
      const vista = await leerSaldosEntidad(db)
      expect(vista.length, 'v_saldo_entidad debe tener una fila por entidad').toBe(entidades.length)

      const finanzas = contables()

      for (const entidad of entidades) {
        const fila = vista.find((f) => f.id_entidad === entidad.id)
        expect(fila, `falta la fila de ${entidad.nombre} en v_saldo_entidad`).toBeTruthy()

        const nodo = { id: entidad.id, rol: entidad.rol as EntidadRolSaldo }

        const saldoTs = calcularSaldoPendienteInventarioConsignacion(
          nodo,
          ticketsTodos,
          [entidad.id],
          finanzas
        )
        const porPagarTs = calcularSaldoPorPagarEfectivo(entidad.id, finanzas)
        const ganadoTs = totalGanadoComoEnElPerfil(entidad.id)

        expect(
          centavos(Number(fila!.saldo_pendiente_consignacion)),
          `saldo pendiente de ${entidad.nombre}`
        ).toBe(centavos(saldoTs))

        expect(
          centavos(Number(fila!.saldo_por_pagar_efectivo)),
          `saldo por pagar (efectivo) de ${entidad.nombre}`
        ).toBe(centavos(porPagarTs))

        expect(
          centavos(Number(fila!.total_ganado_comisiones)),
          `total ganado de ${entidad.nombre}`
        ).toBe(centavos(ganadoTs))
      }
    })

    /**
     * ERP-78: el caso conserva su cifra historica como PISO, no como igualdad.
     * Delirio 85 debia $19,476.00 el 2026-09-02; si compra otra vez sube, y la
     * prueba no tiene por que romperse por eso. Lo que no puede pasar es que
     * BAJE sin abonos que lo expliquen, y de eso se encarga la aritmetica.
     */
    test('Delirio 85: saldo consistente y nunca por debajo de su piso historico', async () => {
      const vista = await leerSaldosEntidad(db)
      const fila = vista.find((f) => f.nombre === DELIRIO_85)
      expect(fila, 'no aparece Delirio 85').toBeTruthy()

      const generada = Number(fila!.deuda_generada_tickets)

      // Fase 7, D58: era `generada - abonos = saldo`, sin CARGO_DEUDA. Un cargo
      // (evento normal: `app/actions/abonos.ts:569`) la tumbaba. La resta
      // completa vive en `violacionesSaldo`.
      expect(violacionesSaldo([fila!]), 'generada + cargos - abonos = saldo').toEqual([])
      expect(centavos(generada), 'lo generado no puede decrecer').toBeGreaterThanOrEqual(
        centavos(19_476)
      )
    })

    /**
     * David Flores: los dos numeros del caso, y por que no son el mismo.
     *
     * El prompt de esta sesion pedia "saldo pendiente $58,000.00 despues de la
     * correccion de sus 2 tickets". $58,000.00 es lo que sus tickets de
     * consignacion GENERARON; su saldo pendiente es eso menos $52,539.07 de
     * abonos aprobados, o sea **$5,460.93** — que es exactamente la cifra que
     * dejo escrita la migracion que corrigio los dos tickets
     * (`20260902210527_...sql`: "de $850.90 a $5,460.93").
     *
     * Se prueban los DOS, cada uno en su columna, para que no vuelva a
     * confundirse el bruto con el neto.
     */
    test('David Flores: el bruto no es el neto, y los dos cuadran entre si', async () => {
      const vista = await leerSaldosEntidad(db)
      const fila = vista.find((f) => f.nombre === DAVID_FLORES)
      expect(fila, 'no aparece David Flores').toBeTruthy()

      const generada = Number(fila!.deuda_generada_tickets)
      const abonos = Number(fila!.abonos_aprobados)

      // Lo que NO se pudre: la relacion entre las columnas — con CARGO_DEUDA
      // (Fase 7, D58: sin cargos, un cargo a David la tumbaba).
      expect(violacionesSaldo([fila!]), 'generada + cargos - abonos = saldo').toEqual([])

      // Los literales del caso quedan como piso. El 2026-09-07 le entro un
      // ticket de concesion de $3,552.00 (`5dd65509`), y con la igualdad vieja
      // eso rompia el push: una venta real tumbando la red del repo.
      expect(centavos(generada), 'lo generado por tickets no decrece').toBeGreaterThanOrEqual(
        centavos(58_000)
      )
      expect(centavos(abonos), 'los abonos aprobados no decrecen').toBeGreaterThanOrEqual(
        centavos(52_539.07)
      )
    })

    /**
     * Aeropuerto pago $6 de mas. El saldo tiene que quedar en **-6.00**: si
     * saliera positivo, seria redondeo inventado tapando un pago excedente, y
     * el nodo apareceria debiendo dinero que ya pago.
     */
    test('Aeropuerto pago $6 de mas: el saldo queda en -$6.00, no en positivo', async () => {
      const vista = await leerSaldosEntidad(db)
      const fila = vista.find((f) => f.nombre === AEROPUERTO)
      expect(fila, 'no aparece Aeropuerto').toBeTruthy()

      // La invariante es el NO REDONDEO, no el -6.00 de aquel dia: mientras
      // haya pagado de mas, el saldo tiene que seguir negativo y cuadrar. Las
      // dos reglas (con CARGO_DEUDA, Fase 7 D58) viven en `violacionesSaldo`.
      expect(violacionesSaldo([fila!]), 'cuadra, y un pago de mas queda negativo').toEqual([])
    })

    /**
     * Antes afirmaba "el Eden nunca abono" y se puso roja el 2026-09-22 sin que
     * cambiara una linea de codigo: Norman registro un abono REAL de $5,413.00.
     * Tercera vez que un hecho de produccion escrito como `expect` tumba el push
     * (2026-09-07, 2026-09-17). La invariante no es de una entidad: es que en
     * TODA fila "sin abonos" y "sin fecha de abono" van juntos, y el saldo cuadra
     * con la resta completa (tickets + cargos - abonos; con solo tickets - abonos
     * Martin Reyes, que tiene CARGO_DEUDA, sale rojo — medido el 2026-09-22).
     */
    test('saldos: sin abonos no hay fecha ni dias; con abonos si, y el saldo cuadra', async () => {
      const vista = await leerSaldosEntidad(db)
      expect(vista.length, 'la vista vino vacia').toBeGreaterThan(0)

      // Fase 7, D59: la misma funcion corre sobre fixtures "despues del evento"
      // en `tests/invariantes-eventos.spec.ts`.
      expect(violacionesSaldo(vista), 'invariantes de v_saldo_entidad').toEqual([])
    })

    /**
     * Martin Reyes no abona desde el 2026-06-16. La fecha se comprueba en hora
     * de Mexico, que es como Norman cuenta los dias: un abono es del dia en que
     * lo cobro, no del dia UTC en que quedo guardado.
     */
    test('Martin Reyes: los dias sin abonar se cuentan en hora de Mexico', async () => {
      const vista = await leerSaldosEntidad(db)
      const fila = vista.find((f) => f.nombre === MARTIN_REYES)
      expect(fila, 'no aparece Martin Reyes').toBeTruthy()
      expect(fila!.ultimo_abono, 'Martin Reyes tiene que tener un abono').toBeTruthy()

      // ERP-78: la fecha del ultimo abono era un literal ('2026-06-16'), o sea
      // que el dia que Martin abone, esta prueba tumba el push por una cobranza
      // exitosa. Lo que se comprueba es la CONVERSION, no la fecha: los dias de
      // la vista tienen que salir del abono contado en hora de Mexico.
      //
      // Fase 7, D58: "hoy" era `new Date()` —el reloj de NODE— contra el `now()`
      // de la BASE con que la vista conto. A las 23:59:59 de Mexico salia roja
      // sin defecto. Ahora "hoy" es `calculado_en` de la misma fila. Y ya no es
      // solo Martin: toda fila con abono.
      expect(violacionesDiasSinAbonar([fila!]), 'Martin Reyes · dias en hora de Mexico').toEqual([])
      expect(violacionesDiasSinAbonar(vista), 'toda fila con abono').toEqual([])
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 2. v_stock_por_cubeta  vs  getStockPorCubetaPorEntidad
  // ══════════════════════════════════════════════════════════════════════════
  test('v_stock_por_cubeta coincide con getStockPorCubetaPorEntidad, entidad por entidad', async () => {
    const vista = await leerStockPorCubeta(db)
    let filasComparadas = 0

    for (const entidad of entidades) {
      // La MISMA funcion que usa la auditoria fisica, sin reimplementar nada.
      const { stockPagado, stockConsignado } = await getStockPorCubetaPorEntidad(entidad.id)

      const esperado = new Map<string, number>()
      for (const fila of stockPagado) esperado.set(`PAGADO|${fila.idProducto}`, fila.stockEsperado)
      for (const fila of stockConsignado) {
        esperado.set(`CONSIGNADO|${fila.idProducto}`, fila.stockEsperado)
      }

      const obtenido = new Map<string, number>()
      for (const fila of vista.filter((f) => f.id_entidad === entidad.id)) {
        obtenido.set(`${fila.cubeta}|${fila.id_producto}`, Number(fila.stock))
      }

      expect(
        [...obtenido.keys()].sort(),
        `${entidad.nombre}: la vista y el motor de auditoria no listan las mismas cubetas/productos`
      ).toEqual([...esperado.keys()].sort())

      for (const [clave, cantidad] of esperado) {
        expect(obtenido.get(clave), `${entidad.nombre} · ${clave}`).toBeCloseTo(cantidad, 4)
        filasComparadas += 1
      }
    }

    // Que la comparacion no haya pasado por estar vacia de los dos lados.
    expect(filasComparadas, 'la comparacion de stock no puede estar vacia').toBeGreaterThan(0)
    expect(vista.length, 'toda fila de la vista tiene que haberse comparado').toBe(filasComparadas)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 3. v_movimiento_clasificado  vs  el Account_Firewall
  // ══════════════════════════════════════════════════════════════════════════
  test('v_movimiento_clasificado: las cuatro banderas, movimiento por movimiento', async () => {
    const vista = await leerMovimientosClasificados(db)

    expect(vista.length, 'la vista no filtra filas: una por movimiento del ledger').toBe(
      finanzasTodas.length
    )

    const setAdmin = new Set(cuentasAdmin)
    expect(setAdmin.size, 'sin cuentas del ADMIN el firewall no prueba nada').toBeGreaterThan(0)

    const porId = new Map(vista.map((f) => [f.id, f]))

    for (const mov of finanzasTodas) {
      const fila = porId.get(mov.id)
      expect(fila, `falta el movimiento ${mov.id} en v_movimiento_clasificado`).toBeTruthy()

      const toca = movimientoTocaCuentaAdmin(mov, setAdmin)
      const contable = movimientoContableEfectivo(mov.status, mov.categoria)
      const ingreso =
        toca && contable && ['INGRESO_VENTA', 'ABONO_DEUDA'].includes(mov.tipo_movimiento ?? '')
      const cuentaEgreso = resolveCuentaEgresoAdmin({
        tipo_movimiento: mov.tipo_movimiento ?? '',
        id_cuenta_origen: mov.id_cuenta_origen,
        id_cuenta_destino: mov.id_cuenta_destino
      })
      const egreso =
        toca &&
        contable &&
        esTipoEgresoAdmin(mov.tipo_movimiento ?? '') &&
        cuentaEgreso != null &&
        setAdmin.has(cuentaEgreso)

      expect(fila!.toca_cuenta_admin, `toca_cuenta_admin de ${mov.id}`).toBe(toca)
      expect(fila!.es_contable_efectivo, `es_contable_efectivo de ${mov.id}`).toBe(contable)
      expect(fila!.es_ingreso_admin, `es_ingreso_admin de ${mov.id}`).toBe(ingreso)
      expect(fila!.es_egreso_admin, `es_egreso_admin de ${mov.id}`).toBe(egreso)
    }

    // Y el firewall completo, no solo fila por fila.
    const firewallTs = filtrarMovimientosFirewallAdmin(finanzasTodas, cuentasAdmin)
    expect(
      vista.filter((f) => f.toca_cuenta_admin).length,
      'el conteo del firewall tiene que ser el mismo'
    ).toBe(firewallTs.length)

    // Que las banderas no sean todas false ni todas true: eso pasaria si la
    // vista fallara abierta o cerrada del todo y la prueba no lo veria.
    const tocan = vista.filter((f) => f.toca_cuenta_admin).length
    expect(
      tocan,
      'ninguna fila toca cuenta admin: el firewall estaria fallando cerrado'
    ).toBeGreaterThan(0)
    expect(
      tocan,
      'todas las filas tocan cuenta admin: el firewall no estaria filtrando'
    ).toBeLessThan(vista.length)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 4. v_pasivo_fiscal  vs  calcularPasivosFiscalesAdmin
  // ══════════════════════════════════════════════════════════════════════════
  test('v_pasivo_fiscal coincide con calcularPasivosFiscalesAdmin', async () => {
    const vista = await leerPasivoFiscal(db)
    expect(vista, 'v_pasivo_fiscal tiene que devolver su unica fila').toBeTruthy()

    const esperado = calcularPasivosFiscalesAdmin(
      finanzasTodas.map((f) => ({
        tipo_movimiento: f.tipo_movimiento ?? '',
        status: f.status,
        id_cuenta_origen: f.id_cuenta_origen,
        id_cuenta_destino: f.id_cuenta_destino,
        categoria_gasto: f.categoria_gasto,
        descripcion: f.descripcion,
        monto: Number(f.monto),
        categoria: f.categoria,
        fecha_movimiento: f.fecha_movimiento ?? ''
      })),
      cuentasAdmin
    )

    expect(centavos(Number(vista!.iva_por_pagar)), 'IVA por pagar').toBe(
      centavos(esperado.ivaPorPagar)
    )
    expect(centavos(Number(vista!.ieps_por_pagar)), 'IEPS por pagar').toBe(
      centavos(esperado.iepsPorPagar)
    )

    // Y las piezas de la resta, una por una: si el acumulado y los pagos
    // cuadran por separado, la resta no puede cuadrar por casualidad.
    const setAdmin = new Set(cuentasAdmin)
    const activos = finanzasTodas.filter(
      (f) =>
        f.status === 'ACTIVO' &&
        f.categoria !== 'ABONO_PENDIENTE' &&
        movimientoTocaCuentaAdmin(f, setAdmin)
    )
    const suma = (predicado: (f: MovimientoCrudo) => boolean): number =>
      activos.filter(predicado).reduce((total, f) => total + Math.abs(Number(f.monto)), 0)

    const comoMov = (f: MovimientoCrudo) => ({
      tipo_movimiento: f.tipo_movimiento ?? '',
      categoria: f.categoria,
      categoria_gasto: f.categoria_gasto,
      descripcion: f.descripcion
    })

    expect(centavos(Number(vista!.pasivo_iva_acumulado)), 'PASIVO_IVA acumulado').toBe(
      centavos(suma((f) => f.tipo_movimiento === 'PASIVO_IVA'))
    )
    expect(centavos(Number(vista!.pasivo_ieps_acumulado)), 'PASIVO_IEPS acumulado').toBe(
      centavos(suma((f) => f.tipo_movimiento === 'PASIVO_IEPS'))
    )
    expect(centavos(Number(vista!.pagos_iva)), 'pagos de IVA').toBe(
      centavos(suma((f) => esPagoImpuestoIva(comoMov(f))))
    )
    expect(centavos(Number(vista!.pagos_ieps)), 'pagos de IEPS').toBe(
      centavos(suma((f) => esPagoImpuestoIeps(comoMov(f))))
    )
  })

  /**
   * HUECO DE COBERTURA, ESCRITO PARA QUE NO SE OLVIDE.
   *
   * Hoy las cuatro filas PASIVO_IVA / PASIVO_IEPS de la base estan ANULADO, y
   * ningun GASTO_OPERATIVO lleva texto de pago de impuesto. O sea: la prueba de
   * arriba compara **0 contra 0**. Eso demuestra que el filtro de status
   * coincide, pero NO ejercita ni la acumulacion ni el reconocimiento por texto
   * (`FUGA_FISCAL_IVA` / `PAGO IVA`), que es la parte fragil.
   *
   * Esta prueba deja el hecho asentado. El dia que se registre un pasivo vivo
   * fallara, y obligara a mirar de verdad la equivalencia de `v_pasivo_fiscal`
   * en vez de dar por buena una comparacion vacia.
   *
   * Fase 7, D58: ESO ERA EL DEFECTO. Una venta FULL_TAX (`lib/venta-servidor.ts:
   * 758-759`) escribe PASIVO_IVA ACTIVO y tumbaba el push por una venta
   * legitima. Ahora es un AVISO: sale en la consola de la suite y en las
   * anotaciones, en los dos sentidos (0 contra 0 = hueco; vivos = mirar la
   * equivalencia de arriba la primera vez). No bloquea.
   */
  test('v_pasivo_fiscal: aviso de si la comparacion es 0 contra 0', () => {
    const pasivosVivos = finanzasTodas.filter(
      (f) =>
        (f.tipo_movimiento === 'PASIVO_IVA' || f.tipo_movimiento === 'PASIVO_IEPS') &&
        f.status === 'ACTIVO'
    )
    const comoMov = (f: MovimientoCrudo) => ({
      tipo_movimiento: f.tipo_movimiento ?? '',
      categoria: f.categoria,
      categoria_gasto: f.categoria_gasto,
      descripcion: f.descripcion
    })
    const pagosVivos = finanzasTodas.filter(
      (f) =>
        f.status === 'ACTIVO' &&
        (esPagoImpuestoIva(comoMov(f)) || esPagoImpuestoIeps(comoMov(f)))
    )

    avisar(test.info(), avisoPasivoFiscal(pasivosVivos.length, pagosVivos.length))
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 5. v_cartera  vs  construirCartera
  // ══════════════════════════════════════════════════════════════════════════
  test('v_cartera coincide con construirCartera, fila por fila', async () => {
    const vista = await leerCartera(db)
    expect(vista.length, 'v_cartera no puede estar vacia').toBeGreaterThan(0)

    // `hoy` se toma del reloj de la BASE, no del de Node: si la prueba corre
    // justo al cruzar la medianoche de Mexico, los dias tienen que contarse
    // desde el mismo instante en los dos lados.
    const hoy = new Date(vista[0].calculado_en).toISOString()

    const filasTs: FilaCartera[] = construirCartera({
      entidades: entidades.map((e) => ({ id: e.id, nombre: e.nombre, rol: e.rol })),
      inventario: inventarioTodo,
      tickets: ticketsTodos,
      // construirCartera filtra por `status !== 'ANULADO'` por su cuenta.
      finanzas: finanzasTodas.map((f) => ({
        tipo_movimiento: f.tipo_movimiento,
        monto: Number(f.monto),
        id_entidad_relacionada: f.id_entidad_relacionada,
        categoria: f.categoria,
        status: f.status,
        fecha_movimiento: f.fecha_movimiento ?? undefined
      })),
      hoy
    })

    expect(vista.length, 'la vista y construirCartera listan distinto numero de nodos').toBe(
      filasTs.length
    )

    // `leerCartera` ordena con el mismo criterio que `construirCartera`
    // (prioridad, deuda, nombre): las dos listas tienen que ir en paralelo.
    expect(
      vista.map((f) => f.nombre),
      'el orden de visita tiene que ser el mismo'
    ).toEqual(filasTs.map((f) => f.nombre))

    for (const esperada of filasTs) {
      const fila = vista.find((f) => f.id_entidad === esperada.id)
      expect(fila, `falta ${esperada.nombre} en v_cartera`).toBeTruthy()
      const donde = esperada.nombre

      expect(Number(fila!.recibidas), `${donde} · recibidas`).toBe(esperada.recibidas)
      expect(Number(fila!.salidas), `${donde} · salidas`).toBe(esperada.salidas)
      expect(Number(fila!.libro_dice), `${donde} · libro dice`).toBe(esperada.libroDice)
      expect(centavos(Number(fila!.generado)), `${donde} · generado`).toBe(centavos(esperada.generado))
      expect(centavos(Number(fila!.abonado)), `${donde} · abonado`).toBe(centavos(esperada.abonado))
      expect(centavos(Number(fila!.deuda)), `${donde} · deuda`).toBe(centavos(esperada.deuda))
      expect(Number(fila!.estimado_en_piso), `${donde} · estimado en piso`).toBe(
        esperada.estimadoEnPiso
      )
      expect(fila!.referencia_dias, `${donde} · referencia de dias`).toBe(esperada.referenciaDias)
      expect(
        fila!.dias_sin_abono === null ? null : Number(fila!.dias_sin_abono),
        `${donde} · dias sin abono`
      ).toBe(esperada.diasSinAbono)
      expect(centavos(Number(fila!.prioridad)), `${donde} · prioridad`).toBe(
        centavos(esperada.prioridad)
      )

      if (esperada.porcentajePagado === null) {
        expect(fila!.porcentaje_pagado, `${donde} · % pagado debe ser "no aplica"`).toBeNull()
      } else {
        expect(Number(fila!.porcentaje_pagado), `${donde} · % pagado`).toBeCloseTo(
          esperada.porcentajePagado,
          10
        )
      }
    }
  })

  /**
   * Antes esta prueba exigia `deuda === 3_610`, la cifra que tenia el Eden el
   * 2026-07-21. Se puso roja el 2026-09-17 sin que nada estuviera mal: el
   * 2026-09-15 entro una venta REAL de $1,803 en concesion y la deuda paso a
   * $5,413. Anclar una constante de produccion en una prueba la convierte en
   * una alarma que suena cada vez que el negocio funciona.
   *
   * La invariante -que es lo que de verdad se queria medir- es que quien nunca
   * abono debe EXACTAMENTE lo que genero. Eso no caduca, y ademas es mas
   * fuerte que la constante: se rompe si la vista suma mal, cosa que un
   * `3_610` escrito a mano no podia ver.
   */
  //
  // Y el 2026-09-22 se volvio a poner roja por la misma clase de causa: el Eden
  // ABONO ($5,413.00, real). "Nunca abono" era un hecho, no una invariante. Ahora
  // la regla se afirma sobre toda fila que la cumpla, sin nombrar a nadie. Si un
  // dia ninguna fila esta sin abonos, el ciclo no afirma nada: la cobertura
  // celda por celda de `porcentaje_pagado` la da la equivalencia de arriba.
  test('v_cartera: quien no ha abonado debe todo lo generado y va en 0%, no en null', async () => {
    const vista = await leerCartera(db)
    expect(vista.length, 'la cartera vino vacia').toBeGreaterThan(0)

    // `porcentaje_pagado` es una FRACCION 0-1 pese al nombre (E-243): lo que se
    // vigila es que un deudor sin abonos diga 0 y no null (`Number(null)` da 0 y
    // dejaria pasar justo el null). La regla vive en `violacionesCarteraSinAbonos`.
    const { violaciones, cubiertas } = violacionesCarteraSinAbonos(vista)
    expect(violaciones, 'quien no ha abonado debe todo y va en 0%').toEqual([])
    // Invariante condicional (Fase 7, D58): si ninguna fila la cumple, no afirma
    // nada, y eso se DICE, no pasa callado.
    if (cubiertas === 0) {
      avisar(
        test.info(),
        'v_cartera: ninguna fila esta sin abonos con deuda; la regla "sin abonos = 0%" no ' +
          'cubrio a nadie en produccion (la cubre tests/invariantes-eventos.spec.ts con fixtures).'
      )
    } else {
      console.log(`[invariantes] v_cartera sin abonos: ${cubiertas} fila(s) cubierta(s)`)
    }
  })
})
