import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// ============================================================================
// SERVER-SIDE AUTH UTILITIES
// ============================================================================

export interface CurrentUser {
  id: string
  email: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO' | 'SUB-ADMIN'
  nombre: string
}

/**
 * Get current logged-in user from server-side
 * Use this in Server Components to fetch user role and apply permissions
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const cookieStore = await cookies()

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set() {
            // No-op en SSR
          },
          remove() {
            // No-op en SSR
          }
        }
      }
    )

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user?.email) {
      return null
    }

    // La identidad se resuelve por `auth_id`, que apunta a `auth.users(id)`: no
    // se teclea en ningun formulario y solo se puede cambiar con service role.
    // El correo NO es identidad — `entidades.email` es una columna de datos que
    // el ADMIN edita desde la pantalla de distribuidores, y un correo puesto en
    // la fila equivocada convertia a un DST en ADMIN. Por eso `mi_entidad_id()`
    // en Postgres tambien dejo de empatar por correo
    // (supabase/migrations/20260902235500_identidad_solo_por_auth_id.sql).
    const SELECCION = 'id, email, rol, nombre'

    const { data: porAuthId, error: errorAuthId } = await supabase
      .from('entidades')
      .select(SELECCION)
      .eq('auth_id', user.id)
      .maybeSingle()

    if (errorAuthId) {
      console.error('Error fetching user entity by auth_id:', errorAuthId.message)
      return null
    }

    let entidad = porAuthId

    if (!entidad) {
      // RESPALDO POR CORREO, y se avisa a gritos. Las 5 entidades con login
      // tienen `auth_id` (comprobado 2026-09-02), asi que esta rama no deberia
      // correr nunca. El aviso existe para enterarnos el dia que corra.
      //
      // OJO: encontrar la fila aqui NO arregla nada. El RLS de Postgres ya solo
      // reconoce `auth_id`, asi que una sesion que llegue por este camino vera
      // la base practicamente vacia aunque la app crea saber quien es. La cura
      // es poblar `entidades.auth_id`, no ampliar este respaldo.
      const { data: porCorreo, error: errorCorreo } = await supabase
        .from('entidades')
        .select(SELECCION)
        .eq('email', user.email)
        .maybeSingle()

      if (errorCorreo || !porCorreo) {
        console.error(
          'Error fetching user entity:',
          errorCorreo?.message ?? `sin fila en entidades para ${user.email}`
        )
        return null
      }

      console.warn(
        `[auth-utils] RESPALDO POR CORREO: ${user.email} no tiene entidades.auth_id = ${user.id}. ` +
          'El RLS ya no resuelve identidad por correo: esta sesion vera datos incompletos. ' +
          'Hay que poblar entidades.auth_id para este usuario.'
      )

      entidad = porCorreo
    }

    return {
      id: entidad.id,
      email: entidad.email,
      rol: entidad.rol as CurrentUser['rol'],
      nombre: entidad.nombre
    }
  } catch (e) {
    console.error('Error in getCurrentUser:', e)
    return null
  }
}

/**
 * Check if current user is SOCIO (read-only role)
 */
export async function isReadOnlyUser(): Promise<boolean> {
  const user = await getCurrentUser()
  return user?.rol === 'SOCIO'
}

/**
 * Check if current user can perform mutations
 */
export async function canMutate(): Promise<boolean> {
  const user = await getCurrentUser()
  return user !== null && user.rol !== 'SOCIO'
}

/**
 * Throw error if user is SOCIO (for Server Actions)
 */
export async function requireMutationPermission(): Promise<void> {
  const user = await getCurrentUser()
  
  if (!user) {
    throw new Error('No autenticado')
  }
  
  if (user.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura. Los usuarios SOCIO no pueden realizar cambios.')
  }
}
