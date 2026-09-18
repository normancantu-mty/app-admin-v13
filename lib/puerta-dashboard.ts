/**
 * ERP-07 — LA PUERTA, en TypeScript puro.
 *
 * QUE PASO. `app/dashboard/layout.tsx` era `'use client'` y decidia el permiso
 * dentro de un `useEffect`: pedia la sesion al navegador, resolvia la entidad
 * **por correo** y, si no le gustaba, llamaba a `router.replace`. Una puerta
 * que corre en el navegador no es una puerta. Para cuando ese `useEffect` se
 * ejecuta, el HTML del Server Component y los datos que traia **ya viajaron**:
 * quedan en el `view-source`, en la cache del navegador y en el log del proxy.
 * El `replace` cambia lo que se VE, no lo que se ENTREGO.
 *
 * DONDE VIVE AHORA. En `proxy.ts`, que corre antes de renderizar nada, y
 * en `app/dashboard/layout.tsx`, que ya es un Server Component. Este archivo es
 * la parte que decide: funciones puras, sin React, sin cookies y sin red, para
 * que `tests/puerta-servidor.spec.ts` las corra en el proyecto `puras` — sin
 * navegador, sin base y sin credenciales. Una puerta cuya prueba se salta es
 * una puerta que nadie vigila.
 *
 * LA REGLA DE ORO: la decision NO vive en el `matcher` de `proxy.ts`. Un
 * `matcher` es una cadena en un objeto de configuracion que ninguna prueba
 * puede ejecutar; si alguien lo edita mal, la puerta se abre en silencio y
 * todo sigue verde. El `matcher` abarca de mas y es `esRutaProtegida` —codigo,
 * y probado— quien dice que se protege.
 */

/** A donde se manda a quien no trae sesion. */
export const RUTA_LOGIN = '/login'

/**
 * La cabecera donde `proxy.ts` -el middleware, renombrado por Next 16- deja el pathname real para que el Server
 * Component lo lea con `headers()`. Un layout no recibe la ruta como prop y la
 * reubicacion por rol la necesita.
 *
 * Es una cabecera de PETICION que pone el servidor: `requestHeaders.set` pisa
 * lo que mande el navegador, asi que no se puede falsear desde fuera. Vive aqui
 * y no en `proxy.ts` porque importar el middleware desde un layout
 * arrastraria `@supabase/ssr` y `next/server` a donde no hacen falta.
 */
export const CABECERA_RUTA = 'x-ruta-actual'

/**
 * Las tres zonas que hoy exigen sesion. Son exactamente las tres que envolvian
 * su layout en `<ProtectedRoute>`: `/dashboard`, `/pos` y `/ticket`. No se
 * agrega ni se quita ninguna aqui sin mirar `tests/puerta-servidor.spec.ts`.
 *
 * `/api/**` queda FUERA a proposito: el bot de Telegram entra por
 * `app/api/bot/**` con su propio sello (`lib/bot-sello.ts`), no con cookies de
 * navegador. Meterlo aqui lo dejaria mudo.
 */
export const RUTAS_PROTEGIDAS = ['/dashboard', '/pos', '/ticket'] as const

/**
 * Las areas de mando: lo que un rol de consulta (DST, LOC, SUB-ADMIN) no abre.
 * Es la misma lista que estaba dentro del `useEffect`, palabra por palabra.
 */
export const AREAS_DE_MANDO = [
  '/dashboard/finanzas',
  '/dashboard/inventario',
  '/dashboard/general'
] as const

/** Los roles que SI abren las areas de mando. */
export const ROLES_DE_MANDO = ['ADMIN', 'SOCIO'] as const

/**
 * ¿Esta ruta exige sesion?
 *
 * Compara por SEGMENTO, no por prefijo de cadena: `/dashboardsecreto` no es
 * `/dashboard`, y `startsWith('/dashboard')` habria dicho que si. El caso
 * inverso —dejar fuera `/dashboard` a secas por no traer barra— es el que abre
 * el hueco, y por eso se prueban los dos.
 */
export function esRutaProtegida(pathname: string): boolean {
  const limpia = normalizar(pathname)
  return RUTAS_PROTEGIDAS.some((zona) => limpia === zona || limpia.startsWith(`${zona}/`))
}

/** ¿Esta ruta es un area de mando? Mismo criterio de segmento. */
export function esAreaDeMando(pathname: string): boolean {
  const limpia = normalizar(pathname)
  return AREAS_DE_MANDO.some((area) => limpia === area || limpia.startsWith(`${area}/`))
}

/**
 * A donde hay que mandar a este usuario, o `null` si se queda donde esta.
 *
 * Reproduce la decision que tomaba el `useEffect`, con una diferencia que no es
 * cosmetica: aqui `rol` y `entidadId` llegan resueltos EN EL SERVIDOR por
 * `lib/auth-utils.ts`, que empata por `entidades.auth_id` —la columna que solo
 * cambia con service role— y no por `entidades.email`, que es un campo que el
 * ADMIN teclea en una pantalla. Un correo puesto en la fila equivocada
 * convertia a un DST en ADMIN (ver el comentario de `getCurrentUser`).
 */
export function destinoPorRol(args: {
  rol: string | null
  entidadId: string | null
  pathname: string
}): string | null {
  const { rol, entidadId, pathname } = args

  // Sin rol resuelto no se reubica a nadie: esa decision es de quien tiene el
  // dato. El layout, en ese caso, pinta el menu vacio -lo mismo que hacia el
  // cliente-, y el RLS sigue siendo quien decide que filas se ven.
  if (!rol) return null

  const enMayusculas = rol.toUpperCase()
  if ((ROLES_DE_MANDO as readonly string[]).includes(enMayusculas)) return null
  if (!esAreaDeMando(pathname)) return null

  const destino =
    enMayusculas === 'DST'
      ? '/dashboard/distribuidores'
      : entidadId
        ? `/dashboard/distribuidores/${entidadId}`
        : '/dashboard/distribuidores'

  // Nunca redirigir a donde ya estamos: eso es un bucle, no una puerta.
  return normalizar(pathname) === destino ? null : destino
}

/** Sin `?query`, sin `#hash` y sin la barra final. `''` se vuelve `/`. */
function normalizar(pathname: string): string {
  const sinQuery = pathname.split('?')[0].split('#')[0]
  if (sinQuery.length > 1 && sinQuery.endsWith('/')) return sinQuery.slice(0, -1)
  return sinQuery || '/'
}
