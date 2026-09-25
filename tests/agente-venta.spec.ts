import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  CATEGORIA_ENVIO_COBRADO,
  CUENTA_EFECTIVO_AGENTE,
  MAX_ENVIO_COBRADO,
  MAX_GASTO_ENVIO,
  PRODUCTO_POR_SKU,
  VENDEDOR_AGENTE,
  autorDelPedido,
  cuentaDestinoAgente,
  filaDeGastoEnvio,
  filasDeEnvioCobrado,
  payloadDeVentaAgente,
  tokenAgenteValido,
  validarGastoEnvio,
  validarVenta
} from '../lib/agente-venta'

/**
 * ERP-45 — las pruebas de la puerta del agente de mensajeria.
 *
 * Puras: sin navegador, sin red, sin base. Vigilan lo que, si se rompe, se
 * rompe con dinero: que el cuerpo no elija nada que no deba, que la
 * transferencia no se adivine, y que el gasto nunca arrastre la venta.
 */

const VENTA_BASE = {
  pedido_id: 42,
  metodo_pago: 'efectivo',
  items: [
    { sku: 'plata-750ml', cantidad: 1, precio: 350 },
    { sku: 'plata-50ml', cantidad: 1, precio: 0, regalo: true }
  ]
}

test.describe('validarVenta', () => {
  test('arma la venta con el total calculado y la regalo en 0', () => {
    const r = validarVenta(VENTA_BASE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.total).toBe(350)
    expect(r.valor.items).toHaveLength(2)
    expect(r.valor.items[0]).toEqual({
      id_producto: PRODUCTO_POR_SKU['plata-750ml'],
      cantidad: 1,
      precio_unitario: 350,
      subtotal_linea: 350
    })
    expect(r.valor.items[1].subtotal_linea).toBe(0)
  })

  test('sin productos no hay venta', () => {
    expect(validarVenta({ ...VENTA_BASE, items: [] }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, items: undefined }).ok).toBe(false)
  })

  test('una venta que suma cero se rechaza', () => {
    const r = validarVenta({ ...VENTA_BASE, items: [{ sku: 'plata-50ml', cantidad: 1, precio: 0 }] })
    expect(r.ok).toBe(false)
  })

  test('SKU fuera de la lista, cantidad rara o precio negativo se rechazan', () => {
    expect(validarVenta({ ...VENTA_BASE, items: [{ sku: 'reposado-750ml', cantidad: 1, precio: 350 }] }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, items: [{ sku: 'plata-750ml', cantidad: 1.5, precio: 350 }] }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, items: [{ sku: 'plata-750ml', cantidad: 61, precio: 350 }] }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, items: [{ sku: 'plata-750ml', cantidad: 1, precio: -1 }] }).ok).toBe(false)
  })

  test('pedido_id y metodo_pago invalidos se rechazan', () => {
    expect(validarVenta({ ...VENTA_BASE, pedido_id: 0 }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, pedido_id: 'abc' }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, metodo_pago: 'tarjeta' }).ok).toBe(false)
  })

  test('un total que no cuadra con los productos se rechaza', () => {
    expect(validarVenta({ ...VENTA_BASE, total: 350 }).ok).toBe(true)
    expect(validarVenta({ ...VENTA_BASE, total: 390 }).ok).toBe(false)
  })

  test('lo que el cuerpo trae de mas no llega a la venta', () => {
    const r = validarVenta({ ...VENTA_BASE, idVendedor: 'otro', idComprador: 'otro', condicion_pago: 'CONCESION' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const p = payloadDeVentaAgente(r.valor, CUENTA_EFECTIVO_AGENTE)
    expect(p.idVendedor).toBe(VENDEDOR_AGENTE)
    expect(p.idComprador).toBeNull()
    expect(p.condicion_pago).toBe('CONTADO')
    expect(p.totalCobradoReal).toBe(350)
  })
})

test.describe('cuentaDestinoAgente', () => {
  test('efectivo va a la cuenta Efectivo', () => {
    expect(cuentaDestinoAgente('efectivo', {})).toEqual({ ok: true, valor: CUENTA_EFECTIVO_AGENTE })
  })

  test('la transferencia sin cuenta mapeada se rechaza, no se adivina', () => {
    const r = cuentaDestinoAgente('transferencia', {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('cuenta sin mapear')
    expect(cuentaDestinoAgente('transferencia', { ERP_AGENTE_CUENTA_TRANSFERENCIA: 'Nu' }).ok).toBe(false)
  })

  test('con la cuenta mapeada, la transferencia entra ahi', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(cuentaDestinoAgente('transferencia', { ERP_AGENTE_CUENTA_TRANSFERENCIA: id })).toEqual({ ok: true, valor: id })
  })
})

test.describe('gasto de envio', () => {
  test('valida monto, subcategoria y limpia la ciudad', () => {
    const r = validarGastoEnvio({ pedido_id: 42, monto: 45, subcategoria: 'local', ciudad: 'Fresnillo<script>' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor).toEqual({ pedidoId: 42, monto: 45, subcategoria: 'local', ciudad: 'Fresnilloscript' })
  })

  test('cero, negativo, excesivo o subcategoria rara se rechazan', () => {
    expect(validarGastoEnvio({ pedido_id: 42, monto: 0, subcategoria: 'local' }).ok).toBe(false)
    expect(validarGastoEnvio({ pedido_id: 42, monto: -5, subcategoria: 'local' }).ok).toBe(false)
    expect(validarGastoEnvio({ pedido_id: 42, monto: MAX_GASTO_ENVIO + 1, subcategoria: 'guia' }).ok).toBe(false)
    expect(validarGastoEnvio({ pedido_id: 42, monto: 45, subcategoria: 'avion' }).ok).toBe(false)
  })

  test('la fila del gasto NO lleva id_ticket y lleva el autor del pedido', () => {
    const fila = filaDeGastoEnvio({ pedidoId: 42, monto: 180, subcategoria: 'guia', ciudad: 'Monterrey' }, new Date('2026-09-25T18:00:00.000Z'))
    expect(fila.id_ticket).toBeNull()
    expect(fila.status).toBe('ACTIVO')
    expect(fila.categoria).toBe('Logistica_Envios')
    expect(fila.usuario_creador).toBe(autorDelPedido(42))
    expect(fila.descripcion).toBe('Envio #E42 Monterrey')
  })
})

test.describe('envio cobrado', () => {
  const TICKET = '99999999-8888-7777-6666-555555555555'
  const PERSONAL = '2e2d25d1-84ed-4a66-bd1a-5cc7072f346b'
  const AHORA = new Date('2026-09-25T18:00:00.000Z')

  test('sin envio_cobrado (cerebro 1.14.0) la venta entra igual, con 0', () => {
    const r = validarVenta(VENTA_BASE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.envioCobrado).toBe(0)
    expect(validarVenta({ ...VENTA_BASE, envio_cobrado: null }).ok).toBe(true)
  })

  test('el envio no se mezcla con el total del producto ni con el ticket', () => {
    const r = validarVenta({ ...VENTA_BASE, total: 350, envio_cobrado: 99 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valor.envioCobrado).toBe(99)
    const p = payloadDeVentaAgente(r.valor, CUENTA_EFECTIVO_AGENTE)
    // El ticket sigue siendo SOLO mercancia: v_ventas_por_mes y v_resumen_del_dia no ven el envio.
    expect(p.totalCobradoReal).toBe(350)
    expect(p.subtotalCatalogo).toBe(350)
  })

  test('envio negativo, no numerico o excesivo se rechaza', () => {
    expect(validarVenta({ ...VENTA_BASE, envio_cobrado: -1 }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, envio_cobrado: 'mucho' }).ok).toBe(false)
    expect(validarVenta({ ...VENTA_BASE, envio_cobrado: MAX_ENVIO_COBRADO + 1 }).ok).toBe(false)
  })

  test('envio 0 no escribe nada', () => {
    expect(filasDeEnvioCobrado({ pedidoId: 42, envioCobrado: 0, idTicket: TICKET, idCuenta: CUENTA_EFECTIVO_AGENTE, tipoFiscalidad: 'LIBRE' }, AHORA)).toEqual([])
  })

  test('efectivo (LIBRE): una fila de ingreso, ligada al ticket y a la misma cuenta, sin impuesto', () => {
    const filas = filasDeEnvioCobrado({ pedidoId: 42, envioCobrado: 40, idTicket: TICKET, idCuenta: CUENTA_EFECTIVO_AGENTE, tipoFiscalidad: 'LIBRE' }, AHORA)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({
      tipo_movimiento: 'INGRESO_VENTA',
      categoria: CATEGORIA_ENVIO_COBRADO,
      monto: 40,
      id_ticket: TICKET,
      id_cuenta_destino: CUENTA_EFECTIVO_AGENTE,
      status: 'ACTIVO',
      usuario_creador: autorDelPedido(42)
    })
  })

  test('transferencia a Cuenta personal (IVA_ONLY): ingreso + PASIVO_IVA del envio, todo con id_ticket', () => {
    const filas = filasDeEnvioCobrado({ pedidoId: 42, envioCobrado: 99, idTicket: TICKET, idCuenta: PERSONAL, tipoFiscalidad: 'IVA_ONLY' }, AHORA)
    expect(filas.map((f) => [f.tipo_movimiento, f.monto])).toEqual([
      ['INGRESO_VENTA', 99],
      ['PASIVO_IVA', 13.66]
    ])
    for (const f of filas) {
      expect(f.id_ticket).toBe(TICKET)
      expect(f.id_cuenta_destino).toBe(PERSONAL)
      expect(f.categoria).toBe(CATEGORIA_ENVIO_COBRADO)
    }
  })

  test('la ruta completa el envio en los DOS caminos: venta nueva y venta que ya existia', () => {
    const fuente = readFileSync(path.join(__dirname, '..', 'app', 'api', 'agente', 'venta', 'route.ts'), 'utf8')
    expect(fuente.match(/await asegurarEnvioCobrado\(/g) ?? []).toHaveLength(2)
  })
})

test.describe('tokenAgenteValido', () => {
  const TOKEN = 'x'.repeat(32)
  const conToken = (t?: string) => new Request('http://localhost/api/agente/venta', { method: 'POST', headers: t ? { 'x-agente-token': t } : {} })

  test('acepta solo el token completo', () => {
    const antes = process.env.ERP_AGENTE_TOKEN
    process.env.ERP_AGENTE_TOKEN = TOKEN
    try {
      expect(tokenAgenteValido(conToken(TOKEN))).toBe(true)
      expect(tokenAgenteValido(conToken(TOKEN.slice(0, 31)))).toBe(false)
      expect(tokenAgenteValido(conToken('y'.repeat(32)))).toBe(false)
      expect(tokenAgenteValido(conToken())).toBe(false)
    } finally {
      if (antes === undefined) delete process.env.ERP_AGENTE_TOKEN
      else process.env.ERP_AGENTE_TOKEN = antes
    }
  })

  test('un token corto en el servidor cierra la puerta', () => {
    const antes = process.env.ERP_AGENTE_TOKEN
    process.env.ERP_AGENTE_TOKEN = 'corto'
    try {
      expect(tokenAgenteValido(conToken('corto'))).toBe(false)
    } finally {
      if (antes === undefined) delete process.env.ERP_AGENTE_TOKEN
      else process.env.ERP_AGENTE_TOKEN = antes
    }
  })
})
