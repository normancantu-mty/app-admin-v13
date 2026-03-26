import { supabase } from './supabase'

// ============================================================================
// SERVER-SIDE AUTH UTILITIES
// ============================================================================

export interface CurrentUser {
  id: string
  email: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO'
  nombre: string
}

/**
 * Get current logged-in user from server-side
 * Use this in Server Components to fetch user role and apply permissions
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    
    if (!session || !session.user.email) {
      return null
    }

    const { data: entidad, error } = await supabase
      .from('entidades')
      .select('id, email, rol, nombre')
      .eq('email', session.user.email)
      .single()

    if (error || !entidad) {
      console.error('Error fetching user entity:', error?.message)
      return null
    }

    return {
      id: entidad.id,
      email: entidad.email,
      rol: entidad.rol as CurrentUser['rol'],
      nombre: entidad.nombre
    }
  } catch (error: any) {
    console.error('Error in getCurrentUser:', error?.message)
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
