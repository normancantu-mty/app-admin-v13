/**
 * REGALOS — el lado de servidor que comparten la web y el bot. Escrito el
 * 2026-11-20 por un ejecutor del Socio.
 *
 * `registrarRegalo` lee el stock (`leerStockConSigno`: la MISMA lectura que `leerStockParaCascada` de la
 * merma y la venta), arma las filas con `armarFilasRegalo` (cascada que avisa
 * y no bloquea) y escribe TODO en una sola llamada a la RPC
 * `registrar_regalo` (encabezado + filas en una transaccion).
 *
 * Dos candados (Norman, 2026-11-25), para la web y para el bot:
 *  - SIEMPRE sale de la matriz. Un distribuidor o un local no regala de lo que
 *    tiene consignado: cualquier otro origen se rechaza.
 *  - Quien regalo sale de la lista cerrada: equipo + DST y LOC de la base.
 *
 * A QUIEN se le dio (2026-11-25): `regalos.id_entidad_destino`, un DST o LOC real.
 * Es un dato del encabezado: NO mueve inventario del que recibe, ni su consignacion,
 * ni su deuda. Si la base todavia no tiene la columna, se lee y se escribe como antes
 * y se AVISA; nunca se bloquea.
 *
 * Limite conocido (el mismo que `escribirSalidaCascada`): la lectura del stock
 * y la escritura son dos peticiones; dos salidas simultaneas de la misma celda
 * dejan el TOTAL exacto pero pueden repartir distinto entre PAGADO y
 * CONSIGNADO. No cambia lo que se regalo ni la cartera.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { leerStockConSigno } from '@/lib/salida-cascada'
import { fetchTodasLasFilas, type ConsultaPaginable } from '@/lib/paginacion'
import { esCompradorSeleccionable } from '@/lib/avisos'
import {
  armarCartera,
  armarFilasRegalo,
  faltaColumnaDestino,
  juntarLineas,
  notaDeRegalo,
  regaloParecido,
  validarSolicitudRegalo,
  type Cartera,
  type LineaCartera,
  type ProductoRegalo,
  type SolicitudRegalo,
  type StockCelda
} from '@/lib/regalos'
import { listaDeDestinos, listaDeQuienes, quienExacto, type DestinoRegalo, type QuienPermitido } from '@/lib/regalos-quien'

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

type EntidadRed = { id: string; nombre: string; rol: string }

/** Los DST y LOC de la base, sin el centinela "pendiente de asignar". */
async function leerRed(supabase: Cliente): Promise<EntidadRed[]> {
  const { data, error } = await supabase.from('entidades').select('id, nombre, rol').in('rol', ['DST', 'LOC']).order('nombre')
  if (error) throw new Error(`entidades: ${error.message}`)
  return (data ?? []).filter(esCompradorSeleccionable).map((e) => ({ id: e.id, nombre: String(e.nombre ?? ''), rol: String(e.rol ?? '') }))
}

/** La lista cerrada de quien puede regalar: el equipo + los DST y LOC reales (ver `esEntidadReal`). */
export async function leerQuienes(supabase: Cliente): Promise<QuienPermitido[]> {
  return listaDeQuienes(await leerRed(supabase))
}

/** Quien regala y a quien se le puede dar, con una sola lectura. */
export async function leerListas(supabase: Cliente): Promise<{ quienes: QuienPermitido[]; destinos: DestinoRegalo[] }> {
  const red = await leerRed(supabase)
  return { quienes: listaDeQuienes(red), destinos: listaDeDestinos(red) }
}

export async function stocksDe(supabase: Cliente, idEntidad: string, ids: readonly string[]): Promise<Map<string, StockCelda>> {
  const pares = await Promise.all(
    [...new Set(ids)].map(async (id) => [id, await leerStockConSigno(supabase, idEntidad, id)] as const)
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
  const motivo = String(solicitud.motivo).replace(/\s+/g, ' ').trim()

  const matriz = await idMatriz(supabase)
  if (idEntidad !== matriz.id) return { ok: false, error: 'Los regalos salen solo de la matriz.' }
  const { quienes, destinos } = await leerListas(supabase)
  const permitido = quienExacto(solicitud.quien_regalo, quienes)
  if (!permitido) {
    return { ok: false, error: `No reconozco a "${solicitud.quien_regalo}": quien regala es alguien del equipo, un distribuidor o un local.` }
  }
  const quien = permitido.nombre
  const idDestino = String(solicitud.id_entidad_destino ?? '').trim()
  const destino = destinos.find((d) => d.id === idDestino) ?? null
  if (idDestino !== '' && !destino) {
    return { ok: false, error: 'A quien se le dio no es un distribuidor ni un local. Escoge otro, o dejalo sin destino.' }
  }

  const productos = await leerProductosRegalo(supabase)
  const conocidos = new Set(productos.map((p) => p.id))
  if (lineas.some((l) => !conocidos.has(l.id_producto))) {
    return { ok: false, error: 'Hay un producto que no es producto terminado del catalogo.' }
  }
  const stocks = await stocksDe(supabase, idEntidad, lineas.map((l) => l.id_producto))
  // ¿Ya esta la columna? Sin ella la RPC vieja ignoraria el destino en silencio: se deja en el motivo y se avisa.
  const guardaDestino = destino !== null && (await hayColumnaDestino(supabase))
  const motivoFinal = destino !== null && !guardaDestino ? motivoConDestino(motivo, destino.nombre) : motivo
  const { filas, avisos } = armarFilasRegalo(lineas, productos, stocks, notaDeRegalo(quien, motivoFinal))
  if (destino !== null && !guardaDestino) {
    avisos.push(`El regalo se guarda, pero todavia no cuenta en la ficha de ${destino.nombre}: falta correr el SQL del destino en la base. Quedo en el motivo.`)
  }
  if (guardaDestino) {
    // El mismo regalo capturado dos veces contaria doble en su ficha. Se avisa; nunca bloquea.
    try {
      const ya = regaloParecido(await leerRegalosDeNodo(supabase, destino.id), { fecha: solicitud.fecha, id_entidad_destino: destino.id, lineas })
      if (ya) avisos.push(`Ya habia un regalo igual para ${destino.nombre} ese dia (de ${ya.quien_regalo}). Se guardo este tambien: revisa que no sea el mismo.`)
    } catch (e) {
      console.error('registrarRegalo: no pude revisar si ya estaba:', e)
    }
  }

  const { data, error } = await supabase.rpc('registrar_regalo', {
    p_regalo: {
      fecha: solicitud.fecha,
      quien_regalo: quien,
      motivo: motivoFinal,
      id_entidad_origen: idEntidad,
      usuario_creador: usuarioCreador,
      ...(guardaDestino ? { id_entidad_destino: destino.id } : {})
    } as unknown as Json,
    p_inventario: filas as unknown as Json
  })
  if (error) return { ok: false, error: `No se guardo: ${error.message}` }
  return { ok: true, id: String(data), filas: filas.length, avisos }
}

/** ¿La base ya tiene `regalos.id_entidad_destino`? Otro error de lectura si se lanza. */
async function hayColumnaDestino(supabase: Cliente): Promise<boolean> {
  const { error } = await supabase.from('regalos').select('id_entidad_destino').limit(1)
  if (!error) return true
  if (faltaColumnaDestino(error)) return false
  throw new Error(`regalos: ${error.message}`)
}

/** "apertura" -> "apertura (para Casa Verde)", si el motivo no lo dice ya. */
function motivoConDestino(motivo: string, nombre: string): string {
  if (motivo.toLowerCase().includes(nombre.toLowerCase())) return motivo
  const cola = ` (para ${nombre})`
  return motivo.slice(0, 300 - cola.length) + cola
}

type FilaVista = Omit<Database['public']['Views']['v_regalo_lineas']['Row'], 'id_entidad_origen' | 'id_entidad_destino'> & { id_entidad_destino?: string | null }

const COLUMNAS_VISTA = 'id_regalo, fecha, quien_regalo, motivo, usuario_creador, id_producto, producto, ml_por_unidad, piezas, creado_en'

/** Las filas de la vista, paginadas (ERP-25: PostgREST corta en silencio a las 1000). */
function leerFilas(supabase: Cliente, conDestino: boolean, soloDestino?: string): Promise<FilaVista[]> {
  return fetchTodasLasFilas<FilaVista>(() => {
    const base = conDestino
      ? supabase.from('v_regalo_lineas').select(`${COLUMNAS_VISTA}, id_entidad_destino` as const)
      : supabase.from('v_regalo_lineas').select(COLUMNAS_VISTA)
    const filtrada = soloDestino ? base.eq('id_entidad_destino', soloDestino) : base
    return filtrada.order('fecha', { ascending: false }).order('id_regalo').order('id_producto') as unknown as ConsultaPaginable<FilaVista>
  }, 'leerCartera: v_regalo_lineas')
}

function aLinea(f: FilaVista, nombres: ReadonlyMap<string, string>): LineaCartera {
  const idDestino = f.id_entidad_destino ?? null
  return {
    id_regalo: String(f.id_regalo),
    fecha: String(f.fecha),
    quien_regalo: String(f.quien_regalo ?? ''),
    motivo: String(f.motivo ?? ''),
    usuario_creador: f.usuario_creador,
    id_producto: String(f.id_producto),
    producto: String(f.producto ?? ''),
    ml_por_unidad: f.ml_por_unidad === null ? null : Number(f.ml_por_unidad),
    piezas: Number(f.piezas) || 0,
    creado_en: f.creado_en ?? null,
    id_entidad_destino: idDestino,
    destino: idDestino ? (nombres.get(idDestino) ?? null) : null
  }
}

/** La cartera completa (todas las filas ACTIVO de `v_regalo_lineas`). Sin la columna del destino, como antes. */
export async function leerCartera(supabase: Cliente): Promise<Cartera> {
  let filas: FilaVista[]
  let hayDestinos = true
  try {
    filas = await leerFilas(supabase, true)
  } catch (e) {
    if (!faltaColumnaDestino(e)) throw e
    hayDestinos = false
    filas = await leerFilas(supabase, false)
  }
  const ids = [...new Set(filas.flatMap((f) => (f.id_entidad_destino ? [f.id_entidad_destino] : [])))]
  const nombres = new Map<string, string>()
  if (ids.length > 0) {
    const { data, error } = await supabase.from('entidades').select('id, nombre').in('id', ids)
    if (error) throw new Error(`entidades: ${error.message}`)
    for (const e of data ?? []) nombres.set(e.id, String(e.nombre ?? '').trim())
  }
  return armarCartera(filas.map((f) => aLinea(f, nombres)), hayDestinos)
}

/**
 * Lo que se le ha dado a UN distribuidor o local, para su ficha. Con la sesion de quien
 * mira: las politicas de `regalos` solo dejan leer a la matriz. `hayDestinos: false` =
 * falta el SQL (se dice; no se ensena un cero que no es).
 */
export async function leerRegalosDeNodo(supabase: Cliente, idNodo: string): Promise<Cartera> {
  try {
    const filas = await leerFilas(supabase, true, idNodo)
    return armarCartera(filas.map((f) => aLinea(f, new Map())), true)
  } catch (e) {
    if (faltaColumnaDestino(e)) return armarCartera([], false)
    throw e
  }
}

/** Hoy en Mexico (UTC-6, sin horario de verano), AAAA-MM-DD. */
export function hoyMx(ahora: Date = new Date()): string {
  return new Date(ahora.getTime() - 6 * 3600_000).toISOString().slice(0, 10)
}
