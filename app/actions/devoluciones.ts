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
import { exigirEntidadDelMovimiento } from '@/lib/inventario-invariante'
import { deudaPorEntrega } from '@/lib/reglas-comerciales'
import { fetchTodasLasFilas } from '@/lib/paginacion'
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
 * v2 (2026-10-29, Socio ejecutor, T5): el precio UNITARIO que se le abona al nodo por
 * cada pieza devuelta. Antes era el precio de LISTA de su zona ($599 la 750), pero la
 * deuda de una consignacion nace con la comision ya descontada (REGLAS_COMERCIALES.md,
 * "la deuda nace con la comision del distribuidor ya descontada del precio";
 * `deudaPorEntrega`, lib/reglas-comerciales.ts). Medido en la base local: DST con 20%,
 * consignacion 3 x $480 = $1,440; la devolucion de 1 abonaba $599 y le borraba $119
 * de deuda legitima por pieza.
 *
 * Regla: se abona el precio con que NACIO la deuda, incluida la del arranque.
 *  1. Lo mas reciente entre:
 *     a. el `precio_unitario` de la consignacion ACTIVA (ticket) de ESE producto a ESA
 *        entidad (asi sale bien tambien si se consigno con Cuenta Fresnillo), y
 *     b. el `costo_unitario_movimiento` de su ENTRADA_CONCESION de arranque: la carga
 *        conciliada escribe ahi el `precio_neto` de la conciliacion (precio al que se
 *        valuo su deuda de arranque).
 *  2. Si no hay ninguno: la regla en efectivo, `ceil(PP x (1 - comision propia))`:
 *     `comision_base` si es DST, `comision_base_local` si es LOC. **Sin** la comision de
 *     red del padre: la deuda de un LOC es con su acreedor directo (el DST o la matriz)
 *     y nace al precio que ese acreedor le cobra (el POS cobra 153 = ceil(180 x 0.85) a
 *     un local de David). Ronda 2 (auditoria 2026-10-29): con la red restada, Al son
 *     abonaba 420 por una 750 cuya deuda nacio a 510.
 *  3. Si la entidad no es DST ni LOC: el precio de lista, como antes.
 */
async function preciosDeAbono(
  supabase: ClienteServidor,
  idEntidad: string,
  preciosLista: Map<string, number>
): Promise<{ ok: true; porProducto: Map<string, number> } | { ok: false; error: string }> {
  const porProducto = new Map<string, number>()

  const { data: ent, error: errEnt } = await supabase
    .from('entidades')
    .select('rol, comision_base, comision_base_local, aplica_redondeo_costo')
    .eq('id', idEntidad)
    .maybeSingle()
  if (errEnt || !ent) return { ok: false, error: `No se pudo leer la entidad: ${errEnt?.message ?? 'no existe'}` }

  const rol = String(ent.rol || '')
  if (rol !== 'DST' && rol !== 'LOC') {
    for (const [id, pp] of preciosLista) porProducto.set(id, pp)
    return { ok: true, porProducto }
  }

  // ERP-25: ledger paginado (`tests/paginacion-ledger.spec.ts`). Un ledger truncado
  // no da error: daria el precio de una consignacion vieja.
  let tickets: { id: string; fecha_transaccion: string | null }[]
  try {
    tickets = await fetchTodasLasFilas(
      () =>
        supabase
          .from('transacciones_tickets')
          .select('id, fecha_transaccion')
          .eq('id_comprador', idEntidad)
          .eq('condicion_pago', 'CONCESION')
          .eq('status', 'ACTIVO')
          .order('id'),
      'preciosDeAbono tickets'
    )
  } catch (e) {
    return { ok: false, error: `No se pudieron leer sus consignaciones: ${e instanceof Error ? e.message : String(e)}` }
  }

  const ms = (f: string | null | undefined) => {
    const n = Date.parse(String(f ?? ''))
    return Number.isFinite(n) ? n : 0
  }
  const fechaDe = new Map(tickets.map((t) => [t.id, ms(t.fecha_transaccion)]))
  // producto -> el precio de origen mas reciente (ticket o arranque)
  const delTicket = new Map<string, { fecha: number; precio: number }>()
  if (fechaDe.size > 0) {
    let detalles: { id_ticket: string | null; id_producto: string | null; precio_unitario: number | null }[]
    try {
      detalles = await fetchTodasLasFilas(
        () =>
          supabase
            .from('ticket_detalles')
            .select('id_ticket, id_producto, precio_unitario')
            .in('id_ticket', [...fechaDe.keys()])
            .order('id'),
        'preciosDeAbono detalles'
      )
    } catch (e) {
      return { ok: false, error: `No se pudo leer el detalle de sus consignaciones: ${e instanceof Error ? e.message : String(e)}` }
    }
    for (const d of detalles) {
      if (!d.id_producto || !d.id_ticket) continue
      const fecha = fechaDe.get(d.id_ticket) ?? 0
      const previo = delTicket.get(d.id_producto)
      if (!previo || fecha > previo.fecha) {
        delTicket.set(d.id_producto, { fecha, precio: Number(d.precio_unitario) })
      }
    }
  }

  // 1b. La consignacion de arranque (sin ticket): su precio de origen lo dejo la carga.
  let deArranque: { id_producto: string; costo_unitario_movimiento: number | null; fecha_movimiento: string | null }[]
  try {
    deArranque = await fetchTodasLasFilas(
      () =>
        supabase
          .from('inventario_ledger')
          .select('id_producto, costo_unitario_movimiento, fecha_movimiento')
          .eq('id_entidad_destino', idEntidad)
          .eq('tipo_movimiento', 'ENTRADA_CONCESION')
          .eq('status', 'ACTIVO')
          .gt('costo_unitario_movimiento', 0)
          .order('id'),
      'preciosDeAbono arranque'
    )
  } catch (e) {
    return { ok: false, error: `No se pudo leer su consignacion de arranque: ${e instanceof Error ? e.message : String(e)}` }
  }
  for (const r of deArranque) {
    const fecha = ms(r.fecha_movimiento)
    const previo = delTicket.get(r.id_producto)
    if (!previo || fecha > previo.fecha) {
      delTicket.set(r.id_producto, { fecha, precio: Number(r.costo_unitario_movimiento) })
    }
  }

  for (const [id, pp] of preciosLista) {
    const deTicket = delTicket.get(id)
    if (deTicket && Number.isFinite(deTicket.precio) && deTicket.precio > 0) {
      porProducto.set(id, deTicket.precio)
      continue
    }
    porProducto.set(
      id,
      deudaPorEntrega({
        pp,
        cantidad: 1,
        rolComprador: rol,
        porcentajes: {
          base: Number(ent.comision_base ?? 0),
          local: Number(ent.comision_base_local ?? 0),
          red: 0
        },
        esCuentaFiscal: false,
        aplicaRedondeo: ent.aplica_redondeo_costo ?? true
      }).precioUnitario
    )
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
    // v2 (T5): la vista previa usa el MISMO precio de abono que se escribe.
    const abono = await preciosDeAbono(supabase, entidadId, precios.porProducto)
    if (!abono.ok) return { success: false, error: abono.error }

    return {
      success: true,
      data: {
        zona,
        productos: (productos ?? []).map((producto) => ({
          id: producto.id,
          sku: producto.sku,
          nombre: producto.nombre,
          precio_final: abono.porProducto.get(producto.id) ?? 0
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

    const precioLista = precios.porProducto.get(idProducto) ?? 0
    if (precioLista <= 0) {
      return {
        success: false,
        error: `${producto.nombre} no tiene precio de lista en la zona ${zonaResult.zona}. No se registro nada.`
      }
    }

    // v2 (T5): se abona lo que se cobro al consignar, no el precio de lista.
    const abono = await preciosDeAbono(supabase, idEntidad, new Map([[idProducto, precioLista]]))
    if (!abono.ok) return { success: false, error: abono.error }
    const precioFinal = abono.porProducto.get(idProducto) ?? precioLista
    const monto = Math.round(precioFinal * cantidad * 100) / 100

    // --- PASO A: el producto vuelve al almacen.
    //
    // ERP-16 · `id_entidad_destino`. ESTE ARCHIVO NO ESTABA EN EL TICKET, y
    // tiene exactamente el mismo defecto que `compras.ts`: escribia una
    // `ENTRADA_COMPRA` sin destino Y sin origen. "Vuelve al almacen" no decia
    // a cual. Es el destino el que lo dice, y es el de la sesion: quien captura
    // la devolucion es quien recibe la mercancia.
    //
    // ERP-15 · CERRADO el 2026-09-17. Antes esto escribia `ENTRADA_COMPRA` con
    // solo destino: la mercancia entraba al almacen y NUNCA salia del libro del
    // distribuidor, asi que el producto existia en los dos lados a la vez.
    //
    // Ahora es `DEVOLUCION_FISICA` con LAS DOS entidades en la MISMA fila:
    // sale de `idEntidad` -el distribuidor que devuelve- y llega a
    // `sesion.entidadId` -quien recibe-. Una fila, no dos: dos se pueden
    // escribir a medias y eso es lo que ERP-11 existe para arreglar.
    //
    // No reclasifica nada: se midio antes de aplicar la migracion y habia 0
    // filas de devolucion en las 488 del ledger. Este flujo nunca se uso.
    //
    // Quien lo sostiene si alguien lo vuelve a cambiar: el CHECK
    // `inventario_ledger_entidad_obligatoria` (migracion `20260918014009`)
    // rechaza la fila si falta cualquiera de las dos entidades, y
    // `exigirEntidadDelMovimiento` de aqui abajo lo detiene antes, con una
    // frase que se entiende.
    const inventarioPayload: InventarioInsert = {
      id_producto: idProducto,
      tipo_movimiento: 'DEVOLUCION_FISICA',
      cantidad,
      id_entidad_origen: idEntidad,
      id_entidad_destino: sesion.entidadId,
      // v2 (T5): lo que se abona a la deuda sale de su cubeta CONSIGNADO. Sin esto la
      // fila caia en PAGADO (el default): al nodo le quedaba -1 en PAGADO (la vista lo
      // esconde, HAVING > 0) y su CONSIGNADO no bajaba. Del lado de la matriz la vista
      // lo cuenta en PAGADO (migracion 20261029120100).
      cubeta: 'CONSIGNADO',
      notas: 'Devolución de Distribuidor',
      usuario_creador: sesion.email, // de la sesion, NUNCA del cliente
      status: 'ACTIVO'
    }

    exigirEntidadDelMovimiento(inventarioPayload, 'devoluciones.registrarDevolucionAction')

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
