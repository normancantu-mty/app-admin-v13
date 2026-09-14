'use server'

/**
 * Compra de insumos: el insumo entra al almacen y el dinero sale de una cuenta.
 *
 * Sustituye a los DOS INSERT sueltos que `inventario/compra` lanzaba desde el
 * navegador. Ahi, si el segundo fallaba, el insumo entraba al inventario **sin
 * que el gasto quedara registrado**: material gratis en los libros.
 *
 * COMO SE COMPENSA (no hay transacciones en este repo, ver CLAUDE.md):
 * son dos tablas distintas, asi que no cabe un INSERT multi-fila. Se escribe
 * primero el inventario; si el gasto falla, la fila de inventario se **anula**
 * (`status = 'ANULADO'`), nunca se borra - regla 6.
 *
 * QUE SE VALIDA AHORA Y ANTES NO: que el producto exista y sea `INSUMO`, y que
 * la cuenta de origen sea de la entidad de la sesion. Antes lo unico que lo
 * garantizaba era como se habia llenado el `<select>` en el navegador.
 */

import { revalidatePath } from 'next/cache'
import type { TablesInsert } from '@/types/database'
import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'
import {
  getServerSupabaseClient,
  resolverSesionOperador
} from '@/lib/server-session'
import { registrarAviso } from '@/lib/avisos-server'
import { resolverCuentaOrigenPorDefecto, type CuentaCandidata } from '@/lib/avisos'

type InventarioInsert = TablesInsert<'inventario_ledger'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

export interface InsumoCompra {
  id: string
  nombre: string
  sku: string
  unidad_medida: string | null
}

export interface CuentaCompra {
  id: string
  nombre: string
}

export interface DatosCompraResult {
  success: boolean
  data?: { insumos: InsumoCompra[]; cuentas: CuentaCompra[] }
  error?: string
}

export interface RegistrarCompraPayload {
  idInsumo: string
  cantidad: number
  costoTotal: number
  idCuentaOrigen: string
}

export interface RegistrarCompraResult {
  success: boolean
  error?: string
}

/**
 * Insumos del catalogo y cuentas de la entidad de la SESION. La lista de
 * cuentas se acota en el servidor con la misma entidad que despues valida el
 * registro, para que el formulario no pueda ofrecer una cuenta ajena.
 */
export async function getDatosCompraAction(): Promise<DatosCompraResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesionResult = await resolverSesionOperador(supabase)
    if (!sesionResult.ok) return { success: false, error: sesionResult.error }
    const sesion = sesionResult.sesion

    const [insumosRes, cuentasRes] = await Promise.all([
      supabase
        .from('catalogo_productos')
        .select('id, nombre, sku, unidad_medida')
        .eq('tipo', 'INSUMO')
        .order('nombre', { ascending: true }),
      supabase
        .from('cuentas_financieras')
        .select('id, nombre')
        .eq('id_entidad', sesion.entidadId)
        .order('nombre', { ascending: true })
    ])

    if (insumosRes.error) {
      return { success: false, error: `No se pudieron leer los insumos: ${insumosRes.error.message}` }
    }
    if (cuentasRes.error) {
      return { success: false, error: `No se pudieron leer las cuentas: ${cuentasRes.error.message}` }
    }

    return {
      success: true,
      data: {
        insumos: insumosRes.data ?? [],
        cuentas: cuentasRes.data ?? []
      }
    }
  } catch (error) {
    console.error('Error cargando datos de compra:', error)
    return { success: false, error: 'No se pudieron cargar los datos de la compra.' }
  }
}

export async function registrarCompraInsumosAction(
  payload: RegistrarCompraPayload
): Promise<RegistrarCompraResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesionResult = await resolverSesionOperador(supabase)
    if (!sesionResult.ok) return { success: false, error: sesionResult.error }
    const sesion = sesionResult.sesion

    const idInsumo = String(payload?.idInsumo || '').trim()
    const idCuentaOrigen = String(payload?.idCuentaOrigen || '').trim()

    // -- W13 . ERP-59 ---------------------------------------------------------
    // Hasta el 2026-09-05 este `if` cubria los dos campos a la vez. Se parte
    // porque **solo el origen se ablanda**: sin insumo no se sabe QUE entro al
    // almacen y no hay nada que rescatar, pero la cuenta de la que salio el
    // dinero se puede deducir de la propia entidad.
    //
    // OJO CON LA FRONTERA (prompt 18-bis §3): esto NO deja entrar una compra a
    // medias. La compra sigue escribiendo SUS DOS LEDGERS -- entrada de insumo y
    // gasto -- y si falla el segundo, el primero se anula como siempre. Lo unico
    // que cambia es de que cuenta sale el dinero. Por eso `costoTotal <= 0` mas
    // abajo SIGUE BLOQUEANDO: sin monto no hay forma de escribir el lado
    // monetario, y media compra es un asiento falso, no una captura incompleta.
    if (!idInsumo) {
      return { success: false, error: 'Completa el insumo de la compra.' }
    }

    let idCuentaOrigenResuelta = idCuentaOrigen
    let avisoCuentaOrigen: { mensaje: string; capturado: Record<string, unknown> } | null = null

    if (!idCuentaOrigen) {
      const { data: propiasRaw, error: propiasError } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, id_entidad, tipo_fiscalidad, entidad:entidades!inner(rol)')
        .eq('id_entidad', sesion.entidadId)

      if (propiasError) {
        return { success: false, error: `No se pudieron leer las cuentas: ${propiasError.message}` }
      }

      const candidatas: CuentaCandidata[] = (propiasRaw ?? []).map((fila) => {
        const dueno = Array.isArray(fila.entidad) ? fila.entidad[0] : fila.entidad
        return {
          id: fila.id,
          nombre: String(fila.nombre ?? ''),
          id_entidad: fila.id_entidad,
          rol_entidad: dueno?.rol ? String(dueno.rol).toUpperCase() : null,
          tipo_fiscalidad: fila.tipo_fiscalidad ?? null
        }
      })

      const resolucion = resolverCuentaOrigenPorDefecto(sesion.entidadId, candidatas)
      if (!resolucion.ok) {
        return { success: false, error: `Falta la cuenta de origen. ${resolucion.motivo}` }
      }

      idCuentaOrigenResuelta = resolucion.idCuenta
      const elegida = candidatas.find((cuenta) => cuenta.id === resolucion.idCuenta)
      avisoCuentaOrigen = {
        mensaje:
          'Compra de insumos capturada sin cuenta de origen. El gasto entro contra ' +
          `la cuenta propia de la entidad ("${elegida?.nombre ?? resolucion.idCuenta}"), ` +
          'nunca contra una cuenta ADMIN ni contra la cuenta fiscal.',
        capturado: { cuenta_origen_capturada: null, cuenta_usada: resolucion.idCuenta }
      }
    }

    const cantidad = Number(payload?.cantidad)
    const costoTotal = Number(payload?.costoTotal)
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { success: false, error: 'La cantidad debe ser mayor a cero.' }
    }
    if (!Number.isFinite(costoTotal) || costoTotal <= 0) {
      return { success: false, error: 'El costo total debe ser mayor a cero.' }
    }

    const { data: insumo, error: insumoError } = await supabase
      .from('catalogo_productos')
      .select('id, nombre, tipo')
      .eq('id', idInsumo)
      .eq('tipo', 'INSUMO')
      .maybeSingle()

    if (insumoError) {
      return { success: false, error: `No se pudo leer el insumo: ${insumoError.message}` }
    }
    if (!insumo) {
      return { success: false, error: 'El producto no existe o no es un insumo.' }
    }

    // La cuenta de origen tiene que ser de la entidad de la sesion: es
    // exactamente lo que ofrecia el formulario, ahora verificado en servidor.
    const { data: cuenta, error: cuentaError } = await supabase
      .from('cuentas_financieras')
      .select('id, id_entidad')
      .eq('id', idCuentaOrigenResuelta)
      .maybeSingle()

    if (cuentaError) {
      return { success: false, error: `No se pudo leer la cuenta: ${cuentaError.message}` }
    }
    if (!cuenta || cuenta.id_entidad !== sesion.entidadId) {
      return { success: false, error: 'La cuenta de origen no pertenece a tu entidad.' }
    }

    // --- PASO A: entra el insumo.
    //
    // ERP-16 · `id_entidad_destino`. El insumo entra al almacen de la entidad
    // que lo compro, y esa entidad no es negociable: doce lineas arriba este
    // mismo archivo rechaza la captura si la cuenta de origen no le pertenece
    // (`cuenta.id_entidad !== sesion.entidadId`). El dinero ya salia de la
    // entidad de la sesion; la mercancia se quedaba sin dueno.
    //
    // Hasta hoy este campo iba nulo, y NO es que el tablero lo ignorara: lo lee
    // como si fuera la Matriz (`!destino || destino.rol === 'ADMIN'`, en
    // app/dashboard/inventario/page.tsx). Con una sola entidad ADMIN el default
    // acertaba por accidente. Con locales que compren lo suyo, la compra del
    // local engordaba el inventario de la Matriz sin error y sin aviso.
    const inventarioPayload: InventarioInsert = {
      id_producto: idInsumo,
      tipo_movimiento: 'ENTRADA_COMPRA',
      cantidad,
      id_entidad_destino: sesion.entidadId,
      usuario_creador: sesion.email, // de la sesion, NUNCA del cliente
      status: 'ACTIVO'
    }

    exigirEntidadDelMovimiento(inventarioPayload, 'compras.registrarCompraInsumoAction')

    const { data: filaInventario, error: inventarioError } = await supabase
      .from('inventario_ledger')
      .insert(inventarioPayload)
      .select('id')
      .single()

    if (inventarioError || !filaInventario) {
      return {
        success: false,
        error: `Error al registrar la entrada de inventario: ${inventarioError?.message ?? 'sin detalle'}`
      }
    }

    // --- PASO B: sale el dinero. Si falla, el PASO A se anula.
    const finanzasPayload: FinanzaInsert = {
      id_cuenta_origen: idCuentaOrigenResuelta,
      tipo_movimiento: 'COMPRA_INSUMOS',
      categoria: 'Insumos',
      monto: costoTotal,
      usuario_creador: sesion.email,
      status: 'ACTIVO'
    }

    const { data: filaFinanzas, error: finanzasError } = await supabase
      .from('finanzas_ledger')
      .insert(finanzasPayload)
      .select('id')
      .maybeSingle()

    if (finanzasError) {
      const { error: errorCompensacion } = await supabase
        .from('inventario_ledger')
        .update({
          status: 'ANULADO',
          notas: 'ANULADO: falló el registro del gasto de la compra'
        })
        .eq('id', filaInventario.id)

      if (errorCompensacion) {
        console.error(
          'Compensacion fallida en compra de insumos. Fila de inventario huerfana:',
          filaInventario.id,
          errorCompensacion.message
        )
        return {
          success: false,
          error:
            `No se pudo registrar el gasto (${finanzasError.message}) Y TAMPOCO revertir la ` +
            `entrada de inventario. Avisa a administración: movimiento ${filaInventario.id}.`
        }
      }

      return {
        success: false,
        error: `No se pudo registrar el gasto: ${finanzasError.message}. La entrada de inventario se revirtió; no quedó nada a medias.`
      }
    }

    if (avisoCuentaOrigen) {
      await registrarAviso(supabase, {
        tipo: 'W13',
        idEntidad: sesion.entidadId,
        mensaje: avisoCuentaOrigen.mensaje,
        tabla: 'finanzas_ledger',
        idRegistro: filaFinanzas?.id,
        datosCapturados: { ...avisoCuentaOrigen.capturado, insumo: insumo.nombre, costo_total: costoTotal }
      })
      revalidatePath('/dashboard/avisos')
    }

    revalidatePath('/dashboard/inventario')
    revalidatePath('/dashboard/finanzas')

    return { success: true }
  } catch (error) {
    console.error('Error registrando compra de insumos:', error)
    return { success: false, error: 'No se pudo registrar la compra.' }
  }
}
