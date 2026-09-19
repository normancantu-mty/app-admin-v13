'use server'

/**
 * La puerta con SESION de la anulacion. **La logica ya no vive aqui.**
 *
 * Desde el 2026-09-19 (Fase 5 del bot) el cuerpo entero —quien puede anular
 * que, la ventana de 12 h, la cascada por ticket— vive en
 * `lib/anulacion-servidor.ts`, sin `cookies()` y sin `getCurrentUser()`, para
 * que el bot de Telegram pueda llamarlo con su identidad de servicio. Es el
 * mismo movimiento que el commit `9b73c58` le hizo a la venta
 * (`pos.ts` -> `lib/venta-servidor.ts`) y por la misma razon: copiarla habria
 * creado **dos verdades sobre la anulacion**, que es la deuda declarada del
 * repo (TKT-034/TKT-035).
 *
 * Lo que queda en este archivo es lo unico que de verdad necesita el navegador:
 * resolver la sesion, y revalidar las rutas de Next.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getCurrentUser } from '@/lib/auth-utils'
import {
  anularFinanzas,
  anularInventario,
  type ActorDeAnulacion
} from '@/lib/anulacion-servidor'

async function getServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set() {
          // No-op en server action
        },
        remove() {
          // No-op en server action
        }
      }
    }
  )
}

/** La sesion, traducida al actor que espera `lib/anulacion-servidor.ts`. */
async function actorDeLaSesion(): Promise<ActorDeAnulacion> {
  const currentUser = await getCurrentUser()
  if (!currentUser) {
    throw new Error('Sesión inválida. Inicia sesión nuevamente.')
  }
  return { idEntidad: currentUser.id, email: currentUser.email, rol: currentUser.rol }
}

export async function bulkDeleteMovements(ids: string[]) {
  if (!ids.length) {
    throw new Error('No se recibieron movimientos para borrar.')
  }

  // Se comprueba la sesion ANTES del bucle, aunque cada anulacion la vuelva a
  // pedir: sin esto, una lista vacia de permisos costaria N viajes a la base
  // para acabar en el mismo error.
  const actor = await actorDeLaSesion()
  if (actor.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }

  let count = 0
  for (const id of ids) {
    const result = await anularMovimientoFinanzas(id)
    if (result.success) count += 1
  }

  return { success: true, count }
}

export async function anularMovimientoFinanzas(id: string, options?: { perfilEntidadId?: string }) {
  const supabase = await getServerSupabaseClient()
  const actor = await actorDeLaSesion()

  const resultado = await anularFinanzas(supabase, actor, id, options)

  if (resultado.idTicket) {
    if (options?.perfilEntidadId) {
      revalidatePath(`/dashboard/distribuidores/${options.perfilEntidadId}`)
    }
    revalidatePath('/dashboard/distribuidores')
    revalidatePath('/dashboard/inventario')
    revalidatePath('/dashboard/finanzas')
    return { success: true as const }
  }

  revalidatePath('/dashboard/finanzas')
  if (options?.perfilEntidadId) {
    revalidatePath(`/dashboard/distribuidores/${options.perfilEntidadId}`)
  }
  revalidatePath('/dashboard/distribuidores')

  return { success: true as const }
}

export async function anularMovimientoInventario(id: string) {
  const supabase = await getServerSupabaseClient()
  const actor = await actorDeLaSesion()

  await anularInventario(supabase, actor, id)

  revalidatePath('/dashboard/inventario')
  revalidatePath('/dashboard/distribuidores')

  return { success: true as const }
}

export async function deleteInventarioMovement(id: string) {
  return anularMovimientoInventario(id)
}
