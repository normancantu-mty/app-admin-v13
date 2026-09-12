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
import { CATALOGO_SEMILLA, type CategoriaDelCatalogo } from '@/lib/bot-gastos'

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

export interface CuentaDelBot {
  id: string
  nombre: string
}

export interface IdentidadBot {
  idEntidad: string
  /**
   * La cuenta contra la que se asienta. **Una sola, y su significado depende
   * del tipo de movimiento**: destino en un gasto, origen en una compra de
   * insumos. Lo decide `formaDeFila()`, nunca el LLM.
   */
  idCuenta: string
  etiqueta: string
  nombreEntidad: string
  /**
   * El rol de la entidad (`ADMIN`, `DST`, `LOC`). **Solo lo usa la Fase 3**,
   * y decide el ALCANCE de una consulta: `ADMIN` ve todo, cualquier otro ve
   * solo lo suyo. Se trae aqui, con la identidad, para que ningun endpoint
   * tenga que volver a preguntarlo — un alcance que se recalcula en dos
   * lugares es un alcance que algun dia discrepa.
   */
  rolEntidad: string
  nombreCuenta: string
  /**
   * Las OTRAS cuentas de la misma entidad que el bot puede usar. Es una lista
   * cerrada calculada en el servidor: el boton "cambiar cuenta" elige de aqui
   * por indice, asi que ni el modelo ni el proceso del bot pueden nombrar una
   * cuenta que este vetada o que sea de otra entidad.
   *
   * Existe porque el default no puede ser correcto: medido el 2026-09-12, los
   * gastos activos se reparten 10/10 entre Cuenta personal y Efectivo. Un
   * default fijo estaria mal la mitad de las veces, y una confirmacion que hay
   * que cancelar la mitad de las veces se vuelve reflejo (automation bias).
   */
  cuentas: CuentaDelBot[]
}

/**
 * Los mismos tres vetos que `cuentaVetadaComoDefault` (lib/avisos.ts) y que el
 * trigger `tg_bot_vetar_cuenta_fiscal`, aplicados aqui porque esta lista es lo
 * que se le ofrece a la persona. Repetido a proposito en las tres capas: el
 * veto barato se paga tres veces, la fuga fiscal una sola y no se deshace.
 */
export function cuentaUsableporElBot(c: { nombre: string | null; tipo_fiscalidad: string | null }): boolean {
  const nombre = (c.nombre ?? '').toLowerCase()
  if (nombre.includes('fresnillo')) return false
  if ((c.tipo_fiscalidad ?? '').toUpperCase() === 'FULL_TAX') return false
  return true
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

  const [entidad, cuentas] = await Promise.all([
    supabase.from('entidades').select('nombre, rol').eq('id', data.id_entidad).maybeSingle(),
    supabase
      .from('cuentas_financieras')
      .select('id, nombre, tipo_fiscalidad')
      .eq('id_entidad', data.id_entidad)
  ])

  const usables = (cuentas.data ?? []).filter(cuentaUsableporElBot)
  const nombreCuenta = usables.find((c) => c.id === data.id_cuenta_destino)?.nombre ?? '(cuenta)'

  return {
    idEntidad: data.id_entidad,
    idCuenta: data.id_cuenta_destino,
    etiqueta: data.etiqueta,
    nombreEntidad: entidad.data?.nombre ?? '(entidad)',
    // Si la lectura fallo, el rol por defecto es el MAS restrictivo. Un
    // default permisivo convierte un error de red en una fuga de datos.
    rolEntidad: entidad.data?.rol ?? 'DESCONOCIDO',
    nombreCuenta,
    cuentas: usables.map((c) => ({ id: c.id, nombre: c.nombre ?? '(cuenta)' }))
  }
}

/**
 * El catalogo VIVO de categorias. Si la base no contesta, devuelve la semilla
 * en vez de una lista vacia: una lista vacia mandaria **todo** a
 * `SIN_CATEGORIZAR` en silencio, que es peor que trabajar con seis categorias.
 */
export async function leerCatalogo(
  supabase: ClienteServicio
): Promise<CategoriaDelCatalogo[]> {
  const { data, error } = await supabase
    .from('bot_categorias')
    .select('nombre, ayuda, tipo_movimiento, columna')
    .eq('activa', true)
    .order('nombre')

  if (error || !data || data.length === 0) {
    if (error) console.error('[bot] no pude leer bot_categorias, uso la semilla:', error)
    return CATALOGO_SEMILLA
  }
  return data.map((c) => ({
    nombre: c.nombre,
    ayuda: c.ayuda ?? '',
    tipo_movimiento: c.tipo_movimiento as 'GASTO_OPERATIVO' | 'COMPRA_INSUMOS',
    columna: c.columna as 'origen' | 'destino'
  }))
}
