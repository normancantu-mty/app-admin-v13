/**
 * Cliente de Supabase por request y resolucion de sesion para server actions.
 *
 * **No lleva `'use server'` a proposito.** En un archivo `'use server'` toda
 * exportacion se convierte en un endpoint invocable desde el navegador; estos
 * dos ayudantes no deben serlo. Viven aqui para que `app/actions/abonos.ts`,
 * `app/actions/devoluciones.ts` y `app/actions/compras.ts` compartan UNA sola
 * copia: la deuda documentada de este repo es logica duplicada que se separa
 * sola (ver `pos.ts` vs `auditoria.ts` en CLAUDE.md), y la resolucion de sesion
 * es justo lo que no puede divergir — de ella sale `usuario_creador`.
 */

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { leerAcceso } from '@/lib/auth-utils'

export type ClienteServidor = SupabaseClient<Database>

export interface SesionOperador {
  email: string
  entidadId: string
  /** Siempre en mayusculas. */
  rol: string
  /** `accesos.permiso_finanzas` (solo cuenta para EMPLEADO_ADMIN). */
  permisoFinanzas?: boolean
}

export type ResultadoSesion =
  | { ok: true; sesion: SesionOperador }
  | { ok: false; error: string }

export async function getServerSupabaseClient(): Promise<ClienteServidor> {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        }
      }
    }
  )
}

/**
 * Resuelve la sesion y la entidad: `accesos` (por auth_id) primero; si no, por correo. `usuario_creador` sale de AQUI,
 * nunca del cliente: eso es lo que cierra el hueco por el que 36 de 118 filas
 * quedaron sin autor y un DST no podia anular su propio movimiento
 * (`app/actions/audit.ts`).
 *
 * `SOCIO` es de solo lectura y se rechaza siempre.
 */
export async function resolverSesionOperador(
  supabase: ClienteServidor
): Promise<ResultadoSesion> {
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) {
    return { ok: false, error: 'No se pudo validar tu sesion. Inicia sesion nuevamente.' }
  }

  // `accesos` primero, como `mi_rol()` / `mi_entidad_id()` en la base.
  const acceso = await leerAcceso(supabase, user.id)
  if (acceso) {
    if (acceso.rol === 'SOCIO') {
      return { ok: false, error: 'Acceso denegado: tu rol es de solo lectura.' }
    }
    return {
      ok: true,
      sesion: { email: user.email, entidadId: acceso.idEntidad, rol: acceso.rol, permisoFinanzas: acceso.permisoFinanzas }
    }
  }

  const { data: entidad, error: entidadError } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (entidadError || !entidad) {
    return { ok: false, error: 'No se pudo validar la entidad operadora.' }
  }

  const rol = String(entidad.rol || '').toUpperCase()
  if (rol === 'SOCIO') {
    return { ok: false, error: 'Acceso denegado: tu rol es de solo lectura.' }
  }

  return { ok: true, sesion: { email: user.email, entidadId: entidad.id, rol } }
}
