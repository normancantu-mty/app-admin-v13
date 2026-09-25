/**
 * ERP-45 — LAS VENTAS DE LucIA (el agente de mensajeria) ENTRAN AL ERP.
 *
 * Escrito el 2026-09-25 por el ejecutor del Socio (plan
 * `Socio/_checkpoints/PLAN_ventas_agente_al_erp_2026-09-25.md`, seccion 7).
 *
 * ─── QUIEN LLAMA Y POR QUE ASI ───────────────────────────────────────────────
 *
 * El cerebro del agente (Edge Function `manychat-cerebro`) llama
 * `POST /api/agente/venta` cuando Norman escribe `entregado #E<id>` en el grupo.
 * La venta la escribe `registrarVenta` (`lib/venta-servidor.ts`), el mismo
 * motor del POS y del bot: stock, fiscalidad y comisiones no se duplican aqui.
 *
 * ─── LA SUPERFICIE, DICHA ENTERA ─────────────────────────────────────────────
 *
 * La ruta entra con service role, asi que **casi nada es parametro**:
 *   · vendedor: CEO Admin, fijo. Comprador: NULL (Publico en General), fijo.
 *   · condicion: CONTADO, fija. Cuenta: Efectivo, o la de transferencia que diga
 *     `ERP_AGENTE_CUENTA_TRANSFERENCIA` (sin ella, la transferencia se rechaza).
 *   · productos: solo los tres SKUs del agente.
 * Lo que el cuerpo trae de mas se ignora: `validarVenta` construye su objeto y
 * no copia nada del cuerpo.
 *
 * ─── IDEMPOTENCIA EN DOS PISOS ───────────────────────────────────────────────
 *
 * 1. En el agente: `agente.ventas_erp.pedido_id` es PRIMARY KEY (un reintento choca).
 * 2. Aqui: `usuario_creador = 'agente:lucia:E<id>'`. Antes de escribir se busca
 *    un ticket ACTIVO con ese autor; si existe se devuelve el mismo. Cierra el
 *    hueco de "la venta entro pero se perdio la respuesta". `tg_forzar_autor`
 *    respeta el valor porque el service role no trae correo en el JWT.
 */

import type { ProcesarVentaPOSPayload } from '@/lib/venta-servidor'
import { calculateReverseTaxes } from '@/lib/finance-utils'

export const VENDEDOR_AGENTE = 'e0000000-0000-0000-0000-000000000001'
export const CUENTA_EFECTIVO_AGENTE = '67e91f62-0ac3-43fe-a640-ec1b85e994b0'

export const PRODUCTO_POR_SKU: Readonly<Record<string, string>> = {
  'plata-750ml': 'c1000000-0000-0000-0000-000000000001',
  'plata-250ml': 'c1000000-0000-0000-0000-000000000003',
  'plata-50ml': 'c1000000-0000-0000-0000-000000000004'
}

export const MAX_PIEZAS_POR_RENGLON = 60
export const MAX_PRECIO_UNITARIO = 10000
export const MAX_GASTO_ENVIO = 5000
/** Lo que LucIA cobra de envio hoy es 0, 40 o 99. El techo solo ataja un dedazo. */
export const MAX_ENVIO_COBRADO = 1000
/** La marca que distingue el envio cobrado de la venta de mercancia (y la llave de la idempotencia). */
export const CATEGORIA_ENVIO_COBRADO = 'Envio_Cobrado'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function autorDelPedido(pedidoId: number): string {
  return `agente:lucia:E${pedidoId}`
}

/** Mismo criterio que `tokenValido` del bot: completo, longitud minima, sin prefijos. */
export function tokenAgenteValido(request: Request): boolean {
  const esperado = process.env.ERP_AGENTE_TOKEN
  if (!esperado || esperado.length < 24) return false
  const recibido = request.headers.get('x-agente-token') ?? ''
  if (recibido.length !== esperado.length) return false
  let diferencia = 0
  for (let i = 0; i < esperado.length; i++) {
    diferencia |= esperado.charCodeAt(i) ^ recibido.charCodeAt(i)
  }
  return diferencia === 0
}

type Resultado<T> = { ok: true; valor: T } | { ok: false; error: string }

function pedidoValido(v: unknown): number | null {
  const n = Number(v)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export interface VentaAgente {
  pedidoId: number
  metodoPago: 'efectivo' | 'transferencia'
  items: { id_producto: string; cantidad: number; precio_unitario: number; subtotal_linea: number }[]
  total: number
  /** Envio que LucIA le cobro al cliente, aparte del producto. 0 si no cobro. */
  envioCobrado: number
}

export function validarVenta(cuerpo: Record<string, unknown>): Resultado<VentaAgente> {
  const pedidoId = pedidoValido(cuerpo.pedido_id)
  if (!pedidoId) return { ok: false, error: 'pedido_id invalido.' }
  const metodo = String(cuerpo.metodo_pago ?? '')
  if (metodo !== 'efectivo' && metodo !== 'transferencia') {
    return { ok: false, error: 'metodo_pago debe ser efectivo o transferencia.' }
  }
  const crudos = Array.isArray(cuerpo.items) ? (cuerpo.items as Record<string, unknown>[]) : []
  if (crudos.length === 0 || crudos.length > 10) return { ok: false, error: 'La venta no trae productos.' }

  const items: VentaAgente['items'] = []
  for (const r of crudos) {
    const sku = String(r?.sku ?? '')
    const idProducto = PRODUCTO_POR_SKU[sku]
    if (!idProducto) return { ok: false, error: `SKU fuera de la lista del agente: ${sku.slice(0, 40)}` }
    const cantidad = Number(r.cantidad)
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_PIEZAS_POR_RENGLON) {
      return { ok: false, error: `Cantidad invalida para ${sku}.` }
    }
    const precio = Number(r.precio)
    if (!Number.isFinite(precio) || precio < 0 || precio > MAX_PRECIO_UNITARIO) {
      return { ok: false, error: `Precio invalido para ${sku}.` }
    }
    items.push({ id_producto: idProducto, cantidad, precio_unitario: precio, subtotal_linea: Number((precio * cantidad).toFixed(2)) })
  }

  const total = Number(items.reduce((a, i) => a + i.subtotal_linea, 0).toFixed(2))
  if (!(total > 0)) return { ok: false, error: 'La venta suma cero.' }
  if (cuerpo.total !== undefined && cuerpo.total !== null && Math.abs(Number(cuerpo.total) - total) > 0.01) {
    return { ok: false, error: `El total (${cuerpo.total}) no cuadra con los productos (${total}).` }
  }
  // Ausente o null = 0: el cerebro 1.14.0 no lo manda y su venta tiene que seguir entrando igual.
  const envioCrudo = cuerpo.envio_cobrado === undefined || cuerpo.envio_cobrado === null ? 0 : Number(cuerpo.envio_cobrado)
  if (!Number.isFinite(envioCrudo) || envioCrudo < 0 || envioCrudo > MAX_ENVIO_COBRADO) {
    return { ok: false, error: `envio_cobrado invalido (de 0 a ${MAX_ENVIO_COBRADO}).` }
  }
  const envioCobrado = Number(envioCrudo.toFixed(2))
  return { ok: true, valor: { pedidoId, metodoPago: metodo, items, total, envioCobrado } }
}

/**
 * La cuenta destino. **La transferencia no se adivina**: la CLABE que LucIA da
 * es de Nu Mexico, y ninguna cuenta del ERP dice ser esa (medido 2026-09-25).
 * Norman decidio el 2026-09-25 que entra a "Cuenta personal" (IVA_ONLY); el id
 * vive en `ERP_AGENTE_CUENTA_TRANSFERENCIA`, no aqui. Sin ella, se rechaza con el porque.
 */
export function cuentaDestinoAgente(
  metodo: VentaAgente['metodoPago'],
  entorno: Partial<Record<string, string | undefined>> = process.env
): Resultado<string> {
  if (metodo === 'efectivo') return { ok: true, valor: CUENTA_EFECTIVO_AGENTE }
  const id = (entorno.ERP_AGENTE_CUENTA_TRANSFERENCIA ?? '').trim()
  if (!UUID.test(id)) {
    return { ok: false, error: 'cuenta sin mapear: falta ERP_AGENTE_CUENTA_TRANSFERENCIA (a que cuenta del ERP entra la transferencia de LucIA).' }
  }
  return { ok: true, valor: id }
}

export function payloadDeVentaAgente(v: VentaAgente, idCuenta: string): ProcesarVentaPOSPayload {
  return {
    idVendedor: VENDEDOR_AGENTE,
    idComprador: null,
    idCuentaDestino: idCuenta,
    condicion_pago: 'CONTADO',
    subtotalCatalogo: v.total,
    totalCobradoReal: v.total,
    // El motor recalcula los impuestos contra la cuenta; de aqui no sale ninguno.
    montoBaseIngreso: 0,
    impuestoIvaCalculado: 0,
    impuestoIepsCalculado: 0,
    items: v.items
  }
}

/**
 * EL ENVIO QUE LucIA COBRA ENTRA COMO INGRESO DE ESA VENTA (2026-09-25).
 *
 * Una fila `INGRESO_VENTA` con `categoria = 'Envio_Cobrado'`, `id_ticket` de la
 * venta y la MISMA cuenta destino. Por que asi y no otra cosa (medido contra las
 * vistas de produccion):
 *   · La cuenta recibe producto + envio: `v_movimiento_clasificado` la marca
 *     `es_ingreso_admin` y `getLiquidezPorCuenta` la suma a su cuenta.
 *   · No se confunde con mercancia: `v_ventas_por_mes` y `v_resumen_del_dia`
 *     suman `transacciones_tickets.total_cobrado_real`, que sigue siendo solo
 *     producto; `v_cartera`/`v_saldo_entidad` no leen `INGRESO_VENTA`.
 *     Subir `total_cobrado_real` por encima de `subtotal_catalogo` la habria
 *     metido en "vendido" y `lib/bot-descuento.ts` lee esa diferencia como descuento.
 *   · Anular la venta la anula: `anular_ticket_atomica` anula toda fila con ese `id_ticket`.
 *   · Idempotente: la ruta busca la fila `Envio_Cobrado` ACTIVA del ticket antes de escribir.
 *
 * El impuesto sale de `calculateReverseTaxes` con la fiscalidad de la cuenta —la
 * MISMA funcion que usa el motor de la venta—: en `IVA_ONLY` el envio cobrado
 * lleva su `PASIVO_IVA` (el IVA grava todo lo que se cobra al adquirente), en
 * `LIBRE` no lleva nada. No se toca el motor fiscal: solo se le pregunta.
 */
export function filasDeEnvioCobrado(
  args: {
    pedidoId: number
    envioCobrado: number
    idTicket: string
    idCuenta: string
    tipoFiscalidad: 'FULL_TAX' | 'IVA_ONLY' | 'LIBRE'
  },
  ahora = new Date()
) {
  if (!(args.envioCobrado > 0)) return []
  const fecha = ahora.toISOString()
  const autor = autorDelPedido(args.pedidoId)
  const base = {
    id_cuenta_destino: args.idCuenta,
    id_ticket: args.idTicket,
    categoria: CATEGORIA_ENVIO_COBRADO,
    status: 'ACTIVO',
    fecha_movimiento: fecha,
    usuario_creador: autor
  }
  const impuestos = calculateReverseTaxes(args.envioCobrado, args.tipoFiscalidad)
  const filas: Array<typeof base & {
    tipo_movimiento: string
    monto: number
    categoria_gasto: string
    descripcion: string
    id_entidad_relacionada?: string
  }> = [
    {
      ...base,
      id_entidad_relacionada: VENDEDOR_AGENTE,
      tipo_movimiento: 'INGRESO_VENTA',
      monto: args.envioCobrado,
      categoria_gasto: 'Envio cobrado al cliente',
      descripcion: `Envio cobrado #E${args.pedidoId}`
    }
  ]
  if (impuestos.iva > 0) {
    filas.push({ ...base, tipo_movimiento: 'PASIVO_IVA', monto: impuestos.iva, categoria_gasto: 'Pasivo fiscal IVA', descripcion: `IVA del envio cobrado #E${args.pedidoId}` })
  }
  if (impuestos.ieps > 0) {
    filas.push({ ...base, tipo_movimiento: 'PASIVO_IEPS', monto: impuestos.ieps, categoria_gasto: 'Pasivo fiscal IEPS', descripcion: `IEPS del envio cobrado #E${args.pedidoId}` })
  }
  return filas
}

export interface GastoEnvioAgente {
  pedidoId: number
  monto: number
  subcategoria: 'local' | 'guia'
  ciudad: string
}

export function validarGastoEnvio(cuerpo: Record<string, unknown>): Resultado<GastoEnvioAgente> {
  const pedidoId = pedidoValido(cuerpo.pedido_id)
  if (!pedidoId) return { ok: false, error: 'pedido_id invalido.' }
  const monto = Number(cuerpo.monto)
  if (!Number.isFinite(monto) || monto <= 0 || monto > MAX_GASTO_ENVIO) {
    return { ok: false, error: `Monto de envio invalido (mayor que 0 y hasta ${MAX_GASTO_ENVIO}).` }
  }
  const sub = String(cuerpo.subcategoria ?? '')
  if (sub !== 'local' && sub !== 'guia') return { ok: false, error: 'subcategoria debe ser local o guia.' }
  const ciudad = String(cuerpo.ciudad ?? '').replace(/[^\p{L}\p{N} .-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return { ok: true, valor: { pedidoId, monto: Number(monto.toFixed(2)), subcategoria: sub, ciudad } }
}

/**
 * La fila del gasto. Forma medida contra produccion: las filas `Logistica_Envios`
 * existentes no llevan cuenta. **Sin `id_ticket`, a proposito**: una fila con
 * `id_ticket` arrastra la venta entera al anularse (`lib/anulacion-servidor.ts`).
 * El vinculo con la venta vive en `agente.ventas_erp.id_gasto_envio`.
 */
export function filaDeGastoEnvio(g: GastoEnvioAgente, ahora = new Date()) {
  return {
    tipo_movimiento: 'GASTO_OPERATIVO',
    categoria: 'Logistica_Envios',
    categoria_gasto: null,
    subcategoria: g.subcategoria,
    descripcion: `Envio #E${g.pedidoId}${g.ciudad ? ' ' + g.ciudad : ''}`,
    monto: g.monto,
    status: 'ACTIVO',
    fecha_movimiento: ahora.toISOString(),
    usuario_creador: autorDelPedido(g.pedidoId),
    id_ticket: null,
    id_cuenta_origen: null,
    id_cuenta_destino: null
  }
}
