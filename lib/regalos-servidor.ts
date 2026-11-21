/**
 * REGALOS — el lado de servidor que comparten la web y el bot. Escrito el
 * 2026-11-20 por un ejecutor del Socio.
 *
 * `registrarRegalo` lee el stock (la MISMA `leerStockParaCascada` que usan la
 * merma y la venta), arma las filas con `armarFilasRegalo` (cascada que avisa
 * y no bloquea) y escribe TODO en una sola llamada a la RPC
 * `registrar_regalo` (encabezado + filas en una transaccion).
 *
 * Limite conocido (el mismo que `escribirSalidaCascada`): la lectura del stock
 * y la escritura son dos peticiones; dos salidas simultaneas de la misma celda
 * dejan el TOTAL exacto pero pueden repartir distinto entre PAGADO y
 * CONSIGNADO. No cambia lo que se regalo ni la cartera.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { leerStockParaCascada } from '@/lib/salida-cascada'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  armarCartera,
  armarFilasRegalo,
  juntarLineas,
  normalizarQuien,
  notaDeRegalo,
  validarSolicitudRegalo,
  type Cartera,
  type LineaCartera,
  type ProductoRegalo,
  type SolicitudRegalo,
  type StockCelda
} from '@/lib/regalos'

type Cliente = SupabaseClient<Database>

export async function leerProductosRegalo(supabase: Cliente): Promise<ProductoRegalo[]> {
  const { data, error } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, ml_por_unidad, costo_unitario')
    .eq('tipo', 'TERMINADO')
    .order('nombre')
  if (error) throw new Error(`catalogo_productos: ${error.message}`)
  return (data ?? []).map((p) => ({
    id: p.id,
    nombre: String(p.nombre ?? ''),
    ml_por_unidad: p.ml_por_unidad === null ? null : Number(p.ml_por_unidad),
    costo_unitario: p.costo_unitario === null ? null : Number(p.costo_unitario)
  }))
}

/** La entidad de la matriz (rol ADMIN): de su inventario salen los regalos. */
export async function idMatriz(supabase: Cliente): Promise<{ id: string; nombre: string }> {
  const { data, error } = await supabase.from('entidades').select('id, nombre').eq('rol', 'ADMIN').order('nombre').limit(2)
  if (error) throw new Error(`entidades: ${error.message}`)
  if (!data || data.length === 0) throw new Error('No encontre la entidad de la matriz (rol ADMIN).')
  if (data.length > 1) throw new Error('Hay mas de una entidad ADMIN: no se de que inventario sale el regalo.')
  return { id: data[0].id, nombre: String(data[0].nombre ?? 'Matriz') }
}

export async function stocksDe(supabase: Cliente, idEntidad: string, ids: readonly string[]): Promise<Map<string, StockCelda>> {
  const pares = await Promise.all(
    [...new Set(ids)].map(async (id) => [id, await leerStockParaCascada(supabase, idEntidad, id)] as const)
  )
  return new Map(pares)
}

export type ResultadoRegalo =
  | { ok: true; id: string; filas: number; avisos: string[] }
  | { ok: false; error: string }

/**
 * Valida, reparte y escribe. `usuarioCreador`: la sesion en la web (la base lo
 * vuelve a poner con `tg_forzar_autor`), `telegram:<etiqueta>` en el bot.
 */
export async function registrarRegalo(
  supabase: Cliente,
  solicitud: SolicitudRegalo,
  idEntidad: string,
  usuarioCreador: string
): Promise<ResultadoRegalo> {
  const invalida = validarSolicitudRegalo(solicitud)
  if (invalida) return { ok: false, error: invalida }
  const lineas = juntarLineas(solicitud.lineas)
  const quien = normalizarQuien(solicitud.quien_regalo)
  const motivo = String(solicitud.motivo).replace(/\s+/g, ' ').trim()

  const productos = await leerProductosRegalo(supabase)
  const conocidos = new Set(productos.map((p) => p.id))
  if (lineas.some((l) => !conocidos.has(l.id_producto))) {
    return { ok: false, error: 'Hay un producto que no es producto terminado del catalogo.' }
  }
  const stocks = await stocksDe(supabase, idEntidad, lineas.map((l) => l.id_producto))
  const { filas, avisos } = armarFilasRegalo(lineas, productos, stocks, notaDeRegalo(quien, motivo))

  const { data, error } = await supabase.rpc('registrar_regalo', {
    p_regalo: {
      fecha: solicitud.fecha,
      quien_regalo: quien,
      motivo,
      id_entidad_origen: idEntidad,
      usuario_creador: usuarioCreador
    } as unknown as Json,
    p_inventario: filas as unknown as Json
  })
  if (error) return { ok: false, error: `No se guardo: ${error.message}` }
  return { ok: true, id: String(data), filas: filas.length, avisos }
}

type FilaVista = Omit<Database['public']['Views']['v_regalo_lineas']['Row'], 'creado_en' | 'id_entidad_origen'>

/** La cartera completa (todas las filas ACTIVO de `v_regalo_lineas`). */
export async function leerCartera(supabase: Cliente): Promise<Cartera> {
  // ERP-25: paginado. PostgREST corta en silencio a las 1000 filas.
  const data = await fetchTodasLasFilas<FilaVista>(
    () =>
      supabase
        .from('v_regalo_lineas')
        .select('id_regalo, fecha, quien_regalo, motivo, usuario_creador, id_producto, producto, ml_por_unidad, costo_unitario, costo_cero_confirmado, piezas')
        .order('fecha', { ascending: false })
        .order('id_regalo')
        .order('id_producto'),
    'leerCartera: v_regalo_lineas'
  )
  const lineas: LineaCartera[] = (data ?? []).map((f) => ({
    id_regalo: String(f.id_regalo),
    fecha: String(f.fecha),
    quien_regalo: String(f.quien_regalo ?? ''),
    motivo: String(f.motivo ?? ''),
    usuario_creador: f.usuario_creador,
    id_producto: String(f.id_producto),
    producto: String(f.producto ?? ''),
    ml_por_unidad: f.ml_por_unidad === null ? null : Number(f.ml_por_unidad),
    costo_unitario: f.costo_unitario === null ? null : Number(f.costo_unitario),
    costo_cero_confirmado: f.costo_cero_confirmado,
    piezas: Number(f.piezas) || 0
  }))
  return armarCartera(lineas)
}

/** Hoy en Mexico (UTC-6, sin horario de verano), AAAA-MM-DD. */
export function hoyMx(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - 6 * 3600_000).toISOString().slice(0, 10)
}
