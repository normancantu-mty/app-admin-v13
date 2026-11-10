import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  armarBotellasPorCliente,
  cambio,
  desdeDondeLeer,
  LEYENDA_EXCLUSIONES,
  periodosDe,
  presentacionDe,
  SIN_CLIENTE,
  textoBotellas,
  type EntidadBotellas,
  type ProductoBotellas,
  type TicketBotellas
} from '../lib/botellas-cliente'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '../lib/avisos'

/**
 * Pruebas PURAS de "botellas por cliente" (tarjeta del panel + /botellas del
 * bot). Escrito el 2026-11-08 por un ejecutor del Socio. Sin base ni red.
 *
 * Lo que mas importa: las orillas de la semana y del mes en hora de MEXICO. Un
 * ticket del domingo a las 23:59 MX ya es lunes en UTC; si cae en la semana
 * equivocada, la tarjeta miente sin que nada truene.
 */

const ADMIN = 'e-admin'
const DST = 'e-dst'
const LOC1 = 'e-loc1'
const LOC2 = 'e-loc2'
const LOC3 = 'e-loc3'

const ENTIDADES: EntidadBotellas[] = [
  { id: ADMIN, nombre: 'CEO Admin', rol: 'ADMIN' },
  { id: DST, nombre: 'Gilberto', rol: 'DST' },
  { id: LOC1, nombre: 'Aeropuerto', rol: 'LOC' },
  { id: LOC2, nombre: 'Delirio', rol: 'LOC' },
  { id: LOC3, nombre: 'Zacatecano', rol: 'LOC' }
]

const P750 = 'p750'
const P250 = 'p250'
const P50 = 'p50'
const PASTA = 'pasta'
const PRODUCTOS: ProductoBotellas[] = [
  { id: P750, nombre: 'Destilado Plata 750ml' },
  { id: P250, nombre: 'Destilado Plata 250ml' },
  { id: P50, nombre: 'Destilado Plata 50ml' },
  { id: PASTA, nombre: 'Pasta-Guajillo-2kg' }
]

/** Domingo 8 de noviembre de 2026, 12:00 en Mexico (18:00 UTC). */
const AHORA = new Date('2026-11-08T18:00:00Z')

let folio = 0
function ticket(
  fecha: string,
  comprador: string | null,
  lineas: Array<[string, number, number?]>,
  extra: Partial<TicketBotellas> = {}
): TicketBotellas {
  folio++
  return {
    id: `t${folio}`,
    fecha_transaccion: fecha,
    status: 'ACTIVO',
    condicion_pago: 'CONTADO',
    id_comprador: comprador,
    id_vendedor: ADMIN,
    ticket_detalles: lineas.map(([id_producto, cantidad, subtotal]) => ({
      id_producto,
      cantidad,
      subtotal_linea: subtotal ?? cantidad * 100
    })),
    ...extra
  }
}

function armar(tickets: TicketBotellas[], ahora = AHORA) {
  return armarBotellasPorCliente(tickets, ENTIDADES, PRODUCTOS, periodosDe(ahora))
}

const fila = (d: ReturnType<typeof armar>, clave: string) => d.filas.find((f) => f.clave === clave)!

test.describe('botellas por cliente · ventanas en hora de Mexico', () => {
  test('domingo: la semana es lunes 2 a domingo 8; la anterior, 26/10 a 1/11', () => {
    const p = periodosDe(AHORA)
    expect([p.semana.desdeDia, p.semana.hastaDia]).toEqual(['2026-11-02', '2026-11-08'])
    expect([p.semanaAnterior.desdeDia, p.semanaAnterior.hastaDia]).toEqual(['2026-10-26', '2026-11-01'])
    expect([p.mes.desdeDia, p.mes.hastaDia]).toEqual(['2026-11-01', '2026-11-30'])
    expect([p.mesAnterior.desdeDia, p.mesAnterior.hastaDia]).toEqual(['2026-10-01', '2026-10-31'])
    // Mexico es UTC-6 (sin horario de verano desde 2022): la medianoche MX es 06:00 UTC.
    expect(p.semana.desde).toBe('2026-11-02T06:00:00.000Z')
    expect(p.semana.hasta).toBe('2026-11-09T06:00:00.000Z')
    expect(p.mes.hasta).toBe('2026-12-01T06:00:00.000Z')
  })

  test('domingo 23:30 MX (lunes 05:30 UTC) sigue en la semana del domingo', () => {
    const p = periodosDe(new Date('2026-11-09T05:30:00Z'))
    expect(p.semana.desdeDia).toBe('2026-11-02')
  })

  test('lunes 00:00 MX arranca semana nueva', () => {
    const p = periodosDe(new Date('2026-11-09T06:00:00Z'))
    expect([p.semana.desdeDia, p.semana.hastaDia]).toEqual(['2026-11-09', '2026-11-15'])
    expect(p.semanaAnterior.desdeDia).toBe('2026-11-02')
  })

  test('cambio de ano: 31/12 21:00 MX todavia es diciembre; la semana cruza el ano', () => {
    const noche = periodosDe(new Date('2027-01-01T03:00:00Z'))
    expect(noche.mes.desdeDia).toBe('2026-12-01')
    expect(noche.mesAnterior.desdeDia).toBe('2026-11-01')
    const manana = periodosDe(new Date('2027-01-01T12:00:00Z'))
    expect([manana.mes.desdeDia, manana.mes.hastaDia]).toEqual(['2027-01-01', '2027-01-31'])
    expect([manana.mesAnterior.desdeDia, manana.mesAnterior.hastaDia]).toEqual(['2026-12-01', '2026-12-31'])
    expect([manana.semana.desdeDia, manana.semana.hastaDia]).toEqual(['2026-12-28', '2027-01-03'])
  })

  test('febrero bisiesto y no bisiesto', () => {
    expect(periodosDe(new Date('2028-02-15T18:00:00Z')).mes.hastaDia).toBe('2028-02-29')
    expect(periodosDe(new Date('2027-03-10T18:00:00Z')).mesAnterior.hastaDia).toBe('2027-02-28')
  })

  test('se lee desde la ventana mas vieja (aqui el 1 de octubre MX)', () => {
    expect(desdeDondeLeer(periodosDe(AHORA))).toBe('2026-10-01T06:00:00.000Z')
    // Lunes 1 de marzo de 2027: la semana anterior (22/02) cae dentro del mes anterior.
    expect(desdeDondeLeer(periodosDe(new Date('2027-03-01T18:00:00Z')))).toBe('2027-02-01T06:00:00.000Z')
  })

  test('un ticket en la orilla cae en la ventana correcta', () => {
    const d = armar([
      // domingo 1/11 23:59:59 MX -> semana anterior, mes de noviembre
      ticket('2026-11-02T05:59:59Z', LOC1, [[P750, 1]]),
      // lunes 2/11 00:00:00 MX -> semana actual
      ticket('2026-11-02T06:00:00Z', LOC1, [[P750, 10]]),
      // sabado 31/10 23:59 MX -> semana anterior, mes de octubre
      ticket('2026-11-01T05:59:00Z', LOC1, [[P750, 100]]),
      // 30/09 23:00 MX -> fuera de las cuatro ventanas
      ticket('2026-10-01T05:00:00Z', LOC1, [[P750, 1000]])
    ])
    const a = fila(d, LOC1).periodos
    expect(a.semana.botellas).toBe(10)
    expect(a.semanaAnterior.botellas).toBe(101)
    expect(a.mes.botellas).toBe(11)
    expect(a.mesAnterior.botellas).toBe(100)
  })
})

test.describe('botellas por cliente · que cuenta y que no', () => {
  test('los anulados no cuentan, pero se cuentan como excluidos', () => {
    const d = armar([
      ticket('2026-11-05T18:00:00Z', LOC1, [[P750, 5]]),
      ticket('2026-11-05T19:00:00Z', LOC1, [[P750, 7]], { status: 'ANULADO' })
    ])
    expect(fila(d, LOC1).periodos.semana.botellas).toBe(5)
    expect(fila(d, LOC1).periodos.mes.tickets).toBe(1)
    expect(d.excluidas.semana.anulados).toBe(1)
    expect(d.excluidas.mes.anulados).toBe(1)
    expect(d.totalMatriz.mes).toBe(5)
  })

  test('cortesia (subtotal 0) y pasta van aparte, no a botellas', () => {
    const d = armar([ticket('2026-11-05T18:00:00Z', LOC1, [[P750, 3], [P50, 2, 0], [PASTA, 4]])])
    const c = fila(d, LOC1).periodos.mes
    expect(c.botellas).toBe(3)
    expect(c.cortesias).toBe(2)
    expect(c.porPresentacion).toEqual({ '750': 3 })
    expect(d.excluidas.mes.noBotella).toBe(4)
  })

  test('concesion cuenta como botella entregada y se separa de contado', () => {
    const d = armar([
      ticket('2026-11-05T18:00:00Z', LOC1, [[P750, 8], [P250, 12], [P50, 48]], { condicion_pago: 'CONCESION' }),
      ticket('2026-11-06T18:00:00Z', LOC1, [[P750, 2]])
    ])
    const c = fila(d, LOC1).periodos.mes
    expect(c.botellas).toBe(70)
    expect(c.concesion).toBe(68)
    expect(c.contado).toBe(2)
    expect(c.porPresentacion).toEqual({ '750': 10, '250': 12, '50': 48 })
  })
})

test.describe('botellas por cliente · agrupacion y orden', () => {
  test('una fila por local/distribuidor (tambien en cero), sin cliente al final, ordenado por mes', () => {
    const d = armar([
      ticket('2026-11-03T18:00:00Z', LOC2, [[P750, 4]]),
      ticket('2026-11-04T18:00:00Z', DST, [[P750, 9]]),
      ticket('2026-11-05T18:00:00Z', LOC2, [[P250, 6]]),
      ticket('2026-11-05T20:00:00Z', null, [[P750, 1]]),
      ticket('2026-10-10T18:00:00Z', LOC1, [[P750, 3]])
    ])
    expect(d.filas.map((f) => f.clave)).toEqual([LOC2, DST, LOC1, LOC3, SIN_CLIENTE])
    expect(fila(d, LOC2).periodos.mes.botellas).toBe(10)
    expect(fila(d, LOC2).periodos.mes.tickets).toBe(2)
    expect(fila(d, LOC3).periodos.mes.botellas).toBe(0)
    expect(fila(d, SIN_CLIENTE).periodos.mes.botellas).toBe(1)
    // El ADMIN no es cliente: no tiene fila.
    expect(d.filas.some((f) => f.clave === ADMIN)).toBe(false)
    expect(d.presentaciones).toEqual(['750', '250', '50'])
    // Suma de control: todas las filas = total de la matriz (todo lo vendio la matriz).
    expect(d.filas.reduce((a, f) => a + f.periodos.mes.botellas, 0)).toBe(d.totalMatriz.mes)
    expect(d.totalMatriz.mes).toBe(20)
    expect(d.totalMatriz.mesAnterior).toBe(3)
  })

  test('lo que un distribuidor le vende a su local no se suma dos veces al total', () => {
    const d = armar([
      ticket('2026-11-03T18:00:00Z', DST, [[P750, 10]]),
      ticket('2026-11-04T18:00:00Z', LOC1, [[P750, 4]], { id_vendedor: DST })
    ])
    expect(fila(d, DST).periodos.mes.botellas).toBe(10)
    expect(fila(d, LOC1).periodos.mes.botellas).toBe(4)
    expect(d.totalMatriz.mes).toBe(10)
    expect(d.totalEntreNodos.mes).toBe(4)
  })

  test('sin tickets: todas las filas en cero y no aparece "sin cliente"', () => {
    const d = armar([])
    expect(d.filas.map((f) => f.clave).sort()).toEqual([DST, LOC1, LOC2, LOC3].sort())
    expect(d.totalMatriz.mes).toBe(0)
  })
})

test.describe('botellas por cliente · formato', () => {
  test('presentacionDe lee los mililitros del nombre', () => {
    expect(presentacionDe('Destilado Plata 750ml')).toBe('750')
    expect(presentacionDe('Destilado Plata 50 ML')).toBe('50')
    expect(presentacionDe('Pasta-Guajillo-2kg')).toBeNull()
    expect(presentacionDe(null)).toBeNull()
  })

  test('cambio: null si el anterior fue 0, nunca Infinity', () => {
    expect(cambio(10, 0)).toEqual({ dif: 10, pct: null })
    expect(cambio(5, 10)).toEqual({ dif: -5, pct: -50 })
  })

  test('el texto del bot trae semana y mes con su anterior, y junta a los quietos', () => {
    const d = armar([
      ticket('2026-11-05T18:00:00Z', LOC1, [[P750, 8], [P50, 48]], { condicion_pago: 'CONCESION' }),
      ticket('2026-10-28T18:00:00Z', LOC1, [[P750, 2]])
    ])
    const t = textoBotellas(d)
    expect(t).toContain('Semana 02/11–08/11 vs 26/10–01/11')
    expect(t).toContain('Mes noviembre 2026 vs octubre 2026')
    expect(t).toContain('Aeropuerto · LOC')
    expect(t).toContain('semana 56 (antes 2, +54) · mes 56 (antes 2, +54)')
    expect(t).toContain('mes: 750ml 8 · 50ml 48 · 56 en concesion')
    expect(t).toContain('Total que salio de la matriz: semana 56 (antes 2) · mes 56 (antes 2)')
    expect(t).toContain('Sin botellas en las 4 ventanas (3): ')
    expect(t).toContain(LEYENDA_EXCLUSIONES)
    expect(LEYENDA_EXCLUSIONES).toMatch(/cortes[ií]as/)
    expect(LEYENDA_EXCLUSIONES).toContain('pasta')
    expect(t).not.toContain('NaN')
  })

  test('el centinela PENDIENTE DE ASIGNAR no es local: sin fila propia, sus tickets van a "Sin cliente", no cuenta entre los quietos', () => {
    // En produccion nace con rol LOC (lib/avisos.ts); aqui igual.
    const entidades: EntidadBotellas[] = [...ENTIDADES, { id: ENTIDAD_PENDIENTE_DE_ASIGNAR, nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' }]
    const d = armarBotellasPorCliente(
      [
        ticket('2026-11-05T18:00:00Z', ENTIDAD_PENDIENTE_DE_ASIGNAR, [[P750, 4]]),
        ticket('2026-11-05T18:00:00Z', null, [[P50, 3]]),
        ticket('2026-11-05T18:00:00Z', LOC1, [[P250, 2]])
      ],
      entidades,
      PRODUCTOS,
      periodosDe(AHORA)
    )
    expect(d.filas.find((f) => f.clave === ENTIDAD_PENDIENTE_DE_ASIGNAR)).toBeUndefined()
    const sin = d.filas.find((f) => f.clave === SIN_CLIENTE)!
    expect(sin.nombre).toBe('Sin cliente / pendiente de asignar')
    expect(sin.periodos.semana.botellas).toBe(7)
    expect(sin.periodos.mes.porPresentacion).toEqual({ '750': 4, '50': 3 })
    expect(d.totalMatriz.mes).toBe(9)
    // Filas: DST + 3 LOC + sin cliente; el centinela no suma una mas.
    expect(d.filas.length).toBe(5)
    const t = textoBotellas(d)
    // Quietos: Gilberto, Delirio, Zacatecano (3); el centinela no entra.
    expect(t).toContain('Sin botellas en las 4 ventanas (3): ')
    expect(t).not.toContain('PENDIENTE DE ASIGNAR')
  })
})

test.describe('botellas por cliente · una sola fuente', () => {
  const RAIZ = path.resolve(__dirname, '..')
  const leer = (r: string) => readFileSync(path.join(RAIZ, r), 'utf8')

  test('la tarjeta del panel y la ruta del bot salen de la MISMA lectura', () => {
    const panel = leer('app/panel/_panel/PanelMando.tsx')
    const ruta = leer('app/api/bot/botellas/route.ts')
    expect(panel).toContain('leerBotellasPorCliente(client)')
    expect(panel).toContain('<CardBotellas')
    // Aislada: un error de esta lectura pinta el aviso en la tarjeta y no tumba el panel.
    expect(panel).toMatch(/leerBotellasPorCliente\(client\)\.then\(\s*\(datos\) => \(\{ datos, error: undefined/)
    expect(panel).toContain('error={botellasCliente.error}')
    const tarjeta = leer('components/v2/panel/CardBotellas.tsx')
    expect(tarjeta).toContain('if (!datos)')
    expect(tarjeta).toContain('card-botellas-error')
    expect(tarjeta).toContain('{LEYENDA_EXCLUSIONES}')
    expect(ruta).toContain('leerBotellasPorCliente(supabase)')
    expect(ruta).toContain('textoBotellas(datos)')
    // Ninguna de las dos arma su propio query de tickets.
    expect(ruta).not.toContain("from('transacciones_tickets')")
  })

  test('el bot tiene el comando y la ruta es de solo lectura en ensayo', () => {
    const bot = leer('bot/bot_gastos.py')
    expect(bot).toContain('CommandHandler("botellas", comando_botellas)')
    expect(bot).toContain('_post("/api/bot/botellas"')
    expect(bot).toMatch(/RUTAS_SOLO_LECTURA = frozenset\([\s\S]*"\/api\/bot\/botellas"[\s\S]*?\)\)/)
  })
})
