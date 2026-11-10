import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida, isTipoMovimientoTraslado } from './inventario-types'
import {
  esAbonoPendienteAprobacion,
  esPagoImpuestoIeps,
  esPagoImpuestoIva,
  movimientoContableEfectivo
} from './finance-utils'
import { limitesRangoMX } from './date-format'
import { fetchTodasLasFilas, type ConsultaPaginable } from './paginacion'
// La flecha va en ESTE sentido y solo en este: `lib/vistas.ts` no importa a
// `dashboard-utils`, que es server-only por `next/headers`; importarlo desde
// alla volveria server-only tambien la lectura de las vistas. Aqui, al reves,
// no cuesta nada: este modulo ya lo es.
import { leerSaldosEntidad } from './vistas'
import { diasDesde } from './actividad'
import { leerUltimaActividadRed } from './actividad-servidor'

// Re-exportado a propósito: las pantallas piden el rango a dashboard-utils, y la
// única implementación vive en date-format.ts junto con los límites del rango.
export { calcularFechasPorRango, limitesRangoMX } from './date-format'

/**
 * **Este modulo es server-only** (importa `next/headers`). No lo importes desde
 * un componente con `'use client'`: es un Client Boundary Error fatal.
 *
 * Cliente por request con la sesion del usuario. Antes este archivo usaba el
 * cliente de navegador de `lib/supabase.ts`; en un Server Component ese cliente
 * no ve las cookies de Next, viaja como `anon`, y desde que se cerro la lectura
 * anonima **cada consulta del Dashboard General devolvia
 * `permission denied for table ...`**. Los `try/catch` se lo tragaban y la
 * pantalla pintaba ceros. Mismo patron que ya usan `inventario/page.tsx` y
 * `feed/page.tsx`.
 */
async function getSupabaseServer() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        }
      }
    }
  )
}

/**
 * Días sin actividad que pintan el semáforo. **Un solo umbral para todo el ERP**
 * (antes: 15/30 en el Dashboard General y 7/14 en el directorio, para la misma
 * entidad el mismo día). Se conserva 7/14, que es el que Norman ve a diario en
 * el directorio (`getSemaforoMovimiento` en `lib/risk-utils.ts`).
 */
export const DIAS_SEMAFORO_AMARILLO = 7
export const DIAS_SEMAFORO_ROJO = 14

/**
 * La paginación vive en `lib/paginacion.ts` y desde aquí se **re-exporta**.
 *
 * Por qué re-exportada y no mudada a secas: cuatro pantallas y `risk-utils` la
 * importan desde este módulo, y `lib/vistas.ts` mantenía su propia copia
 * (`leerTodo`) porque no puede importar `dashboard-utils` sin volverse
 * server-only. Ahora la implementación es UNA y las dos puertas siguen
 * abiertas. Ver ERP-25 y `tests/paginacion-ledger.spec.ts`.
 */
export { fetchTodasLasFilas } from './paginacion'

/**
 * Filas de `v_movimiento_clasificado` para el periodo pedido.
 *
 * **Aqui es donde el Account_Firewall dejo de recalcularse en memoria.** Antes
 * cada funcion de este archivo resolvia la entidad ADMIN, sus cuentas y despues
 * filtraba fila por fila con `filtrarMovimientosFirewallAdmin`: tres consultas
 * y una copia del firewall por tablero. La vista trae las banderas ya puestas y
 * **falla cerrada igual** — quien no ve las cuentas del ADMIN obtiene `false`
 * en las cuatro, que es lo mismo que devolvia el filtro con la lista vacia.
 *
 * `filtrarMovimientosFirewallAdmin` y `movimientoTocaCuentaAdmin` NO se borran:
 * son la referencia contra la que `tests/vistas-equivalencia.spec.ts` compara la
 * vista, movimiento por movimiento.
 *
 * La vista no filtra fechas a proposito: el corte lo pone quien consulta, y es
 * el mismo `limitesRangoMX` de siempre.
 */
async function fetchMovimientosClasificados(
  fechaInicio?: string,
  fechaFin?: string
): Promise<MovimientoClasificadoDashboard[]> {
  const supabase = await getSupabaseServer()
  const { desde, hastaExclusivo } = limitesRangoMX(fechaInicio, fechaFin)

  return fetchTodasLasFilas<MovimientoClasificadoDashboard>(() => {
    let query = supabase
      .from('v_movimiento_clasificado')
      .select(
        'tipo_movimiento, monto, categoria, fecha_movimiento, id_cuenta_destino, ' +
          'id_cuenta_origen, toca_cuenta_admin, es_contable_efectivo, es_ingreso_admin, es_egreso_admin'
      )

    if (desde && hastaExclusivo) {
      query = query.gte('fecha_movimiento', desde).lt('fecha_movimiento', hastaExclusivo)
    }

    return query as unknown as ConsultaPaginable<MovimientoClasificadoDashboard>
  }, 'v_movimiento_clasificado')
}

export interface DesgloseIngresos {
  ventaRed: number
  ventaDirecta: number
  abonos: number
}

export interface DesgloseEgresos {
  insumos: number
  renta: number
  logistica: number
  otros: number
}

export interface FinanzasDashboard {
  totalIngresos: number
  totalEgresos: number
  desgloseIngresos: DesgloseIngresos
  desgloseEgresos: DesgloseEgresos
}

export interface EntidadLiderazgo {
  id: string
  nombre: string
  rol: string
  patrocinador: string | null
  ingresoNetoEmpresa: number
  /** Mercancía en consignación pendiente de liquidar. Mismo número (y misma
   *  función) que "Saldo Pendiente" del directorio y del perfil. */
  saldoPendiente: number
  diasSinActividad: number
  ultimaActividad: string
}

export interface LiderazgoRed {
  nodosAlfa: EntidadLiderazgo[]
  subNodos: EntidadLiderazgo[]
}

export interface SemaforoAlerta {
  id: string
  nombre: string
  diasSinActividad: number
  saldoPendiente: number
}

export interface AlertaInventario {
  id: string
  nombre: string
  sku: string
  stockActual: number
  minimoRequerido: number
}

export interface AspectosUrgentes {
  semaforosRojos: SemaforoAlerta[]
  semaforosAmarillos: SemaforoAlerta[]
  alertasInventario: AlertaInventario[]
}

export interface LiquidezPorCuenta {
  EFECTIVO: number
  CUENTA_PERSONAL: number
  CUENTA_FRESNILLO: number
  /** v2: cuenta Transferencias del ADMIN (cobros por transferencia pendientes de convertir). */
  TRANSFERENCIAS: number
}

export interface PasivosFiscalesAdmin {
  ivaPorPagar: number
  iepsPorPagar: number
}

type MovimientoPasivoFiscal = {
  tipo_movimiento: string
  monto: number
  status: string
  categoria?: string | null
  categoria_gasto?: string | null
  descripcion?: string | null
  id_cuenta_destino: string | null
  id_cuenta_origen?: string | null
}

/** Ticket tal como lo lee el Liderazgo de Red (con condición y status). */
type TicketLiderazgo = {
  id_comprador: string | null
  monto_base_ingreso: number
  total_cobrado_real: number
  condicion_pago: string
  status: string | null
  fecha_transaccion: string
}

/** Fila de `v_movimiento_clasificado` tal como la leen los tableros. */
type MovimientoClasificadoDashboard = {
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  fecha_movimiento: string | null
  id_cuenta_destino: string | null
  id_cuenta_origen: string | null
  toca_cuenta_admin: boolean
  es_contable_efectivo: boolean
  es_ingreso_admin: boolean
  es_egreso_admin: boolean
}

export type MovimientoEgresoAdmin = {
  tipo_movimiento: string
  monto: number
  status: string
  categoria?: string | null
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
}

export const TIPOS_EGRESO_ADMIN = [
  'GASTO_OPERATIVO',
  'COMPRA_INSUMOS',
  'SUBSIDIO_FISCAL',
  'EGRESO_TRASPASO'
] as const

/**
 * **Account_Firewall — única implementación del ERP.**
 *
 * Un movimiento entra en cualquier KPI de nivel Admin sólo si toca una cuenta
 * del ADMIN por **origen o por destino**. Antes vivía copiada cuatro veces
 * (dos aquí, una en `getDesgloseCategorias` y otra en `finanzas/page.tsx`), y
 * una de las copias fallaba abierta.
 */
export function movimientoTocaCuentaAdmin(
  mov: { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null },
  adminAccountSet: Set<string>
): boolean {
  return (
    Boolean(mov.id_cuenta_destino && adminAccountSet.has(mov.id_cuenta_destino)) ||
    Boolean(mov.id_cuenta_origen && adminAccountSet.has(mov.id_cuenta_origen))
  )
}

/**
 * Aplica el firewall a una lista. **Falla cerrada:** si no se pudo resolver
 * ninguna cuenta del ADMIN, devuelve vacío. Devolver la lista completa —lo que
 * hacía `finanzas/page.tsx:70`— era publicar el ledger de toda la red.
 */
export function filtrarMovimientosFirewallAdmin<
  T extends { id_cuenta_destino?: string | null; id_cuenta_origen?: string | null }
>(movimientos: T[], adminAccountIds: string[]): T[] {
  if (adminAccountIds.length === 0) return []
  const adminAccountSet = new Set(adminAccountIds)
  return movimientos.filter((m) => movimientoTocaCuentaAdmin(m, adminAccountSet))
}

/**
 * Las tarjetas de egresos. `es_egreso_admin` trae tambien `EGRESO_TRASPASO` y su
 * pareja no esta en `es_ingreso_admin`: sumada tal cual, mover dinero entre dos
 * cuentas propias salia como gasto (2026-11-05). La vista se queda como esta,
 * que corregirla es migracion; aqui se filtra el lector.
 */
export function esEgresoDelPeriodo(m: { es_egreso_admin: boolean; tipo_movimiento: string | null }): boolean {
  return m.es_egreso_admin && m.tipo_movimiento !== 'EGRESO_TRASPASO'
}

/** Resuelve la cuenta admin afectada por un egreso (GASTO_OPERATIVO usa destino legacy). */
export function resolveCuentaEgresoAdmin(
  mov: Pick<MovimientoEgresoAdmin, 'tipo_movimiento' | 'id_cuenta_origen' | 'id_cuenta_destino'>
): string | null {
  if (mov.tipo_movimiento === 'GASTO_OPERATIVO' || mov.tipo_movimiento === 'EGRESO_TRASPASO') {
    return mov.id_cuenta_origen ?? mov.id_cuenta_destino
  }
  return mov.id_cuenta_origen ?? mov.id_cuenta_destino
}

export function esTipoEgresoAdmin(tipoMovimiento: string): boolean {
  return (
    TIPOS_EGRESO_ADMIN.includes(tipoMovimiento as (typeof TIPOS_EGRESO_ADMIN)[number]) ||
    tipoMovimiento.startsWith('EGRESO_') ||
    tipoMovimiento.startsWith('GASTO_') ||
    tipoMovimiento.startsWith('CARGO_')
  )
}

/** Egresos del periodo alineados con General Dashboard (cuentas admin). */
export function calcularEgresosAdmin(
  movimientos: MovimientoEgresoAdmin[],
  adminAccountIds: string[]
): number {
  if (adminAccountIds.length === 0) return 0

  const adminAccountSet = new Set(adminAccountIds)
  return movimientos
    .filter((m) => movimientoContableEfectivo(m.status, m.categoria))
    .filter((m) => esTipoEgresoAdmin(m.tipo_movimiento))
    .filter((m) => {
      const cuenta = resolveCuentaEgresoAdmin(m)
      return cuenta != null && adminAccountSet.has(cuenta)
    })
    .reduce((sum, m) => sum + m.monto, 0)
}

/** Pasivos fiscales netos = PASIVO_* acumulado − pagos GASTO_OPERATIVO de impuestos. */
export function calcularPasivosFiscalesAdmin(
  movimientos: MovimientoPasivoFiscal[],
  adminAccountIds: string[]
): PasivosFiscalesAdmin {
  if (adminAccountIds.length === 0) {
    return { ivaPorPagar: 0, iepsPorPagar: 0 }
  }

  const adminAccountSet = new Set(adminAccountIds)
  const movimientosActivos = movimientos.filter(
    (mov) =>
      mov.status === 'ACTIVO' &&
      !esAbonoPendienteAprobacion(mov.categoria) &&
      movimientoTocaCuentaAdmin(mov, adminAccountSet)
  )

  const pasivosIva = movimientosActivos
    .filter((mov) => mov.tipo_movimiento === 'PASIVO_IVA')
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pasivosIeps = movimientosActivos
    .filter((mov) => mov.tipo_movimiento === 'PASIVO_IEPS')
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pagosIva = movimientosActivos
    .filter((mov) => esPagoImpuestoIva(mov))
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  const pagosIeps = movimientosActivos
    .filter((mov) => esPagoImpuestoIeps(mov))
    .reduce((sum, mov) => sum + Math.abs(mov.monto), 0)

  return {
    ivaPorPagar: Math.max(0, pasivosIva - pagosIva),
    iepsPorPagar: Math.max(0, pasivosIeps - pagosIeps)
  }
}

/** Cuentas financieras del ADMIN (ids + nombre para buckets de liquidez). */
async function fetchAdminCuentasRows(): Promise<{ id: string; nombre: string; clase: string | null }[]> {
  const supabase = await getSupabaseServer()
  const { data: adminEntity, error: adminErr } = await supabase
    .from('entidades')
    .select('id')
    .eq('rol', 'ADMIN')
    .limit(1)
    .maybeSingle()

  if (adminErr || !adminEntity?.id) {
    if (adminErr) console.error('fetchAdminCuentasRows entidad:', adminErr.message)
    return []
  }

  const { data: cuentas, error: cuentasErr } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, clase')
    .eq('id_entidad', adminEntity.id)

  if (cuentasErr || !cuentas) {
    if (cuentasErr) console.error('fetchAdminCuentasRows cuentas:', cuentasErr.message)
    return []
  }

  return cuentas.map((c) => ({ id: c.id, nombre: c.nombre ?? '', clase: c.clase ?? null }))
}

/**
 * A que tarjeta de liquidez pertenece una cuenta del ADMIN, por su nombre.
 *
 * Exportada para que `tests/cableado-pantallas.spec.ts` compare las tres
 * tarjetas con ESTA funcion y no con una copia suya: una copia se desincroniza
 * en silencio y la prueba pasaria comparando dos errores distintos.
 */
export function clasificarCuentaLiquidezPorNombre(
  nombre: string,
  /**
   * v2: `cuentas_financieras.clase`. Si viene, MANDA sobre el nombre: la cuenta
   * PERSONAL se llama "Cuenta Gilberto" desde el 2026-10-29 y su nombre ya no dice
   * "personal". Sin clase (base vieja) se clasifica por nombre como antes.
   */
  clase?: string | null
): keyof LiquidezPorCuenta | null {
  const porClase: Record<string, keyof LiquidezPorCuenta> = {
    EFECTIVO: 'EFECTIVO',
    PERSONAL: 'CUENTA_PERSONAL',
    FISCAL: 'CUENTA_FRESNILLO',
    TRANSFERENCIAS: 'TRANSFERENCIAS'
  }
  if (clase && porClase[clase]) return porClase[clase]
  const cuentaUpper = String(nombre).toUpperCase()
  // v2: va primero; "Transferencias" no contiene ninguna otra subcadena, pero el
  // orden deja claro que una cuenta de transferencias nunca cae en EFECTIVO.
  if (cuentaUpper.includes('TRANSFERENCIA')) return 'TRANSFERENCIAS'
  if (cuentaUpper.includes('EFECTIVO') || cuentaUpper.includes('CAJA')) return 'EFECTIVO'
  if (cuentaUpper.includes('PERSONAL')) return 'CUENTA_PERSONAL'
  if (cuentaUpper.includes('FRESNILLO') || cuentaUpper.includes('EMPRESA')) return 'CUENTA_FRESNILLO'
  return null
}

/**
 * Ingresos y egresos del tablero, ya con el Account_Firewall aplicado.
 *
 * Antes: tres consultas (entidad ADMIN, sus cuentas, el ledger) y el firewall
 * armado a mano. Ahora: **una**, contra `v_movimiento_clasificado`. Las dos
 * banderas `es_ingreso_admin` / `es_egreso_admin` son la transcripcion literal
 * de los dos filtros que estaban aqui —tipo de movimiento, contabilidad
 * efectiva, firewall y `resolveCuentaEgresoAdmin`—, comprobada movimiento por
 * movimiento en `tests/vistas-equivalencia.spec.ts`.
 *
 * El desglose por categoria (venta red / venta directa / abonos · insumos /
 * renta / logistica) NO esta en ninguna vista: se sigue agrupando aqui, sobre
 * las filas que la vista ya clasifico. No es aritmetica del dinero, es la
 * misma suma partida por `categoria`.
 */
export async function getFinanzasDashboard(
  fechaInicio?: string,
  fechaFin?: string
): Promise<FinanzasDashboard> {
  try {
    const movimientos = await fetchMovimientosClasificados(fechaInicio, fechaFin)

    const ingresos = movimientos.filter((m) => m.es_ingreso_admin)
    const egresos = movimientos.filter(esEgresoDelPeriodo)

    const totalIngresos = ingresos.reduce((sum, m) => sum + m.monto, 0)
    const totalEgresos = egresos.reduce((sum, m) => sum + m.monto, 0)

    const ventaRed = ingresos
      .filter(m => m.tipo_movimiento === 'INGRESO_VENTA' && m.categoria === 'VENTA_RED')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const ventaDirecta = ingresos
      .filter(m => m.tipo_movimiento === 'INGRESO_VENTA' && m.categoria === 'VENTA_DIRECTA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const abonos = ingresos
      .filter(m => m.tipo_movimiento === 'ABONO_DEUDA')
      .reduce((sum, m) => sum + m.monto, 0)

    const insumos = egresos
      .filter(
        (m) =>
          m.categoria === 'INSUMOS' ||
          m.categoria === 'Insumos' ||
          m.tipo_movimiento === 'COMPRA_INSUMOS'
      )
      .reduce((sum, m) => sum + m.monto, 0)
    
    const renta = egresos
      .filter(m => m.categoria === 'RENTA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const logistica = egresos
      .filter(m => m.categoria === 'LOGISTICA')
      .reduce((sum, m) => sum + m.monto, 0)
    
    const otros = egresos
      .filter(
        (m) =>
          !['INSUMOS', 'Insumos', 'RENTA', 'LOGISTICA'].includes(String(m.categoria ?? '')) &&
          m.tipo_movimiento !== 'COMPRA_INSUMOS'
      )
      .reduce((sum, m) => sum + m.monto, 0)

    return {
      totalIngresos,
      totalEgresos,
      desgloseIngresos: { ventaRed, ventaDirecta, abonos },
      desgloseEgresos: { insumos, renta, logistica, otros }
    }
  } catch (error: any) {
    console.error('Error in getFinanzasDashboard:', error?.message, error?.details, error?.hint)
    return {
      totalIngresos: 0,
      totalEgresos: 0,
      desgloseIngresos: { ventaRed: 0, ventaDirecta: 0, abonos: 0 },
      desgloseEgresos: { insumos: 0, renta: 0, logistica: 0, otros: 0 }
    }
  }
}

export async function getLiquidezPorCuenta(
  fechaInicio?: string,
  fechaFin?: string
): Promise<LiquidezPorCuenta> {
  const resultado: LiquidezPorCuenta = {
    EFECTIVO: 0,
    CUENTA_PERSONAL: 0,
    CUENTA_FRESNILLO: 0,
    TRANSFERENCIAS: 0
  }

  try {
    // [HUECO] Ninguna vista dice a que tarjeta pertenece una cuenta: el reparto
    // en EFECTIVO / PERSONAL / FRESNILLO se hace por SUBCADENA del nombre de la
    // cuenta (`clasificarCuentaLiquidezPorNombre`), y `v_movimiento_clasificado`
    // solo lleva los ids. Por eso estas dos consultas siguen aqui. Lo que si se
    // fue es el firewall en memoria: lo pone la vista.
    //
    // Las dos lecturas no dependen una de otra: van en paralelo. En serie eran
    // tres viajes a Supabase (entidad -> cuentas -> movimientos) y cada viaje
    // de Vercel (iad1) a la base (us-west-1) cuesta una ida y vuelta completa.
    const [adminRows, data] = await Promise.all([
      fetchAdminCuentasRows(),
      fetchMovimientosClasificados(fechaInicio, fechaFin)
    ])

    const cuentaIdABucket = new Map<string, keyof LiquidezPorCuenta>()
    for (const row of adminRows) {
      const bucket = clasificarCuentaLiquidezPorNombre(row.nombre, row.clase)
      if (bucket) cuentaIdABucket.set(row.id, bucket)
    }

    // v2: SALDO_INICIAL es el saldo de arranque de la cuenta (misma regla que
    // public.saldo_cuenta en SQL). No es ingreso del periodo: solo liquidez.
    // AJUSTE_SALDO (2026-11-03): correccion del ADMIN, monto con signo hacia el destino.
    const tiposIngreso = new Set(['INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL', 'AJUSTE_SALDO'])
    const tiposEgreso = new Set([
      'GASTO_OPERATIVO',
      'CARGO_DEUDA',
      'SUBSIDIO_FISCAL',
      'COMPRA_INSUMOS',
      'EGRESO_TRASPASO'
    ])

    // Las dos condiciones que antes se armaban aqui —firewall y contabilidad
    // efectiva— vienen ya resueltas de la vista.
    const filas = data.filter((mov) => mov.toca_cuenta_admin && mov.es_contable_efectivo)

    filas.forEach((mov) => {
      const monto = Number(mov.monto) || 0

      if (tiposIngreso.has(mov.tipo_movimiento ?? '') && mov.id_cuenta_destino) {
        const bucket = cuentaIdABucket.get(mov.id_cuenta_destino)
        if (bucket) resultado[bucket] += monto
      }

      if (tiposEgreso.has(mov.tipo_movimiento ?? '')) {
        const cuentaId = resolveCuentaEgresoAdmin({
          tipo_movimiento: mov.tipo_movimiento ?? '',
          id_cuenta_origen: mov.id_cuenta_origen ?? null,
          id_cuenta_destino: mov.id_cuenta_destino ?? null
        })
        if (!cuentaId) return
        const bucket = cuentaIdABucket.get(cuentaId)
        if (bucket) resultado[bucket] -= monto
      }
    })

    return resultado
  } catch (error: any) {
    console.error('Error in getLiquidezPorCuenta:', error?.message, error?.details, error?.hint)
    return resultado
  }
}

/**
 * Liderazgo de red: el ingreso que cada nodo genero y lo que debe.
 *
 * **Sin parametros de fecha, y a proposito.** Los tenia y ningun llamador los
 * usaba nunca (`app/dashboard/general/page.tsx` la invoca sin argumentos): esta
 * tabla siempre fue historica. Dejarlos ahora seria una trampa, porque el saldo
 * pendiente ya viene de `v_saldo_entidad`, que no conoce periodos: una llamada
 * con rango habria mezclado tickets recortados con un saldo completo.
 *
 * La columna "Saldo Pendiente (consignacion)" ya no se calcula aqui: la trae
 * `v_saldo_entidad`, la misma fila que ven el directorio y el perfil. Antes esta
 * funcion se traia el `finanzas_ledger` entero para rehacer esa resta.
 */
export async function getLiderazgoRed(): Promise<LiderazgoRed> {
  try {
    const supabase = await getSupabaseServer()
    const { data: entidades, error: entidadesError } = await supabase
      .from('entidades')
      .select('id, nombre, rol, id_padre, id_nodo_padre, fecha_ultimo_seguimiento, ultimo_seguimiento')
      .neq('rol', 'ADMIN')

    if (entidadesError || !entidades) {
      console.error('Error fetching entidades:', entidadesError?.message, entidadesError?.details, entidadesError?.hint)
      return { nodosAlfa: [], subNodos: [] }
    }

    const [tickets, saldos, actividadPorNodo] = await Promise.all([
      fetchTodasLasFilas<TicketLiderazgo>(
        () =>
          supabase
            .from('transacciones_tickets')
            .select(
              'id_comprador, monto_base_ingreso, total_cobrado_real, condicion_pago, status, fecha_transaccion'
            ),
        'getLiderazgoRed tickets'
      ),
      leerSaldosEntidad(supabase),
      // Ronda 2 (auditoria 2026-10-29): la MISMA regla que el directorio (lib/actividad.ts).
      leerUltimaActividadRed(supabase, entidades)
    ])

    const saldoPorEntidad = new Map(saldos.map((fila) => [fila.id_entidad, fila]))

    const entidadesConMetricas: EntidadLiderazgo[] = entidades.map(entidad => {
      const ticketsVivos = tickets.filter(
        (t) => t.id_comprador === entidad.id && (t.status ?? 'ACTIVO') !== 'ANULADO'
      )
      const saldo = saldoPorEntidad.get(entidad.id)

      const ingresoNetoEmpresa = ticketsVivos.reduce((sum, t) => sum + (t.monto_base_ingreso || 0), 0)

      // Misma cifra que el directorio y que el perfil, ahora por la misma via:
      // solo mercancia en CONSIGNACION viva, mas CARGO_DEUDA, menos abonos ya
      // aprobados. Antes se rehacia aqui con `calcularSaldoPendienteInventarioConsignacion`.
      const saldoPendiente = Number(saldo?.saldo_pendiente_consignacion ?? 0)

      // v2, ronda 2 (auditoria 2026-10-29): la actividad y los dias salen de la regla
      // unica de `lib/actividad.ts` (la misma del directorio): movimientos vivos donde el
      // nodo es parte, sus tickets vivos, su seguimiento manual y el corte de arranque;
      // dias de calendario en hora de Mexico. 999 = nunca hubo nada.
      const ultimaActividad = actividadPorNodo.get(entidad.id) ?? null
      const diasSinActividad = diasDesde(ultimaActividad) ?? 999

      const parentId = entidad.id_nodo_padre ?? entidad.id_padre
      const padre = entidades.find(e => e.id === parentId)

      return {
        id: entidad.id,
        nombre: entidad.nombre,
        rol: entidad.rol,
        patrocinador: padre ? padre.nombre : null,
        ingresoNetoEmpresa,
        saldoPendiente,
        diasSinActividad,
        ultimaActividad: ultimaActividad ? ultimaActividad.toISOString() : ''
      }
    })

    const nodosAlfa = entidadesConMetricas
      .filter(e => !e.patrocinador)
      .sort((a, b) => b.ingresoNetoEmpresa - a.ingresoNetoEmpresa)

    const subNodos = entidadesConMetricas
      .filter(e => e.patrocinador)
      .sort((a, b) => b.ingresoNetoEmpresa - a.ingresoNetoEmpresa)

    return { nodosAlfa, subNodos }
  } catch (error: any) {
    console.error('Error in getLiderazgoRed:', error?.message, error?.details, error?.hint)
    return { nodosAlfa: [], subNodos: [] }
  }
}

/**
 * Alertas del panel derecho del Dashboard General.
 *
 * Recibe el liderazgo ya calculado: antes lo volvia a pedir aqui dentro, asi
 * que cada carga del General traia dos veces los tickets y el ledger completos.
 *
 * Acepta tambien la PROMESA del liderazgo: asi el ledger y el catalogo se piden
 * mientras el liderazgo todavia viaja, en vez de esperar a que llegue. Se
 * consume al final, que es donde se usa.
 */
export async function getAspectosUrgentes(
  liderazgoOPromesa: LiderazgoRed | PromiseLike<LiderazgoRed>
): Promise<AspectosUrgentes> {
  try {
    const supabase = await getSupabaseServer()
    const [inventarioLedger, { data: productos, error: productosError }, liderazgo] = await Promise.all([
      fetchTodasLasFilas<{
        id_producto: string
        tipo_movimiento: string
        cantidad: number
        status: string | null
      }>(
        () => supabase.from('inventario_ledger').select('id_producto, tipo_movimiento, cantidad, status'),
        'getAspectosUrgentes inventario'
      ),
      supabase.from('catalogo_productos').select('id, nombre, sku'),
      liderazgoOPromesa
    ])

    if (productosError) {
      console.error('Error fetching productos:', productosError?.message, productosError?.details, productosError?.hint)
    }

    const alertasInventario: AlertaInventario[] = []

    if (productos) {
      const stockPorProducto = new Map<string, number>()

      inventarioLedger.forEach(mov => {
        if (mov.status === 'ANULADO') return
        // Este total es GLOBAL: no mira entidad. Un traslado -una devolucion
        // fisica- no crea ni destruye producto, solo lo cambia de lugar, y como
        // esta en las dos listas el `if/else if` de abajo lo contaria como
        // entrada y inflaria el total. Aqui se salta a proposito.
        // Ver TIPOS_MOVIMIENTO_TRASLADO en lib/inventario-types.ts.
        if (isTipoMovimientoTraslado(mov.tipo_movimiento)) return
        const stockActual = stockPorProducto.get(mov.id_producto) || 0
        if (isTipoMovimientoEntrada(mov.tipo_movimiento)) {
          stockPorProducto.set(mov.id_producto, stockActual + mov.cantidad)
        } else if (isTipoMovimientoSalida(mov.tipo_movimiento)) {
          stockPorProducto.set(mov.id_producto, stockActual - mov.cantidad)
        }
      })

      stockPorProducto.forEach((stock, idProducto) => {
        if (stock < 20) {
          const producto = productos.find(p => p.id === idProducto)
          if (producto) {
            alertasInventario.push({
              id: producto.id,
              nombre: producto.nombre,
              sku: producto.sku,
              stockActual: stock,
              minimoRequerido: 20
            })
          }
        }
      })
    }

    const todasEntidades = [...liderazgo.nodosAlfa, ...liderazgo.subNodos]
    const aAlerta = (e: EntidadLiderazgo): SemaforoAlerta => ({
      id: e.id,
      nombre: e.nombre,
      diasSinActividad: e.diasSinActividad,
      saldoPendiente: e.saldoPendiente
    })

    const semaforosRojos: SemaforoAlerta[] = todasEntidades
      .filter(e => e.diasSinActividad > DIAS_SEMAFORO_ROJO)
      .map(aAlerta)

    const semaforosAmarillos: SemaforoAlerta[] = todasEntidades
      .filter(
        e => e.diasSinActividad >= DIAS_SEMAFORO_AMARILLO && e.diasSinActividad <= DIAS_SEMAFORO_ROJO
      )
      .map(aAlerta)

    return {
      semaforosRojos,
      semaforosAmarillos,
      alertasInventario
    }
  } catch (error: any) {
    console.error('Error in getAspectosUrgentes:', error?.message, error?.details, error?.hint)
    return {
      semaforosRojos: [],
      semaforosAmarillos: [],
      alertasInventario: []
    }
  }
}

/** Tipos que no deben inflar totales de categoría (doblete con ABONO / venta). */
const TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS = new Set([
  'INGRESO_COMISION',
  'DEUDA_A_MATRIZ',
  'COMISION_PASIVA',
  // Un traspaso no es ingreso ni gasto: solo cambia de cuenta.
  'INGRESO_TRASPASO',
  'EGRESO_TRASPASO'
])

/** Tipos que cuentan como entrada de dinero en el desglose por categoria. */
const TIPOS_INGRESO_DESGLOSE = new Set([
  'INGRESO_VENTA',
  'ABONO_DEUDA',
  'INGRESO_TRASPASO',
  'INGRESO'
])

export type GrupoCategoria = 'INGRESO' | 'EGRESO'

export interface CategoriaDesglose {
  categoria: string
  monto: number
  porcentaje: number
  grupo: GrupoCategoria
}

/**
 * Desglose por categoria de la pantalla de Finanzas.
 *
 * Dos correcciones respecto de la version anterior:
 * 1. **Ingresos y egresos ya no comparten total.** Antes se sumaban en un mismo
 *    denominador, asi que un peso cobrado y un peso gastado se cancelaban en el
 *    porcentaje y el total no era ni la caja ni el gasto: era la suma de los dos.
 * 2. **Se aplica `movimientoContableEfectivo`**, igual que las tarjetas de
 *    arriba en esa misma pantalla, para no colar `ABONO_PENDIENTE`.
 */
/**
 * @param aplicarFirewallAdmin `true` para que el desglose se limite a los
 *   movimientos que tocan una cuenta del ADMIN. Antes se recibia la LISTA de
 *   cuentas admin y se filtraba en memoria; ahora la condicion la trae la vista
 *   en `toca_cuenta_admin`, asi que basta el si o el no. Sigue fallando cerrado:
 *   si la sesion no ve las cuentas del ADMIN, la bandera es `false` en todas
 *   las filas y el desglose sale vacio, nunca con el ledger de la red.
 */
export async function getDesgloseCategorias(
  fechaInicio?: string,
  fechaFin?: string,
  aplicarFirewallAdmin?: boolean
): Promise<CategoriaDesglose[]> {
  try {
    const data = await fetchMovimientosClasificados(fechaInicio, fechaFin)

    const filtrados = data
      .filter((item) => item.es_contable_efectivo)
      .filter((item) => !TIPOS_EXCLUIR_DESGLOSE_CATEGORIAS.has(String(item.tipo_movimiento ?? '')))
      .filter((item) => (aplicarFirewallAdmin ? item.toca_cuenta_admin : true))

    const agrupar = (grupo: GrupoCategoria, filas: MovimientoClasificadoDashboard[]): CategoriaDesglose[] => {
      const total = filas.reduce((sum, item) => sum + item.monto, 0)
      const porCategoria = new Map<string, number>()

      filas.forEach((item) => {
        const categoria = item.categoria || 'Sin Categoría'
        porCategoria.set(categoria, (porCategoria.get(categoria) || 0) + item.monto)
      })

      const etiqueta = grupo === 'INGRESO' ? 'Ingreso' : 'Egreso'
      return Array.from(porCategoria.entries())
        .map(([categoria, monto]) => ({
          categoria: `${etiqueta} · ${categoria}`,
          monto,
          porcentaje: total > 0 ? Math.round((monto / total) * 100) : 0,
          grupo
        }))
        .sort((a, b) => b.monto - a.monto)
    }

    const esIngreso = (item: MovimientoClasificadoDashboard) =>
      TIPOS_INGRESO_DESGLOSE.has(String(item.tipo_movimiento ?? ''))

    return [
      ...agrupar('INGRESO', filtrados.filter(esIngreso)),
      ...agrupar('EGRESO', filtrados.filter((item) => !esIngreso(item)))
    ]
  } catch (error) {
    console.error('Error in getDesgloseCategorias:', error)
    return []
  }
}

/**
 * v2: metrica de transferencias (vista `v_transferencias_resumen`, una fila por
 * cuenta con clase TRANSFERENCIAS). Recibido / convertido / pendiente, en conteo
 * y en dinero. El conteo pendiente es FIFO: ver la migracion 20261028120300.
 */
export interface TransferenciasResumen {
  recibidasN: number
  recibidoMonto: number
  conversionesN: number
  convertidoMonto: number
  comisionMonto: number
  netoAEfectivo: number
  pendientesN: number
  pendienteMonto: number
}

export async function getTransferenciasResumen(): Promise<TransferenciasResumen | null> {
  try {
    const supabase = await getSupabaseServer()
    const { data, error } = await supabase.from('v_transferencias_resumen').select('*')
    if (error) {
      console.error('Error in getTransferenciasResumen:', error.message, error.details, error.hint)
      return null
    }
    if (!data || data.length === 0) return null
    const n = (v: number | null | undefined) => Number(v) || 0
    return data.reduce<TransferenciasResumen>(
      (acc, r) => ({
        recibidasN: acc.recibidasN + n(r.recibidas_n),
        recibidoMonto: acc.recibidoMonto + n(r.recibido_monto),
        conversionesN: acc.conversionesN + n(r.conversiones_n),
        convertidoMonto: acc.convertidoMonto + n(r.convertido_monto),
        comisionMonto: acc.comisionMonto + n(r.comision_monto),
        netoAEfectivo: acc.netoAEfectivo + n(r.neto_a_efectivo),
        pendientesN: acc.pendientesN + n(r.pendientes_n),
        pendienteMonto: acc.pendienteMonto + n(r.pendiente_monto)
      }),
      {
        recibidasN: 0, recibidoMonto: 0, conversionesN: 0, convertidoMonto: 0,
        comisionMonto: 0, netoAEfectivo: 0, pendientesN: 0, pendienteMonto: 0
      }
    )
  } catch (error: unknown) {
    console.error('Error in getTransferenciasResumen:', error instanceof Error ? error.message : error)
    return null
  }
}
