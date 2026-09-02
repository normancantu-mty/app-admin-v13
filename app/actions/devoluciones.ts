'use server'

/**
 * Logistica inversa: el distribuidor devuelve mercancia, el producto vuelve al
 * almacen y su deuda baja por el mismo importe.
 *
 * Sustituye a los DOS INSERT sueltos que `distribuidores/[id]/devolucion`
 * lanzaba desde el navegador. Ahi, si el segundo fallaba, el stock ya habia
 * regresado, la deuda NO bajaba, y el `alert()` decia igual
 * "Stock restaurado y deuda cancelada". Esa fila fantasma no la veia nadie.
 *
 * COMO SE COMPENSA (no hay transacciones en este repo, ver CLAUDE.md):
 * son dos tablas distintas, asi que no cabe un INSERT multi-fila. Se escribe
 * primero el inventario; si el movimiento financiero falla, la fila de
 * inventario se **anula** (`status = 'ANULADO'`), nunca se borra - regla 6.
 *
 * DE DONDE SALE EL DINERO: el monto lo calcula ESTE archivo, no el navegador.
 * Antes el formulario mandaba el `subtotal` que el mismo habia calculado, asi
 * que el importe de la deuda cancelada era un dato del cliente.
 */

import { revalidatePath } from 'next/cache'
import type { TablesInsert } from '@/types/database'
import {
  getServerSupabaseClient,
  resolverSesionOperador,
  type ClienteServidor
} from '@/lib/server-session'

type InventarioInsert = TablesInsert<'inventario_ledger'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>

/**
 * Zona de precio cuando la entidad no tiene una. Misma regla que el POS
 * (`app/pos/page.tsx`: `entidades.find(...)?.zona || 'Zacatecas'`) y misma zona
 * de referencia que `auditoria.ts` y el tablero de inventario.
 *
 * CAMBIO DE COMPORTAMIENTO DELIBERADO. El formulario viejo valuaba con
 * `listas_precios[0]`: la primera fila que devolviera Postgres, de cualquier
 * zona y sin orden garantizado. Eso no es una formula, es un volado - y ademas
 * hacia imposible que el servidor reprodujera lo que el usuario vio en pantalla.
 * Se adopta la unica regla que ya existia en el repo: **el precio de la zona de
 * la entidad que devuelve**. Para toda entidad de Zacatecas el numero es el
 * mismo de antes.
 */
const ZONA_PRECIO_POR_DEFECTO = 'Zacatecas'

export interface ProductoDevolucion {
  id: string
  sku: string
  nombre: string
  precio_final: number
}

export interface ProductosDevolucionResult {
  success: boolean
  data?: { productos: ProductoDevolucion[]; zona: string }
  error?: string
}

export interface RegistrarDevolucionPayload {
  idEntidad: string
  idProducto: string
  cantidad: number
}

export interface RegistrarDevolucionResult {
  success: boolean
  error?: string
  /** El importe que realmente se escribio, calculado en el servidor. */
  monto?: number
}

/** La zona de la entidad que devuelve; de ella sale el precio de lista. */
async function resolverZonaEntidad(
  supabase: ClienteServidor,
  idEntidad: string
): Promise<{ ok: true; zona: string } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('entidades')
    .select('id, zona')
    .eq('id', idEntidad)
    .maybeSingle()

  if (error) {
    return { ok: false, error: `No se pudo leer la entidad: ${error.message}` }
  }
  if (!data) {
    return { ok: false, error: 'La entidad de la devolucion no existe.' }
  }

  return { ok: true, zona: String(data.zona || '').trim() || ZONA_PRECIO_POR_DEFECTO }
}

/** Precio de lista por producto en una zona. Se queda con el mas alto si hay varios. */
async function cargarPreciosZona(
  supabase: ClienteServidor,
  idsProducto: string[],
  zona: string
): Promise<{ ok: true; porProducto: Map<string, number> } | { ok: false; error: string }> {
  const porProducto = new Map<string, number>()
  if (!idsProducto.length) return { ok: true, porProducto }

  const { data, error } = await supabase
    .from('listas_precios')
    .select('id_producto, precio_final, zona')
    .eq('zona', zona)
    .in('id_producto', idsProducto)

  if (error) {
    return { ok: false, error: `No se pudieron leer los precios (${zona}): ${error.message}` }
  }

  for (const fila of data ?? []) {
    if (!fila.id_producto) continue
    const precio = Number(fila.precio_final)
    if (!Number.isFinite(precio) || precio <= 0) continue
    if (precio > (porProducto.get(fila.id_producto) ?? 0)) {
      porProducto.set(fila.id_producto, precio)
    }
  }

  return { ok: true, porProducto }
}

/**
 * Catalogo de terminados con el precio de la zona ya resuelto. El formulario
 * pinta la vista previa con estos numeros, que son EXACTAMENTE los que se
 * escribiran: preview y ledger no pueden discrepar porque salen del mismo sitio.
 */
export async function getProductosDevolucionAction(
  idEntidad: string
): Promise<ProductosDevolucionResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesion = await resolverSesionOperador(supabase)
    if (!sesion.ok) return { success: false, error: sesion.error }

    const entidadId = String(idEntidad || '').trim()
    if (!entidadId) return { success: false, error: 'Falta la entidad.' }

    const zonaResult = await resolverZonaEntidad(supabase, entidadId)
    if (!zonaResult.ok) return { success: false, error: zonaResult.error }
    const { zona } = zonaResult

    const { data: productos, error: productosError } = await supabase
      .from('catalogo_productos')
      .select('id, sku, nombre')
      .eq('tipo', 'TERMINADO')
      .order('nombre', { ascending: true })

    if (productosError) {
      return { success: false, error: `No se pudo leer el catalogo: ${productosError.message}` }
    }

    const ids = (productos ?? []).map((producto) => producto.id)
    const precios = await cargarPreciosZona(supabase, ids, zona)
    if (!precios.ok) return { success: false, error: precios.error }

    return {
      success: true,
      data: {
        zona,
        productos: (productos ?? []).map((producto) => ({
          id: producto.id,
          sku: producto.sku,
          nombre: producto.nombre,
          precio_final: precios.porProducto.get(producto.id) ?? 0
        }))
      }
    }
  } catch (error) {
    console.error('Error cargando productos para devolucion:', error)
    return { success: false, error: 'No se pudo cargar el catalogo de devoluciones.' }
  }
}

export async function registrarDevolucionAction(
  payload: RegistrarDevolucionPayload
): Promise<RegistrarDevolucionResult> {
  try {
    const supabase = await getServerSupabaseClient()

    const sesionResult = await resolverSesionOperador(supabase)
    if (!sesionResult.ok) return { success: false, error: sesionResult.error }
    const sesion = sesionResult.sesion

    const idEntidad = String(payload?.idEntidad || '').trim()
    const idProducto = String(payload?.idProducto || '').trim()
    if (!idEntidad || !idProducto) {
      return { success: false, error: 'Falta la entidad o el producto.' }
    }

    const cantidad = Number(payload?.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { success: false, error: 'La cantidad debe ser mayor a cero.' }
    }

    const zonaResult = await resolverZonaEntidad(supabase, idEntidad)
    if (!zonaResult.ok) return { success: false, error: zonaResult.error }

    // El producto tiene que existir y ser TERMINADO: era lo unico que
    // garantizaba el <select> del navegador.
    const { data: producto, error: productoError } = await supabase
      .from('catalogo_productos')
      .select('id, nombre, tipo')
      .eq('id', idProducto)
      .eq('tipo', 'TERMINADO')
      .maybeSingle()

    if (productoError) {
      return { success: false, error: `No se pudo leer el producto: ${productoError.message}` }
    }
    if (!producto) {
      return { success: false, error: 'El producto no existe o no es un producto terminado.' }
    }

    const precios = await cargarPreciosZona(supabase, [idProducto], zonaResult.zona)
    if (!precios.ok) return { success: false, error: precios.error }

    const precioFinal = precios.porProducto.get(idProducto) ?? 0
    if (precioFinal <= 0) {
      return {
        success: false,
        error: `${producto.nombre} no tiene precio de lista en la zona ${zonaResult.zona}. No se registro nada.`
      }
    }

    const monto = precioFinal * cantidad

    // --- PASO A: el producto vuelve al almacen.
    const inventarioPayload: InventarioInsert = {
      id_producto: idProducto,
      tipo_movimiento: 'ENTRADA_COMPRA',
      cantidad,
      notas: 'Devolución de Distribuidor',
      usuario_creador: sesion.email, // de la sesion, NUNCA del cliente
      status: 'ACTIVO'
    }

    const { data: filaInventario, error: errorInventario } = await supabase
      .from('inventario_ledger')
      .insert(inventarioPayload)
      .select('id')
      .single()

    if (errorInventario || !filaInventario) {
      return {
        success: false,
        error: `Error al registrar la entrada de inventario: ${errorInventario?.message ?? 'sin detalle'}`
      }
    }

    // --- PASO B: baja la deuda. Si falla, el PASO A se anula.
    const finanzasPayload: FinanzaInsert = {
      id_entidad_relacionada: idEntidad,
      tipo_movimiento: 'ABONO_DEUDA',
      monto,
      categoria_gasto: 'Devolucion de Mercancia',
      usuario_creador: sesion.email, // antes esta fila se escribia SIN autor
      status: 'ACTIVO'
    }

    const { error: errorFinanzas } = await supabase
      .from('finanzas_ledger')
      .insert(finanzasPayload)

    if (errorFinanzas) {
      const { error: errorCompensacion } = await supabase
        .from('inventario_ledger')
        .update({
          status: 'ANULADO',
          notas: 'Devolución de Distribuidor | ANULADO: falló el abono de la deuda'
        })
        .eq('id', filaInventario.id)

      if (errorCompensacion) {
        // Lo unico peor que un fallo es un fallo que nadie puede rastrear.
        console.error(
          'Compensacion fallida en devolucion. Fila de inventario huerfana:',
          filaInventario.id,
          errorCompensacion.message
        )
        return {
          success: false,
          error:
            `No se pudo cancelar la deuda (${errorFinanzas.message}) Y TAMPOCO revertir la ` +
            `entrada de inventario. Avisa a administración: movimiento ${filaInventario.id}.`
        }
      }

      return {
        success: false,
        error: `No se pudo cancelar la deuda: ${errorFinanzas.message}. La entrada de inventario se revirtió; no quedó nada a medias.`
      }
    }

    revalidatePath(`/dashboard/distribuidores/${idEntidad}`)
    revalidatePath('/dashboard/distribuidores')
    revalidatePath('/dashboard/inventario')

    return { success: true, monto }
  } catch (error) {
    console.error('Error registrando devolucion:', error)
    return { success: false, error: 'No se pudo procesar la devolucion.' }
  }
}
