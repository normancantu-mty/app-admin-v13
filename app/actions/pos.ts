'use server'

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import type { TablesInsert } from '@/types/database'
import { calcularDeduccionCascada } from '@/lib/inventario-auditoria'
import { type Cubeta } from '@/lib/inventario-types'
import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'

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

type TicketInsert = TablesInsert<'transacciones_tickets'>
type TicketDetalleInsert = TablesInsert<'ticket_detalles'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>
type InventarioInsert = TablesInsert<'inventario_ledger'>

function roundTo2(value: number): number {
  return Number(value.toFixed(2))
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
    const supabase = createServerClient(
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
    if (payload.condicion_pago === 'CONCESION' && !payload.idComprador) {
      throw new Error('La venta en concesión requiere un Comprador identificado (No puede ser Público en General).')
    }

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
      .select('id, rol, id_padre, nombre, comision_base, comision_base_local, comision_hijo_local')
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
      .select('id, rol, nombre, comision_base, comision_hijo_local')
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
    let compradorEntidad: any = null
    if (payload.idComprador) {
      const { data: compradorInventario, error: compradorInventarioError } = await supabase
        .from('entidades')
        .select('id, rol, id_padre, id_nodo_padre, comision_base_local')
        .eq('id', payload.idComprador)
        .single()

      if (compradorInventarioError || !compradorInventario) {
        return { ok: false, error: 'No se pudo validar el comprador para movimiento de inventario.' }
      }

      compradorInventarioValido = compradorInventario.id
      compradorEntidad = compradorInventario
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
      id_comprador: payload.idComprador,
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

    const detalles = itemsNormalizados.map((item) => ({
      id_ticket: ticketData.id,
      id_producto: item.id_producto,
      cantidad: item.cantidad,
      precio_unitario: item.precio_unitario,
      subtotal_linea: item.subtotal_linea
    }))

    const { error: detallesError } = await supabase.from('ticket_detalles').insert(detalles)
    if (detallesError) {
      await rollbackTicket(ticketData.id)
      return { ok: false, error: `Error al guardar detalles: ${detallesError.message}` }
    }

const movimientosComisionTriangulacionYAdmin: FinanzaInsert[] = []

    if (vendedor.rol === 'ADMIN' && compradorEntidad?.rol === 'LOC') {
      const idPadreLocal = compradorEntidad.id_nodo_padre || compradorEntidad.id_padre
      if (idPadreLocal) {
        const comisionBase = compradorEntidad.comision_base_local || 0
        const factorComision = comisionBase > 1 ? comisionBase / 100 : comisionBase
        // FIX MATEMÁTICO: Multiplicamos por la base sin impuestos
        const montoComision = roundTo2(montoBaseIngreso * factorComision)

        if (montoComision > 0) {
          movimientosComisionTriangulacionYAdmin.push({
            id_entidad_relacionada: idPadreLocal,
            id_ticket: ticketData.id,
            tipo_movimiento: 'INGRESO_COMISION',
            monto: montoComision,
            categoria_gasto: `Comisión Pasiva Matriz a Local`,
            status: 'APPROVED', // FIX DE VISIBILIDAD EN DASHBOARD
            fecha_movimiento: timestampTransaccion,
            usuario_creador: user.email
          })
        }
      }
    }

    if (
      usaTriangulacionInventario &&
      entidadOrigenInventario.rol === 'DST' &&
      compradorEntidad?.rol === 'LOC'
    ) {
      const comisionBaseDistribuidor = Number(entidadOrigenInventario.comision_base ?? 0)
      const comisionHijoLocalDistribuidor = Number(entidadOrigenInventario.comision_hijo_local ?? 0)
      const comisionBaseLocalComprador = Number(compradorEntidad.comision_base_local ?? 0)
      const porcentajeBono = (comisionHijoLocalDistribuidor + comisionBaseLocalComprador) - comisionBaseDistribuidor

      if (porcentajeBono > 0) {
        const montoComisionTriangulada = roundTo2(montoBaseIngreso * porcentajeBono)
        movimientosComisionTriangulacionYAdmin.push({
          id_entidad_relacionada: origenInventarioId,
          id_ticket: ticketData.id,
          tipo_movimiento: 'INGRESO_COMISION',
          monto: montoComisionTriangulada,
          categoria_gasto: `Comisión pasiva por triangulación hacia ${compradorEntidad.nombre || compradorEntidad.id}`,
          status: 'APPROVED', // FIX DE VISIBILIDAD EN DASHBOARD
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
      }
    }

    if (payload.condicion_pago === 'CONTADO') {
      const movimientosFinancieros: FinanzaInsert[] = []
      const montoIngresoNeto = montoBaseIngreso
      const totalLiquidezEsperado = roundTo2(payload.totalCobradoReal)
      const totalComponentes = roundTo2(montoIngresoNeto + impuestoIvaCalculado + impuestoIepsCalculado)

      if (Math.abs(totalComponentes - totalLiquidezEsperado) > 0.01) {
        await rollbackTicket(ticketData.id)
        return { ok: false, error: 'Descuadre contable detectado.' }
      }

      movimientosFinancieros.push({
        id_entidad_relacionada: vendedorId,
        id_cuenta_destino: cuentaData.id,
        id_ticket: ticketData.id,
        tipo_movimiento: 'INGRESO_VENTA',
        monto: montoIngresoNeto,
        categoria_gasto: 'Venta de mercancia',
        status: 'APPROVED', // FIX DE VISIBILIDAD
        fecha_movimiento: timestampTransaccion,
        usuario_creador: user.email
      })

      if (impuestoIvaCalculado > 0) movimientosFinancieros.push({ id_cuenta_destino: cuentaData.id, id_ticket: ticketData.id, tipo_movimiento: 'PASIVO_IVA', monto: impuestoIvaCalculado, categoria_gasto: 'Pasivo fiscal IVA', status: 'APPROVED', fecha_movimiento: timestampTransaccion, usuario_creador: user.email })
      if (impuestoIepsCalculado > 0) movimientosFinancieros.push({ id_cuenta_destino: cuentaData.id, id_ticket: ticketData.id, tipo_movimiento: 'PASIVO_IEPS', monto: impuestoIepsCalculado, categoria_gasto: 'Pasivo fiscal IEPS', status: 'APPROVED', fecha_movimiento: timestampTransaccion, usuario_creador: user.email })

      if (usaTriangulacionInventario) {
        movimientosFinancieros.push({
          id_entidad_relacionada: origenInventarioId,
          id_ticket: ticketData.id,
          tipo_movimiento: 'ABONO_DEUDA',
          monto: montoBaseIngreso,
          categoria_gasto: 'Abono por triangulación de inventario',
          status: 'APPROVED', // FIX DE VISIBILIDAD
          fecha_movimiento: timestampTransaccion,
          usuario_creador: user.email
        })
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
      const { error: inventarioError } = await supabase.from('inventario_ledger').insert(inventarioMovimientos)
      if (inventarioError) {
        await rollbackTicket(ticketData.id)
        return { ok: false, error: `Error inventario: ${inventarioError.message}` }
      }

      return { ok: true, ticketId: ticketData.id }
    }
  } catch (error: any) {
    return { ok: false, error: error?.message || 'Error interno POS.' }
  }
}
