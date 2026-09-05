'use server'

/**
 * ERP-59 — Las acciones de la cola de avisos.
 *
 * Leer, resolver, ignorar y armar el resumen del dia. Lo que NO esta aqui, a
 * proposito:
 *
 *   * **Crear avisos.** Los crean las validaciones, desde dentro del servidor,
 *     con `registrarAviso` de `lib/avisos-server.ts`. Si fabricar un aviso
 *     fuera un endpoint, cualquiera podria llenar la cola de ruido.
 *   * **Borrar avisos.** No hay politica de DELETE en la tabla: ni un ADMIN
 *     puede. Un aviso se resuelve o se ignora con motivo. Poder borrarlos seria
 *     poder tapar exactamente lo que la cola viene a destapar.
 */

import { revalidatePath } from 'next/cache'
import { getServerSupabaseClient, resolverSesionOperador } from '@/lib/server-session'
import {
  ordenarColaAvisos,
  resumenDiarioAvisos,
  type AvisoEnCola,
  type EstadoAviso,
  type ResumenDiarioAvisos,
  type SeveridadAviso
} from '@/lib/avisos'

const COLUMNAS =
  'id, tipo, severidad, mensaje, estado, creado_en, id_entidad, tabla, id_registro, ' +
  'datos_capturados, usuario_creador, motivo_cierre, cerrado_por, cerrado_en'

export interface AvisoDeCola extends AvisoEnCola {
  usuario_creador: string
  motivo_cierre: string | null
  cerrado_por: string | null
  cerrado_en: string | null
  nombre_entidad: string | null
}

export type ListarAvisosResult =
  | { success: true; avisos: AvisoDeCola[] }
  | { success: false; error: string }

/**
 * La cola. **No filtra por entidad en el `WHERE`**: lo hace el RLS. Un ADMIN ve
 * todo, un DST ve lo suyo y lo de sus locales, y la consulta es la misma — que
 * es justo lo que evita que el filtro de la app y el de la base diverjan.
 */
export async function listarAvisosAction(
  estado: EstadoAviso | 'TODOS' = 'ABIERTO'
): Promise<ListarAvisosResult> {
  try {
    const supabase = await getServerSupabaseClient()

    let consulta = supabase
      .from('avisos_captura')
      .select(`${COLUMNAS}, entidad:entidades!id_entidad(nombre)`)

    if (estado !== 'TODOS') {
      consulta = consulta.eq('estado', estado)
    }

    const { data, error } = await consulta.order('creado_en', { ascending: true })

    if (error) {
      return { success: false, error: `No se pudo leer la cola de avisos: ${error.message}` }
    }

    const avisos: AvisoDeCola[] = (data ?? []).map((fila) => {
      const entidad = fila.entidad as { nombre: string } | { nombre: string }[] | null
      const nombre = Array.isArray(entidad) ? entidad[0]?.nombre ?? null : entidad?.nombre ?? null

      return {
        id: fila.id,
        tipo: fila.tipo,
        severidad: fila.severidad as SeveridadAviso,
        mensaje: fila.mensaje,
        estado: fila.estado as EstadoAviso,
        creado_en: fila.creado_en,
        id_entidad: fila.id_entidad,
        tabla: fila.tabla,
        id_registro: fila.id_registro,
        datos_capturados: fila.datos_capturados,
        usuario_creador: fila.usuario_creador,
        motivo_cierre: fila.motivo_cierre,
        cerrado_por: fila.cerrado_por,
        cerrado_en: fila.cerrado_en,
        nombre_entidad: nombre
      }
    })

    // El orden lo pone la funcion pura, no el `ORDER BY`: asi la pantalla y el
    // resumen del bot ordenan con el MISMO criterio, y `tests/avisos.spec.ts`
    // puede vigilarlo sin base de datos.
    return { success: true, avisos: ordenarColaAvisos(avisos) }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Error inesperado al leer la cola de avisos.'
    }
  }
}

/** El contador del menu. Que se vea, o la cola no sirve. */
export async function contarAvisosAbiertosAction(): Promise<number> {
  try {
    const supabase = await getServerSupabaseClient()
    const { count, error } = await supabase
      .from('avisos_captura')
      .select('id', { count: 'exact', head: true })
      .eq('estado', 'ABIERTO')

    if (error) {
      console.error('[avisos] No se pudo contar la cola:', error.message)
      return 0
    }
    return count ?? 0
  } catch (e) {
    console.error('[avisos] Excepcion al contar la cola:', e)
    return 0
  }
}

export type CerrarAvisoResult = { success: true } | { success: false; error: string }

/**
 * Resolver = el dato ya quedo bien. **El candado de W4 no vive aqui**: vive en
 * el trigger `tg_avisos_vigilar_cierre`, porque la app no es el unico camino a
 * la base. Si el ticket sigue apuntando a "PENDIENTE DE ASIGNAR", Postgres
 * rechaza el UPDATE y el mensaje del error es el que se le muestra al usuario.
 */
export async function resolverAvisoAction(idAviso: string): Promise<CerrarAvisoResult> {
  return cerrarAviso(idAviso, 'RESUELTO', null)
}

/**
 * Ignorar pide motivo, en una linea. Sin motivo no hay boton: si ignorar fuera
 * gratis, la cola entera se ignoraria en dos clics y no habriamos construido
 * nada. El `CHECK avisos_ignorado_con_motivo` lo exige tambien en la base.
 */
export async function ignorarAvisoAction(
  idAviso: string,
  motivo: string
): Promise<CerrarAvisoResult> {
  const limpio = String(motivo ?? '').trim()
  if (limpio === '') {
    return { success: false, error: 'Escribe el motivo para ignorar el aviso.' }
  }
  return cerrarAviso(idAviso, 'IGNORADO', limpio)
}

async function cerrarAviso(
  idAviso: string,
  estado: 'RESUELTO' | 'IGNORADO',
  motivo: string | null
): Promise<CerrarAvisoResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }

    const id = String(idAviso ?? '').trim()
    if (!id) return { success: false, error: 'Falta el identificador del aviso.' }

    // `cerrado_por` y `cerrado_en` NO se mandan: los pone el trigger con el
    // correo de la sesion. Mandarlos desde aqui seria dejar que el cliente
    // firme por otro.
    const { error } = await supabase
      .from('avisos_captura')
      .update({ estado, motivo_cierre: motivo })
      .eq('id', id)
      .eq('estado', 'ABIERTO')

    if (error) {
      return { success: false, error: error.message }
    }

    revalidatePath('/dashboard/avisos')
    return { success: true }
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Error inesperado al cerrar el aviso.'
    }
  }
}

/**
 * EL RESUMEN DEL DIA — la pieza que espera el bot de Telegram (AG-01).
 *
 * **Es una funcion expuesta, no un cron.** Norman pidio recordatorios diarios,
 * pero hoy no hay canal: el bot no existe. Montar cron, correo o
 * notificaciones del navegador seria construir para un futuro que no existe
 * [Filtro: DOC02 — YAGNI]. Cuando el bot exista, llama a esto y lo manda.
 *
 * El texto sale incluso con la cola vacia: es el latido. "No hay nada
 * pendiente" y "llevo tres dias sin correr" no se pueden ver igual.
 */
export async function resumenDiarioAvisosAction(): Promise<
  { success: true; resumen: ResumenDiarioAvisos } | { success: false; error: string }
> {
  const cola = await listarAvisosAction('ABIERTO')
  if (!cola.success) return { success: false, error: cola.error }

  return { success: true, resumen: resumenDiarioAvisos(cola.avisos, new Date()) }
}
