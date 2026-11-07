/**
 * EL CLIENTE QUE FISICAMENTE NO PUEDE ESCRIBIR (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 2: preguntas al ERP).
 *
 * `/api/bot/pregunta` contesta preguntas libres. Que "no escriba" no puede
 * depender de que el codigo de la ruta se porte bien: el candado esta en la
 * capa HTTP. El `fetch` de este cliente deja salir **solo GET y HEAD**. Toda
 * escritura de PostgREST (insert/update/upsert/delete, y cualquier rpc por
 * POST) es otro metodo, y aqui se contesta 405 sin que la peticion salga del
 * proceso. Las rpc de lectura (`saldo_cuenta`, STABLE) se llaman por GET
 * (`rpc(..., { get: true })`), que PostgREST solo acepta para funciones que
 * no modifican.
 *
 * LO QUE ESTO NO ES (dicho para que nadie lo lea de mas): sigue usando la llave
 * de servicio, asi que **no** pasa por RLS. El alcance por rol lo aplica la
 * ruta con `lib/bot-permisos.ts`, igual que `/api/bot/consulta`. Correr bajo
 * la identidad de quien pregunta pide una migracion (rol de base para el bot):
 * propuesta en `supabase/migraciones_propuestas/`.
 */

import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { ClienteServicio } from '@/lib/bot-servidor'

const METODOS_DE_LECTURA = new Set(['GET', 'HEAD'])

/** Las peticiones que el candado paro, para quien quiera leerlas (pruebas). */
export const escriturasParadas: { metodo: string; url: string }[] = []

function metodoDe(entrada: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && entrada instanceof Request) return entrada.method.toUpperCase()
  return 'GET'
}

/** Envuelve un `fetch`: GET/HEAD pasan; lo demas, 405 sin salir. **Puro.** */
export function fetchDeSoloLectura(base: typeof fetch): typeof fetch {
  return (async (entrada: RequestInfo | URL, init?: RequestInit) => {
    const metodo = metodoDe(entrada, init)
    if (METODOS_DE_LECTURA.has(metodo)) return base(entrada, init)
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url
    escriturasParadas.push({ metodo, url })
    return new Response(
      JSON.stringify({ message: `SOLO_LECTURA: ${metodo} no sale de este cliente`, code: 'SOLO_LECTURA' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch
}

/**
 * El cliente de `/api/bot/pregunta`. `base` existe para las pruebas (un
 * PostgREST falso); en produccion es el `fetch` global, leido al llamar.
 */
export function clienteDeSoloLectura(base?: typeof fetch): ClienteServicio {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  const salida: typeof fetch = base ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a))
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchDeSoloLectura(salida) }
  })
}
