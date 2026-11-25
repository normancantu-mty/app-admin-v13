/**
 * LA SALIDA DE INVENTARIO EN CASCADA (merma, devolucion fisica, salida por
 * venta o concesion) — el nucleo que comparten la web y el bot (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 3). Es el cuerpo de `registrarSalidaCascada` (`app/actions/inventario.ts`)
 * movido aqui SIN cambiar su regla: la accion de la web conserva la sesion y el
 * `revalidatePath`, y llama a esta funcion; el bot (`/api/bot/merma/confirmar`)
 * llama a la MISMA. Dos copias de "de que cubeta sale" divergen el dia que una
 * corrige un caso de borde y la otra no.
 *
 * La regla: primero sale de lo PAGADO y lo que falte de lo CONSIGNADO
 * (`calcularDeduccionCascada`). Si no alcanza, SE ESCRIBE IGUAL (2026-11-24,
 * regla de Norman): el faltante queda en PAGADO, negativo, y sale el aviso W20.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, TablesInsert } from '@/types/database'
import type { Cubeta } from '@/lib/inventario-types'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import { calcularDeduccionCascada } from '@/lib/inventario-auditoria'
import { faltanteDeStock, mensajeFaltaStock, notaCorteLocal } from '@/lib/aviso-stock'
import { conTope } from '@/lib/venta-servidor'
import { registrarAviso } from '@/lib/avisos-server'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'

type InventarioInsert = TablesInsert<'inventario_ledger'>

export type TipoSalidaCascada = 'SALIDA_VENTA' | 'MERMA' | 'DEVOLUCION_FISICA' | 'SALIDA_CONCESION'
export const TIPOS_SALIDA_CASCADA: readonly TipoSalidaCascada[] = ['SALIDA_VENTA', 'MERMA', 'DEVOLUCION_FISICA', 'SALIDA_CONCESION']

/** Las cinco columnas del ledger que decide la cascada. Ver ERP-25. */
interface MovimientoCascadaRow {
  tipo_movimiento: string | null
  cantidad: number | null
  cubeta: string | null
  id_entidad_destino: string | null
  id_entidad_origen: string | null
}

export interface SalidaCascada {
  id_entidad: string
  id_producto: string
  cantidad_a_deducir: number
  tipo_movimiento: TipoSalidaCascada
  /** El autor: la sesion en la web, `telegram:<etiqueta>` en el bot. Nunca el cliente. */
  usuario_creador: string
  notas?: string | null
  /** El bot necesita el id para su marca; la web no lo pide (su insert sigue igual). */
  devolverIds?: boolean
}

export type ResultadoSalidaCascada =
  | { success: true; data: InventarioInsert[]; ids: string[]; avisoStock?: string | null }
  | { success: false; error: string }

/**
 * El stock de UN producto en UNA entidad, por cubeta, CON SU SIGNO: un saldo
 * negativo se dice negativo (quien reparte lo trata como 0). ERP-25: paginado — aqui el truncamiento decide CUANTO se
 * resta y DE QUE cubeta.
 */
export async function leerStockParaCascada(
  supabase: SupabaseClient<Database>,
  idEntidad: string,
  idProducto: string
): Promise<{ pagado: number; consignado: number }> {
  const movimientos = await fetchTodasLasFilas<MovimientoCascadaRow>(
    () =>
      supabase
        .from('inventario_ledger')
        .select('tipo_movimiento, cantidad, cubeta, id_entidad_destino, id_entidad_origen')
        .eq('status', 'ACTIVO')
        .eq('id_producto', idProducto)
        .or(`id_entidad_destino.eq.${idEntidad},id_entidad_origen.eq.${idEntidad}`),
    'deduccionCascada: inventario_ledger'
  )

  let pagado = 0
  let consignado = 0
  for (const mov of movimientos) {
    const cubeta = mov.cubeta as Cubeta
    if (cubeta !== 'PAGADO' && cubeta !== 'CONSIGNADO') continue
    const cantidad = Number(mov.cantidad) || 0
    const esEntradaEntidad = mov.id_entidad_destino === idEntidad && isTipoMovimientoEntrada(mov.tipo_movimiento)
    const esSalidaEntidad = mov.id_entidad_origen === idEntidad && isTipoMovimientoSalida(mov.tipo_movimiento)
    const delta = esEntradaEntidad ? cantidad : esSalidaEntidad ? -cantidad : 0
    if (cubeta === 'PAGADO') pagado += delta
    else consignado += delta
  }
  return { pagado, consignado }
}

/** El W20 de una salida. No lanza y va con tope: la salida ya entro y esto solo avisa. */
async function avisarFaltante(
  supabase: SupabaseClient<Database>,
  salida: SalidaCascada,
  stock: { pagado: number; consignado: number }
): Promise<string | null> {
  const faltante = faltanteDeStock(stock.pagado + stock.consignado, salida.cantidad_a_deducir)
  if (!faltante) return null
  let pieza = salida.id_producto
  let lugar = salida.id_entidad
  let rol: string | null | undefined
  try {
    const [producto, entidad] = await conTope(
      Promise.all([
        supabase.from('catalogo_productos').select('nombre').eq('id', salida.id_producto).maybeSingle(),
        supabase.from('entidades').select('nombre, rol').eq('id', salida.id_entidad).maybeSingle()
      ])
    )
    pieza = producto.data?.nombre || pieza
    lugar = entidad.data?.nombre || lugar
    rol = entidad.data?.rol
  } catch {
    // Sin nombre se avisa con el id: peor seria callar.
  }
  const faltantes = [{ idProducto: salida.id_producto, pieza, ...faltante }]
  const mensaje = mensajeFaltaStock('La salida', lugar, faltantes, [notaCorteLocal(rol)])
  await conTope(
    registrarAviso(supabase, {
      tipo: 'W20',
      idEntidad: salida.id_entidad,
      mensaje,
      datosCapturados: { tipo_movimiento: salida.tipo_movimiento, usuario: salida.usuario_creador, faltantes }
    })
  ).catch((e) => console.error('W20: no se pudo avisar', mensaje, e))
  return mensaje
}

export async function escribirSalidaCascada(
  supabase: SupabaseClient<Database>,
  salida: SalidaCascada
): Promise<ResultadoSalidaCascada> {
  try {
    const { id_entidad, id_producto, cantidad_a_deducir, tipo_movimiento, usuario_creador } = salida

    if (!id_entidad) return { success: false, error: 'id_entidad vacío' }
    if (!id_producto) return { success: false, error: 'id_producto vacío' }
    if (!TIPOS_SALIDA_CASCADA.includes(tipo_movimiento)) {
      return { success: false, error: 'tipo_movimiento inválido para deducción en cascada.' }
    }
    if (!Number.isFinite(cantidad_a_deducir) || cantidad_a_deducir <= 0) {
      return { success: false, error: 'cantidad_a_deducir debe ser un número mayor a cero.' }
    }

    const stock = await leerStockParaCascada(supabase, id_entidad, id_producto)
    const { deduccionPagado, deduccionConsignado } = calcularDeduccionCascada({
      cantidadDeducir: cantidad_a_deducir,
      stockPagadoActual: stock.pagado,
      stockConsignadoActual: stock.consignado
    })

    const payloadArray: InventarioInsert[] = []
    const base = {
      id_producto,
      id_entidad_origen: id_entidad,
      tipo_movimiento,
      usuario_creador,
      ...(salida.notas ? { notas: salida.notas } : {})
    }
    if (deduccionPagado > 0) payloadArray.push({ ...base, cubeta: 'PAGADO', cantidad: deduccionPagado })
    if (deduccionConsignado > 0) payloadArray.push({ ...base, cubeta: 'CONSIGNADO', cantidad: deduccionConsignado })

    if (payloadArray.length === 0) {
      return { success: false, error: 'No se generó ninguna deducción de inventario.' }
    }

    // `tipo_movimiento` aqui es una variable, no un literal: el compilador no
    // puede saber si la entidad que trae le corresponde. Por eso la puerta.
    exigirEntidadDelMovimiento(payloadArray, 'inventario.deduccionCascada')

    // UN solo INSERT (tests/inventario-invariante.spec.ts los cuenta). La web
    // no pide ids y su peticion sale igual que antes; el bot pide `.select('id')`.
    const insercion = supabase.from('inventario_ledger').insert(payloadArray)
    if (!salida.devolverIds) {
      const { error: insertError } = await insercion
      if (insertError) return { success: false, error: insertError.message }
      return { success: true, data: payloadArray, ids: [], avisoStock: await avisarFaltante(supabase, salida, stock) }
    }
    const { data, error } = await insercion.select('id')
    if (error || !data || data.length !== payloadArray.length) {
      return { success: false, error: error?.message ?? 'No se escribieron todas las filas.' }
    }
    return {
      success: true,
      data: payloadArray,
      ids: data.map((f) => f.id),
      avisoStock: await avisarFaltante(supabase, salida, stock)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error inesperado al registrar salida en cascada.'
    return { success: false, error: message }
  }
}
