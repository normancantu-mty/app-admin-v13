/**
 * Lectura tipada de las **vistas canonicas** de Postgres.
 *
 * Las vistas viven en `supabase/migrations/20260902230000_vistas_canonicas.sql`
 * y reproducen, al peso, la aritmetica que hoy sigue calculandose en
 * TypeScript. Cada una dice en su `COMMENT ON VIEW` que funcion reproduce.
 *
 * **Hoy NADIE importa este modulo, y es a proposito.** Esta sesion movio la
 * aritmetica de lugar y probo que coincide; reescribir las pantallas para que
 * lean de aqui es otra sesion, con esas pruebas ya en verde.
 * [Filtro: DOC02 — YAGNI]
 *
 * Tres reglas de este archivo:
 *
 * 1. **No importa `lib/dashboard-utils.ts`.** Ese modulo es server-only
 *    (importa `next/headers`) y arrastrarlo aqui volveria server-only tambien
 *    a la lectura de las vistas, que es justo lo que van a necesitar el bot de
 *    Telegram y los reportes. Por eso la paginacion se importa de
 *    `lib/paginacion.ts` —que no depende de nada— y NO de `dashboard-utils`.
 *    Hasta ERP-25 estaba reimplementada aqui abajo en doce lineas; eran dos
 *    copias de la misma regla, que es una copia de mas.
 * 2. **El cliente se recibe, no se construye.** Ni `createBrowserClient` ni
 *    `createServerClient` ni service role: quien llama decide con que sesion
 *    lee, y las vistas —creadas con `security_invoker = true`— aplican el RLS
 *    de ESA sesion. Es la misma regla que dejo escrita el incidente del
 *    2026-09-02 y que vigila `tests/arquitectura.spec.ts`.
 * 3. **Si la consulta falla, se lanza.** Nunca un `[]` con cara de dato: eso
 *    es lo que dejo al Dashboard General pintando ceros durante dias.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from './paginacion'
import type { FilaEfectivo } from './bot-entrega'

// ─── Tipos de fila ──────────────────────────────────────────────────────────

/** Una fila de `v_saldo_entidad`. Reproduce `lib/distribuidores-saldos.ts`. */
export interface FilaSaldoEntidad {
  id_entidad: string
  nombre: string
  rol: string
  /** `calcularSaldoPendienteInventarioConsignacion`. Puede ser negativo (pago de mas). */
  saldo_pendiente_consignacion: number
  /** `calcularSaldoPorPagarEfectivo`. Positivo: el nodo debe. Negativo: saldo a favor. */
  saldo_por_pagar_efectivo: number
  /** INGRESO_COMISION + COMISION_PASIVA historicas. El KPI "Total Ganado". */
  total_ganado_comisiones: number
  /** ISO del ultimo abono aprobado. `null` si nunca abono. */
  ultimo_abono: string | null
  /** Dias de calendario en America/Mexico_City. `null` si nunca abono. */
  dias_sin_abonar: number | null
  /** Piezas del desglose, para auditar la resta sin abrir el codigo. */
  deuda_generada_tickets: number
  cargos_deuda: number
  abonos_aprobados: number
  calculado_en: string
}

/** Una fila de `v_stock_por_cubeta`. Reproduce `getStockPorCubetaPorEntidad`. */
export interface FilaStockPorCubeta {
  id_entidad: string
  entidad: string
  id_producto: string
  producto: string
  cubeta: 'PAGADO' | 'CONSIGNADO'
  /** Neto replayeado del ledger. La vista solo devuelve filas con stock > 0. */
  stock: number
}

/** Una fila de `v_movimiento_clasificado`. El Account_Firewall, ya calculado. */
export interface FilaMovimientoClasificado {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string | null
  monto: number
  categoria: string | null
  categoria_gasto: string | null
  descripcion: string | null
  status: string
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  id_entidad_relacionada: string | null
  id_ticket: string | null
  /** `movimientoTocaCuentaAdmin`: toca una cuenta del ADMIN por origen o destino. */
  toca_cuenta_admin: boolean
  /** `movimientoContableEfectivo`: impacta caja, saldos y KPIs. */
  es_contable_efectivo: boolean
  es_ingreso_admin: boolean
  es_egreso_admin: boolean
}

/** La unica fila de `v_pasivo_fiscal`. Reproduce `calcularPasivosFiscalesAdmin`. */
export interface FilaPasivoFiscal {
  iva_por_pagar: number
  ieps_por_pagar: number
  pasivo_iva_acumulado: number
  pasivo_ieps_acumulado: number
  pagos_iva: number
  pagos_ieps: number
  calculado_en: string
}

/**
 * Una fila de `v_cartera`. Reproduce `construirCartera` (`lib/cartera-utils.ts`).
 * Se llama `...Vista` para no chocar con la `FilaCartera` de ese modulo.
 */
export interface FilaCarteraVista {
  id_entidad: string
  nombre: string
  rol: 'DST' | 'LOC'
  recibidas: number
  salidas: number
  libro_dice: number
  generado: number
  abonado: number
  /**
   * ⚠️ **FRACCION 0-1, no un porcentaje**, pese al nombre. `0.757` es 75.7%.
   * Quien lo muestre multiplica por 100 — asi lo hace `formateaPorcentaje` en
   * la pantalla de Cartera. Omitirlo ya produjo un "1% pagado" donde lo real
   * era 75.7% (2026-09-12, E-243).
   *
   * `null` cuando no genero deuda: no es 0%, es "no aplica".
   */
  porcentaje_pagado: number | null
  estimado_en_piso: number
  deuda: number
  ultimo_abono: string | null
  dias_sin_abono: number | null
  referencia_dias: 'ABONO' | 'ENTREGA' | 'NINGUNA'
  /** deuda x dias. El orden de visita. */
  prioridad: number
  calculado_en: string
  /**
   * v2 (migracion 20261029120000): con quien es la deuda. `null` = la matriz; si
   * no, el id del padre en la red (el DST que le entrego). Opcional para que las
   * filas de prueba viejas sigan valiendo: ausente = la matriz.
   */
  id_acreedor?: string | null
}

/**
 * v2: la deuda de un local con su distribuidor NO es cartera de la matriz: el
 * distribuidor ya la debe en su propio renglon. Sumarla la cuenta dos veces
 * (19,382.00 en la carga conciliada del 2026-10-29).
 */
export function esDeudaConLaMatriz(fila: Pick<FilaCarteraVista, 'id_acreedor'>): boolean {
  return !fila.id_acreedor
}

// ─── Fontaneria ─────────────────────────────────────────────────────────────

/**
 * `types/database.ts` se genera desde el esquema y hoy trae
 * `Views: { [_ in never]: never }`: no conoce estas cinco vistas, asi que
 * `client.from('v_saldo_entidad')` no compila contra `SupabaseClient<Database>`.
 *
 * En vez de regenerar el archivo de tipos —que esta fuera del alcance de esta
 * sesion y traeria un diff enorme— el ensanche vive AQUI y en un solo sitio.
 * Las filas ya van tipadas a mano arriba, que es lo que ve quien llama.
 */
type ClienteConVistas = {
  from(vista: string): {
    select(columnas: string): {
      range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
      eq(columna: string, valor: string): {
        range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
      }
    }
  }
}

/**
 * Envoltorio de `fetchTodasLasFilas` para las vistas.
 *
 * Solo existe por el tipo: `ClienteConVistas` devuelve `unknown[]` —las vistas
 * no estan en `types/database.ts`, ver `ClienteConVistas` arriba— y el cast a
 * `T[]` se concentra aqui en vez de repetirse en cada lectura. La paginacion en
 * si ya no se reimplementa: es la de `lib/paginacion.ts` (ERP-25).
 */
async function leerTodo<T>(
  construir: () => { range(desde: number, hasta: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> },
  etiqueta: string
): Promise<T[]> {
  return (await fetchTodasLasFilas<unknown>(construir, etiqueta)) as T[]
}

function comoClienteConVistas(client: SupabaseClient<Database>): ClienteConVistas {
  return client as unknown as ClienteConVistas
}

// ─── Lecturas ───────────────────────────────────────────────────────────────

/**
 * Saldos de todas las entidades que la sesion pueda ver. Un DST ve la suya y
 * las de sus locales hijos; el ADMIN y el SOCIO ven las quince.
 */
export async function leerSaldosEntidad(
  client: SupabaseClient<Database>
): Promise<FilaSaldoEntidad[]> {
  const c = comoClienteConVistas(client)
  return leerTodo<FilaSaldoEntidad>(
    () => c.from('v_saldo_entidad').select('*'),
    'v_saldo_entidad'
  )
}

/** El saldo de UN nodo. `null` si no existe o si la sesion no puede verlo. */
export async function leerSaldoEntidad(
  client: SupabaseClient<Database>,
  idEntidad: string
): Promise<FilaSaldoEntidad | null> {
  const c = comoClienteConVistas(client)
  const filas = await leerTodo<FilaSaldoEntidad>(
    () => c.from('v_saldo_entidad').select('*').eq('id_entidad', idEntidad),
    'v_saldo_entidad'
  )
  return filas[0] ?? null
}

/**
 * Stock por entidad x producto x cubeta. Sin `idEntidad` devuelve toda la red
 * visible. Solo salen filas con stock mayor que cero: es lo que hace
 * `getStockPorCubetaPorEntidad`, y por eso un nodo en ceros no aparece.
 */
export async function leerStockPorCubeta(
  client: SupabaseClient<Database>,
  idEntidad?: string
): Promise<FilaStockPorCubeta[]> {
  const c = comoClienteConVistas(client)
  return leerTodo<FilaStockPorCubeta>(
    () =>
      idEntidad
        ? c.from('v_stock_por_cubeta').select('*').eq('id_entidad', idEntidad)
        : c.from('v_stock_por_cubeta').select('*'),
    'v_stock_por_cubeta'
  )
}

/**
 * Movimientos de `finanzas_ledger` con las banderas del firewall calculadas.
 *
 * **La vista no filtra fechas a proposito**: el periodo lo pone quien
 * consulta, y asi el tablero, el reporte semanal y el bot de Telegram cortan
 * igual sin que ninguno reinvente el corte.
 */
export async function leerMovimientosClasificados(
  client: SupabaseClient<Database>
): Promise<FilaMovimientoClasificado[]> {
  const c = comoClienteConVistas(client)
  return leerTodo<FilaMovimientoClasificado>(
    () => c.from('v_movimiento_clasificado').select('*'),
    'v_movimiento_clasificado'
  )
}

/**
 * IVA e IEPS por pagar de la matriz. Una sola fila.
 *
 * Falla cerrada: quien no puede ver las cuentas del ADMIN obtiene ceros, no el
 * pasivo de la red. Es el mismo criterio de `filtrarMovimientosFirewallAdmin`.
 */
export async function leerPasivoFiscal(
  client: SupabaseClient<Database>
): Promise<FilaPasivoFiscal | null> {
  const c = comoClienteConVistas(client)
  const filas = await leerTodo<FilaPasivoFiscal>(
    () => c.from('v_pasivo_fiscal').select('*'),
    'v_pasivo_fiscal'
  )
  return filas[0] ?? null
}

/**
 * La cartera: a quien visitar, cuanto tiene y cuanto debe.
 *
 * La vista NO ordena. `construirCartera` ordena por prioridad (deuda x dias),
 * luego por deuda y luego por nombre en español; `ordenarCartera` reproduce
 * ese orden aqui para que la lista no dependa del plan del planificador.
 */
export async function leerCartera(
  client: SupabaseClient<Database>
): Promise<FilaCarteraVista[]> {
  const c = comoClienteConVistas(client)
  const filas = await leerTodo<FilaCarteraVista>(
    () => c.from('v_cartera').select('*'),
    'v_cartera'
  )
  return ordenarCartera(filas)
}

/**
 * FASE 11 (D112): `v_efectivo_por_entregar`. **Tolerante a proposito:** la
 * vista nace con la migracion `d112`, que no esta aplicada cuando este codigo
 * se escribe. Si no existe, devuelve `null` y quien llama deja la nota de
 * siempre (`NOTA_EFECTIVO_NO_SEPARABLE`) en vez de reventar la consulta entera.
 * Cualquier OTRO error si revienta: no se esconde.
 */
export async function leerEfectivoPorEntregar(
  client: SupabaseClient<Database>
): Promise<FilaEfectivo[] | null> {
  const c = comoClienteConVistas(client)
  try {
    return await leerTodo<FilaEfectivo>(() => c.from('v_efectivo_por_entregar').select('*'), 'v_efectivo_por_entregar')
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e)
    if (esVistaQueNoExiste(texto)) return null
    throw e
  }
}

/** PostgREST dice que la vista no esta en su cache, o Postgres que no existe. */
export function esVistaQueNoExiste(texto: string): boolean {
  return /does not exist|Could not find the table|schema cache|42P01|PGRST205/i.test(texto)
}

/** Mismo criterio de orden que `construirCartera`: prioridad, deuda, nombre. */
export function ordenarCartera(filas: FilaCarteraVista[]): FilaCarteraVista[] {
  return [...filas].sort((a, b) => {
    if (b.prioridad !== a.prioridad) return b.prioridad - a.prioridad
    if (b.deuda !== a.deuda) return b.deuda - a.deuda
    return a.nombre.localeCompare(b.nombre, 'es')
  })
}

/**
 * El pie de tabla de la cartera: la misma suma que `totalesCartera`
 * (lib/cartera-utils.ts), sobre las filas de la vista.
 *
 * Vive aqui y no en la pagina para que **nadie fuera de este modulo tenga que
 * saber que `libro_dice` es el `libroDice` de antes**. No recalcula nada: suma
 * las cuatro columnas que ya vienen calculadas de Postgres.
 */
export function totalesCarteraVista(filas: FilaCarteraVista[]) {
  // `deuda` = por cobrar DE LA MATRIZ. La de los locales con su distribuidor va
  // aparte (`deudaConDistribuidor`) y no se suma: ver `esDeudaConLaMatriz`.
  return filas.reduce(
    (acc, fila) => {
      const conMatriz = esDeudaConLaMatriz(fila)
      return {
        recibidas: acc.recibidas + Number(fila.recibidas),
        libroDice: acc.libroDice + Number(fila.libro_dice),
        estimadoEnPiso: acc.estimadoEnPiso + Number(fila.estimado_en_piso),
        deuda: acc.deuda + (conMatriz ? Number(fila.deuda) : 0),
        deudaConDistribuidor: acc.deudaConDistribuidor + (conMatriz ? 0 : Number(fila.deuda)),
        nodosConDistribuidor: acc.nodosConDistribuidor + (conMatriz ? 0 : 1)
      }
    },
    { recibidas: 0, libroDice: 0, estimadoEnPiso: 0, deuda: 0, deudaConDistribuidor: 0, nodosConDistribuidor: 0 }
  )
}

// ─── v_ventas_por_mes ───────────────────────────────────────────────────────

/**
 * Una fila de `v_ventas_por_mes`. **No reproduce ninguna funcion de
 * TypeScript**, a diferencia de las otras cinco: este dato no se calculaba en
 * ningun lado porque no se enseñaba en ningun lado.
 */
export interface FilaVentasPorMes {
  /** Primer dia del mes, ya en hora de Mexico. `2026-08-01`. */
  mes: string
  tickets: number
  vendido: number
  vendido_contado: number | null
  vendido_concesion: number | null
  tickets_concesion: number
  /** Cuantos compradores distintos hubo ese mes. */
  compradores: number
}

/**
 * La venta mes a mes, del mas reciente al mas viejo.
 *
 * **La agrupacion por mes la hace Postgres, no este codigo, y es a proposito:**
 * `fecha_transaccion` es `timestamptz` y agruparla en JavaScript la meteria en
 * el huso del servidor —que en Vercel es UTC—, moviendo cada venta de la tarde
 * al mes siguiente. Ese error ya se cometio una vez midiendo a mano.
 */
export async function leerVentasPorMes(
  client: SupabaseClient<Database>
): Promise<FilaVentasPorMes[]> {
  const c = comoClienteConVistas(client)
  return leerTodo<FilaVentasPorMes>(
    () => c.from('v_ventas_por_mes').select('*'),
    'v_ventas_por_mes'
  )
}
