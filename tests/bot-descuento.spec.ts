/**
 * BLOQUE D (Fase 6) — LAS PROMOCIONES. **D55 · D56 · D57.**
 *
 * ─── DE DONDE SALE CADA NUMERO DE ESTE ARCHIVO ──────────────────────────────
 *
 * De produccion, medido el 2026-09-19, no inventado:
 *
 *  · **$10,176.00** es la cotizacion que Norman le pidio al bot para Aeropuerto
 *    (12 de 750, 12 de 250, 48 de 50). Se recalcula aqui con el mismo
 *    `precioParaComprador` del endpoint, asi que no es un numero magico: si un
 *    precio de la base se mueve, esta prueba lo dice antes que nadie.
 *
 *  · **30%** es el tope, y sale de `entidades`: existe una entidad de la red
 *    llamada literalmente `Descuento del 30%`, con dos ventas vivas a su
 *    nombre. Es el descuento mas grande que Norman ya se aplica a si mismo.
 *
 *  · **0 de 67** tickets `ACTIVO` tienen hoy `subtotal_catalogo` distinto de
 *    `total_cobrado_real`. Por eso el control negativo 2 de D57 —una venta sin
 *    descuento deja las dos columnas iguales— es el que protege lo que ya
 *    servia, y el caso con descuento es el que prueba que sirvio.
 *
 * ─── LO QUE ESTE ARCHIVO **NO** PUEDE PROBAR, Y SE DICE ─────────────────────
 *
 * Que la RUTA devuelva 422 arriba del tope es una propiedad del endpoint, y un
 * `.spec.ts` puro no habla con el servidor. Aqui se prueba que la funcion que
 * la ruta llama rechaza, y que `normalizarVenta` / `normalizarCotizacion`
 * **tampoco** arman payload aunque alguien les meta el descuento por el
 * contexto saltandose la ruta. El 422 de verdad se comprueba contra el
 * servidor vivo y queda en el informe con su codigo de respuesta.
 */

import { expect, test } from '@playwright/test'
import {
  aplicarDescuento,
  descuentoDelPayload,
  lineasDeDescuento,
  notaDeDescuento,
  sinDescuento,
  TOPE_DESCUENTO_PORCENTAJE
} from '@/lib/bot-descuento'
import {
  aProductoDelCatalogo,
  mensajeDeConfirmacionVenta,
  normalizarVenta,
  precioParaComprador,
  ZONA_POR_DEFECTO,
  type CompradorDeVenta,
  type ContextoVenta,
  type ProductoConPrecios
} from '@/lib/bot-venta'
import {
  mensajeDeConfirmacionCotizacion,
  normalizarCotizacion,
  type ContextoCotizacion
} from '@/lib/bot-cotizacion'

// ── Los fixtures, copiados de produccion ───────────────────────────────────
const CEO_ADMIN = 'e0000000-0000-0000-0000-000000000001'

const CATALOGO_CRUDO: ProductoConPrecios[] = [
  {
    id: 'c1000000-0000-0000-0000-000000000001',
    sku: 'plata-750ml',
    nombre: 'Destilado Plata 750ml',
    ml_por_unidad: 750,
    precios: [
      { zona: 'Zacatecas', precio_final: 599 },
      { zona: 'Foraneo', precio_final: 799 }
    ]
  },
  {
    id: 'c1000000-0000-0000-0000-000000000003',
    sku: 'plata-250ml',
    nombre: 'Destilado Plata 250ml',
    ml_por_unidad: 250,
    precios: [
      { zona: 'Zacatecas', precio_final: 179 },
      { zona: 'Foraneo', precio_final: 199 }
    ]
  },
  {
    id: 'c1000000-0000-0000-0000-000000000004',
    sku: 'plata-50ml',
    nombre: 'Destilado Plata 50ml',
    ml_por_unidad: 50,
    precios: [
      { zona: 'Zacatecas', precio_final: 69 },
      { zona: 'Foraneo', precio_final: 99 }
    ]
  }
]

const CATALOGO = CATALOGO_CRUDO.map((p) => aProductoDelCatalogo(p, ZONA_POR_DEFECTO))

/** Aeropuerto, copiado de produccion: LOC de Zacatecas al 20%. */
const AEROPUERTO: CompradorDeVenta = {
  id: '4cbad6ad-41f6-4397-86d3-0f5ec5be21dd',
  nombre: 'Aeropuerto',
  rol: 'LOC',
  zona: 'Zacatecas',
  comision_base: 0,
  comision_base_local: 0.2,
  aplica_redondeo_costo: true
}

/** Los tres renglones de la cotizacion real del 2026-09-19. */
const RENGLONES_REALES = [
  { producto: CATALOGO[0], cantidad: 12 },
  { producto: CATALOGO[1], cantidad: 12 },
  { producto: CATALOGO[2], cantidad: 48 }
]

const HOY = '2026-09-19'

function contextoVenta(parcial: Partial<ContextoVenta> = {}): ContextoVenta {
  return {
    idVendedor: CEO_ADMIN,
    nombreVendedor: 'CEO Admin',
    comprador: AEROPUERTO,
    idCuentaDestino: 'cta-0000',
    nombreCuentaDestino: 'Efectivo (CEO Admin)',
    tipoFiscalidadCuenta: 'LIBRE',
    etiqueta: 'norman',
    lineas: RENGLONES_REALES,
    ...parcial
  }
}

function contextoCotizacion(parcial: Partial<ContextoCotizacion> = {}): ContextoCotizacion {
  return {
    idVendedor: CEO_ADMIN,
    nombreVendedor: 'CEO Admin',
    comprador: AEROPUERTO,
    nombreProspecto: null,
    zona: ZONA_POR_DEFECTO,
    etiqueta: 'norman',
    hoy: HOY,
    lineas: RENGLONES_REALES,
    ...parcial
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. EL ANCLA: la cotizacion real de Norman
// ═══════════════════════════════════════════════════════════════════════════

test.describe('el ancla contra produccion', () => {
  test('los tres renglones de Aeropuerto son $10,176.00', () => {
    const total = RENGLONES_REALES.reduce(
      (t, l) => t + precioParaComprador(l.producto, AEROPUERTO) * l.cantidad,
      0
    )
    expect(Number(total.toFixed(2))).toBe(10176)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. D57 — 10% SOBRE $10,176.00 COBRA $9,158.40
// ═══════════════════════════════════════════════════════════════════════════

test.describe('D57 — el 10% que pidio el encargo', () => {
  test('10% sobre $10,176.00 cobra $9,158.40', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.subtotal).toBe(10176)
    expect(d.importe).toBe(1017.6)
    expect(d.total).toBe(9158.4)
    expect(d.porcentaje).toBe(10)
    expect(d.hay).toBe(true)
  })

  test('el mensaje de la cotizacion ensena LAS DOS cifras', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    if (!d.ok) throw new Error(d.error)
    const r = normalizarCotizacion({}, contextoCotizacion({ descuento: d }))
    if (!r.ok) throw new Error(r.error)

    const mensaje = mensajeDeConfirmacionCotizacion(r.payload, r.desglose, r.avisos, {
      paraQuien: 'Aeropuerto',
      esDeLaRed: true,
      rolComprador: 'DST',
      vigenteHasta: '2026-10-04'
    })

    // La de lista, la rebaja y el cobrado. **Las tres, en el mismo globo.**
    expect(mensaje).toContain('Precio de lista:  $10,176.00')
    expect(mensaje).toContain('Descuento 10%:  -$1,017.60')
    expect(mensaje).toContain('TOTAL A COBRAR:   $9,158.40')
    // Y el `total` sellado es el COBRADO, no la lista: es el que se convierte
    // en venta y el que el cliente va a pagar.
    expect(r.payload.total).toBe(9158.4)
  })

  test('la venta con 10% ensena las dos cifras y sella el cobrado', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    if (!d.ok) throw new Error(d.error)
    const r = normalizarVenta({}, contextoVenta({ descuento: d }))
    if (!r.ok) throw new Error(r.error)

    const mensaje = mensajeDeConfirmacionVenta(
      r.payload,
      {
        nombreVendedor: 'CEO Admin',
        nombreComprador: 'Aeropuerto',
        nombreCuentaDestino: 'Efectivo (CEO Admin)',
        desglose: r.desglose
      },
      r.avisos
    )
    expect(mensaje).toContain('Precio de lista:  $10,176.00')
    expect(mensaje).toContain('TOTAL A COBRAR:   $9,158.40')
    // Las piezas siguen a la vista: 12 + 12 + 48.
    expect(mensaje).toContain('(72 piezas)')
  })

  test('el motivo dictado sale en el mensaje y en la nota', () => {
    const d = aplicarDescuento(10176, { porcentaje: 15, motivo: 'Promocion de septiembre' })
    if (!d.ok) throw new Error(d.error)
    expect(lineasDeDescuento(d)[1]).toBe('Promocion de septiembre (15%):  -$1,526.40')
    expect(notaDeDescuento(d)).toBe('Promocion de septiembre 15%: de $10,176.00 a $8,649.60.')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. D57 — LA FILA ESCRITA TIENE LAS DOS COLUMNAS DISTINTAS
// ═══════════════════════════════════════════════════════════════════════════

test.describe('D57 — las dos columnas del ticket', () => {
  test('con descuento, `subtotal_catalogo` y `total_cobrado_real` se SEPARAN', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    if (!d.ok) throw new Error(d.error)
    const r = normalizarVenta({}, contextoVenta({ descuento: d }))
    if (!r.ok) throw new Error(r.error)

    expect(r.payload.subtotal_catalogo).toBe(10176)
    expect(r.payload.total_cobrado_real).toBe(9158.4)
    expect(r.payload.subtotal_catalogo).not.toBe(r.payload.total_cobrado_real)
  })

  // ── CONTROL NEGATIVO 2 (D57): lo que ya servia no se rompe ───────────────
  // Hoy los 67 tickets vivos tienen las dos columnas iguales. Si esta prueba
  // se pone roja, el Bloque D le cambio el numero a una venta normal.
  test('SIN descuento, las dos columnas quedan IGUALES', () => {
    const r = normalizarVenta({}, contextoVenta())
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.subtotal_catalogo).toBe(10176)
    expect(r.payload.total_cobrado_real).toBe(10176)
    expect(r.payload.subtotal_catalogo).toBe(r.payload.total_cobrado_real)
  })

  test('SIN descuento el mensaje es el de siempre, sin una linea de mas', () => {
    const r = normalizarVenta({}, contextoVenta())
    if (!r.ok) throw new Error(r.error)
    const mensaje = mensajeDeConfirmacionVenta(
      r.payload,
      {
        nombreVendedor: 'CEO Admin',
        nombreComprador: 'Aeropuerto',
        nombreCuentaDestino: 'Efectivo (CEO Admin)',
        desglose: r.desglose
      },
      r.avisos
    )
    expect(mensaje).toContain('TOTAL:      $10,176.00   (72 piezas)')
    expect(mensaje).not.toContain('Precio de lista')
    expect(mensaje).not.toContain('TOTAL A COBRAR')
  })

  test('un descuento de cero pesos NO cuenta como descuento', () => {
    // Redondea a cero: no hay separacion de columnas ni linea de mas.
    const d = aplicarDescuento(100, { porcentaje: 0.001 })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.hay).toBe(false)
    expect(d.total).toBe(100)
    expect(lineasDeDescuento(d)).toEqual([])
    expect(notaDeDescuento(d)).toBe('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. D56 — EL TOPE
// ═══════════════════════════════════════════════════════════════════════════

test.describe('D56 — el tope, y que no lo decide el modelo', () => {
  test('el tope es 30, y sale de una entidad real de produccion', () => {
    expect(TOPE_DESCUENTO_PORCENTAJE).toBe(30)
  })

  test('justo EN el tope pasa', () => {
    const d = aplicarDescuento(10176, { porcentaje: TOPE_DESCUENTO_PORCENTAJE })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.total).toBe(7123.2)
  })

  // ── CONTROL NEGATIVO (D57): arriba del tope, y NO escribe nada ────────────
  test('un centesimo arriba del tope se rechaza', () => {
    const d = aplicarDescuento(10176, { porcentaje: TOPE_DESCUENTO_PORCENTAJE + 0.01 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain(String(TOPE_DESCUENTO_PORCENTAJE))
  })

  test('60% se rechaza, y el mensaje dice contra que numero choco', () => {
    const d = aplicarDescuento(10176, { porcentaje: 60 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain('el tope es 30%')
  })

  test('el tope tambien aplica cuando el descuento viene como TOTAL', () => {
    // $5,000 sobre $10,176 es un 50.86%: por arriba del tope.
    const d = aplicarDescuento(10176, { total_final: 5000 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain('el tope es 30%')
  })

  test('un total DENTRO del tope si pasa, y deriva el porcentaje', () => {
    const d = aplicarDescuento(10000, { total_final: 8000 })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.porcentaje).toBe(20)
    expect(d.total).toBe(8000)
    expect(d.importe).toBe(2000)
  })

  // ── El tope no se puede saltar por el contexto ────────────────────────────
  // Si alguien llama a la funcion pura sin pasar por la ruta, el payload
  // tampoco se arma. Es la mitad que convierte el 422 de la ruta en una regla.
  test('un descuento arriba del tope metido por el contexto NO arma venta', () => {
    const fuera = { ...sinDescuento(10176), porcentaje: 60, importe: 6105.6, total: 4070.4, hay: true }
    const r = normalizarVenta({}, contextoVenta({ descuento: fuera }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('el tope es 30%')
  })

  test('un descuento arriba del tope metido por el contexto NO arma cotizacion', () => {
    const fuera = { ...sinDescuento(10176), porcentaje: 60, importe: 6105.6, total: 4070.4, hay: true }
    const r = normalizarCotizacion({}, contextoCotizacion({ descuento: fuera }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('el tope es 30%')
  })

  test('un descuento calculado sobre OTRO total no se aplica al de ahora', () => {
    // El escenario: se resolvio el descuento, cambio un renglon, y el numero
    // sobre el que se descontaba ya no es el que se va a escribir.
    const viejo = aplicarDescuento(5000, { porcentaje: 10 })
    if (!viejo.ok) throw new Error(viejo.error)
    const r = normalizarVenta({}, contextoVenta({ descuento: viejo }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('ya no es el mismo')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. LA BASURA QUE NO SE VUELVE DINERO
// ═══════════════════════════════════════════════════════════════════════════

test.describe('lo que se rechaza', () => {
  test('sin dictado no hay descuento', () => {
    for (const nada of [undefined, null, {}, 'nel', 7, [] as unknown]) {
      const d = aplicarDescuento(10176, nada)
      expect(d.ok).toBe(true)
      if (!d.ok) continue
      expect(d.hay).toBe(false)
      expect(d.total).toBe(10176)
      expect(d.subtotal).toBe(d.total)
    }
  })

  test('los dos numeros a la vez se rechazan enteros', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10, total_final: 9158.4 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain('dos descuentos')
  })

  test('un total ARRIBA de la lista es un recargo, y no se aplica', () => {
    const d = aplicarDescuento(10176, { total_final: 12000 })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.error).toContain('recargo')
  })

  test('un porcentaje que no es numero se rechaza', () => {
    for (const malo of ['mucho', NaN, Infinity, -5, 0]) {
      const d = aplicarDescuento(10176, { porcentaje: malo })
      expect(d.ok).toBe(false)
    }
  })

  test('un total que no es numero se rechaza', () => {
    for (const malo of ['barato', NaN, -1, 0]) {
      const d = aplicarDescuento(10176, { total_final: malo })
      expect(d.ok).toBe(false)
    }
  })

  test('un 100% deja el cobro en cero y se rechaza por el tope', () => {
    const d = aplicarDescuento(10176, { porcentaje: 100 })
    expect(d.ok).toBe(false)
  })

  test('sobre un subtotal que no es positivo no se descuenta nada', () => {
    for (const malo of [0, -1, NaN]) {
      const d = aplicarDescuento(malo, { porcentaje: 10 })
      expect(d.ok).toBe(false)
    }
  })

  test('el motivo se recorta: es una etiqueta, no un parrafo', () => {
    const largo = 'x'.repeat(200)
    const d = aplicarDescuento(1000, { porcentaje: 10, motivo: largo })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.motivo.length).toBe(60)
  })

  test('el motivo pierde los saltos de linea', () => {
    const d = aplicarDescuento(1000, { porcentaje: 10, motivo: ' promo\n de\tseptiembre ' })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.motivo).toBe('promo de septiembre')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. EL MENSAJE SALE DE LO SELLADO, NO DE UNA VARIABLE PARALELA
// ═══════════════════════════════════════════════════════════════════════════

test.describe('las cifras del mensaje son las del payload', () => {
  test('`descuentoDelPayload` reconstruye exactamente lo aplicado', () => {
    const aplicado = aplicarDescuento(10176, { porcentaje: 10, motivo: 'promo' })
    if (!aplicado.ok) throw new Error(aplicado.error)
    const reconstruido = descuentoDelPayload(aplicado.subtotal, aplicado.total, 'promo')
    expect(reconstruido.subtotal).toBe(aplicado.subtotal)
    expect(reconstruido.total).toBe(aplicado.total)
    expect(reconstruido.importe).toBe(aplicado.importe)
    expect(reconstruido.porcentaje).toBe(aplicado.porcentaje)
    expect(reconstruido.hay).toBe(true)
  })

  test('con las dos cifras iguales, no reconstruye ningun descuento', () => {
    const d = descuentoDelPayload(10176, 10176)
    expect(d.hay).toBe(false)
    expect(lineasDeDescuento(d)).toEqual([])
  })

  // El modo de fallo que esto cierra: el mensaje ensenaba una cifra y la fila
  // guardaba otra. Se comprueba moviendo el payload SIN tocar nada mas.
  test('si el payload cambia, el mensaje cambia con el', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    if (!d.ok) throw new Error(d.error)
    const r = normalizarVenta({}, contextoVenta({ descuento: d }))
    if (!r.ok) throw new Error(r.error)

    const torcido = { ...r.payload, total_cobrado_real: 1 }
    const mensaje = mensajeDeConfirmacionVenta(
      torcido,
      {
        nombreVendedor: 'CEO Admin',
        nombreComprador: 'Aeropuerto',
        nombreCuentaDestino: 'Efectivo (CEO Admin)',
        desglose: r.desglose
      },
      []
    )
    expect(mensaje).toContain('TOTAL A COBRAR:   $1.00')
    expect(mensaje).not.toContain('$9,158.40')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. LA NOTA DE LA COTIZACION
// ═══════════════════════════════════════════════════════════════════════════

test.describe('la cotizacion deja escrito el descuento', () => {
  test('la nota va en `notas`, antes de lo que haya dictado el modelo', () => {
    const d = aplicarDescuento(10176, { porcentaje: 10 })
    if (!d.ok) throw new Error(d.error)
    const r = normalizarCotizacion({ notas: 'entrega en tienda' }, contextoCotizacion({ descuento: d }))
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.notas).toBe(
      'Descuento 10%: de $10,176.00 a $9,158.40. entrega en tienda'
    )
  })

  test('sin descuento, `notas` es exactamente lo que se dicto', () => {
    const r = normalizarCotizacion({ notas: 'entrega en tienda' }, contextoCotizacion())
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.notas).toBe('entrega en tienda')
  })

  test('sin descuento y sin notas, `notas` queda vacia como siempre', () => {
    const r = normalizarCotizacion({}, contextoCotizacion())
    if (!r.ok) throw new Error(r.error)
    expect(r.payload.notas).toBe('')
  })
})
