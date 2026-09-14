'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { Database, TablesInsert } from '@/types/database'
import { resolverCompradorDeVenta } from '@/lib/avisos'
import { registrarAviso } from '@/lib/avisos-server'
import { notasConIdTicket } from '@/lib/ticket-annul-cascade'
import { calcularDeduccionCascada } from '@/lib/inventario-auditoria'
import { type Cubeta } from '@/lib/inventario-types'
import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'
import { validarCompradorContraCuentaFiscal } from '@/lib/venta-cuenta-fiscal'
import { comisionBaseLocalDecimal } from '@/lib/comision-base-local'

interface POSItemPayload {
  id_producto: string
  cantidad: number
  precio_unitario: number
  subtotal_linea: number
}

export interface ProcesarVentaPOSPayload {
  idVendedor: string
  vendedor_id?: string
  idComprador: string | null
  origenInventarioId?: string | null
  idCuentaDestino: string | null
  condicion_pago: 'CONTADO' | 'CONCESION'
  subtotalCatalogo: number
  totalCobradoReal: number
  montoBaseIngreso: number
  impuestoIvaCalculado: number
  impuestoIepsCalculado: number
  items: POSItemPayload[]
}

interface ProcesarVentaPOSResult {
  ok: boolean
  ticketId?: string
  error?: string
}

interface CompradorEntidad {
  id: string
  rol: string
  id_padre: string | null
  id_nodo_padre: string | null
  comision_base_local: number | null
  nombre?: string | null
}

type TicketInsert = TablesInsert<'transacciones_tickets'>
type TicketDetalleInsert = TablesInsert<'ticket_detalles'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>
type InventarioInsert = TablesInsert<'inventario_ledger'>

function roundTo2(value: number): number {
  return Number(value.toFixed(2))
}

// ─── Commission Engine (Lean Global-Percentage + Cost-Rounding Model) ────────
//
// TWO commission paths exist depending on who receives the commission:
//
// ① calcularComisionConRedondeo — active inventory provider (Block 2 / DST direct)
//   precio_base_calculo = cuentaEsDeAdmin ? (precioVenta / 1.7748) : precioVenta
//   costo_crudo  = precio_base_calculo × (1 − comision_base)
//   costo_final  = aplica_redondeo ? Math.ceil(costo_crudo) : costo_crudo
//   comision_unitaria = max(0, precio_base_calculo − costo_final)
//   → Math.ceil raises the cost floor, protecting the Admin's margin.
//
// ② calcularComisionPasiva — passive network fee (Block 1 / parent DST of buying LOC)
//   precio_base_calculo = cuentaEsDeAdmin ? (precioVenta / 1.7748) : precioVenta
//   comision_cruda = precio_base_calculo × comision_hijo_local
//   comision_final = aplica_redondeo ? Math.floor(comision_cruda) : comision_cruda
//   → Math.floor caps the passive payout, also protecting the Admin's margin.
//
// AUDIT NOTE (id_entidad_relacionada):
//   Block 1 → LOC's id_nodo_padre (parent DST of the buying LOC) — uses path ②.
//   Block 2 → origenInventarioId (DST whose inventory was triangulated) — uses path ①.
function calcularComisionConRedondeo(
  items: Array<{ precio_unitario: number; cantidad: number }>,
  comisionBase: number,
  aplicaRedondeo: boolean,
  cuentaEsDeAdmin: boolean
): number {
  let total = 0
  for (const item of items) {
    const precioBaseCalculo = cuentaEsDeAdmin
      ? item.precio_unitario / 1.7748
      : item.precio_unitario
    const costoCrudo = precioBaseCalculo * (1 - comisionBase)
    const costoFinal = aplicaRedondeo ? Math.ceil(costoCrudo) : costoCrudo
    const comisionUnitaria = Math.max(0, precioBaseCalculo - costoFinal)
    total += comisionUnitaria * item.cantidad
  }
  return roundTo2(total)
}

function calcularComisionPasiva(
  items: Array<{ precio_unitario: number; cantidad: number }>,
  comisionHijoLocal: number,
  aplicaRedondeo: boolean,
  cuentaEsDeAdmin: boolean
): number {
  let total = 0
  for (const item of items) {
    const precioBaseCalculo = cuentaEsDeAdmin
      ? item.precio_unitario / 1.7748
      : item.precio_unitario
    const comisionCruda = precioBaseCalculo * comisionHijoLocal
    const comisionFinal = aplicaRedondeo ? Math.floor(comisionCruda) : comisionCruda
    total += comisionFinal * item.cantidad
  }
  return roundTo2(total)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function toTipoFiscalidad(value: string): TipoFiscalidad {
  if (value === 'FULL_TAX' || value === 'IVA_ONLY' || value === 'LIBRE') {
    return value
  }
  return 'FULL_TAX'
}

function resolveTipoFiscalidadCuenta(cuentaNombre: string, tipoFiscalidadRaw: string): TipoFiscalidad {
  const cuentaNormalizada = normalizeText(cuentaNombre)
  const esCuentaFresnillo = cuentaNormalizada.includes('fresnillo')

  if (!esCuentaFresnillo) {
    return 'LIBRE'
  }

  return toTipoFiscalidad(tipoFiscalidadRaw)
}

export async function procesarVentaPOS(payload: ProcesarVentaPOSPayload): Promise<ProcesarVentaPOSResult> {
  try {
    const timestampTransaccion = new Date().toISOString()
    const cookieStore = await cookies()
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value },
          set() {},
          remove() {}
        }
      }
    )

    const { data: { user }, error: userError } = await supabase.auth.getUser()

    if (userError || !user?.email) {
      return { ok: false, error: 'Sesión inválida. Inicia sesión nuevamente.' }
    }

    const vendedorId = payload.vendedor_id ?? payload.idVendedor

    if (!vendedorId || payload.items.length === 0) {
      return { ok: false, error: 'Payload POS inválido.' }
    }
    // ── W4 · ERP-59 ─────────────────────────────────────────────────────────
    // Hasta el 2026-09-05 esta linea decia:
    //
    //     if (payload.condicion_pago === 'CONCESION' && !payload.idComprador) {
    //       throw new Error('La venta en concesión requiere un Comprador identificado...')
    //     }
    //
    // Ese rechazo es la razon por la que hay 72 botellas facturadas fuera del
    // ERP. La botella SALIO DEL ALMACEN: ese es el hecho, y es fisico. Quien la
    // debe es el campo que falta, y para eso existe la cola.
    //
    // La venta entra a nombre de la entidad centinela "PENDIENTE DE ASIGNAR",
    // **jamas con `id_comprador = NULL`** (decision del prompt 18-bis §1). Con
    // entidad real el par de inventario se escribe COMPLETO — salida del
    // vendedor y entrada al comprador — en vez de quedar cojo, y el aviso se
    // cuelga de un ticket que existe.
    //
    // La concesion no escribe NINGUNA fila de finanzas (mas abajo: el bloque
    // financiero entero esta dentro de `if (condicion_pago === 'CONTADO')`), asi
    // que esto no parte ningun asiento en dos: respeta la frontera del §3.
    //
    // El aviso W4 NO SE PUEDE CERRAR mientras el ticket siga apuntando al
    // centinela. Lo impone el trigger `tg_avisos_vigilar_cierre` en Postgres, no
    // esta funcion: con un token valido, PostgREST atiende un `curl`.
    // ERP-80 · LA PREGUNTA CORRECTA NO ES SI VINO VACIO.
    // La primera version de esto decia:
    //
    //     const concesionSinComprador =
    //       payload.condicion_pago === 'CONCESION' && !payload.idComprador
    //
    // y tenia un hueco silencioso: el centinela nace con rol LOC, y el
    // desplegable del POS le ofrece a un ADMIN *todos* los DST y LOC. Elegirlo
    // a mano dejaba `payload.idComprador` lleno, la bandera en `false`, y el
    // ticket apuntando al centinela **sin aviso W4**. La consignacion sin dueno
    // entraba igual, pero ya sin nada que la delatara -- justo lo contrario de
    // lo que la cola viene a hacer.
    //
    // Lo que decide es el ESTADO EN QUE VA A QUEDAR LA FILA, no como llego.
    // La regla vive en `resolverCompradorDeVenta` (pura, probada) y la usan las
    // dos mitades: la pantalla para no ofrecerlo, y esto para no creerle a la
    // pantalla -- `procesarVentaPOS` se puede llamar sin pasar por ella.
    const comprador = resolverCompradorDeVenta(payload.condicion_pago, payload.idComprador)
    if (!comprador.ok) {
      return { ok: false, error: comprador.error }
    }
    const concesionSinComprador = comprador.avisoW4
    const idCompradorResuelto = comprador.idComprador

    const { data: currentUser, error: currentUserError } = await supabase
      .from('entidades')
      .select('id, rol')
      .eq('email', user.email)
      .single()

    if (currentUserError || !currentUser) {
      return { ok: false, error: 'No se pudo validar la sesión operativa actual.' }
    }

    const { data: vendedor, error: vendedorError } = await supabase
      .from('entidades')
      .select('id, rol, id_padre, nombre, comision_base, comision_base_local, comision_hijo_local, aplica_redondeo_costo')
      .eq('id', vendedorId)
      .single()

    if (vendedorError || !vendedor) {
      return { ok: false, error: 'No se pudo validar el vendedor seleccionado.' }
    }

    if (currentUser.rol !== 'ADMIN' && currentUser.id !== vendedor.id) {
      return { ok: false, error: 'No autorizado para operar ventas con otro vendedor.' }
    }

    const origenInventarioId = (payload.origenInventarioId || vendedorId).trim()
    if (!origenInventarioId) {
      return { ok: false, error: 'Origen de inventario inválido.' }
    }
    if (currentUser.rol !== 'ADMIN' && origenInventarioId !== vendedorId) {
      return { ok: false, error: 'No autorizado para usar inventario de otra entidad.' }
    }

    const { data: entidadOrigenInventario, error: origenInventarioError } = await supabase
      .from('entidades')
      .select('id, rol, nombre, comision_base, comision_hijo_local, aplica_redondeo_costo')
      .eq('id', origenInventarioId)
      .single()

    if (origenInventarioError || !entidadOrigenInventario) {
      return { ok: false, error: 'No se pudo validar el origen de inventario seleccionado.' }
    }

    let cuentaData: { id: string; nombre: string; tipo_fiscalidad: string } | null = null

    if (payload.idCuentaDestino) {
      const { data: cuentaSeleccionada, error: cuentaSeleccionadaError } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, tipo_fiscalidad, id_entidad')
        .eq('id', payload.idCuentaDestino)
        .single()

      if (cuentaSeleccionadaError || !cuentaSeleccionada) {
        return { ok: false, error: 'La cuenta destino seleccionada no existe o no es válida.' }
      }

      const esCuentaFresnillo = normalizeText(cuentaSeleccionada.nombre).includes('fresnillo')
      if (cuentaSeleccionada.id_entidad !== vendedorId && !esCuentaFresnillo) {
        return { ok: false, error: 'La cuenta destino no pertenece al vendedor seleccionado.' }
      }

      cuentaData = {
        id: cuentaSeleccionada.id,
        nombre: cuentaSeleccionada.nombre,
        tipo_fiscalidad: cuentaSeleccionada.tipo_fiscalidad
      }
    } else {
      const { data: cuentasEntidad, error: cuentaError } = await supabase
        .from('cuentas_financieras')
        .select('id, nombre, tipo_fiscalidad')
        .eq('id_entidad', vendedorId)
        .order('nombre', { ascending: true })

      if (cuentaError || !cuentasEntidad || cuentasEntidad.length === 0) {
        throw new Error('Bóveda financiera no encontrada para esta entidad.')
      }

      let cuentaFallback = cuentasEntidad.find((cuenta) => normalizeText(cuenta.nombre).startsWith('cta-'))

      if (vendedor.rol === 'ADMIN') {
        const cuentaFresnillo = cuentasEntidad.find((cuenta) => normalizeText(cuenta.nombre).includes('fresnillo'))
        cuentaFallback = cuentaFresnillo ?? cuentaFallback ?? cuentasEntidad[0]
      } else {
        cuentaFallback = cuentaFallback ?? cuentasEntidad[0]
      }

      cuentaData = cuentaFallback
    }

    const tipoFiscalidadCuenta = resolveTipoFiscalidadCuenta(cuentaData.nombre, cuentaData.tipo_fiscalidad)
    // True when the cash destination is the Admin's own account (e.g. "Cuenta Fresnillo").
    // In this scenario the DST never holds physical cash, so no ABONO_DEUDA should be
    // generated for them — only their commission leg is valid.
    const cuentaEsDeAdmin = normalizeText(cuentaData.nombre).includes('fresnillo')
    const desgloseFiscal = calculateReverseTaxes(payload.totalCobradoReal, tipoFiscalidadCuenta)
    const montoBaseIngreso = roundTo2(desgloseFiscal.montoBase)
    const impuestoIepsCalculado = roundTo2(desgloseFiscal.ieps)
    const impuestoIvaCalculado = roundTo2(desgloseFiscal.iva)

    const referenciasProducto = Array.from(new Set(payload.items.map((item) => item.id_producto)))
    const [productosPorIdResult, productosPorSkuResult] = await Promise.all([
      supabase.from('catalogo_productos').select('id, sku').in('id', referenciasProducto),
      supabase.from('catalogo_productos').select('id, sku').in('sku', referenciasProducto)
    ])

    const productoCanonicoPorReferencia = new Map<string, string>()
    for (const producto of productosPorIdResult.data || []) {
      productoCanonicoPorReferencia.set(producto.id, producto.id)
      if (producto.sku) productoCanonicoPorReferencia.set(producto.sku, producto.id)
    }
    for (const producto of productosPorSkuResult.data || []) {
      productoCanonicoPorReferencia.set(producto.id, producto.id)
      if (producto.sku) productoCanonicoPorReferencia.set(producto.sku, producto.id)
    }

    const itemsNormalizados = payload.items.map((item) => ({
      ...item,
      id_producto: productoCanonicoPorReferencia.get(item.id_producto) ?? item.id_producto
    }))

    let compradorInventarioValido: string | null = null
    let compradorEntidad: CompradorEntidad | null = null
    if (idCompradorResuelto) {
      const { data: compradorInventario, error: compradorInventarioError } = await supabase
        .from('entidades')
        .select('id, rol, id_padre, id_nodo_padre, comision_base_local')
        .eq('id', idCompradorResuelto)
        .single()

      if (compradorInventarioError || !compradorInventario) {
        return { ok: false, error: 'No se pudo validar el comprador para movimiento de inventario.' }
      }

      compradorInventarioValido = compradorInventario.id
      compradorEntidad = compradorInventario

      // La cuenta fiscal factura al LOCAL, no al distribuidor: cuando el local paga, se le paga
      // al DST por su servicio. Un ticket contra la cuenta fiscal con un DST de comprador es
      // error de captura, y el motor de impuesto inverso le separa IVA/IEPS que no existen.
      // TODO ERP-21: detectar la cuenta fiscal por `tipo_fiscalidad`, no por el nombre.
      const errorCuentaFiscal = validarCompradorContraCuentaFiscal(
        cuentaData.nombre,
        compradorInventario.rol
      )
      if (errorCuentaFiscal) {
        return { ok: false, error: errorCuentaFiscal }
      }
    }

    const usaTriangulacionInventario = origenInventarioId !== vendedorId && entidadOrigenInventario.rol === 'DST'
    if (usaTriangulacionInventario) {
      if (currentUser.rol !== 'ADMIN') return { ok: false, error: 'Solo ADMIN puede triangular origen de inventario.' }
      if (!compradorEntidad || compradorEntidad.rol !== 'LOC') return { ok: false, error: 'La triangulación solo aplica cuando el comprador es un LOC.' }
      const parentComprador = compradorEntidad.id_padre ?? compradorEntidad.id_nodo_padre
      if (parentComprador !== origenInventarioId) return { ok: false, error: 'El origen de inventario debe corresponder al distribuidor padre del LOC.' }
    }

    const esConcesion = payload.condicion_pago === 'CONCESION'
    const tipoSalidaInventario = esConcesion ? 'SALIDA_CONCESION' : 'SALIDA_VENTA'
    const tipoEntradaInventario = esConcesion ? 'ENTRADA_CONCESION' : 'ENTRADA_COMPRA'
    const cubetaMovimiento: Cubeta = esConcesion ? 'CONSIGNADO' : 'PAGADO'

    const cantidadPorProducto = new Map<string, number>()
    for (const item of itemsNormalizados) {
      const cantidadActual = cantidadPorProducto.get(item.id_producto) || 0
      cantidadPorProducto.set(item.id_producto, cantidadActual + item.cantidad)
    }

    const inventarioMovimientos: InventarioInsert[] = []
    for (const [idProducto, cantidadVendida] of cantidadPorProducto.entries()) {
      const { data: sellerMovs } = await supabase
        .from('inventario_ledger')
        .select('id_entidad_destino, id_entidad_origen, cantidad, cubeta, status')
        .eq('id_producto', idProducto)
        .eq('status', 'ACTIVO')
        .or(`id_entidad_destino.eq.${origenInventarioId},id_entidad_origen.eq.${origenInventarioId}`)

      let stockPagadoActual = 0
      let stockConsignadoActual = 0
      let stockNeto = 0
      ;(sellerMovs || []).forEach(m => {
        const cubetaAsignada = (m.cubeta || 'PAGADO') as Cubeta
        const isReceiver = m.id_entidad_destino === origenInventarioId
        const isSender = m.id_entidad_origen === origenInventarioId
        const cantidad = Number(m.cantidad) || 0
        const signedCantidad = isReceiver ? cantidad : isSender ? -cantidad : 0
        stockNeto += signedCantidad

        if (cubetaAsignada === 'PAGADO') {
          if (isReceiver) stockPagadoActual += cantidad
          if (isSender) stockPagadoActual -= cantidad
        } else if (cubetaAsignada === 'CONSIGNADO') {
          if (isReceiver) stockConsignadoActual += cantidad
          if (isSender) stockConsignadoActual -= cantidad
        }
      })

      stockPagadoActual = Math.max(0, stockPagadoActual)
      stockConsignadoActual = Math.max(0, stockConsignadoActual)
      const stockTotal = Math.max(0, stockNeto)

      if (stockTotal < cantidadVendida) {
        throw new Error(`Stock insuficiente para producto ${idProducto}. Disponible: ${stockTotal}, requerido: ${cantidadVendida}.`)
      }

      let deduccionPagado = 0
      let deduccionConsignado = 0
      if (usaTriangulacionInventario) {
        if (stockConsignadoActual < cantidadVendida) return { ok: false, error: `Stock consignado insuficiente.` }
        deduccionConsignado = cantidadVendida
      } else {
        const deduccion = calcularDeduccionCascada({ cantidadDeducir: cantidadVendida, stockPagadoActual, stockConsignadoActual })
        deduccionPagado = deduccion.deduccionPagado
        deduccionConsignado = deduccion.deduccionConsignado
      }

      if (deduccionPagado > 0) {
        inventarioMovimientos.push({
          id_producto: idProducto,
          tipo_movimiento: tipoSalidaInventario,
          cantidad: deduccionPagado,
          cubeta: 'PAGADO',
          id_entidad_origen: origenInventarioId,
          status: 'ACTIVO',
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
      }

      if (deduccionConsignado > 0) {
        inventarioMovimientos.push({
          id_producto: idProducto,
          tipo_movimiento: tipoSalidaInventario,
          cantidad: deduccionConsignado,
          cubeta: 'CONSIGNADO',
          id_entidad_origen: origenInventarioId,
          status: 'ACTIVO',
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
      }

      if (compradorInventarioValido) {
        inventarioMovimientos.push({
          id_producto: idProducto,
          tipo_movimiento: tipoEntradaInventario,
          cantidad: cantidadVendida,
          cubeta: cubetaMovimiento,
          id_entidad_destino: compradorInventarioValido,
          status: 'ACTIVO',
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
      }
    }

    const ticketInsert: TicketInsert = {
      id_vendedor: vendedorId,
      id_comprador: idCompradorResuelto,
      condicion_pago: payload.condicion_pago,
      subtotal_catalogo: payload.subtotalCatalogo,
      total_cobrado_real: payload.totalCobradoReal,
      monto_base_ingreso: montoBaseIngreso,
      impuesto_iva_calculado: impuestoIvaCalculado,
      impuesto_ieps_calculado: impuestoIepsCalculado,
      id_cuenta_destino: cuentaData.id,
      fecha_transaccion: timestampTransaccion,
      usuario_creador: user.email
    }

    const { data: ticketData, error: ticketError } = await supabase.from('transacciones_tickets').insert(ticketInsert).select('id').single()
    if (ticketError || !ticketData) return { ok: false, error: `Error al generar ticket: ${ticketError?.message}` }

    const rollbackTicket = async (ticketId: string) => {
      await supabase.from('finanzas_ledger').delete().eq('id_ticket', ticketId)
      await supabase.from('ticket_detalles').delete().eq('id_ticket', ticketId)
      await supabase.from('transacciones_tickets').delete().eq('id', ticketId)
    }

    const detalles: TicketDetalleInsert[] = itemsNormalizados.map((item) => {
      const precioUnitarioFinal = roundTo2(item.precio_unitario)
      return {
      id_ticket: ticketData.id,
      id_producto: item.id_producto,
      cantidad: item.cantidad,
      precio_unitario: precioUnitarioFinal,
      subtotal_linea: roundTo2(precioUnitarioFinal * item.cantidad)
    }
    })

    const { error: detallesError } = await supabase.from('ticket_detalles').insert(detalles)
    if (detallesError) {
      await rollbackTicket(ticketData.id)
      return { ok: false, error: `Error al guardar detalles: ${detallesError.message}` }
    }

    const movimientosComisionTriangulacionYAdmin: FinanzaInsert[] = []

    // ── Block 1: Admin sells directly from own inventory → LOC ──────────────
    // Passive commission recipient = LOC's parent DST (id_nodo_padre).
    // Uses comision_hijo_local (the DST's network fee rate) + Math.floor to
    // protect the Admin's margin while paying the DST their passive cut.
    // Block 2 owns the active commission leg when triangulation is active; this
    // guard prevents both blocks firing and producing a duplicate INGRESO_COMISION.
    if (vendedor.rol === 'ADMIN' && compradorEntidad?.rol === 'LOC' && !usaTriangulacionInventario) {
      const idPadreLocal = compradorEntidad.id_nodo_padre || compradorEntidad.id_padre
      if (idPadreLocal) {
        const { data: dstPadre } = await supabase
          .from('entidades')
          .select('comision_hijo_local, aplica_redondeo_costo')
          .eq('id', idPadreLocal)
          .single()

        const comisionHijoLocalPadre = Number(dstPadre?.comision_hijo_local ?? 0)
        const aplicaRedondePadre     = dstPadre?.aplica_redondeo_costo ?? true

        const montoComision = calcularComisionPasiva(
          itemsNormalizados,
          comisionHijoLocalPadre,
          aplicaRedondePadre,
          cuentaEsDeAdmin
        )

        if (montoComision > 0) {
          movimientosComisionTriangulacionYAdmin.push({
            id_entidad_relacionada: idPadreLocal,
            id_cuenta_destino: null,
            id_ticket: ticketData.id,
            tipo_movimiento: 'COMISION_PASIVA',
            monto: montoComision,
            categoria_gasto: `Comisión ganada - Ticket #${ticketData.id.slice(0, 8).toUpperCase()}`,
            status: 'ACTIVO',
            fecha_movimiento: timestampTransaccion,
            usuario_creador: user.email
          })
        }
      }
    }

    // ── Block 2: Admin uses DST's inventory → LOC (triangulation) ────────────
    // Commission recipient = the DST whose inventory was used (origenInventarioId).
    if (
      usaTriangulacionInventario &&
      entidadOrigenInventario.rol === 'DST' &&
      compradorEntidad?.rol === 'LOC'
    ) {
      const comisionBaseOrigen  = Number(entidadOrigenInventario.comision_base ?? 0)
      const aplicaRedondeoOrigen = entidadOrigenInventario.aplica_redondeo_costo ?? true

      const montoComisionTriangulada = calcularComisionConRedondeo(
        itemsNormalizados,
        comisionBaseOrigen,
        aplicaRedondeoOrigen,
        cuentaEsDeAdmin
      )

      if (montoComisionTriangulada > 0) {
        movimientosComisionTriangulacionYAdmin.push({
          id_entidad_relacionada: origenInventarioId,
          id_cuenta_destino: null,
          id_ticket: ticketData.id,
          tipo_movimiento: 'INGRESO_COMISION',
          monto: montoComisionTriangulada,
          categoria_gasto: `Comisión ganada - Ticket #${ticketData.id.slice(0, 8).toUpperCase()}`,
          status: 'ACTIVO',
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
      }
    }

    if (payload.condicion_pago === 'CONTADO') {
      const movimientosFinancieros: FinanzaInsert[] = []
      const totalLiquidezEsperado = roundTo2(payload.totalCobradoReal)
      if (!Number.isFinite(totalLiquidezEsperado) || totalLiquidezEsperado <= 0) {
        await rollbackTicket(ticketData.id)
        return { ok: false, error: 'Monto de cobro inválido.' }
      }

      if (vendedor.rol === 'DST' || vendedor.rol === 'LOC') {
        // ── Node Contado Split ───────────────────────────────────────────────
        // Cash collected by the node is split into two ledger legs:
        //   INGRESO_COMISION → node's earned margin (kept by node)
        //   DEUDA_A_MATRIZ   → admin's share (node holds cash, must remit later)
        // Rounding: Math.floor for node's share, exact complement for admin's share.
        const comisionDecimal = vendedor.rol === 'DST'
          ? Number(vendedor.comision_base ?? 0)
          : comisionBaseLocalDecimal(vendedor.comision_base_local)
        const aplicaRedondeo = vendedor.aplica_redondeo_costo ?? true
        const ticketRef = `Ticket #${ticketData.id.slice(0, 8).toUpperCase()}`

        let montoComision: number
        let montoDeuda: number
        if (aplicaRedondeo) {
          montoComision = Math.floor(totalLiquidezEsperado * comisionDecimal)
          montoDeuda = totalLiquidezEsperado - montoComision
        } else {
          montoComision = roundTo2(totalLiquidezEsperado * comisionDecimal)
          montoDeuda = roundTo2(totalLiquidezEsperado - montoComision)
        }

        if (montoComision > 0) {
          movimientosFinancieros.push({
            id_entidad_relacionada: vendedorId,
            id_cuenta_destino: cuentaData.id,
            id_ticket: ticketData.id,
            tipo_movimiento: 'INGRESO_COMISION',
            monto: montoComision,
            categoria_gasto: `Comisión ganada - ${ticketRef}`,
            status: 'ACTIVO',
            fecha_movimiento: timestampTransaccion,
            usuario_creador: user.email
          })
        }
        if (montoDeuda > 0) {
          movimientosFinancieros.push({
            id_entidad_relacionada: vendedorId,
            id_cuenta_destino: cuentaData.id,
            id_ticket: ticketData.id,
            tipo_movimiento: 'DEUDA_A_MATRIZ',
            monto: montoDeuda,
            categoria_gasto: `Caja por entregar a Matriz - ${ticketRef}`,
            status: 'ACTIVO',
            fecha_movimiento: timestampTransaccion,
            usuario_creador: user.email
          })
        }
      } else {
        // ── Admin Contado: monolithic INGRESO_VENTA ──────────────────────────
        movimientosFinancieros.push({
          id_entidad_relacionada: vendedorId,
          id_cuenta_destino: cuentaData.id,
          id_ticket: ticketData.id,
          tipo_movimiento: 'INGRESO_VENTA',
          monto: totalLiquidezEsperado,
          categoria_gasto: 'Venta de mercancia',
          status: 'ACTIVO',
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })

        if (impuestoIvaCalculado > 0) movimientosFinancieros.push({ id_cuenta_destino: cuentaData.id, id_ticket: ticketData.id, tipo_movimiento: 'PASIVO_IVA', monto: impuestoIvaCalculado, categoria_gasto: 'Pasivo fiscal IVA', status: 'ACTIVO', fecha_movimiento: timestampTransaccion, usuario_creador: user.email })
        if (impuestoIepsCalculado > 0) movimientosFinancieros.push({ id_cuenta_destino: cuentaData.id, id_ticket: ticketData.id, tipo_movimiento: 'PASIVO_IEPS', monto: impuestoIepsCalculado, categoria_gasto: 'Pasivo fiscal IEPS', status: 'ACTIVO', fecha_movimiento: timestampTransaccion, usuario_creador: user.email })

        // Only credit the DST with an ABONO_DEUDA when they physically hold the cash
        // (i.e. the destination account belongs to the DST, not to Admin). When the
        // Admin collects cash into their own account (cuentaEsDeAdmin), the DST
        // receives only their INGRESO_COMISION from Block 2 — never a debt reduction.
        if (usaTriangulacionInventario && !cuentaEsDeAdmin) {
          movimientosFinancieros.push({
            id_entidad_relacionada: origenInventarioId,
            id_ticket: ticketData.id,
            tipo_movimiento: 'ABONO_DEUDA',
            monto: montoBaseIngreso,
            categoria_gasto: 'Abono por triangulación de inventario',
            status: 'ACTIVO',
            fecha_movimiento: timestampTransaccion,
            usuario_creador: user.email
          })
        }
      }

      if (movimientosFinancieros.length > 0) {
        const { error: finanzasError } = await supabase.from('finanzas_ledger').insert(movimientosFinancieros)
        if (finanzasError) {
          await rollbackTicket(ticketData.id)
          return { ok: false, error: `Error financiero: ${finanzasError.message}` }
        }
      }
    }

    if (movimientosComisionTriangulacionYAdmin.length > 0) {
      const { error: comisionError } = await supabase.from('finanzas_ledger').insert(movimientosComisionTriangulacionYAdmin)
      if (comisionError) {
        await rollbackTicket(ticketData.id)
        return { ok: false, error: `Error comision: ${comisionError.message}` }
      }
    }

    if (inventarioMovimientos.length > 0) {
      const inventarioConTicket = inventarioMovimientos.map((row) => ({
        ...row,
        notas: notasConIdTicket(ticketData.id, row.notas)
      }))
      const { error: inventarioError } = await supabase.from('inventario_ledger').insert(inventarioConTicket)
      if (inventarioError) {
        await rollbackTicket(ticketData.id)
        return { ok: false, error: `Error inventario: ${inventarioError.message}` }
      }
    }

    revalidatePath('/dashboard/finanzas')
    revalidatePath('/dashboard/inventario')
    revalidatePath('/dashboard/distribuidores')
    if (idCompradorResuelto) {
      revalidatePath(`/dashboard/distribuidores/${idCompradorResuelto}`)
    }
    if (origenInventarioId && origenInventarioId !== vendedorId) {
      revalidatePath(`/dashboard/distribuidores/${origenInventarioId}`)
    }
    revalidatePath(`/dashboard/distribuidores/${vendedorId}`)

    // El aviso se escribe AL FINAL, cuando ya no queda nada que pueda disparar
    // `rollbackTicket`. Registrarlo antes dejaria un aviso apuntando a un ticket
    // borrado el dia que un insert posterior falle.
    if (concesionSinComprador) {
      await registrarAviso(supabase, {
        tipo: 'W4',
        idEntidad: vendedorId,
        mensaje:
          `Venta en concesion por $${Number(payload.totalCobradoReal).toFixed(2)} sin ` +
          'comprador identificado. La mercancia salio y quedo a nombre de ' +
          '"PENDIENTE DE ASIGNAR": nadie la debe todavia. Este aviso no se cierra ' +
          'sin asignar el comprador real.',
        tabla: 'transacciones_tickets',
        idRegistro: ticketData.id,
        datosCapturados: {
          vendedor: vendedor.nombre,
          total_cobrado_real: payload.totalCobradoReal,
          origen_inventario: origenInventarioId,
          piezas: itemsNormalizados.reduce((suma, item) => suma + Number(item.cantidad || 0), 0)
        }
      })
      revalidatePath('/dashboard/avisos')
    }

    return { ok: true, ticketId: ticketData.id }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Error interno POS.'
    return { ok: false, error: message }
  }
}