'use server'

/**
 * La accion de servidor del POS. **Hoy es una envoltura, y nada mas.**
 *
 * ─── QUE QUEDO AQUI Y QUE SE FUE ────────────────────────────────────────────
 *
 * Toda la regla de negocio de la venta —validaciones, cascada de stock, los dos
 * motores de comision, la fiscalidad inversa y la unica escritura atomica— vive
 * en `lib/venta-servidor.ts`. Aqui solo queda lo que de verdad es de Next y de
 * la sesion del navegador:
 *
 *   1. leer la cookie y resolver `auth.getUser()`
 *   2. traducir ese correo a una entidad del ERP (el `OperadorDeVenta`)
 *   3. llamar a `registrarVenta`
 *   4. `revalidatePath` de las pantallas que cambiaron
 *
 * **Por que se partio:** el bot de Telegram tambien captura ventas, y no tiene
 * sesion — entra con `service_role`. Copiar esta logica al bot crearia dos
 * verdades sobre el dinero, que es la deuda declarada de este repo. La cabecera
 * de `lib/venta-servidor.ts` cuenta la extraccion completa.
 *
 * **La firma de `procesarVentaPOS` NO cambio**: `app/pos/page.tsx` no se toco.
 *
 * ⚠️ REGLA PARA QUIEN EDITE ESTE ARCHIVO: si una regla de negocio nueva te pide
 * escribirla aqui, va en `lib/venta-servidor.ts`. Lo que se escriba en esta
 * envoltura el bot NO lo ejecuta, y eso es exactamente la divergencia que la
 * extraccion vino a cerrar. Cuatro pruebas lo vigilan (ver esa cabecera).
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { Database } from '@/types/database'
import { registrarVenta, type ProcesarVentaPOSPayload } from '@/lib/venta-servidor'


interface ProcesarVentaPOSResult {
  ok: boolean
  ticketId?: string
  error?: string
}

export async function procesarVentaPOS(payload: ProcesarVentaPOSPayload): Promise<ProcesarVentaPOSResult> {
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set() {},
          remove() {}
        }
      }
    )

    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user?.email) {
      return { ok: false, error: 'Sesión inválida. Inicia sesión nuevamente.' }
    }

    const { data: currentUser, error: currentUserError } = await supabase
      .from('entidades')
      .select('id, rol')
      .eq('email', user.email)
      .single()

    if (currentUserError || !currentUser) {
      return { ok: false, error: 'No se pudo validar la sesión operativa actual.' }
    }

    const resultado = await registrarVenta(
      supabase,
      { email: user.email, idEntidad: currentUser.id, rol: currentUser.rol },
      payload
    )

    if (!resultado.ok) {
      return { ok: false, error: resultado.error }
    }

    // ── Lo unico que no se pudo mover: `revalidatePath` es de Next ──────────
    // Por eso `registrarVenta` devuelve los tres ids que hacen falta aqui: el
    // comprador ya RESUELTO (que puede ser el centinela y no el que vino en el
    // payload), el origen de inventario ya normalizado, y el vendedor.
    revalidatePath('/dashboard/finanzas')
    revalidatePath('/dashboard/inventario')
    revalidatePath('/dashboard/distribuidores')
    if (resultado.idComprador) {
      revalidatePath(`/dashboard/distribuidores/${resultado.idComprador}`)
    }
    if (resultado.origenInventarioId && resultado.origenInventarioId !== resultado.vendedorId) {
      revalidatePath(`/dashboard/distribuidores/${resultado.origenInventarioId}`)
    }
    revalidatePath(`/dashboard/distribuidores/${resultado.vendedorId}`)
    // El aviso W4 lo escribe `registrarVenta`; la pantalla de avisos se refresca
    // siempre, porque desde aqui no se sabe si hubo uno y preguntarlo costaria
    // otra lectura para ahorrar un `revalidatePath` que es gratis.
    revalidatePath('/dashboard/avisos')

    return { ok: true, ticketId: resultado.ticketId }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error interno POS.'
    return { ok: false, error: message }
  }
}
