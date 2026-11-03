'use server'

/**
 * Correcciones del ADMIN: stock de una cubeta y saldo de una cuenta. Escrito el
 * 2026-11-03 por el agente de la ruta admin.
 *
 * Tres puertas antes de escribir, y las tres son de servidor:
 *   1. aqui: sesion resuelta por `auth_id` (`getCurrentUser`) y rol ADMIN;
 *   2. aqui: las DOS confirmaciones y el motivo (`validarSolicitudAjuste`);
 *   3. en Postgres: la RPC vuelve a exigir ADMIN (`mi_rol()`), toma el LOCK,
 *      recalcula el valor y rechaza si no es el que el usuario vio. El trigger
 *      `tg_ajuste_solo_admin` cierra el insert directo.
 * La RPC corre con la sesion del usuario (no service role): el autor lo pone
 * `tg_forzar_autor` y la bitacora `tg_bitacora`.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth-utils'
import { getServerSupabaseClient } from '@/lib/server-session'
import { RUTA_BASE } from '@/lib/v2/rutas'
import {
  leerClaveInventario,
  mensajeDeErrorRpc,
  redondearA,
  decimalesDe,
  validarSolicitudAjuste,
  type SolicitudAjuste
} from '@/lib/ajustes-admin'

export type ResultadoAjuste =
  | { ok: true; id: string; anterior: number; nuevo: number; diferencia: number }
  | { ok: false; error: string }

export async function aplicarAjusteAction(solicitud: SolicitudAjuste): Promise<ResultadoAjuste> {
  try {
    const usuario = await getCurrentUser()
    if (!usuario || usuario.rol !== 'ADMIN') return { ok: false, error: 'No autorizado.' }

    const s: SolicitudAjuste = {
      clase: solicitud?.clase,
      clave: String(solicitud?.clave ?? ''),
      visto: Number(solicitud?.visto),
      nuevo: Number(solicitud?.nuevo),
      motivo: String(solicitud?.motivo ?? ''),
      paso1: solicitud?.paso1 === true,
      confirmacion: String(solicitud?.confirmacion ?? '')
    }
    const invalida = validarSolicitudAjuste(s)
    if (invalida) return { ok: false, error: invalida }

    const d = decimalesDe(s.clase)
    const visto = redondearA(s.visto, d)
    const nuevo = redondearA(s.nuevo, d)
    const motivo = s.motivo.trim()
    const supabase = await getServerSupabaseClient()

    const { data, error } =
      s.clase === 'inventario'
        ? await (() => {
            const c = leerClaveInventario(s.clave)!
            return supabase.rpc('ajustar_inventario', {
              p_id_entidad: c.idEntidad,
              p_id_producto: c.idProducto,
              p_cubeta: c.cubeta,
              p_valor_visto: visto,
              p_valor_nuevo: nuevo,
              p_motivo: motivo
            })
          })()
        : await supabase.rpc('ajustar_saldo_cuenta', {
            p_id_cuenta: s.clave,
            p_saldo_visto: visto,
            p_saldo_nuevo: nuevo,
            p_motivo: motivo
          })
    if (error) return { ok: false, error: mensajeDeErrorRpc(error.message) }

    const r = data as { id: string; anterior: number; nuevo: number; diferencia: number }
    revalidatePath(`${RUTA_BASE}/correcciones`)
    revalidatePath(RUTA_BASE)
    return { ok: true, id: r.id, anterior: Number(r.anterior), nuevo: Number(r.nuevo), diferencia: Number(r.diferencia) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error inesperado' }
  }
}
