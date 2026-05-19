import { supabase } from './supabase'

export interface CurrentClientUser {
  id: string
  email: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO'
  nombre: string
}

export async function getCurrentClientUser(): Promise<CurrentClientUser | null> {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession()

  if (sessionError || !session?.user?.email) {
    return null
  }

  const { data, error } = await supabase
    .from('entidades')
    .select('id, email, rol, nombre')
    .eq('email', session.user.email)
    .single()

  if (error || !data) {
    return null
  }

  return {
    id: data.id,
    email: data.email,
    rol: data.rol as CurrentClientUser['rol'],
    nombre: data.nombre
  }
}

export async function requireClientMutationPermission(): Promise<void> {
  const user = await getCurrentClientUser()

  if (!user) {
    throw new Error('No autenticado')
  }

  if (user.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura. Los usuarios SOCIO no pueden realizar cambios.')
  }
}
