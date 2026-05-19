'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getCurrentUser } from '@/lib/auth-utils'
import { getStockEsperadoPorEntidad } from '@/lib/inventario-auditoria'
import { calculateReverseTaxes, type TipoFiscalidad } from '@/lib/finance-utils'
import { notasConIdTicket } from '@/lib/ticket-annul-cascade'
import type { TablesInsert } from '@/types/database'

interface ConteoFisicoPayload {
  idProducto: string
  fisico: number
}

interface ProcesarCorteInventarioPayload {
  idEntidad: string
  conteosFisicos: ConteoFisicoPayload[]
  idCuentaDestino?: string | null
}

interface ProcesarCorteInventarioResult {
  ok: boolean
  ticketId?: string
  error?: string
}

type InventarioInsert = TablesInsert<'inventario_ledger'>
type FinanzaInsert = TablesInsert<'finanzas_ledger'>
type TicketInsert = TablesInsert<'transacciones_tickets'>
type TicketDetalleInsert = TablesInsert<'ticket_detalles'>

interface ProductoAuditoria {
  id: string
  nombre: string
  costo_unitario: number | null
}

function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizePercentage(rawValue: number | null | undefined, defaultValue: number): number {
  const safeDefault = Number(defaultValue)
  const safeValue = Number(rawValue ?? safeDefault)
  if (!Number.isFinite(safeValue)) return safeDefault
  return safeValue <= 1 ? safeValue : (safeValue / 100)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

async function getServerSupabaseClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set() {
          // No-op en server action
        },
        remove() {
          // No-op en server action
        }
      }
    }
  )
}

async function resolveCuentaDestinoAuditoria(
  supabase: Awaited<ReturnType<typeof getServerSupabaseClient>>,
  entidadOperadora: { id: string; rol: string },
  idCuentaDestino?: string | null
) {
  if (idCuentaDestino) {
    const { data: cuentaSeleccionada, error: cuentaSeleccionadaError } = await supabase
      .from('cuentas_financieras')
      .select('id, nombre, tipo_fiscalidad, id_entidad')
      .eq('id', idCuentaDestino)
      .single()

    if (cuentaSeleccionadaError || !cuentaSeleccionada) {
      throw new Error('La cuenta destino seleccionada no existe o no es válida para cobranza.')
    }
    if (cuentaSeleccionada.id_entidad !== entidadOperadora.id) {
      throw new Error('La cuenta destino no pertenece a la entidad auditora.')
    }

    return cuentaSeleccionada
  }

  const { data: cuentas, error } = await supabase
    .from('cuentas_financieras')
    .select('id, nombre, tipo_fiscalidad')
    .eq('id_entidad', entidadOperadora.id)
    .order('nombre', { ascending: true })

  if (error) {
    throw new Error(`No se pudo resolver cuenta destino: ${error.message}`)
  }

  const cuentasDisponibles = cuentas || []
  if (cuentasDisponibles.length === 0) {
    throw new Error('No hay cuentas financieras para la entidad auditada.')
  }

  let cuentaFallback = cuentasDisponibles.find((cuenta) => normalizeText(cuenta.nombre).startsWith('cta-'))
  if (entidadOperadora.rol === 'ADMIN') {
    const cuentaFresnillo = cuentasDisponibles.find((cuenta) => normalizeText(cuenta.nombre).includes('fresnillo'))
    cuentaFallback = cuentaFresnillo ?? cuentaFallback ?? cuentasDisponibles[0]
  } else {
    cuentaFallback = cuentaFallback ?? cuentasDisponibles[0]
  }

  return cuentaFallback
}

export async function procesarCorteInventarioAction(
  payload: ProcesarCorteInventarioPayload
): Promise<ProcesarCorteInventarioResult> {
  const idEntidadObjetivo = payload.idEntidad?.trim()
  if (!idEntidadObjetivo) {
    throw new Error('Entidad inválida para corte de inventario.')
  }

  const currentUser = await getCurrentUser()
  if (!currentUser) {
    throw new Error('Sesión inválida. Inicia sesión nuevamente.')
  }
  if (currentUser.rol === 'SOCIO') {
    throw new Error('Acceso denegado: Solo lectura.')
  }
  const supabase = await getServerSupabaseClient()
  const { data: entidadObjetivo, error: entidadObjetivoError } = await supabase
    .from('entidades')
    .select('id, rol, comision_base, comision_base_local, comision_hijo_local, id_padre, id_nodo_padre, aplica_redondeo_costo')
    .eq('id', idEntidadObjetivo)
    .single()

  if (entidadObjetivoError || !entidadObjetivo) {
    throw new Error('No se pudo encontrar la entidad objetivo para el corte.')
  }

  const targetParentId = entidadObjetivo.id_nodo_padre ?? entidadObjetivo.id_padre
  if (
    currentUser.rol !== 'ADMIN' &&
    currentUser.id !== idEntidadObjetivo &&
    !(currentUser.rol === 'DST' && targetParentId === currentUser.id)
  ) {
    throw new Error('No autorizado para ejecutar corte de inventario en esta entidad.')
  }

  const { data: entidadOperadora, error: entidadOperadoraError } = await supabase
    .from('entidades')
    .select('id, rol, comision_base, comision_base_local, comision_hijo_local')
    .eq('id', currentUser.id)
    .single()

  if (entidadOperadoraError || !entidadOperadora) {
    throw new Error('No se pudo resolver la entidad auditora.')
  }

  const stockEsperado = await getStockEsperadoPorEntidad(idEntidadObjetivo)
  const conteoMap = new Map(
    payload.conteosFisicos.map((conteo) => [conteo.idProducto, Number(conteo.fisico)])
  )

  const diferencias = stockEsperado.map((item) => {
    const fisico = conteoMap.has(item.idProducto) ? (conteoMap.get(item.idProducto) || 0) : item.stockEsperado
    const diferencia = roundTo2(item.stockEsperado - fisico)
    return {
      ...item,
      fisico,
      diferencia
    }
  })

  const sobregiro = diferencias.find((item) => item.diferencia < 0)
  if (sobregiro) {
    throw new Error(`Sobregiro físico detectado en producto ${sobregiro.producto}. Revisar conteo.`)
  }

  const diferenciasVenta = diferencias.filter((item) => item.diferencia > 0)
  if (diferenciasVenta.length === 0) {
    throw new Error('No hay diferencias positivas para procesar cobranza.')
  }

  const productosIds = diferenciasVenta.map((item) => item.idProducto)
  const ZONA_PRECIO_CALLE = 'Zacatecas'

  const { data: productos, error: productosError } = await supabase
    .from('catalogo_productos')
    .select('id, nombre, costo_unitario')
    .in('id', productosIds)

  if (productosError) {
    throw new Error(`No se pudieron cargar productos para auditoría: ${productosError.message}`)
  }

  const { data: preciosZona, error: preciosZonaError } = await supabase
    .from('listas_precios')
    .select('id_producto, precio_final')
    .eq('zona', ZONA_PRECIO_CALLE)
    .in('id_producto', productosIds)

  if (preciosZonaError) {
    throw new Error(`No se pudieron cargar precios (${ZONA_PRECIO_CALLE}): ${preciosZonaError.message}`)
  }

  const precioCallePorProducto = new Map<string, number>()
  for (const row of preciosZona || []) {
    const pid = row.id_producto
    if (!pid) continue
    const raw = Number(row.precio_final)
    if (Number.isFinite(raw) && raw > 0) {
      precioCallePorProducto.set(pid, raw)
    }
  }

  const cuentaDestino = await resolveCuentaDestinoAuditoria(
    supabase,
    { id: entidadOperadora.id, rol: entidadOperadora.rol },
    payload.idCuentaDestino
  )

  const productosMap = new Map<string, ProductoAuditoria>(
    ((productos as ProductoAuditoria[] | null) || []).map((producto) => [producto.id, producto])
  )

  const itemsCobranza: {
    id_producto: string
    cantidad: number
    precio_unitario: number
    subtotal_linea: number
    nombre_producto: string
  }[] = []
  let totalCobranza = 0

  for (const diff of diferenciasVenta) {
    const producto = productosMap.get(diff.idProducto)
    if (!producto) {
      throw new Error(`Producto ${diff.idProducto} no encontrado para auditoría.`)
    }

    const precioLista = precioCallePorProducto.get(diff.idProducto)
    const costoEmergencia = roundTo2(Number(producto.costo_unitario ?? 0))
    const basePrecio =
      precioLista != null && Number.isFinite(precioLista) && precioLista > 0 ? precioLista : costoEmergencia
    const comisionDecimal =
      Number(entidadObjetivo.comision_base_local) > 1
        ? Number(entidadObjetivo.comision_base_local) / 100
        : Number(entidadObjetivo.comision_base_local || 0)
    const precioDescontado = basePrecio * (1 - comisionDecimal)
    const aplicaRedondeoPrecioUnitario = entidadObjetivo.aplica_redondeo_costo ?? true
    const precioUnitario = aplicaRedondeoPrecioUnitario
      ? Math.ceil(precioDescontado)
      : roundTo2(precioDescontado)
    const subtotalLinea = roundTo2(precioUnitario * diff.diferencia)
    totalCobranza = roundTo2(totalCobranza + subtotalLinea)

    itemsCobranza.push({
      id_producto: diff.idProducto,
      cantidad: diff.diferencia,
      precio_unitario: precioUnitario,
      subtotal_linea: subtotalLinea,
      nombre_producto: producto.nombre
    })
  }

  if (totalCobranza <= 0) {
    throw new Error('El monto de cobranza resultó en cero. Verifica listas_precios (Zacatecas) o costo_unitario.')
  }

  const usuarioCreador = currentUser.email ?? null

  // STEP 1: Comprobante mínimo para historial/recibo de cobranza (sin puente POS/B2B).
  const ticketInsert: TicketInsert = {
    id_vendedor: entidadOperadora.id,
    id_comprador: idEntidadObjetivo,
    condicion_pago: 'CONTADO',
    subtotal_catalogo: totalCobranza,
    total_cobrado_real: totalCobranza,
    monto_base_ingreso: totalCobranza,
    impuesto_iva_calculado: 0,
    impuesto_ieps_calculado: 0,
    id_cuenta_destino: cuentaDestino.id,
    usuario_creador: usuarioCreador
  }

  const { data: ticketData, error: ticketError } = await supabase
    .from('transacciones_tickets')
    .insert(ticketInsert)
    .select('id')
    .single()

  if (ticketError || !ticketData) {
    throw new Error(`Error al crear ticket de cobranza de auditoría: ${ticketError?.message || 'sin detalle'}`)
  }

  const tipoFiscalCuenta = cuentaDestino.tipo_fiscalidad
  const aplicarPasivosFiscales =
    tipoFiscalCuenta === 'FULL_TAX' || tipoFiscalCuenta === 'IVA_ONLY'

  const pasivosAuditoria: FinanzaInsert[] = []
  if (aplicarPasivosFiscales) {
    const breakdown = calculateReverseTaxes(
      totalCobranza,
      tipoFiscalCuenta as TipoFiscalidad
    )
    const montoIva = roundTo2(breakdown.iva)
    const montoIeps = roundTo2(breakdown.ieps)
    if (montoIva > 0) {
      pasivosAuditoria.push({
        id_cuenta_destino: cuentaDestino.id,
        id_entidad_relacionada: idEntidadObjetivo,
        id_ticket: ticketData.id,
        tipo_movimiento: 'PASIVO_IVA',
        monto: montoIva,
        categoria_gasto: 'Pasivo fiscal IVA',
        descripcion: 'IVA reconstruido por cobranza de auditoría (precio con impuestos embebidos).',
        status: 'ACTIVO',
        usuario_creador: usuarioCreador
      })
    }
    if (montoIeps > 0) {
      pasivosAuditoria.push({
        id_cuenta_destino: cuentaDestino.id,
        id_entidad_relacionada: idEntidadObjetivo,
        id_ticket: ticketData.id,
        tipo_movimiento: 'PASIVO_IEPS',
        monto: montoIeps,
        categoria_gasto: 'Pasivo fiscal IEPS',
        descripcion: 'IEPS reconstruido por cobranza de auditoría (precio con impuestos embebidos).',
        status: 'ACTIVO',
        usuario_creador: usuarioCreador
      })
    }
  }

  const categoriaAbonoAuditoria =
    entidadObjetivo.rol === 'DST' ? 'Abono por distribuidor' : 'Abono por local'

  // STEP 2: Ledger de inventario y finanzas asociado al ticket.
  const inventarioMovimientos: InventarioInsert[] = itemsCobranza.map((item) => ({
    id_producto: item.id_producto,
    tipo_movimiento: 'SALIDA_VENTA',
    cantidad: item.cantidad,
    cubeta: 'CONSIGNADO',
    id_entidad_origen: idEntidadObjetivo,
    status: 'ACTIVO',
    usuario_creador: usuarioCreador,
    notas: 'Salida por cobranza de auditoría física'
  }))

  const inventarioConTicket = inventarioMovimientos.map((row) => ({
    ...row,
    notas: notasConIdTicket(ticketData.id, row.notas || '')
  }))

  const { error: inventarioError } = await supabase
    .from('inventario_ledger')
    .insert(inventarioConTicket)

  if (inventarioError) {
    throw new Error(`Error al registrar salida de inventario por auditoría: ${inventarioError.message}`)
  }

  const movimientosFinancieros: FinanzaInsert[] = [
    {
      id_cuenta_destino: cuentaDestino.id,
      id_entidad_relacionada: idEntidadObjetivo,
      id_ticket: ticketData.id,
      tipo_movimiento: 'ABONO_DEUDA',
      monto: totalCobranza,
      categoria: categoriaAbonoAuditoria,
      categoria_gasto: 'Cobranza por auditoría física',
      descripcion: `Pago recibido / Deuda saldada por diferencia de inventario (${diferenciasVenta.length} producto(s)).`,
      status: 'ACTIVO',
      usuario_creador: usuarioCreador
    },
    ...pasivosAuditoria
  ]

  const isDstAuditingLoc = entidadOperadora.rol === 'DST' && entidadObjetivo.rol === 'LOC'
  if (isDstAuditingLoc) {
    const rawComision = Number(entidadObjetivo.comision_base_local ?? 15)
    const comisionDecimal = normalizePercentage(rawComision, 15)
    const aplicaRedondeo = entidadObjetivo.aplica_redondeo_costo ?? true

    let montoAdmin: number
    let montoDST: number
    if (aplicaRedondeo) {
      // Math.ceil for Admin's share; exact complement guarantees sum === totalCobranza
      montoAdmin = Math.ceil(totalCobranza * (1 - comisionDecimal))
      montoDST = totalCobranza - montoAdmin
    } else {
      montoAdmin = roundTo2(totalCobranza * (1 - comisionDecimal))
      montoDST = roundTo2(totalCobranza - montoAdmin)
    }

    // aplica_redondeo_costo=true: montoDST is the exact complement, so sum === totalCobranza always.
    // aplica_redondeo_costo=false: roundTo2 may carry sub-cent drift; accepted as tolerable.

    movimientosFinancieros.push(
      {
        id_cuenta_destino: cuentaDestino.id,
        id_entidad_relacionada: entidadOperadora.id,
        id_ticket: ticketData.id,
        tipo_movimiento: 'INGRESO_COMISION',
        monto: montoDST,
        categoria_gasto: 'Comisión cobranza de red',
        descripcion: `Comisión ganada por red en cobranza de ${entidadObjetivo.id}.`,
        status: 'ACTIVO',
        usuario_creador: usuarioCreador
      },
      {
        id_cuenta_destino: cuentaDestino.id,
        id_entidad_relacionada: entidadOperadora.id,
        id_ticket: ticketData.id,
        tipo_movimiento: 'DEUDA_A_MATRIZ',
        monto: montoAdmin,
        categoria_gasto: 'Caja por entregar a matriz',
        descripcion: `Efectivo recolectado (Por entregar a Matriz) por cobranza de ${entidadObjetivo.id}.`,
        status: 'ACTIVO',
        usuario_creador: usuarioCreador
      }
    )
  }

  const { error: finanzasError } = await supabase
    .from('finanzas_ledger')
    .insert(movimientosFinancieros)

  if (finanzasError) {
    throw new Error(`Error al registrar movimientos financieros de auditoría: ${finanzasError.message}`)
  }

  const detallesTicket: TicketDetalleInsert[] = itemsCobranza.map((item) => ({
    id_ticket: ticketData.id,
    id_producto: item.id_producto,
    cantidad: item.cantidad,
    precio_unitario: item.precio_unitario,
    subtotal_linea: item.subtotal_linea
  }))

  const { error: detallesError } = await supabase
    .from('ticket_detalles')
    .insert(detallesTicket)

  if (detallesError) {
    throw new Error(`Error al guardar detalles del ticket de cobranza: ${detallesError.message}`)
  }

  revalidatePath('/dashboard/finanzas')
  revalidatePath('/dashboard/inventario')
  revalidatePath('/dashboard/distribuidores')
  revalidatePath(`/dashboard/distribuidores/${idEntidadObjetivo}`)

  return {
    ok: true,
    ticketId: ticketData.id
  }
}
