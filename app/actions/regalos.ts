'use server'

/**
 * Regalos desde la web. Escrito el 2026-11-20 por un ejecutor del Socio.
 *
 * Puertas: sesion resuelta por `auth_id` (`getCurrentUser`) y rol de captura
 * de la matriz (ADMIN o EMPLEADO_ADMIN, `puedeCapturarMatriz`); la RPC
 * `registrar_regalo` vuelve a exigir el rol y corre con la sesion del usuario
 * (RLS, autor por `tg_forzar_autor`, bitacora por `tg_bitacora`).
 *
 * La existencia NO bloquea: si no alcanza, se guarda y regresan `avisos`.
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth-utils'
import { getServerSupabaseClient } from '@/lib/server-session'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { RUTA_BASE } from '@/lib/v2/rutas'
import { idMatriz, registrarRegalo, type ResultadoRegalo } from '@/lib/regalos-servidor'
import type { SolicitudRegalo } from '@/lib/regalos'

export async function registrarRegaloAction(solicitud: SolicitudRegalo): Promise<ResultadoRegalo> {
  try {
    const usuario = await getCurrentUser()
    if (!usuario || !puedeCapturarMatriz(usuario.rol)) return { ok: false, error: 'No autorizado.' }

    // Campo por campo: el cliente no cuela nada mas (ni la entidad ni el autor).
    const s: SolicitudRegalo = {
      fecha: String(solicitud?.fecha ?? ''),
      quien_regalo: String(solicitud?.quien_regalo ?? ''),
      motivo: String(solicitud?.motivo ?? ''),
      lineas: Array.isArray(solicitud?.lineas)
        ? solicitud.lineas.map((l) => ({ id_producto: String(l?.id_producto ?? ''), cantidad: Number(l?.cantidad) }))
        : [],
      // Lo valida `registrarRegalo` contra los DST y LOC de la base.
      id_entidad_destino: solicitud?.id_entidad_destino ? String(solicitud.id_entidad_destino) : null
    }
    const supabase = await getServerSupabaseClient()
    const matriz = await idMatriz(supabase)
    const r = await registrarRegalo(supabase, s, matriz.id, usuario.email)
    if (r.ok) {
      revalidatePath(`${RUTA_BASE}/regalos`)
      revalidatePath(`${RUTA_BASE}/inventario`)
      revalidatePath(RUTA_BASE)
      if (s.id_entidad_destino) revalidatePath(`${RUTA_BASE}/red/${s.id_entidad_destino}`)
    }
    return r
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error inesperado al registrar el regalo.' }
  }
}
