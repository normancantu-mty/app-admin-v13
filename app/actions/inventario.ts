'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { Database, TablesInsert } from '@/types/database'
import { registrarAviso } from '@/lib/avisos-server'
import { escribirSalidaCascada, type TipoSalidaCascada } from '@/lib/salida-cascada'

// La cascada (y su lectura paginada del ledger, ERP-25) vive en `lib/salida-cascada.ts`.

type TipoLogisticaInversa = 'MERMA' | 'DEVOLUCION_FISICA'
type InventarioInsert = TablesInsert<'inventario_ledger'>

import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'
import { leerAcceso } from '@/lib/auth-utils'
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

interface RegistrarSalidaCascadaInput {
  id_entidad: string
  id_producto: string
  cantidad_a_deducir: number
  tipo_movimiento: TipoSalidaCascada
}

interface RegistrarSalidaCascadaResult {
  success: boolean
  data?: InventarioInsert[]
  error?: string
}

export interface RegistrarLogisticaInversaState {
  success: boolean
  error?: string
}

export interface RegistrarProduccionPayload {
  idProductoTerminado: string
  cantidad: number
}

export interface RegistrarProduccionResult {
  success: boolean
  error?: string
}

/**
 * La entidad desde la que opera la sesion: `accesos` primero (por auth_id, como
 * `mi_entidad_id()`; asi entra EMPLEADO_ADMIN, que no tiene fila en
 * `entidades`), y si no, por correo como siempre. No se exporta: este archivo
 * es `'use server'`.
 */
async function entidadOperadoraDe(
  supabase: Awaited<ReturnType<typeof getServerSupabaseClient>>,
  user: { id: string; email?: string }
): Promise<{ data: { id: string; rol: string } | null; error: unknown }> {
  const acceso = await leerAcceso(supabase, user.id)
  if (acceso) return { data: { id: acceso.idEntidad, rol: acceso.rol }, error: null }
  return supabase.from('entidades').select('id, rol').eq('email', user.email ?? '').single()
}

async function getServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
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

export async function registrarProduccionAction(
  payload: RegistrarProduccionPayload
): Promise<RegistrarProduccionResult> {
  try {
    const supabase = await getServerSupabaseClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user?.email) {
      return { success: false, error: 'No se pudo validar tu sesión. Inicia sesión nuevamente.' }
    }

    const { data: entidadOperadora, error: entidadError } = await entidadOperadoraDe(supabase, user)

    if (entidadError || !entidadOperadora) {
      return { success: false, error: 'No se pudo validar la entidad operadora.' }
    }

    if (entidadOperadora.rol === 'SOCIO') {
      return { success: false, error: 'No autorizado para registrar producción.' }
    }

    const { data: adminEntity, error: adminError } = await supabase
      .from('entidades')
      .select('id, nombre')
      .eq('rol', 'ADMIN')
      .limit(1)
      .maybeSingle()

    if (adminError) {
      return { success: false, error: `No se pudo resolver la entidad ADMIN: ${adminError.message}` }
    }
    if (!adminEntity?.id) {
      return { success: false, error: 'No existe una entidad ADMIN para asignar propiedad de producción.' }
    }
    const adminId = adminEntity.id

    const productoTerminadoId = String(payload.idProductoTerminado || '').trim()
    const cantidadProduccion = Number(payload.cantidad)

    if (!productoTerminadoId) {
      return { success: false, error: 'Debes seleccionar un producto terminado.' }
    }

    if (!Number.isFinite(cantidadProduccion) || cantidadProduccion <= 0) {
      return { success: false, error: 'La cantidad de producción debe ser mayor a cero.' }
    }

    const { data: productoTerminado, error: productoError } = await supabase
      .from('catalogo_productos')
      .select('id, tipo')
      .eq('id', productoTerminadoId)
      .single()

    if (productoError || !productoTerminado) {
      return { success: false, error: 'El producto terminado seleccionado no existe.' }
    }

    if (productoTerminado.tipo !== 'TERMINADO') {
      return { success: false, error: 'Solo se puede producir sobre productos de tipo TERMINADO.' }
    }

    const { data: recetas, error: recetasError } = await supabase
      .from('recetas_produccion')
      .select('id_insumo, cantidad_requerida')
      .eq('id_producto_terminado', productoTerminadoId)

    if (recetasError) {
      return { success: false, error: recetasError.message }
    }

    // ── W3 y W9 · ERP-59 ───────────────────────────────────────────────────
    // Hasta el 2026-09-05 las dos condiciones tiraban la produccion entera:
    //
    //     if (!recetas || recetas.length === 0)  -> 'no tiene receta (BOM)'
    //     if (contieneInsumosInvalidos)          -> 'receta con insumos invalidos'
    //
    // Las botellas EXISTEN. Salieron de la linea, estan en el almacen, y en las
    // dos ramas el sistema decidia no enterarse. Ahora la produccion se
    // registra siempre y lo que no se pudo hacer sale como aviso.
    //
    // Esto NO cruza la frontera del prompt 18-bis §3: `PRODUCCION` no genera ni
    // una fila de finanzas — el par que queda cojo es inventario contra
    // inventario, no fisico contra monetario. La consecuencia esta dicha en el
    // aviso: **el inventario de insumo se lee mas alto de lo real** hasta que
    // alguien cargue la receta y descuente a mano.
    const usuarioCreador = user.email || entidadOperadora.id
    const lineasReceta = recetas ?? []

    const movimientoProduccion: InventarioInsert = {
      id_producto: productoTerminadoId,
      tipo_movimiento: 'PRODUCCION',
      cantidad: cantidadProduccion,
      id_entidad_destino: adminId,
      cubeta: 'PAGADO',
      status: 'ACTIVO',
      usuario_creador: usuarioCreador
    }

    const lineasBOM = lineasReceta.map((receta) => ({
      id_insumo: receta.id_insumo || '',
      cantidad: Number(receta.cantidad_requerida || 0) * cantidadProduccion
    }))

    const lineasValidas = lineasBOM.filter(
      (linea) => Boolean(linea.id_insumo) && Number.isFinite(linea.cantidad) && linea.cantidad > 0
    )
    const lineasInvalidas = lineasBOM.filter((linea) => !lineasValidas.includes(linea))

    const movimientosProduccion: InventarioInsert[] = [
      movimientoProduccion,
      ...lineasValidas.map((linea) => ({
        id_producto: linea.id_insumo,
        tipo_movimiento: 'TRASPASO',
        cantidad: linea.cantidad,
        id_entidad_origen: adminId,
        cubeta: 'PAGADO' as const,
        status: 'ACTIVO' as const,
        usuario_creador: usuarioCreador
      }))
    ]

    exigirEntidadDelMovimiento(movimientosProduccion, 'inventario.registrarProduccionAction')

    const { data: filasProduccion, error: insertError } = await supabase
      .from('inventario_ledger')
      .insert(movimientosProduccion)
      .select('id')

    if (insertError) {
      return { success: false, error: insertError.message }
    }

    const idFilaProduccion = filasProduccion?.[0]?.id

    if (lineasReceta.length === 0) {
      await registrarAviso(supabase, {
        tipo: 'W3',
        idEntidad: entidadOperadora.id,
        mensaje:
          `Se produjeron ${cantidadProduccion} unidad(es) sin receta (BOM) cargada. ` +
          'Ningun insumo se desconto: el inventario de insumo se lee mas alto de lo real.',
        tabla: 'inventario_ledger',
        idRegistro: idFilaProduccion,
        datosCapturados: { id_producto_terminado: productoTerminadoId, cantidad: cantidadProduccion }
      })
      revalidatePath('/dashboard/avisos')
    } else if (lineasInvalidas.length > 0) {
      await registrarAviso(supabase, {
        tipo: 'W9',
        idEntidad: entidadOperadora.id,
        mensaje:
          `Produccion registrada con ${lineasInvalidas.length} de ${lineasBOM.length} linea(s) ` +
          'de receta invalidas (sin insumo o con cantidad <= 0). Esas lineas NO se ' +
          'descontaron; las validas si.',
        tabla: 'inventario_ledger',
        idRegistro: idFilaProduccion,
        datosCapturados: {
          id_producto_terminado: productoTerminadoId,
          cantidad: cantidadProduccion,
          lineas_saltadas: lineasInvalidas
        }
      })
      revalidatePath('/dashboard/avisos')
    }

    revalidatePath('/dashboard/inventario')
    return { success: true }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error inesperado al registrar producción.'
    return { success: false, error: message }
  }
}

export async function registrarSalidaCascada(
  input: RegistrarSalidaCascadaInput
): Promise<RegistrarSalidaCascadaResult> {
  try {
    const supabase = await getServerSupabaseClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user?.email) {
      return { success: false, error: 'Sesión no válida. Inicia sesión nuevamente.' }
    }

    const { data: entidadOperadora, error: entidadError } = await entidadOperadoraDe(supabase, user)

    if (entidadError || !entidadOperadora) {
      return { success: false, error: 'No se pudo validar tu identidad operativa.' }
    }

    if (entidadOperadora.rol === 'SOCIO') {
      return { success: false, error: 'No autorizado para registrar salidas de inventario.' }
    }

    // El autor sale de la sesión, nunca de lo que mande el cliente.
    const usuarioCreador = user.email || entidadOperadora.id

    // 2026-11-07: la regla de la cascada vive en `lib/salida-cascada.ts`, la
    // MISMA que usa el bot para la merma. Aqui se queda lo que es de la web:
    // la sesion de arriba y el revalidate de abajo.
    // Campo por campo, los mismos que la web pasaba en bf7c361: sin `...input`,
    // un cliente no puede colar `notas` ni `devolverIds` (auditoria 2026-11-07).
    const resultado = await escribirSalidaCascada(supabase, {
      id_entidad: input.id_entidad,
      id_producto: input.id_producto,
      cantidad_a_deducir: input.cantidad_a_deducir,
      tipo_movimiento: input.tipo_movimiento,
      usuario_creador: usuarioCreador
    })
    if (!resultado.success) {
      return { success: false, error: resultado.error }
    }

    revalidatePath('/dashboard/inventario')
    return { success: true, data: resultado.data }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error inesperado al registrar salida en cascada.'
    return { success: false, error: message }
  }
}

export async function registrarLogisticaInversaAction(
  _prevState: RegistrarLogisticaInversaState,
  formData: FormData
): Promise<RegistrarLogisticaInversaState> {
  try {
    const supabase = await getServerSupabaseClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user?.email) {
      return { success: false, error: 'Sesión no válida. Inicia sesión nuevamente.' }
    }

    const { data: entidad, error: entidadError } = await entidadOperadoraDe(supabase, user)

    if (entidadError || !entidad) {
      return { success: false, error: 'No se pudo validar tu identidad operativa.' }
    }

    if (entidad.rol === 'SOCIO') {
      return { success: false, error: 'No autorizado para registrar logística inversa.' }
    }

    const productoId = String(formData.get('producto_id') || '').trim()
    const tipoMovimiento = String(formData.get('tipo_movimiento') || '').trim() as TipoLogisticaInversa
    const cantidadRaw = String(formData.get('cantidad') || '').trim()
    const distribuidorIdRaw = String(formData.get('distribuidor_id') || '').trim()
    const montoAbonoRaw = String(formData.get('monto_abono') || '').trim()

    const cantidad = Number(cantidadRaw)
    if (!productoId) {
      return { success: false, error: 'Selecciona un producto.' }
    }
    if (!['MERMA', 'DEVOLUCION_FISICA'].includes(tipoMovimiento)) {
      return { success: false, error: 'Tipo de movimiento inválido.' }
    }
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { success: false, error: 'La cantidad debe ser un número mayor a cero.' }
    }

    let distribuidorId: string | null = null
    let montoAbono: number | null = null

    if (tipoMovimiento === 'DEVOLUCION_FISICA') {
      if (!distribuidorIdRaw) {
        return { success: false, error: 'Selecciona un distribuidor para la devolución física.' }
      }

      const { data: distribuidor, error: distribuidorError } = await supabase
        .from('entidades')
        .select('id, rol')
        .eq('id', distribuidorIdRaw)
        .single()

      if (distribuidorError || !distribuidor || distribuidor.rol !== 'DST') {
        return { success: false, error: 'El distribuidor seleccionado no es válido.' }
      }

      const monto = Number(montoAbonoRaw)
      if (!Number.isFinite(monto) || monto < 0) {
        return { success: false, error: 'El monto de abono debe ser un número válido (>= 0).' }
      }
      distribuidorId = distribuidor.id
      montoAbono = monto
    }

    const usuarioCreador = user.email || entidad.id

    const inventarioPayload: InventarioInsert = {
      id_producto: productoId,
      tipo_movimiento: tipoMovimiento,
      cantidad,
      usuario_creador: usuarioCreador,
      id_entidad_origen: tipoMovimiento === 'DEVOLUCION_FISICA' ? distribuidorId : entidad.id,
      id_entidad_destino: tipoMovimiento === 'DEVOLUCION_FISICA' ? entidad.id : null
    }

    exigirEntidadDelMovimiento(inventarioPayload, 'inventario.registrarMovimientoConAbono')

    const { error: inventarioError } = await supabase
      .from('inventario_ledger')
      .insert(inventarioPayload)

    if (inventarioError) {
      return { success: false, error: inventarioError.message }
    }

    if (tipoMovimiento === 'DEVOLUCION_FISICA' && distribuidorId && montoAbono !== null) {
      const finanzaPayload: FinanzaInsert = {
        id_entidad_relacionada: distribuidorId,
        tipo_movimiento: 'ABONO_DEUDA',
        monto: montoAbono,
        categoria_gasto: 'Devolucion de Mercancia',
        status: 'ACTIVO',
        usuario_creador: usuarioCreador
      }

      const { error: finanzaError } = await supabase
        .from('finanzas_ledger')
        .insert(finanzaPayload)

      if (finanzaError) {
        return { success: false, error: finanzaError.message }
      }
    }

    revalidatePath('/dashboard/inventario')
    return { success: true }
  } catch (error: unknown) {
    console.error('🚨 [ERROR DE EJECUCIÓN CATCH]:', error)
    const message = error instanceof Error ? error.message : 'Error inesperado al registrar logística inversa.'
    return {
      success: false,
      error: message
    }
  }
}