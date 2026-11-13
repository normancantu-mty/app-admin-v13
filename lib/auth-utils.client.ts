import { supabase } from './supabase'

export interface CurrentClientUser {
  id: string
  email: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO' | 'EMPLEADO_ADMIN'
  nombre: string
  permiso_finanzas?: boolean
}

export async function getCurrentClientUser(): Promise<CurrentClientUser | null> {
  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession()

  if (sessionError || !session?.user?.email) {
    return null
  }

  // `accesos` primero (por auth_id), como `mi_rol()` en la base.
  const { data: acceso } = await supabase
    .from('accesos')
    .select('*')
    .eq('auth_id', session.user.id)
    .eq('activo', true)
    .maybeSingle()
  if (acceso) {
    const fila = acceso as { id_entidad: string; rol: string; nombre: string; permiso_finanzas?: boolean | null }
    return {
      id: fila.id_entidad,
      email: session.user.email,
      rol: String(fila.rol || '').toUpperCase() as CurrentClientUser['rol'],
      nombre: fila.nombre,
      permiso_finanzas: fila.permiso_finanzas === true
    }
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
