import { test, expect } from '@playwright/test'
import {
  aCentavos,
  ajusteTraspasoDstALocal,
  baseDesdePrecioPublico,
  comision,
  deudaPorEntrega,
  precioParaNodo,
  techoAPesoEntero
} from '../lib/reglas-comerciales'

/**
 * Pruebas puramente aritmeticas de `lib/reglas-comerciales.ts`: sin base de
 * datos, sin red, sin navegador.
 *
 * Los numeros salen de `Claude/Fresnillo/ERP_Fresnillo/REGLAS_COMERCIALES.md`
 * (Norman, 2026-09-02) y de los tickets reales de David Flores leidos de
 * Supabase el 2026-09-02. Si una prueba de aqui se pone en rojo, el que esta
 * mal es el codigo, no el numero.
 */

// Precios publicos de `listas_precios`, zona Zacatecas (verificado 2026-09-02).
const PP_750 = 599
const PP_250 = 179
const PP_50 = 69

// Porcentajes de David Flores en `entidades` (verificado 2026-09-02).
const DAVID_BASE = 0.2
const DAVID_RED = 0.15
const LOCAL_DE_DAVID = 0.15

test.describe('centavos: el redondeo sube al peso, no al centavo', () => {
  test('techoAPesoEntero es el Math.ceil de aplica_redondeo_costo', () => {
    expect(techoAPesoEntero(aCentavos(479.2))).toBe(48000) // $479.20 -> $480
    expect(techoAPesoEntero(aCentavos(479.01))).toBe(48000)
    expect(techoAPesoEntero(aCentavos(480))).toBe(48000) // exacto no sube
  })
})

test.describe('baseDesdePrecioPublico: solo la cuenta fiscal divide entre 1.7748', () => {
  test('en efectivo la Base es el precio publico', () => {
    expect(baseDesdePrecioPublico(PP_750, false)).toBe(599)
    expect(baseDesdePrecioPublico(PP_250, false)).toBe(179)
    expect(baseDesdePrecioPublico(PP_50, false)).toBe(69)
  })

  test('en Cuenta Fresnillo la Base es PP / 1.7748', () => {
    // REGLAS_COMERCIALES.md, escenario B: Base de $599 es $337.50.
    expect(baseDesdePrecioPublico(PP_750, true)).toBe(337.5)
    expect(baseDesdePrecioPublico(PP_250, true)).toBe(100.86)
    expect(baseDesdePrecioPublico(PP_50, true)).toBe(38.88)
  })

  test('Base + IEPS + IVA reconstruyen el precio publico', () => {
    const base = baseDesdePrecioPublico(PP_750, true)
    const ieps = base * 0.53
    const iva = (base + ieps) * 0.16
    expect(base + ieps + iva).toBeCloseTo(PP_750, 1)
  })
})

test.describe('comision: siempre % x Base, nunca % x PP', () => {
  test('escenario A — 750 ml en efectivo, 20%: $119.80', () => {
    expect(comision(PP_750, DAVID_BASE, false)).toBe(119.8)
  })

  test('escenario B — 750 ml a Cuenta Fresnillo, 20%: $67.50 y no $119.80', () => {
    // Esta es LA regla nueva. El impuesto lo absorbe la empresa, no se le
    // regala al distribuidor.
    expect(comision(PP_750, DAVID_BASE, true)).toBe(67.5)
    expect(comision(PP_750, DAVID_BASE, true)).not.toBe(119.8)
  })

  test('la comision fiscal es exactamente la de efectivo dividida entre 1.7748', () => {
    const efectivo = comision(PP_750, DAVID_BASE, false)
    const fiscal = comision(PP_750, DAVID_BASE, true)
    expect(fiscal).toBeCloseTo(efectivo / 1.7748, 2)
  })

  test('un porcentaje fuera de [0,1] es un error, no un 2000%', () => {
    expect(() => comision(PP_750, 20, false)).toThrow(/decimal entre 0 y 1/)
    expect(() => comision(PP_750, -0.1, false)).toThrow(/decimal entre 0 y 1/)
  })
})

test.describe('precioParaNodo: los tres SKU que Norman usa a diario', () => {
  test('en efectivo al 20%, con techo: 599->480, 179->144, 69->56', () => {
    expect(precioParaNodo(PP_750, DAVID_BASE, false, true)).toBe(480)
    expect(precioParaNodo(PP_250, DAVID_BASE, false, true)).toBe(144)
    expect(precioParaNodo(PP_50, DAVID_BASE, false, true)).toBe(56)
  })

  test('sin techo queda el 80% exacto', () => {
    expect(precioParaNodo(PP_750, DAVID_BASE, false, false)).toBe(479.2)
    expect(precioParaNodo(PP_250, DAVID_BASE, false, false)).toBe(143.2)
    expect(precioParaNodo(PP_50, DAVID_BASE, false, false)).toBe(55.2)
  })

  test('a Cuenta Fresnillo el precio SUBE, porque la comision baja', () => {
    // El sistema de hoy cobra $480 tambien aqui. Esa es la brecha.
    expect(precioParaNodo(PP_750, DAVID_BASE, true, true)).toBe(532)
    expect(precioParaNodo(PP_250, DAVID_BASE, true, true)).toBe(159)
    expect(precioParaNodo(PP_50, DAVID_BASE, true, true)).toBe(62)
  })
})

test.describe('deudaPorEntrega: los tres escenarios de REGLAS_COMERCIALES.md', () => {
  test('A · David vende directo, efectivo, 750 ml @ $599', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'DST',
      porcentajes: { base: DAVID_BASE, red: DAVID_RED },
      esCuentaFiscal: false,
      aplicaRedondeo: true
    })

    expect(r.base).toBe(599)
    expect(r.comisiones.base).toBe(119.8)
    expect(r.comisiones.red).toBe(0) // nunca cobra las dos
    expect(r.precioUnitario).toBe(480)
    expect(r.deuda).toBe(480)
  })

  test('B · David vende directo, Cuenta Fresnillo, 750 ml @ $599', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'DST',
      porcentajes: { base: DAVID_BASE, red: DAVID_RED },
      esCuentaFiscal: true,
      aplicaRedondeo: true
    })

    expect(r.base).toBe(337.5)
    expect(r.comisiones.base).toBe(67.5)
    expect(r.deuda).toBe(532)
  })

  test('B sin techo da los $531.50 del documento', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'DST',
      porcentajes: { base: DAVID_BASE },
      esCuentaFiscal: true,
      aplicaRedondeo: false
    })

    expect(r.deuda).toBe(531.5)
  })

  test('C · vende su local, efectivo: local $89.85 + red $89.85, Matriz $419.30', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'LOC',
      porcentajes: { base: DAVID_BASE, red: DAVID_RED, local: LOCAL_DE_DAVID },
      esCuentaFiscal: false,
      aplicaRedondeo: false
    })

    expect(r.comisiones.local).toBe(89.85)
    expect(r.comisiones.red).toBe(89.85)
    expect(r.comisiones.base).toBe(0) // el DST no cobra base cuando vende su local
    expect(r.comisionTotalUnitaria).toBe(179.7)
    expect(r.deuda).toBe(419.3)
  })

  test('C con techo sube a $420: la cadena entrega 30% y a Matriz le queda el 70%', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'LOC',
      porcentajes: { red: DAVID_RED, local: LOCAL_DE_DAVID },
      esCuentaFiscal: false,
      aplicaRedondeo: true
    })

    expect(r.deuda).toBe(420)
    // 30% entregado, 70% para Matriz (antes del techo).
    expect(419.3 / PP_750).toBeCloseTo(0.7, 4)
  })

  test('la cantidad multiplica el precio unitario ya redondeado', () => {
    const r = deudaPorEntrega({
      pp: PP_750,
      cantidad: 12,
      rolComprador: 'DST',
      porcentajes: { base: DAVID_BASE },
      esCuentaFiscal: false,
      aplicaRedondeo: true
    })

    expect(r.deuda).toBe(5760) // 12 x 480, igual que el ticket real
  })
})

test.describe('ajusteTraspasoDstALocal: el −10% x Base de la opcion (i)', () => {
  test('15% + 15% − 20% = 10% x Base, en efectivo: $59.90 por botella', () => {
    const ajuste = ajusteTraspasoDstALocal({
      pp: PP_750,
      comisionLocal: LOCAL_DE_DAVID,
      comisionRed: DAVID_RED,
      comisionBase: DAVID_BASE,
      esCuentaFiscal: false
    })

    expect(ajuste).toBe(59.9)
    expect(ajuste).toBeCloseTo(0.1 * PP_750, 2)
  })

  test('el ajuste cierra la aritmetica: 80% − 10% = 70%', () => {
    const deudaAl80 = deudaPorEntrega({
      pp: PP_750,
      cantidad: 1,
      rolComprador: 'DST',
      porcentajes: { base: DAVID_BASE },
      esCuentaFiscal: false,
      aplicaRedondeo: false
    }).deuda
    const ajuste = ajusteTraspasoDstALocal({
      pp: PP_750,
      comisionLocal: LOCAL_DE_DAVID,
      comisionRed: DAVID_RED,
      comisionBase: DAVID_BASE,
      esCuentaFiscal: false
    })

    expect(deudaAl80 - ajuste).toBe(419.3)
  })

  test('en Cuenta Fresnillo el mismo 10% se calcula sobre la Base', () => {
    const ajuste = ajusteTraspasoDstALocal({
      pp: PP_750,
      comisionLocal: LOCAL_DE_DAVID,
      comisionRed: DAVID_RED,
      comisionBase: DAVID_BASE,
      esCuentaFiscal: true
    })

    expect(ajuste).toBe(33.75) // 10% de $337.50
  })

  test('un local al 20% invierte el signo: la cadena entrega 35%, no 30%', () => {
    // `Delirio 85`, `Casa Verde`, `Aeropuerto` y `Nuevo Ideal` tienen
    // comision_base_local = 0.20 en la base de datos. Con ellos el ajuste ya no
    // es −10%: es +15%, y a la Matriz le queda el 65%, no el 70%.
    const ajuste = ajusteTraspasoDstALocal({
      pp: PP_750,
      comisionLocal: 0.2,
      comisionRed: DAVID_RED,
      comisionBase: DAVID_BASE,
      esCuentaFiscal: false
    })

    expect(ajuste).toBe(89.85) // 15% de $599
  })

  test('la cantidad multiplica el ajuste unitario', () => {
    const ajuste = ajusteTraspasoDstALocal({
      pp: PP_750,
      comisionLocal: LOCAL_DE_DAVID,
      comisionRed: DAVID_RED,
      comisionBase: DAVID_BASE,
      esCuentaFiscal: false,
      cantidad: 12
    })

    expect(ajuste).toBe(718.8)
  })
})

// ─── GOLDEN TEST — tickets reales de David Flores ────────────────────────────
//
// 9 tickets de consignacion, 20 lineas de detalle (el prompt decia 21; la
// lectura de Supabase del 2026-09-02 devuelve 20). SIETE tickets entraron por
// `Efectivo` (16 lineas) y DOS por `Cuenta Fresnillo` (4 lineas).
//
// id_comprador = f0443423-60a0-4156-9bcd-52394ae274fe

interface LineaTicket {
  ml: 750 | 250 | 50
  cantidad: number
  /** `ticket_detalles.precio_unitario` tal como esta hoy en la base. */
  cobrado: number
}

interface TicketGolden {
  id: string
  fecha: string
  cuentaFiscal: boolean
  lineas: LineaTicket[]
  /** `transacciones_tickets.total_cobrado_real` de hoy. */
  totalReal: number
  /** `transacciones_tickets.monto_base_ingreso` de hoy: lo que el perfil usa como deuda. */
  montoBaseIngreso: number
}

const PP_POR_ML: Record<750 | 250 | 50, number> = { 750: PP_750, 250: PP_250, 50: PP_50 }

const TICKETS_DAVID: TicketGolden[] = [
  {
    id: '9b9c3570',
    fecha: '2026-05-23',
    cuentaFiscal: false,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 },
      { ml: 50, cantidad: 24, cobrado: 56 }
    ],
    totalReal: 8832,
    montoBaseIngreso: 8832
  },
  {
    id: '6444058e',
    fecha: '2026-06-09',
    cuentaFiscal: false,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 }
    ],
    totalReal: 7488,
    montoBaseIngreso: 7488
  },
  {
    id: 'a83054d0',
    fecha: '2026-06-16',
    cuentaFiscal: true,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 }
    ],
    totalReal: 7488,
    montoBaseIngreso: 4219.07
  },
  {
    id: 'e9314112',
    fecha: '2026-07-22',
    cuentaFiscal: false,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 },
      { ml: 50, cantidad: 24, cobrado: 56 }
    ],
    totalReal: 8832,
    montoBaseIngreso: 8832
  },
  {
    id: '5fcc3b58',
    fecha: '2026-07-22',
    cuentaFiscal: false,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 }
    ],
    totalReal: 7488,
    montoBaseIngreso: 7488
  },
  {
    id: 'fe71145b',
    fecha: '2026-07-31',
    cuentaFiscal: false,
    lineas: [
      { ml: 750, cantidad: 12, cobrado: 480 },
      { ml: 250, cantidad: 12, cobrado: 144 }
    ],
    totalReal: 7488,
    montoBaseIngreso: 7488
  },
  {
    id: '88615f9f',
    fecha: '2026-08-01',
    cuentaFiscal: false,
    lineas: [
      { ml: 50, cantidad: 20, cobrado: 56 },
      { ml: 250, cantidad: 1, cobrado: 144 },
      { ml: 750, cantidad: 6, cobrado: 480 }
    ],
    totalReal: 4144,
    montoBaseIngreso: 4144
  },
  {
    id: '8fdb213c',
    fecha: '2026-08-01',
    cuentaFiscal: true,
    lineas: [
      { ml: 250, cantidad: 12, cobrado: 144 },
      { ml: 50, cantidad: 24, cobrado: 56 }
    ],
    totalReal: 3072,
    montoBaseIngreso: 1730.9
  },
  {
    id: '607b56ac',
    fecha: '2026-08-05',
    cuentaFiscal: false,
    lineas: [{ ml: 250, cantidad: 22, cobrado: 144 }],
    totalReal: 3168,
    montoBaseIngreso: 3168
  }
]

/** Precio unitario que la regla manda cobrarle a David por un SKU. */
function precioSegunRegla(linea: LineaTicket, cuentaFiscal: boolean): number {
  return precioParaNodo(PP_POR_ML[linea.ml], DAVID_BASE, cuentaFiscal, true)
}

test.describe('GOLDEN · los 7 tickets en Efectivo: la regla reproduce lo cobrado', () => {
  const enEfectivo = TICKETS_DAVID.filter((t) => !t.cuentaFiscal)

  test('son 7 tickets y 16 lineas', () => {
    expect(enEfectivo).toHaveLength(7)
    expect(enEfectivo.reduce((n, t) => n + t.lineas.length, 0)).toBe(16)
  })

  for (const ticket of enEfectivo) {
    test(`ticket ${ticket.id} (${ticket.fecha}) linea por linea`, () => {
      for (const linea of ticket.lineas) {
        expect(precioSegunRegla(linea, false)).toBe(linea.cobrado)
      }
    })
  }

  test('los tres precios de memoria: 750->480, 250->144, 50->56', () => {
    expect(precioParaNodo(PP_750, DAVID_BASE, false, true)).toBe(480)
    expect(precioParaNodo(PP_250, DAVID_BASE, false, true)).toBe(144)
    expect(precioParaNodo(PP_50, DAVID_BASE, false, true)).toBe(56)
  })

  test('el total de cada ticket en efectivo cuadra al peso', () => {
    for (const ticket of enEfectivo) {
      const total = ticket.lineas.reduce(
        (suma, linea) => suma + precioSegunRegla(linea, false) * linea.cantidad,
        0
      )
      expect(total).toBe(ticket.totalReal)
    }
  })

  test('en efectivo monto_base_ingreso ya es igual a la deuda correcta', () => {
    for (const ticket of enEfectivo) {
      expect(ticket.montoBaseIngreso).toBe(ticket.totalReal)
    }
  })
})

test.describe('GOLDEN · los 2 tickets fiscales NO cuadran con la regla', () => {
  const fiscales = TICKETS_DAVID.filter((t) => t.cuentaFiscal)

  const totalSegunRegla = (ticket: TicketGolden) =>
    ticket.lineas.reduce(
      (suma, linea) => suma + precioSegunRegla(linea, true) * linea.cantidad,
      0
    )

  test('son 2 tickets y 4 lineas', () => {
    expect(fiscales).toHaveLength(2)
    expect(fiscales.reduce((n, t) => n + t.lineas.length, 0)).toBe(4)
  })

  test('a83054d0 (2026-06-16): hoy $7,488, la regla dice $8,292', () => {
    const ticket = fiscales.find((t) => t.id === 'a83054d0')!

    // Hoy: 12 x 480 + 12 x 144. Cobra el 20% sobre el precio PUBLICO.
    expect(ticket.totalReal).toBe(7488)
    // La regla: 12 x 532 + 12 x 159. El 20% sale de la Base.
    expect(precioSegunRegla({ ml: 750, cantidad: 12, cobrado: 480 }, true)).toBe(532)
    expect(precioSegunRegla({ ml: 250, cantidad: 12, cobrado: 144 }, true)).toBe(159)
    expect(totalSegunRegla(ticket)).toBe(8292)
    expect(totalSegunRegla(ticket) - ticket.totalReal).toBe(804) // cobrado de menos
  })

  test('8fdb213c (2026-08-01): hoy $3,072, la regla dice $3,396', () => {
    const ticket = fiscales.find((t) => t.id === '8fdb213c')!

    expect(ticket.totalReal).toBe(3072)
    // 12 x 159 (250 ml) + 24 x 62 (50 ml) = 1908 + 1488
    expect(precioSegunRegla({ ml: 250, cantidad: 12, cobrado: 144 }, true)).toBe(159)
    expect(precioSegunRegla({ ml: 50, cantidad: 24, cobrado: 56 }, true)).toBe(62)
    expect(totalSegunRegla(ticket)).toBe(3396)
    expect(totalSegunRegla(ticket) - ticket.totalReal).toBe(324)
  })

  test('el doble descuento: monto_base_ingreso es aun mas bajo que lo cobrado', () => {
    // El precio ya venia descontado 20% del PUBLICO, y despues el motor fiscal
    // lo vuelve a dividir entre 1.7748 para `monto_base_ingreso` — que es el
    // numero que `lib/distribuidores-saldos.ts` usa como deuda del DST.
    for (const ticket of fiscales) {
      expect(ticket.montoBaseIngreso).toBeLessThan(ticket.totalReal)
      expect(ticket.montoBaseIngreso).toBeLessThan(totalSegunRegla(ticket))
    }

    const a83054d0 = fiscales.find((t) => t.id === 'a83054d0')!
    expect(a83054d0.montoBaseIngreso).toBe(4219.07)
    // Brecha real contra la regla, no contra lo cobrado:
    expect(totalSegunRegla(a83054d0) - a83054d0.montoBaseIngreso).toBeCloseTo(4072.93, 2)

    const _8fdb213c = fiscales.find((t) => t.id === '8fdb213c')!
    expect(_8fdb213c.montoBaseIngreso).toBe(1730.9)
    expect(totalSegunRegla(_8fdb213c) - _8fdb213c.montoBaseIngreso).toBeCloseTo(1665.1, 2)
  })
})

test.describe('GOLDEN · impacto en el saldo de David Flores', () => {
  test('deuda de los 9 tickets: hoy $53,389.97, con la regla $59,128', () => {
    const hoy = TICKETS_DAVID.reduce((suma, t) => suma + t.montoBaseIngreso, 0)
    const segunRegla = TICKETS_DAVID.reduce(
      (suma, t) =>
        suma +
        t.lineas.reduce(
          (sub, linea) => sub + precioSegunRegla(linea, t.cuentaFiscal) * linea.cantidad,
          0
        ),
      0
    )

    expect(hoy).toBeCloseTo(53389.97, 2)
    expect(segunRegla).toBe(59128)
    expect(segunRegla - hoy).toBeCloseTo(5738.03, 2)
  })
})
