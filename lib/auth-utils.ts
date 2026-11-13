import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies, headers } from 'next/headers'
import { CABECERA_SESION_VERIFICADA } from './cabecera-sesion'

// ============================================================================
// SERVER-SIDE AUTH UTILITIES
// ============================================================================

export interface CurrentUser {
  id: string
  email: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO' | 'SUB-ADMIN' | 'EMPLEADO_ADMIN'
  nombre: string
  /** Solo cuenta para EMPLEADO_ADMIN (`accesos.permiso_finanzas`). Ver `puedeVerFinanzas`. */
  permiso_finanzas?: boolean
}

/**
 * La fila activa de `accesos` de este login, o `null`. Mismo orden que
 * `mi_rol()` / `mi_entidad_id()` en Postgres (20261104175839_accesos.sql): si
 * hay fila, manda ella (rol y entidad desde la que opera); si no, `entidades`.
 * `select('*')` a proposito: si `permiso_finanzas` aun no existe en la base,
 * la lectura no truena (queda en false). Un error se registra y se cae al
 * camino de siempre: para un login que solo vive en `accesos` eso es `null`
 * (falla cerrada).
 */
export async function leerAcceso(
  supabase: SupabaseClient,
  authId: string
): Promise<{ rol: string; idEntidad: string; nombre: string; permisoFinanzas: boolean } | null> {
  const { data, error } = await supabase.from('accesos').select('*').eq('auth_id', authId).eq('activo', true).maybeSingle()
  if (error) {
    console.error('Error leyendo accesos:', error.message)
    return null
  }
  if (!data) return null
  const fila = data as { rol: string; id_entidad: string; nombre: string; permiso_finanzas?: boolean | null }
  return {
    rol: String(fila.rol || '').toUpperCase(),
    idEntidad: fila.id_entidad,
    nombre: fila.nombre,
    permisoFinanzas: fila.permiso_finanzas === true
  }
}

/**
 * El cliente de SOLO LECTURA por peticion. No escribe cookies a proposito: un
 * Server Component no puede hacerlo —Next lanza al intentarlo— y no le hace
 * falta, porque el refresco del token lo hace `proxy.ts`, que si puede.
 */
async function crearClienteDeLectura() {
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
          // No-op en SSR
        },
        remove() {
          // No-op en SSR
        }
      }
    }
  )
}

/**
 * ¿Hay sesion valida? Devuelve el usuario de `auth`, o `null`.
 *
 * ERP-07: existe para que `app/dashboard/layout.tsx` distinga los dos "no" que
 * `getCurrentUser` junta en un solo `null` — **no hay sesion** (rebota a
 * `/login`) y **hay sesion pero el usuario no tiene fila en `entidades`** (NO
 * rebota: seria el bucle login → dashboard → login, y esa cuenta ya entraba
 * antes al tablero, con el menu vacio).
 *
 * `getUser()` y no `getSession()`: el primero valida el token contra el
 * servidor de auth, el segundo le cree a la cookie.
 */
export async function getAuthUser(): Promise<{ id: string; email: string } | null> {
  try {
    const supabase = await crearClienteDeLectura()
    const {
      data: { user },
      error
    } = await supabase.auth.getUser()

    if (error || !user?.email) return null
    return { id: user.id, email: user.email }
  } catch (e) {
    // Falla cerrada: si no se pudo comprobar, no hay sesion.
    console.error('Error in getAuthUser:', e)
    return null
  }
}

/**
 * `sub` y `email` del access token de la sesion, SIN viaje de red y SIN
 * verificar la firma: solo sirve si lo que sigue es una consulta a PostgREST con
 * ese mismo cliente (que manda ese mismo JWT y lo verifica). `getSession()`
 * refresca el token si ya vencio, igual que lo hacia `getUser()` por dentro.
 */
async function usuarioDelToken(
  supabase: Awaited<ReturnType<typeof crearClienteDeLectura>>
): Promise<{ id: string; email: string } | null> {
  const {
    data: { session },
    error
  } = await supabase.auth.getSession()
  if (error || !session?.access_token) return null
  const partes = session.access_token.split('.')
  if (partes.length !== 3) return null
  try {
    const reclamos = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8')) as {
      sub?: unknown
      email?: unknown
    }
    if (typeof reclamos.sub !== 'string' || typeof reclamos.email !== 'string' || !reclamos.email) return null
    return { id: reclamos.sub, email: reclamos.email }
  } catch {
    return null
  }
}

/**
 * Get current logged-in user from server-side
 * Use this in Server Components to fetch user role and apply permissions
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const supabase = await crearClienteDeLectura()

    // PERF (2026-10-30): si `proxy.ts` ya verifico la sesion en ESTA peticion
    // (cabecera interna con el `sub` verificado, que la puerta borra de toda
    // peticion entrante), no se repite el viaje de red a Auth: era uno en CADA
    // render, en serie antes de cualquier lectura. La identidad sale entonces
    // del `sub` del access token, y aun asi NO se le cree a la cookie: debe
    // coincidir con el que verifico la puerta, y la consulta a `entidades` de
    // abajo viaja autenticada con ESE MISMO JWT, que PostgREST verifica (firma
    // y expiracion; alterado o vencido = 401 = `null`). No se usa `session.user`
    // (un JSON de la cookie editable sin tocar la firma). Sin la cabecera (una
    // ruta fuera de la puerta, como `/api/...`), todo sigue como antes: `getUser()`.
    const verificadoPorLaPuerta = (await headers()).get(CABECERA_SESION_VERIFICADA)
    const delToken = verificadoPorLaPuerta ? await usuarioDelToken(supabase) : null
    let user: { id: string; email?: string } | null = delToken && delToken.id === verificadoPorLaPuerta ? delToken : null
    if (!user) {
      const {
        data: { user: deAuth },
        error: authError
      } = await supabase.auth.getUser()
      if (authError) return null
      user = deAuth
    }
    if (!user?.email) {
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

    // `accesos` primero, como `mi_rol()`. Ojo: un login que esta en las dos
    // tablas (p. ej. ADMIN en accesos y DST en entidades) se ve aqui con el rol
    // de `accesos`, que es el que la base ya le aplica.
    const acceso = await leerAcceso(supabase, user.id)
    if (acceso) {
      return {
        id: acceso.idEntidad,
        email: user.email,
        rol: acceso.rol as CurrentUser['rol'],
        nombre: acceso.nombre,
        permiso_finanzas: acceso.permisoFinanzas
      }
    }

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
