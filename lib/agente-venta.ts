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
  return { ok: true, valor: { pedidoId, metodoPago: metodo, items, total } }
}

/**
 * La cuenta destino. **La transferencia no se adivina**: la CLABE que LucIA da
 * es de Nu Mexico, y ninguna cuenta del ERP dice ser esa (medido 2026-09-25).
 * Hasta que Norman diga cual es, la transferencia se rechaza con el porque.
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
