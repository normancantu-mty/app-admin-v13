/**
 * AG-01 — La identidad de servicio del bot, y su puerta de entrada.
 *
 * **No lleva `'use server'` a proposito** (misma razon que `lib/server-session.ts`
 * y `lib/avisos-server.ts`): en un archivo `'use server'` toda exportacion se
 * vuelve un endpoint invocable desde el navegador. Esto no lo debe poder
 * llamar nadie desde fuera.
 *
 * POR QUE `service_role` Y NO UNA SESION: un `telegram_id` no trae ni correo de
 * sesion ni `auth_id`, y `mi_entidad_id()` resuelve SOLO por `auth_id` desde el
 * 20260903043244. El bot no puede tener sesion de usuario sin inventarle una
 * cuenta de auth a cada persona de planta, que es exactamente el rol nuevo que
 * AG-02 prohibe. Entra con identidad de servicio y la autorizacion la hace este
 * archivo, fila por fila, contra `bot_identidades`.
 *
 * El trigger `tg_forzar_autor` respeta `usuario_creador` cuando no hay JWT de
 * sesion (verificado en la migracion 20260903043105, linea 167: sin email de
 * sesion hace `COALESCE(NULLIF(BTRIM(NEW.usuario_creador),''), 'sistema')`).
 * **Por eso el bot SI puede marcar `telegram:<quien>` y que sobreviva.**
 */

import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export type ClienteServicio = SupabaseClient<Database>

export function clienteDeServicio(): ClienteServicio {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Falta NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

/**
 * El secreto compartido entre el proceso del bot y la app. Es lo unico que
 * separa estos endpoints de internet, asi que se compara **completo y en
 * tiempo constante-ish**: nunca con `startsWith`, nunca por prefijo.
 *
 * Si `BOT_API_TOKEN` no esta definido, la puerta queda **cerrada**, no abierta.
 * Un secreto ausente no es "modo desarrollo": es la unica configuracion en la
 * que un olvido se convierte en un endpoint publico de escritura al ledger.
 */
export function tokenValido(request: Request): boolean {
  const esperado = process.env.BOT_API_TOKEN
  if (!esperado || esperado.length < 24) return false
  const recibido = request.headers.get('x-bot-token') ?? ''
  if (recibido.length !== esperado.length) return false
  let diferencia = 0
  for (let i = 0; i < esperado.length; i++) {
    diferencia |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i)
  }
  return diferencia === 0
}

export interface IdentidadBot {
  idEntidad: string
  idCuentaDestino: string
  etiqueta: string
  nombreEntidad: string
  nombreCuenta: string
}

/**
 * Resuelve un `telegram_id` a una entidad del ERP. **`null` si no esta dado de
 * alta, y eso significa que no escribe nada.** No hay auto-registro: el alta la
 * hace Norman a mano, 15 filas en total (Q-14). Que sea manual es una ventaja
 * de seguridad — nadie se auto-asigna una entidad.
 */
export async function resolverIdentidad(
  supabase: ClienteServicio,
  telegramId: number
): Promise<IdentidadBot | null> {
  const { data, error } = await supabase
    .from('bot_identidades')
    .select('etiqueta, id_entidad, id_cuenta_destino, activo')
    .eq('telegram_id', telegramId)
    .eq('activo', true)
    .maybeSingle()

  if (error || !data) return null

  const [entidad, cuenta] = await Promise.all([
    supabase.from('entidades').select('nombre').eq('id', data.id_entidad).maybeSingle(),
    supabase.from('cuentas_financieras').select('nombre').eq('id', data.id_cuenta_destino).maybeSingle()
  ])

  return {
    idEntidad: data.id_entidad,
    idCuentaDestino: data.id_cuenta_destino,
    etiqueta: data.etiqueta,
    nombreEntidad: entidad.data?.nombre ?? '(entidad)',
    nombreCuenta: cuenta.data?.nombre ?? '(cuenta)'
  }
}
