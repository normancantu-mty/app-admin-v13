/**
 * AG-06 FASE 5 — DAR DE ALTA UN DISTRIBUIDOR O UN LOCAL. Las escrituras.
 *
 * D8: extraido de `registrarEntidadAction` (`app/actions/distribuidores.ts`)
 * para que el bot lo pueda usar sin sesion de navegador. La accion se queda con
 * `cookies()`, `getCurrentUser()` y `revalidatePath()`; lo demas vive aqui.
 *
 * La aritmetica de comisiones, las listas cerradas y los mensajes estan en
 * `lib/bot-entidad.ts`, que no toca la base y por eso se prueba en `puras`.
 *
 * ─── EL PERMISO LO APLICA ESTE ARCHIVO, PORQUE LA BASE NO VA A HACERLO ──────
 *
 * La politica `entidades_ins_admin` dice que solo un ADMIN inserta en
 * `entidades`. El bot entra con `service_role`, y `service_role` **se salta el
 * RLS entero** — no hay `FORCE ROW LEVEL SECURITY` en ninguna tabla. O sea que
 * para el camino del chat esa politica no existe, y la unica comprobacion que
 * queda en pie es `assertPuedeDarDeAlta()`, unas lineas mas abajo.
 *
 * Su control negativo esta en `tests/bot-entidad.spec.ts` y no es decorativo:
 * es la prueba de que un DST no puede crear entidades por Telegram.
 */

import { randomBytes } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { buscarPorNombre } from '@/lib/bot-nombres'
import { esRolDeAlta, esZonaValida, type PayloadAlta } from '@/lib/bot-entidad'

type Cliente = SupabaseClient<Database>

// ============================================================================
// 1. LA CONTRASENA (D11)
// ============================================================================

/** Sin `0`, `O`, `1`, `l` ni `I`: esta contrasena se va a leer en voz alta o se
 * va a copiar a mano de la pantalla de un celular. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

export const LARGO_MINIMO_PASSWORD = 16

/**
 * La contrasena de un DST **la genera el servidor y se ensena una sola vez**.
 *
 * Que la dicte la persona la deja en tres lugares a la vez: transcrita en el log
 * del bot, dentro del archivo de audio de `bot/_audios/`, y en el historial del
 * chat de Telegram. Tres copias de una credencial a cambio de ahorrarse una
 * funcion.
 */
export function generarPassword(largo: number = LARGO_MINIMO_PASSWORD): string {
  const n = Math.max(LARGO_MINIMO_PASSWORD, largo)
  // El limite por debajo del cual el modulo no sesga el alfabeto. Descartar los
  // bytes de arriba cuesta nada y quita la unica objecion real a generar
  // contrasenas asi.
  const limite = 256 - (256 % ALFABETO.length)
  let salida = ''
  while (salida.length < n) {
    // `randomBytes`, no `Math.random()`: esto es una credencial, no un id de UI.
    const bytes = randomBytes(n * 2)
    for (let i = 0; i < bytes.length && salida.length < n; i += 1) {
      if (bytes[i] >= limite) continue
      salida += ALFABETO[bytes[i] % ALFABETO.length]
    }
  }
  return salida
}

// ============================================================================
// 2. EL DUPLICADO POR NOMBRE (D12)
// ============================================================================

export interface EntidadParecida {
  id: string
  nombre: string
  rol: string
  zona: string | null
}

export interface JuicioDeDuplicado {
  hayParecido: boolean
  parecidas: EntidadParecida[]
}

/**
 * *"da de alta a Juan"* crea un segundo Juan sin decir nada: **no hay `UNIQUE`
 * en `entidades.nombre`** (verificado contra produccion el 2026-09-19). Y dos
 * entidades con el mismo nombre no se notan hasta que alguien le abona al Juan
 * equivocado, que es un error que ya no se deshace con un `UPDATE`.
 *
 * Se usa la busqueda difusa que ya existe —con sus `PALABRAS_VACIAS` y sus tres
 * pasadas— para no tener dos criterios de parecido en el mismo repo. El correo
 * si es `UNIQUE` y ahi la base protege sola.
 */
export async function buscarParecidas(
  supabase: Cliente,
  nombre: string
): Promise<JuicioDeDuplicado> {
  const { data, error } = await supabase
    .from('entidades')
    .select('id, nombre, rol, zona')
    .in('rol', ['DST', 'LOC'])
  if (error) throw new Error(error.message)

  const candidatas = (data ?? []) as EntidadParecida[]
  const hallazgo = buscarPorNombre(nombre, candidatas, (e) => [e.nombre])

  if (hallazgo.ok) return { hayParecido: true, parecidas: [hallazgo.elegido] }
  if (hallazgo.motivo === 'ambiguo') {
    return { hayParecido: true, parecidas: hallazgo.candidatos }
  }
  return { hayParecido: false, parecidas: [] }
}

// ============================================================================
// 3. EL PERMISO (D14)
// ============================================================================

export interface ActorDeAlta {
  idEntidad: string
  rol: string
}

export function puedeDarDeAlta(actor: ActorDeAlta): boolean {
  return String(actor.rol ?? '').toUpperCase() === 'ADMIN'
}

/**
 * **Solo ADMIN da de alta entidades.** Con `service_role` esta es la unica
 * comprobacion que existe — ver el encabezado del archivo.
 *
 * ─── DEFECTO CONOCIDO, ANOTADO Y NO ARREGLADO AQUI ──────────────────────────
 *
 * El TypeScript de la app (`registrarEntidadAction`) deja que un DST cree un
 * LOC: solo le prohibe crear otro DST. La politica `entidades_ins_admin` lo
 * rechaza igual, asi que ese camino esta escrito y **no funciona** — el DST
 * llena el formulario y recibe un error de RLS que no explica nada.
 *
 * No se toca desde aqui porque arreglarlo es decidir cual de las dos mitades
 * tiene razon (si los DST deben poder crear sus locales o no), y esa es una
 * decision de negocio, no de este paso. Queda en el informe.
 */
export function assertPuedeDarDeAlta(actor: ActorDeAlta): void {
  if (!puedeDarDeAlta(actor)) {
    throw new Error('Solo administracion da de alta distribuidores y locales.')
  }
}

// ============================================================================
// 4. EL ALTA
// ============================================================================

export interface ResultadoDeAlta {
  id: string
  nombre: string
  cuenta: string
}

export interface PuertaDeAuth {
  crear: (email: string, password: string) => Promise<string>
  borrar: (authId: string) => Promise<void>
}

/**
 * La entidad y su cuenta, en UNA transaccion (D13).
 *
 * ─── EL ORDEN, Y POR QUE EL USUARIO DE AUTH VA FUERA ────────────────────────
 *
 * `auth.admin.createUser()` es una llamada HTTP al servidor de Auth de
 * Supabase, y eso **no cabe dentro de una transaccion de Postgres**. Asi que va
 * antes, y se borra en el `catch` si la RPC lanza. Es el mismo orden que tiene
 * hoy la app y es el correcto: un usuario de Auth huerfano se puede borrar; una
 * entidad sin cuenta, no — no puede recibir ningun movimiento (`finanzas_ledger`
 * se asienta contra `cuentas_financieras`, no contra `entidades`) y aun asi
 * aparece en el desplegable de compradores.
 *
 * Lo que SI desaparece es la compensacion por `DELETE` de la app: si la cuenta
 * fallaba, borraba la entidad. La leccion de ERP-66 es que un DELETE denegado
 * por RLS no da error — devuelve cero filas y un 200, o sea que esa compensacion
 * podia "funcionar" sin borrar nada. Ahora las dos filas entran juntas o no
 * entra ninguna, y no queda nada que compensar.
 */
export async function crearEntidad(
  supabase: Cliente,
  actor: ActorDeAlta,
  datos: PayloadAlta,
  password: string | null,
  auth?: PuertaDeAuth
): Promise<ResultadoDeAlta> {
  assertPuedeDarDeAlta(actor)

  const nombre = datos.nombre.trim()
  if (!nombre) throw new Error('El nombre viene vacio.')
  if (!esRolDeAlta(datos.rol)) throw new Error('Rol invalido.')
  if (!esZonaValida(datos.zona)) throw new Error('Zona invalida.')

  const email = datos.email?.trim().toLowerCase() || null
  if (datos.rol === 'DST' && !email) throw new Error('Un distribuidor necesita correo.')
  if (datos.rol === 'DST' && !password) throw new Error('Un distribuidor necesita contrasena.')

  let authId: string | null = null
  if (datos.rol === 'DST' && auth) {
    authId = await auth.crear(email as string, password as string)
  }

  try {
    const { data, error } = await supabase.rpc('crear_entidad_atomica', {
      p_entidad: {
        nombre,
        rol: datos.rol,
        zona: datos.zona,
        email,
        auth_id: authId,
        telefono: datos.telefono?.trim() || null,
        ubicacion_maps: null,
        es_distribuidor: datos.rol === 'DST',
        // El puente legacy: las dos columnas se leen para resolver al padre, asi
        // que las dos se escriben. Poner solo una deja la jerarquia a medias
        // segun por donde la lea cada pantalla.
        id_nodo_padre: datos.id_nodo_padre,
        id_padre: datos.id_nodo_padre,
        comision_base: datos.comision_base,
        comision_base_local: datos.comision_base_local,
        comision_hijo_local: datos.comision_hijo_local,
        // La columna muerta. Se escribe 0 explicito y no se pregunta nunca.
        // Ver `COLUMNA_MUERTA` en `lib/bot-entidad.ts`.
        comision_logistica: 0,
        aplica_redondeo_costo: true
      },
      p_cuenta: {
        // Exactamente UNA, y `LIBRE`. Una cuenta fiscal creada por chat caeria
        // despues en el veto de `cuentaUsableporElBot` y en la deteccion de
        // "fresnillo" de la maquina de impuestos inversos: esas no se crean
        // hablando.
        nombre: `Efectivo (${nombre})`,
        tipo_fiscalidad: 'LIBRE'
      }
    })

    if (error) throw new Error(error.message)
    const id = String(data ?? '')
    if (!id) throw new Error('El alta no devolvio id.')

    return { id, nombre, cuenta: `Efectivo (${nombre})` }
  } catch (e) {
    if (authId && auth) {
      try {
        await auth.borrar(authId)
      } catch (errBorrado) {
        // No se traga: queda un usuario de Auth sin entidad, y alguien tiene que
        // saberlo para borrarlo a mano. Un fallo silencioso aqui deja el correo
        // ocupado, y el siguiente intento de alta choca con el `UNIQUE` sin que
        // se entienda por que.
        console.error('[alta] no pude borrar el usuario de Auth huerfano', authId, errBorrado)
        throw new Error(
          `${e instanceof Error ? e.message : 'Fallo el alta'}. Ademas quedo un usuario de ` +
            `acceso huerfano (${email}) que hay que borrar a mano.`
        )
      }
    }
    throw e
  }
}
