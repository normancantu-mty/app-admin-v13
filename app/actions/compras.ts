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
import { escribirCompraInsumos } from '@/lib/compra-insumos'
import {
  getServerSupabaseClient,
  resolverSesionOperador
} from '@/lib/server-session'
import { registrarAviso } from '@/lib/avisos-server'
import { resolverCuentaOrigenPorDefecto, type CuentaCandidata } from '@/lib/avisos'

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

    // 2026-11-07: la validacion y las dos escrituras viven en
    // `lib/compra-insumos.ts`, que es lo MISMO que llama el bot de Telegram.
    // Aqui se queda lo que es de la web: la sesion, la cuenta por defecto (W13)
    // y el revalidate.
    const resultado = await escribirCompraInsumos(supabase, {
      idInsumo,
      cantidad: Number(payload?.cantidad),
      costoTotal: Number(payload?.costoTotal),
      idCuentaOrigen: idCuentaOrigenResuelta,
      idEntidad: sesion.entidadId,
      usuarioCreador: sesion.email // de la sesion, NUNCA del cliente
    })
    if (!resultado.ok) {
      return { success: false, error: resultado.error }
    }
    const filaFinanzas = { id: resultado.idFinanzas }
    const insumo = { nombre: resultado.insumo }
    const costoTotal = Number(payload?.costoTotal)

    if (avisoCuentaOrigen) {
      await registrarAviso(supabase, {
        tipo: 'W13',
        idEntidad: sesion.entidadId,
        mensaje: avisoCuentaOrigen.mensaje,
        tabla: 'finanzas_ledger',
        idRegistro: filaFinanzas.id ?? undefined,
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
