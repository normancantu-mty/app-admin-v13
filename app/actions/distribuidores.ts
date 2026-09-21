'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { TablesInsert } from '@/types/database'
import { annulComercialCascadePorTicketId, assertPermiteAnularTicketEnPerfil } from '@/lib/ticket-annul-cascade'
import { comisionValidada, type PayloadAlta } from '@/lib/bot-entidad'
import { crearEntidad, type PuertaDeAuth } from '@/lib/entidad-servidor'

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

type EntidadInsert = TablesInsert<'entidades'>
type CuentaFinancieraInsert = TablesInsert<'cuentas_financieras'>

interface RegistrarEntidadInput {
  nombre: string
  email?: string | null
  password?: string | null
  rol: 'DST' | 'LOC'
  zona: string
  telefono?: string | null
  ubicacion_maps?: string | null
  id_nodo_padre?: string | null
  comision_base?: number
  comision_base_local?: number
  comision_hijo_local?: number
  comision_logistica?: number
  aplica_redondeo_costo?: boolean
}

interface UpdateEntidadInput {
  nombre?: string
  telefono?: string | null
  ubicacion_maps?: string | null
  zona?: string
  comision_base?: number
  comision_base_local?: number
  comision_hijo_local?: number
  aplica_redondeo_costo?: boolean
}

/**
 * ⛔ RETIRADO 2026-09-19, lo sustituye `normalizarComision` de `lib/bot-entidad.ts`.
 *
 * **Cero llamadores.** Se queda escrito, no borrado (regla 6): es la
 * especificacion de las tres trampas que tenia vivas, y la replica congelada
 * que vive en las pruebas es la prueba de que se cerraron.
 *
 *   1. Convertia a fraccion sin preguntar: `1` se leia como **100%** en
 *      silencio, o sea regalar el producto. Hoy `normalizarComision` devuelve
 *      `ambigua` y se pregunta cual de las dos lecturas es.
 *   2. Redondeaba a **cuatro** decimales sin enterarse de que la columna es
 *      `numeric(5,2)` y guarda **dos**: un 12.5% entraba como `0.125` y
 *      Postgres lo guardaba `0.13` sin avisarle a nadie. Hoy eso es un error de
 *      validacion que dice el numero real que quedaria.
 *   3. Un valor invalido devolvia `0` -- comision cero, callado -- en vez de
 *      detenerse.
 *
 * ```ts
 * function normalizeCommission(value: number | undefined | null): number {
 *   if (value === undefined || value === null || !Number.isFinite(value)) return 0
 *   const v = value > 1 ? value / 100 : value
 *   return Math.max(0, Math.min(1, Math.round(v * 10000) / 10000))
 * }
 * ```
 */

async function getServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        }
      }
    }
  )
}

export async function registrarSeguimientoAction(entidadId: string) {
  if (!entidadId) {
    throw new Error('Entidad inválida.')
  }

  const supabase = await getServerSupabaseClient()
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) {
    throw new Error('Sesión no válida. Inicia sesión nuevamente.')
  }

  const { data: entidadOperadora, error: entidadError } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (entidadError || !entidadOperadora) {
    throw new Error('No se pudo validar tu identidad operativa.')
  }

  if (entidadOperadora.rol === 'SOCIO') {
    throw new Error('No autorizado para registrar seguimiento.')
  }

  const { error: updateError } = await supabase
    .from('entidades')
    .update({ fecha_ultimo_seguimiento: new Date().toISOString() })
    .eq('id', entidadId)

  if (updateError) {
    throw new Error(updateError.message)
  }

  revalidatePath('/dashboard/distribuidores')
}

/**
 * EL ALTA POR PANTALLA. **Un solo camino de servidor, el del bot (D16).**
 *
 * --- LA DEUDA QUE CIERRA (2026-09-19) ---------------------------------------
 *
 * La Fase 5 pedia EXTRAER esta funcion a `lib/entidad-servidor.ts`. No se
 * extrajo: se construyo en paralelo. Quedaron dos verdades para la misma
 * operacion -- `TKT-034`/`TKT-035`, la deuda recien creada otra vez -- y la
 * misma alta daba resultados distintos segun la puerta:
 *
 * | | por el bot | por esta pantalla, hasta hoy |
 * |---|---|---|
 * | un `1` de comision | pregunta 1% o 100% | lo guardaba como **100%**, callado |
 * | un 12.5% | avisa que quedaria 13% antes del "va" | lo guardaba **0.13**, callado |
 * | la escritura | `crear_entidad_atomica`, UNA transaccion | **tres escrituras sueltas** |
 *
 * Esa tercera fila es la peor: si el proceso moria en medio quedaba una entidad
 * sin cuenta, que no puede recibir ningun movimiento -- `finanzas_ledger` se
 * asienta contra `cuentas_financieras` -- y aun asi aparece en el desplegable de
 * compradores. La compensacion por `DELETE` que tenia no servia: la leccion de
 * ERP-66 es que un DELETE denegado por RLS devuelve 200 y cero filas, asi que
 * "funcionaba" sin borrar nada.
 *
 * **La direccion del arreglo no es simetrica: el bueno era el del bot.** Esta
 * funcion pasa a llamar a lo que ya existe, y hereda gratis la atomicidad.
 *
 * --- LO QUE ESTO NO HACE, Y ES EL LIMITE DEL ENCARGO ------------------------
 *
 * **No se rediseña el formulario.** La pantalla sigue sin preguntar las tres
 * comisiones como las pregunta el chat. Esta tanda hace que haya UN SOLO CAMINO
 * DE SERVIDOR, no que la UI sea igual de buena que el bot.
 */
export async function registrarEntidadAction(payload: RegistrarEntidadInput) {
  const { id_nodo_padre } = payload
  const nombre = payload.nombre?.trim()
  const email = payload.email?.trim().toLowerCase() || null
  const password = payload.password?.trim() || null

  if (!nombre) throw new Error('Nombre inválido.')
  if (payload.rol === 'DST' && !email) throw new Error('Email inválido para distribuidor.')
  if (payload.rol === 'DST' && !password) throw new Error('Password inválido para distribuidor.')
  if (!['DST', 'LOC'].includes(payload.rol)) throw new Error('Rol inválido.')

  const supabase = await getServerSupabaseClient()
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) throw new Error('Sesión no válida. Inicia sesión nuevamente.')

  const { data: entidadOperadora, error: entidadError } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (entidadError || !entidadOperadora) throw new Error('No se pudo validar tu identidad operativa.')

  const parentNodeIdRaw = id_nodo_padre?.trim() || ''
  const isValidParentId = parentNodeIdRaw === '' || UUID_REGEX.test(parentNodeIdRaw)
  if (!isValidParentId) throw new Error('id_nodo_padre inválido.')

  let parentNodeId: string | null = null
  if (payload.rol === 'LOC') {
    parentNodeId = entidadOperadora.rol === 'DST' ? entidadOperadora.id : (parentNodeIdRaw || null)
  }

  // -- LAS COMISIONES, CON EL MISMO CRITERIO QUE EL CHAT (D18/D20) ----------
  // El aviso de redondeo vuelve como ERROR DE VALIDACION en vez de redondear en
  // silencio: un 12.5% por pantalla **falla diciendo que quedaria 13%**. Y el
  // `1` ambiguo se detiene en vez de leerse como 100%.
  const comision = comisionValidada

  const datos: PayloadAlta = {
    nombre,
    rol: payload.rol,
    zona: payload.zona as PayloadAlta['zona'],
    email,
    telefono: payload.telefono?.trim() || null,
    id_nodo_padre: parentNodeId,
    comision_base: payload.rol === 'DST' ? comision(payload.comision_base, 'Comisión base') : 0,
    comision_base_local:
      payload.rol === 'LOC' ? comision(payload.comision_base_local, 'Comisión base local') : 0,
    comision_hijo_local:
      payload.rol === 'DST' ? comision(payload.comision_hijo_local, 'Comisión hijo local') : 0
  }

  // La puerta de Auth: la misma llamada de siempre, ahora detras de la interfaz
  // que `crearEntidad` sabe deshacer si la transaccion falla.
  let puerta: PuertaDeAuth | undefined
  if (payload.rol === 'DST') {
    const supabaseAdminUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseAdminUrl || !serviceRoleKey) {
      throw new Error('Configuración de Supabase Admin incompleta.')
    }
    const supabaseAdmin = createClient(supabaseAdminUrl, serviceRoleKey)
    puerta = {
      crear: async (correo: string, clave: string) => {
        const { data: authData, error: createAuthError } =
          await supabaseAdmin.auth.admin.createUser({
            email: correo,
            password: clave,
            email_confirm: true
          })
        if (createAuthError) {
          const msgLower = createAuthError.message?.toLowerCase() ?? ''
          const status = (createAuthError as { status?: number }).status
          const yaRegistrado =
            msgLower.includes('already been registered') ||
            msgLower.includes('already exists') ||
            status === 422 ||
            status === 409
          if (yaRegistrado) {
            throw new Error(
              'Este correo electrónico ya está registrado en el sistema de acceso. Por favor, utiliza un correo distinto o contacta a soporte para liberarlo.'
            )
          }
          throw new Error(
            createAuthError.message
              ? 'Fallo al crear credenciales: ' + createAuthError.message
              : 'No se pudo crear el usuario de autenticación.'
          )
        }
        if (!authData.user?.id) throw new Error('No se pudo crear el usuario de autenticación.')
        return authData.user.id
      },
      borrar: async (authId: string) => {
        const { error } = await supabaseAdmin.auth.admin.deleteUser(authId)
        if (error) throw new Error(error.message)
      }
    }
  }

  await crearEntidad(
    supabase,
    { idEntidad: entidadOperadora.id, rol: entidadOperadora.rol },
    datos,
    password,
    puerta,
    {
      ubicacion_maps: payload.ubicacion_maps ?? null,
      aplica_redondeo_costo: payload.aplica_redondeo_costo ?? true
    }
  )

  revalidatePath('/dashboard/distribuidores')
  return { success: true }
}

export async function updateEntidadAction(id: string, formData: UpdateEntidadInput) {
  const entidadId = id?.trim()
  if (!entidadId || !UUID_REGEX.test(entidadId)) throw new Error('Entidad inválida.')

  const nombre = formData.nombre?.trim()
  const zona = formData.zona?.trim()
  const telefonoRaw = typeof formData.telefono === 'string' ? formData.telefono.trim() : ''
  const telefono = telefonoRaw.length > 0 ? telefonoRaw : null
  const ubicacionRaw = typeof formData.ubicacion_maps === 'string' ? formData.ubicacion_maps.trim() : ''
  const ubicacion_maps = ubicacionRaw.length > 0 ? ubicacionRaw : null

  if (!nombre) throw new Error('Nombre inválido.')
  if (!zona) throw new Error('Zona inválida.')

  const supabase = await getServerSupabaseClient()
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) throw new Error('Sesión no válida. Inicia sesión nuevamente.')

  const { data: entidadOperadora, error: entidadError } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (entidadError || !entidadOperadora) throw new Error('No se pudo validar tu identidad operativa.')
  if (entidadOperadora.rol !== 'ADMIN') throw new Error('No autorizado para editar entidades.')

  const { data: entidadObjetivo, error: entidadObjetivoError } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('id', entidadId)
    .single()

  if (entidadObjetivoError || !entidadObjetivo) throw new Error('Entidad objetivo no encontrada.')
  if (entidadObjetivo.rol === 'ADMIN') throw new Error('No se permite editar el nodo ADMIN desde este flujo.')

  const rawComisionBase = entidadObjetivo.rol === 'DST' ? formData.comision_base : 0
  const rawComisionBaseLocal = entidadObjetivo.rol === 'LOC' ? formData.comision_base_local : 0
  const rawComisionHijoLocal = entidadObjetivo.rol === 'DST' ? formData.comision_hijo_local : 0

  const { error: updateError } = await supabase
    .from('entidades')
    .update({
      nombre,
      telefono,
      ubicacion_maps,
      zona,
      // El mismo criterio que el alta y que el chat. Editar una comision tenia
      // EXACTAMENTE las mismas tres trampas que crearla -- un 12.5% editado
      // desde la pantalla se guardaba 0.13 sin decirlo -- y arreglar solo el
      // alta habria dejado la deuda de las dos verdades a medio cerrar.
      comision_base: comisionValidada(rawComisionBase, 'Comision base'),
      comision_base_local: comisionValidada(rawComisionBaseLocal, 'Comision base local'),
      comision_hijo_local: comisionValidada(rawComisionHijoLocal, 'Comision hijo local'),
      aplica_redondeo_costo: formData.aplica_redondeo_costo ?? true
    })
    .eq('id', entidadId)

  if (updateError) throw new Error(updateError.message)

  revalidatePath('/dashboard/distribuidores')
  return { success: true }
}

export async function annularTicketHistorialDistribuidorAction(ticketId: string, perfilEntidadId: string) {
  const tid = ticketId?.trim()
  const perfil = perfilEntidadId?.trim()
  if (!tid || !UUID_REGEX.test(tid)) throw new Error('Ticket inválido.')
  if (!perfil || !UUID_REGEX.test(perfil)) throw new Error('Perfil inválido.')

  const supabase = await getServerSupabaseClient()
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) throw new Error('Sesión no válida. Inicia sesión nuevamente.')

  const { data: operadora, error: opErr } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (opErr || !operadora) throw new Error('No se pudo validar tu identidad operativa.')

  await assertPermiteAnularTicketEnPerfil(supabase, tid, perfil, {
    id: operadora.id,
    email: user.email,
    rol: String(operadora.rol)
  })

  await annulComercialCascadePorTicketId(supabase, tid)

  revalidatePath(`/dashboard/distribuidores/${perfil}`)
  revalidatePath('/dashboard/distribuidores')
  revalidatePath('/dashboard/inventario')
}

export async function eliminarEntidadAction(entidadId: string) {
  const id = entidadId?.trim()
  if (!id || !UUID_REGEX.test(id)) throw new Error('Entidad inválida.')

  const supabase = await getServerSupabaseClient()
  const {
    data: { user },
    error: authError
  } = await supabase.auth.getUser()

  if (authError || !user?.email) throw new Error('Sesión no válida. Inicia sesión nuevamente.')

  const { data: operadora, error: opErr } = await supabase
    .from('entidades')
    .select('id, rol')
    .eq('email', user.email)
    .single()

  if (opErr || !operadora) throw new Error('No se pudo validar tu identidad operativa.')
  if (operadora.rol !== 'ADMIN') throw new Error('Solo administradores pueden eliminar entidades.')

  const { data: objetivo, error: objErr } = await supabase.from('entidades').select('id, rol').eq('id', id).single()

  if (objErr || !objetivo) throw new Error('Entidad no encontrada.')
  if (objetivo.rol === 'ADMIN') throw new Error('No se puede eliminar la entidad ADMIN.')

  const { error: deleteError } = await supabase.from('entidades').delete().eq('id', id)

  if (deleteError) throw new Error(deleteError.message)

  revalidatePath('/dashboard/distribuidores')
}

