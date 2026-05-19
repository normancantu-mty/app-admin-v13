'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { TablesInsert } from '@/types/database'
import { annulComercialCascadePorTicketId, assertPermiteAnularTicketEnPerfil } from '@/lib/ticket-annul-cascade'

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

/** Normalizes a commission value: accepts both percentage (20) and decimal (0.20). */
function normalizeCommission(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 0
  const v = value > 1 ? value / 100 : value
  return Math.max(0, Math.min(1, Math.round(v * 10000) / 10000))
}

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
  if (entidadOperadora.rol === 'SOCIO') throw new Error('No autorizado para crear miembros.')

  const parentNodeIdRaw = id_nodo_padre?.trim() || ''
  const isValidParentId = parentNodeIdRaw === '' || UUID_REGEX.test(parentNodeIdRaw)
  if (!isValidParentId) throw new Error('id_nodo_padre inválido.')
  if (entidadOperadora.rol === 'DST' && payload.rol === 'DST') throw new Error('Unauthorized')

  let parentNodeId: string | null = null
  if (payload.rol === 'LOC') {
    parentNodeId = entidadOperadora.rol === 'DST' ? entidadOperadora.id : (parentNodeIdRaw || null)
  }

  const rawComisionBase = payload.rol === 'DST' ? payload.comision_base : 0
  const rawComisionBaseLocal = payload.rol === 'LOC' ? payload.comision_base_local : 0
  const rawComisionHijoLocal = payload.rol === 'DST' ? payload.comision_hijo_local : 0

  const comisionBase = normalizeCommission(rawComisionBase)
  const comisionBaseLocal = normalizeCommission(rawComisionBaseLocal)
  const comisionHijoLocal = normalizeCommission(rawComisionHijoLocal)
  const comisionLogistica = normalizeCommission(payload.comision_logistica)

  const insertPayload: EntidadInsert = {
    nombre,
    email,
    auth_id: null,
    rol: payload.rol,
    zona: payload.zona,
    telefono: payload.telefono?.trim() || null,
    ubicacion_maps: payload.ubicacion_maps?.trim() || null,
    es_distribuidor: payload.rol === 'DST',
    id_nodo_padre: parentNodeId,
    id_padre: parentNodeId,
    comision_base: comisionBase,
    comision_base_local: comisionBaseLocal,
    comision_hijo_local: comisionHijoLocal,
    comision_logistica: comisionLogistica,
    aplica_redondeo_costo: payload.aplica_redondeo_costo ?? true
  }

  let authUserId: string | null = null
  let supabaseAdmin: ReturnType<typeof createClient> | null = null

  if (payload.rol === 'DST') {
    const supabaseAdminUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseAdminUrl || !serviceRoleKey) throw new Error('Configuración de Supabase Admin incompleta.')

    supabaseAdmin = createClient(supabaseAdminUrl, serviceRoleKey)
    const { data: authData, error: createAuthError } = await supabaseAdmin.auth.admin.createUser({
      email: email!,
      password: password!,
      email_confirm: true
    })

    if (createAuthError) {
      const msgLower = createAuthError.message?.toLowerCase() ?? ''
      const status = (createAuthError as { status?: number }).status
      const isEmailAlreadyRegistered =
        msgLower.includes('already been registered') ||
        msgLower.includes('already exists') ||
        status === 422 ||
        status === 409
      if (isEmailAlreadyRegistered) {
        throw new Error(
          'Este correo electrónico ya está registrado en el sistema de acceso. Por favor, utiliza un correo distinto o contacta a soporte para liberarlo.'
        )
      }
      throw new Error(createAuthError.message ? `Fallo al crear credenciales: ${createAuthError.message}` : 'No se pudo crear el usuario de autenticación.')
    }

    if (!authData.user?.id) throw new Error('No se pudo crear el usuario de autenticación.')
    authUserId = authData.user.id
    insertPayload.auth_id = authUserId
  }

  try {
    const { data: entidadCreada, error: insertError } = await supabase
      .from('entidades')
      .insert(insertPayload)
      .select('id')
      .single()

    if (insertError || !entidadCreada?.id) {
      throw new Error(insertError?.message || 'No se pudo crear la entidad.')
    }

    const cuentaPayloads: CuentaFinancieraInsert[] = [
      {
        id_entidad: entidadCreada.id,
        nombre: `Efectivo (${nombre})`,
        tipo_fiscalidad: 'LIBRE'
      }
    ]

    const { error: cuentaError } = await supabase.from('cuentas_financieras').insert(cuentaPayloads)

    if (cuentaError) {
      const { error: rollbackEntidadError } = await supabase.from('entidades').delete().eq('id', entidadCreada.id)
      if (rollbackEntidadError) {
        throw new Error(`Cuenta financiera no creada (${cuentaError.message}) y fallo rollback de entidad (${rollbackEntidadError.message}).`)
      }
      throw new Error(`No se pudo crear la cuenta financiera por defecto: ${cuentaError.message}`)
    }
  } catch (dbError) {
    if (supabaseAdmin && authUserId) {
      const { error: rollbackAuthError } = await supabaseAdmin.auth.admin.deleteUser(authUserId)
      if (rollbackAuthError) {
        throw new Error(`Fallo de persistencia en base de datos y rollback de auth fallido (${rollbackAuthError.message}).`)
      }
    }
    throw dbError
  }

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
      comision_base: normalizeCommission(rawComisionBase),
      comision_base_local: normalizeCommission(rawComisionBaseLocal),
      comision_hijo_local: normalizeCommission(rawComisionHijoLocal),
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

