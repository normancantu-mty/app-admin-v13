/**
 * ERP-07 — LA PUERTA DEL SERVIDOR.
 *
 * SE LLAMA `proxy.ts` Y NO `middleware.ts` porque Next 16 renombro la
 * convencion: con `middleware.ts` el build imprime
 * `The "middleware" file convention is deprecated`, y el cargador de Next
 * (node_modules/next/dist/build/templates/middleware.js) busca en este
 * archivo una funcion exportada que se llame `proxy`. Tener los dos archivos
 * a la vez es un error de build, no un aviso.
 *
 * Corre ANTES de que Next renderice nada. Si no hay sesion, el navegador
 * recibe un 307 a `/login` con el cuerpo vacio: ni el HTML del Server
 * Component ni los datos que traia llegan a salir. Eso es lo que el
 * `useEffect` de `app/dashboard/layout.tsx` no podia hacer — cuando el
 * `useEffect` corre, la respuesta ya se entrego.
 *
 * TRES DECISIONES QUE NO SON DE ESTILO
 *
 * 1. **`auth.getClaims()`, nunca `getSession()`.** `getSession()` cree lo que
 *    diga la cookie; `getClaims()` verifica la FIRMA del JWT. Una cookie
 *    fabricada a mano pasa la primera y no pasa la segunda. (Hasta 2026-10-30
 *    era `getUser()`; se cambio por velocidad: con llaves de firma asimetricas
 *    (ES256/RS256) `getClaims()` verifica en local contra el JWKS cacheado, sin
 *    viaje a Auth en cada peticion; con la llave simetrica HS256 —la de Supabase
 *    local hoy— `getClaims()` llama a `getUser()` por dentro, o sea que se
 *    comporta exactamente igual que antes. Lo que se cede con llaves
 *    asimetricas: una sesion cerrada en otro lado sigue pasando esta puerta
 *    hasta que su JWT vence (`jwt_expiry`, 1 h) — lo mismo que ya aceptaba
 *    PostgREST con ese token.)
 * 2. **El `matcher` abarca de mas y `esRutaProtegida` decide.** Un `matcher`
 *    es configuracion que ninguna prueba ejecuta. La decision vive en
 *    `lib/puerta-dashboard.ts`, que se prueba en `puras`.
 * 3. **Falla cerrada.** Si Supabase no contesta o faltan las variables de
 *    entorno, esto revienta o rebota a `/login`; lo que no hace nunca es
 *    dejar pasar. El modo de fallo caro de este repo es el contrario: un
 *    `try/catch` que convierte "permission denied" en `[]` y pinta ceros
 *    (2026-09-02).
 *
 * Y lo que este archivo NO hace: autorizar. Quien puede ver que fila lo decide
 * el RLS de Postgres, que es la unica autoridad que no depende de que la app
 * se acuerde de preguntar.
 */

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { CABECERA_RUTA, esRutaProtegida, RUTA_LOGIN } from './lib/puerta-dashboard'
import { CABECERA_SESION_VERIFICADA } from './lib/cabecera-sesion'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  const cabeceras = new Headers(request.headers)
  cabeceras.set(CABECERA_RUTA, pathname)
  // Nadie de afuera la puede traer puesta: se borra SIEMPRE y solo se vuelve a
  // poner abajo, con el `sub` que esta puerta acaba de verificar.
  cabeceras.delete(CABECERA_SESION_VERIFICADA)

  if (!esRutaProtegida(pathname)) {
    return NextResponse.next({ request: { headers: cabeceras } })
  }

  // El refresco del token se junta aqui y se escribe en la respuesta final,
  // que se arma DESPUES de verificar (lleva la cabecera de sesion verificada).
  const refrescadas: { name: string; value: string; options: Parameters<NextResponse['cookies']['set']>[2] }[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // El refresco del token tiene que volver al navegador o la sesion se
          // cae sola a la hora. Se escribe en la respuesta, no en la peticion.
          refrescadas.push(...cookiesToSet)
        }
      }
    }
  )

  const { data, error } = await supabase.auth.getClaims()

  if (error || !data?.claims?.sub) {
    const destino = request.nextUrl.clone()
    destino.pathname = RUTA_LOGIN
    destino.search = ''
    // 307 y no 302: conserva el metodo. Un POST rebotado como GET se pierde en
    // silencio, y aqui rebotan tambien los envios de formulario sin sesion.
    return NextResponse.redirect(destino, 307)
  }

  // `getCurrentUser` (lib/auth-utils.ts) lee esta cabecera para no repetir el
  // viaje a Auth que esta puerta ya hizo en ESTA peticion.
  cabeceras.set(CABECERA_SESION_VERIFICADA, data.claims.sub)
  const respuesta = NextResponse.next({ request: { headers: cabeceras } })
  refrescadas.forEach(({ name, value, options }) => respuesta.cookies.set(name, value, options))
  return respuesta
}

/**
 * Abarca todo menos los estaticos. Quien decide de verdad es `esRutaProtegida`
 * (ver la decision 2 arriba): lo que este `matcher` deja pasar sin proteger es
 * codigo probado, no una cadena que nadie ejecuta.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)']
}
