/**
 * Front v2 — lecturas de la base para las pantallas `/v2`. Escrito el 2026-10-29
 * por el ejecutor del Front v2 (lanzado por el Socio).
 *
 * Reusa lo que ya existe: `lib/vistas.ts` (v_cartera, v_stock_por_cubeta,
 * v_pasivo_fiscal, v_ventas_por_mes), la RPC `saldo_cuenta(uuid)` y la vista
 * `v_transferencias_resumen`. Lo unico que se lee directo de `finanzas_ledger`
 * son los movimientos de las cuentas de la matriz, con las columnas que la vista
 * clasificada no trae (subcategoria, usuario_creador).
 *
 * FALLA CERRADA: todo error se lanza. Nunca se pinta un cero por un permiso
 * negado (el incidente del 2026-09-02).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  leerCartera,
  leerPasivoFiscal,
  leerStockPorCubeta,
  leerVentasPorMes,
  type FilaCarteraVista,
  type FilaPasivoFiscal,
  type FilaStockPorCubeta,
  type FilaVentasPorMes
} from '@/lib/vistas'
import type { CategoriaLista, MovimientoDinero } from './dinero'

type Cliente = SupabaseClient<Database>
// Las vistas y la RPC v2 no estan todas en `types/database.ts` (parchado a mano):
// se leen con el cliente sin tipos y se tipan aqui, en la frontera.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteLibre = SupabaseClient<any>
const libre = (c: Cliente) => c as unknown as ClienteLibre

export type ClaseCuenta = 'EFECTIVO' | 'FISCAL' | 'PERSONAL' | 'TRANSFERENCIAS'

export interface CuentaMatriz {
  id: string
  nombre: string
  clase: ClaseCuenta | null
  tipo_fiscalidad: string | null
  solo_egresos: boolean
  saldo: number
}

/** Orden fijo de las tarjetas: el de la decision de Norman (4 cuentas). */
export const ORDEN_CLASES: ClaseCuenta[] = ['EFECTIVO', 'FISCAL', 'PERSONAL', 'TRANSFERENCIAS']

/** Slug de URL <-> clase. */
export const SLUG_CLASE: Record<string, ClaseCuenta> = {
  efectivo: 'EFECTIVO',
  fresnillo: 'FISCAL',
  gilberto: 'PERSONAL',
  transferencias: 'TRANSFERENCIAS'
}
export function slugDeClase(clase: ClaseCuenta | null): string {
  return Object.entries(SLUG_CLASE).find(([, c]) => c === clase)?.[0] ?? 'efectivo'
}

/** Las cuentas de las entidades ADMIN, con su saldo de `saldo_cuenta()`. */
export async function leerCuentasMatriz(client: Cliente): Promise<CuentaMatriz[]> {
  const db = libre(client)
  const { data: admins, error: e1 } = await db.from('entidades').select('id').eq('rol', 'ADMIN')
  if (e1) throw new Error(`entidades ADMIN: ${e1.message}`)
  const ids = (admins ?? []).map((a: { id: string }) => a.id)
  if (ids.length === 0) throw new Error('No hay entidad ADMIN: el tablero no tiene a quien leer')

  const { data: cuentas, error: e2 } = await db
    .from('cuentas_financieras')
    .select('id, nombre, clase, tipo_fiscalidad, solo_egresos')
    .in('id_entidad', ids)
  if (e2) throw new Error(`cuentas_financieras: ${e2.message}`)

  const conSaldo = await Promise.all(
    (cuentas ?? []).map(async (c: Omit<CuentaMatriz, 'saldo'>) => {
      const { data, error } = await db.rpc('saldo_cuenta', { p_id_cuenta: c.id })
      if (error) throw new Error(`saldo_cuenta(${c.nombre}): ${error.message}`)
      return { ...c, solo_egresos: Boolean(c.solo_egresos), saldo: Number(data) || 0 }
    })
  )
  return conSaldo.sort((a, b) => {
    const ia = a.clase ? ORDEN_CLASES.indexOf(a.clase) : 99
    const ib = b.clase ? ORDEN_CLASES.indexOf(b.clase) : 99
    return ia - ib || a.nombre.localeCompare(b.nombre, 'es')
  })
}

/** Movimientos de dinero que tocan alguna de las cuentas dadas (todas las filas, paginado). */
export async function leerMovimientosDeCuentas(client: Cliente, idsCuentas: string[]): Promise<MovimientoDinero[]> {
  if (idsCuentas.length === 0) return []
  const db = libre(client)
  const lista = idsCuentas.join(',')
  const filas = await fetchTodasLasFilas<MovimientoDinero>(
    () =>
      db
        .from('finanzas_ledger')
        .select(
          'id, tipo_movimiento, monto, status, categoria, subcategoria, categoria_gasto, descripcion, fecha_movimiento, id_cuenta_origen, id_cuenta_destino, id_entidad_relacionada, usuario_creador'
        )
        .or(`id_cuenta_origen.in.(${lista}),id_cuenta_destino.in.(${lista})`)
        .order('fecha_movimiento', { ascending: false })
        .order('id', { ascending: true }),
    'finanzas_ledger (cuentas de la matriz)'
  )
  return filas.map((f) => ({ ...f, monto: Number(f.monto) || 0 }))
}

export interface ResumenTransferencias {
  recibidasN: number
  recibidoMonto: number
  conversionesN: number
  convertidoMonto: number
  comisionMonto: number
  netoAEfectivo: number
  pendientesN: number
  pendienteMonto: number
}

export async function leerResumenTransferencias(client: Cliente): Promise<ResumenTransferencias | null> {
  const { data, error } = await libre(client).from('v_transferencias_resumen').select('*')
  if (error) throw new Error(`v_transferencias_resumen: ${error.message}`)
  if (!data || data.length === 0) return null
  const n = (v: unknown) => Number(v) || 0
  return data.reduce(
    (acc: ResumenTransferencias, r: Record<string, unknown>) => ({
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
      recibidasN: 0,
      recibidoMonto: 0,
      conversionesN: 0,
      convertidoMonto: 0,
      comisionMonto: 0,
      netoAEfectivo: 0,
      pendientesN: 0,
      pendienteMonto: 0
    }
  )
}

/**
 * La lista CERRADA de categorias de egreso (`categorias_movimiento`), con la
 * misma consulta que el formulario de gasto (`app/dashboard/finanzas/nuevo`):
 * tipo EGRESO, activas, por `orden`. Solo lectura. Falla cerrada.
 */
export async function leerCategoriasEgreso(client: Cliente): Promise<CategoriaLista[]> {
  const { data, error } = await libre(client)
    .from('categorias_movimiento')
    .select('categoria, subcategoria, orden')
    .eq('tipo', 'EGRESO')
    .eq('activa', true)
    .order('orden', { ascending: true })
  if (error) throw new Error(`categorias_movimiento: ${error.message}`)
  return (data ?? []).map((f: CategoriaLista) => ({ ...f, orden: Number(f.orden) || 0 }))
}

/** Nombres de entidades por id (para «Asignado a» y el acreedor de la cartera). */
export async function leerNombresEntidades(client: Cliente): Promise<Map<string, { nombre: string; rol: string }>> {
  const { data, error } = await libre(client).from('entidades').select('id, nombre, rol')
  if (error) throw new Error(`entidades: ${error.message}`)
  return new Map((data ?? []).map((e: { id: string; nombre: string; rol: string }) => [e.id, { nombre: e.nombre, rol: e.rol }]))
}

export interface EnvasadoFila {
  fecha: string
  botellas: number
  id_producto: string
}

export async function leerEnvasado(client: Cliente): Promise<EnvasadoFila[]> {
  return fetchTodasLasFilas<EnvasadoFila>(
    () => libre(client).from('lote_envasado').select('fecha, botellas, id_producto').order('id'),
    'lote_envasado'
  )
}

async function contar(client: Cliente, tabla: string): Promise<number> {
  const { count, error } = await libre(client).from(tabla).select('*', { count: 'exact', head: true })
  if (error) throw new Error(`${tabla}: ${error.message}`)
  return count ?? 0
}

export interface DatosTablero {
  cuentas: CuentaMatriz[]
  movimientos: MovimientoDinero[]
  transferencias: ResumenTransferencias | null
  pasivo: FilaPasivoFiscal | null
  cartera: FilaCarteraVista[]
  stockMatriz: FilaStockPorCubeta[]
  ventasPorMes: FilaVentasPorMes[]
  envasado: EnvasadoFila[]
  nombres: Map<string, { nombre: string; rol: string }>
  insumosEnNegativo: number
  conteosFisicos: number
  lotes: number
  categorias: CategoriaLista[]
}

/** Todo lo que pinta `/v2`, en paralelo. */
export async function leerTablero(client: Cliente): Promise<DatosTablero> {
  // A4 (paridad v2): una sola tanda. Los movimientos salen en cuanto llegan las
  // cuentas, en paralelo con todo lo demas (antes esperaban a que terminara la tanda).
  const cuentasP = leerCuentasMatriz(client)
  const movimientosP = cuentasP.then((cs) => leerMovimientosDeCuentas(client, cs.map((c) => c.id)))
  const [cuentas, movimientos, admins, transferencias, pasivo, cartera, stock, ventasPorMes, envasado, insumosEnNegativo, conteosFisicos, lotes, categorias] =
    await Promise.all([
      cuentasP,
      movimientosP,
      leerNombresEntidades(client),
      leerResumenTransferencias(client),
      leerPasivoFiscal(client),
      leerCartera(client),
      leerStockPorCubeta(client),
      leerVentasPorMes(client),
      leerEnvasado(client),
      contar(client, 'v_insumos_en_negativo'),
      contar(client, 'conteos_fisicos'),
      contar(client, 'lotes'),
      leerCategoriasEgreso(client)
    ])
  const idsAdmin = [...admins.entries()].filter(([, e]) => e.rol === 'ADMIN').map(([id]) => id)
  return {
    cuentas,
    movimientos,
    transferencias,
    pasivo,
    cartera,
    stockMatriz: stock.filter((s) => idsAdmin.includes(s.id_entidad)),
    ventasPorMes,
    envasado,
    nombres: admins,
    insumosEnNegativo,
    conteosFisicos,
    lotes,
    categorias
  }
}
