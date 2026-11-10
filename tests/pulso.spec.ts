import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  armarCobertura,
  armarPulso,
  armarSinSurtir,
  LEYENDA_PULSO,
  textoPulso,
  UMBRAL_DIAS_SIN_SURTIR,
  type EntradaPulso,
  type EntregaPulso,
  type StockPulso
} from '../lib/pulso'
import type { EntidadBotellas, ProductoBotellas, TicketBotellas } from '../lib/botellas-cliente'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '../lib/avisos'

/**
 * Pruebas PURAS del "Pulso" (tarjeta del panel + /pulso del bot). Escrito el
 * 2026-11-08 por un ejecutor del Socio. Sin base ni red.
 *
 * Lo que mas importa: (1) la ventana del ritmo se recorta al arranque, si no el
 * ritmo sale 28 / 11.87 = 2.36 veces mas bajo con la historia de hoy; (2) "dias sin surtir"
 * cuenta dias de calendario en hora de MEXICO y no confunde una cortesia, una
 * entrega de pasta o un ticket anulado con una compra.
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
  { id: LOC3, nombre: 'Zacatecano', rol: 'LOC' },
  { id: ENTIDAD_PENDIENTE_DE_ASIGNAR, nombre: 'PENDIENTE DE ASIGNAR', rol: 'LOC' }
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
    ticket_detalles: lineas.map(([id_producto, cantidad, subtotal]) => ({ id_producto, cantidad, subtotal_linea: subtotal ?? cantidad * 100 })),
    ...extra
  }
}

const stockMatriz = (m: Record<string, number>): StockPulso[] =>
  Object.entries(m).map(([id_producto, stock]) => ({ id_entidad: ADMIN, id_producto, producto: null, stock }))

const entrega = (destino: string, fecha: string, producto = P750, status = 'ACTIVO'): EntregaPulso => ({
  id_entidad_destino: destino,
  id_producto: producto,
  fecha_movimiento: fecha,
  status
})

function entrada(p: Partial<EntradaPulso>): EntradaPulso {
  return { tickets: [], entidades: ENTIDADES, productos: PRODUCTOS, stock: [], entregas: [], corte: null, ...p }
}

const filaCob = (c: ReturnType<typeof armarCobertura>, ml: string) => c.filas.find((f) => f.presentacion === ml)!
const cliente = (s: ReturnType<typeof armarSinSurtir>, id: string) => [...s.filas, ...s.nunca].find((f) => f.id === id)!

test.describe('pulso · cobertura de producto terminado', () => {
  test('sin corte: ventana de 28 dias; semanas = stock / (vendidas / 4)', () => {
    const c = armarCobertura(
      entrada({
        stock: stockMatriz({ [P750]: 40, [P250]: 10, [P50]: 0 }),
        tickets: [ticket('2026-10-20T18:00:00Z', LOC1, [[P750, 20], [P250, 8]]), ticket('2026-11-01T18:00:00Z', null, [[P750, 20]])]
      }),
      AHORA
    )
    expect(c.recortadaAlArranque).toBe(false)
    expect(c.dias).toBeCloseTo(28, 9)
    expect(filaCob(c, '750')).toMatchObject({ stock: 40, vendidas: 40, porSemana: 10, semanas: 4, reponer: false })
    expect(filaCob(c, '250')).toMatchObject({ stock: 10, vendidas: 8, porSemana: 2, semanas: 5, reponer: false })
    // 50 ml: sin ventas en la ventana -> no hay semanas (no Infinity), y no se pide reponer.
    expect(filaCob(c, '50')).toMatchObject({ stock: 0, vendidas: 0, porSemana: 0, semanas: null, reponer: false })
    expect(c.filas.map((f) => f.presentacion)).toEqual(['750', '250', '50'])
  })

  test('el arranque recorta la ventana: 14 dias de historia, el ritmo se divide entre 2 semanas, no entre 4', () => {
    const c = armarCobertura(
      entrada({ corte: '2026-10-25T18:00:00Z', stock: stockMatriz({ [P750]: 3 }), tickets: [ticket('2026-11-02T18:00:00Z', LOC1, [[P750, 10]])] }),
      AHORA
    )
    expect(c.recortadaAlArranque).toBe(true)
    expect(c.dias).toBeCloseTo(14, 9)
    expect(filaCob(c, '750').porSemana).toBeCloseTo(5, 9)
    expect(filaCob(c, '750').semanas).toBeCloseTo(0.6, 9)
    expect(filaCob(c, '750').reponer).toBe(true)
  })

  test('orilla del umbral: exactamente 2 semanas NO es reponer; 1.99 si', () => {
    const base = { tickets: [ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 28]])] }
    expect(filaCob(armarCobertura(entrada({ ...base, stock: stockMatriz({ [P750]: 14 }) }), AHORA), '750')).toMatchObject({ semanas: 2, reponer: false })
    const c = armarCobertura(entrada({ ...base, stock: stockMatriz({ [P750]: 13.93 }) }), AHORA)
    expect(filaCob(c, '750').reponer).toBe(true)
  })

  test('agotado con ventas -> 0 semanas y reponer', () => {
    const c = armarCobertura(entrada({ stock: [], tickets: [ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 5]])] }), AHORA)
    expect(filaCob(c, '750')).toMatchObject({ stock: 0, semanas: 0, reponer: true })
  })

  test('menos de 7 dias de historia: sin ritmo, sin semanas, sin alerta', () => {
    const c = armarCobertura(
      entrada({ corte: '2026-11-03T18:00:00Z', stock: stockMatriz({ [P750]: 1 }), tickets: [ticket('2026-11-05T18:00:00Z', LOC1, [[P750, 50]])] }),
      AHORA
    )
    expect(c.historiaInsuficiente).toBe(true)
    expect(filaCob(c, '750')).toMatchObject({ vendidas: 50, porSemana: null, semanas: null, reponer: false })
  })

  test('no cuentan: anulados, cortesias (aparte), pasta, ventas de un DST, ni lo de fuera de la ventana; stock de un DST tampoco', () => {
    const c = armarCobertura(
      entrada({
        stock: [...stockMatriz({ [P750]: 10, [PASTA]: 99 }), { id_entidad: DST, id_producto: P750, producto: null, stock: 500 }],
        tickets: [
          ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 7]]),
          ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 100]], { status: 'ANULADO' }),
          ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 3, 0], [PASTA, 9]]),
          ticket('2026-11-01T18:00:00Z', LOC2, [[P750, 40]], { id_vendedor: DST }),
          ticket('2026-10-10T18:00:00Z', LOC1, [[P750, 60]]),
          ticket('2026-11-08T18:00:01Z', LOC1, [[P750, 60]])
        ]
      }),
      AHORA
    )
    expect(filaCob(c, '750')).toMatchObject({ stock: 10, vendidas: 7 })
    expect(c.cortesiasFuera).toBe(3)
    expect(c.filas.some((f) => f.presentacion === 'pasta')).toBe(false)
  })
})

test.describe('pulso · dias sin surtir', () => {
  test('la ultima vez gana: ticket o entrega a concesion; empate -> ticket; dias de calendario MX', () => {
    const s = armarSinSurtir(
      entrada({
        // 2026-11-05 03:29 UTC = 4 de noviembre 21:29 en Mexico -> 4 dias al domingo 8.
        tickets: [ticket('2026-11-05T03:29:32Z', LOC1, [[P750, 8]], { condicion_pago: 'CONCESION' })],
        entregas: [
          entrega(LOC1, '2026-10-28T05:59:00Z'),
          entrega(LOC1, '2026-11-05T03:29:32Z'),
          // 2026-10-28 05:59 UTC = 27 de octubre 23:59 MX -> 12 dias, no 11.
          entrega(LOC2, '2026-10-28T05:59:00Z')
        ]
      }),
      AHORA
    )
    expect(cliente(s, LOC1)).toMatchObject({ fuente: 'ticket', dias: 4, compras: 1, ritmo: null, umbral: UMBRAL_DIAS_SIN_SURTIR, atrasado: false })
    expect(cliente(s, LOC2)).toMatchObject({ fuente: 'entrega', dias: 12, compras: 0, atrasado: false })
  })

  test('orilla del umbral fijo: 21 dias no es atrasado, 22 si', () => {
    const s = armarSinSurtir(
      entrada({
        entregas: [entrega(LOC1, '2026-10-18T18:00:00Z'), entrega(LOC2, '2026-10-17T18:00:00Z')]
      }),
      AHORA
    )
    expect(cliente(s, LOC1)).toMatchObject({ dias: 21, atrasado: false })
    expect(cliente(s, LOC2)).toMatchObject({ dias: 22, atrasado: true })
    expect(s.atrasados).toBe(1)
    // Atrasados primero.
    expect(s.filas[0].id).toBe(LOC2)
  })

  test('ritmo propio con 3+ compras en dias distintos (mediana); dos tickets el mismo dia son una compra', () => {
    const s = armarSinSurtir(
      entrada({
        tickets: [
          ticket('2026-10-12T18:00:00Z', LOC1, [[P750, 1]]),
          ticket('2026-10-19T18:00:00Z', LOC1, [[P750, 1]]),
          ticket('2026-10-19T20:00:00Z', LOC1, [[P750, 1]]),
          ticket('2026-10-26T18:00:00Z', LOC1, [[P750, 1]]),
          // LOC2: solo 2 compras -> sin ritmo, umbral fijo.
          ticket('2026-10-26T18:00:00Z', LOC2, [[P750, 1]]),
          ticket('2026-11-02T18:00:00Z', LOC2, [[P750, 1]])
        ]
      }),
      AHORA
    )
    // LOC1 compra cada 7 dias; van 13 desde el 26/10 -> atrasado aunque no llegue a 21.
    expect(cliente(s, LOC1)).toMatchObject({ compras: 3, ritmo: 7, umbral: 7, dias: 13, atrasado: true })
    expect(cliente(s, LOC2)).toMatchObject({ compras: 2, ritmo: null, umbral: 21, dias: 6, atrasado: false })
  })

  test('no es surtir: ticket anulado, ticket solo de cortesias o de pasta, entrega anulada o de pasta, futuro', () => {
    const s = armarSinSurtir(
      entrada({
        tickets: [
          ticket('2026-11-07T18:00:00Z', LOC1, [[P750, 5]], { status: 'ANULADO' }),
          ticket('2026-11-07T18:00:00Z', LOC1, [[P750, 2, 0]]),
          ticket('2026-11-07T18:00:00Z', LOC1, [[PASTA, 2]]),
          ticket('2026-11-09T18:00:00Z', LOC1, [[P750, 2]])
        ],
        entregas: [
          entrega(LOC1, '2026-11-06T18:00:00Z', P750, 'ANULADO'),
          entrega(LOC1, '2026-11-06T18:00:00Z', PASTA),
          entrega(LOC1, '2026-10-01T18:00:00Z')
        ]
      }),
      AHORA
    )
    expect(cliente(s, LOC1)).toMatchObject({ fuente: 'entrega', dias: 38, compras: 0, atrasado: true })
  })

  test('universo canonico del ledger: entrega ACTIVO o APPROVED cuenta; NULL, PENDIENTE o ANULADO no', () => {
    const s = armarSinSurtir(
      entrada({
        entregas: [
          entrega(LOC1, '2026-11-06T18:00:00Z', P750, 'APPROVED'),
          entrega(LOC2, '2026-11-06T18:00:00Z', P750, 'PENDIENTE'),
          { ...entrega(LOC2, '2026-11-05T18:00:00Z'), status: null },
          entrega(LOC2, '2026-10-30T18:00:00Z')
        ]
      }),
      AHORA
    )
    expect(cliente(s, LOC1)).toMatchObject({ fuente: 'entrega', dias: 2 })
    expect(cliente(s, LOC2)).toMatchObject({ fuente: 'entrega', dias: 9 })
  })

  test('la carga inicial (entrega en el arranque o antes) se rotula "desde el arranque (>=N d)"; atrasado igual', () => {
    const corte = '2026-10-10T18:00:00Z'
    const p = armarPulso(
      entrada({
        corte,
        tickets: [ticket('2026-11-01T18:00:00Z', LOC3, [[P750, 1]])],
        entregas: [entrega(LOC1, corte), entrega(LOC2, '2026-10-11T18:00:00Z'), entrega(DST, '2026-10-01T18:00:00Z')]
      }),
      AHORA
    )
    const s = p.sinSurtir
    expect(cliente(s, LOC1)).toMatchObject({ dias: 29, desdeArranque: true, atrasado: true })
    expect(cliente(s, DST)).toMatchObject({ dias: 38, desdeArranque: true, atrasado: true })
    // Un dia despues del arranque ya es una entrega real.
    expect(cliente(s, LOC2)).toMatchObject({ dias: 28, desdeArranque: false, atrasado: true })
    expect(cliente(s, LOC3)).toMatchObject({ fuente: 'ticket', desdeArranque: false })
    const t = textoPulso(p)
    expect(t).toContain('! Aeropuerto · LOC: desde el arranque (>=29 d) · umbral 21 d, pasa por 8 d')
    expect(t).toContain('! Delirio · LOC: 28 d (entrega sin ticket 11/10) · umbral 21 d, pasa por 7 d')
    expect(t).not.toContain('entrega sin ticket 10/10')
  })

  test('el centinela PENDIENTE DE ASIGNAR y la matriz no son clientes; los nunca surtidos van aparte', () => {
    const s = armarSinSurtir(
      entrada({
        tickets: [ticket('2026-11-01T18:00:00Z', ENTIDAD_PENDIENTE_DE_ASIGNAR, [[P750, 3]])],
        entregas: [entrega(LOC1, '2026-11-01T18:00:00Z')]
      }),
      AHORA
    )
    const ids = [...s.filas, ...s.nunca].map((f) => f.id)
    expect(ids).not.toContain(ENTIDAD_PENDIENTE_DE_ASIGNAR)
    expect(ids).not.toContain(ADMIN)
    expect(s.filas.map((f) => f.id)).toEqual([LOC1])
    expect(s.nunca.map((f) => f.nombre)).toEqual(['Delirio', 'Gilberto', 'Zacatecano'])
    expect(s.nunca.every((f) => f.dias === null && !f.atrasado)).toBe(true)
  })
})

test.describe('pulso · texto del bot', () => {
  test('trae cobertura con REPONER, atrasados y nunca surtidos, y manda la cobranza a /cartera', () => {
    const p = armarPulso(
      entrada({
        stock: stockMatriz({ [P750]: 1, [P250]: 50 }),
        tickets: [ticket('2026-11-01T18:00:00Z', LOC1, [[P750, 8], [P250, 4]])],
        entregas: [entrega(LOC2, '2026-10-10T18:00:00Z')]
      }),
      AHORA
    )
    const t = textoPulso(p)
    expect(t).toContain('750ml: 1 pzas · 2/sem · 0.5 sem  <- REPONER')
    expect(t).toContain('250ml: 50 pzas · 1/sem · 50 sem')
    expect(t).not.toContain('250ml: 50 pzas · 1/sem · 50 sem  <- REPONER')
    expect(t).toContain('50ml: 0 pzas · 0/sem · sin ventas en la ventana')
    expect(t).toContain('Atrasados: 1')
    expect(t).toContain('! Delirio · LOC: 29 d (entrega sin ticket 10/10) · umbral 21 d, pasa por 8 d')
    expect(t).toContain('  Aeropuerto · LOC: 7 d (compra 01/11) · umbral 21 d, faltan 15 d')
    expect(t).toContain('Nunca surtidos (2): Gilberto, Zacatecano')
    expect(t).toContain('Cobranza: /cartera. Piezas en concesion por punto de venta: /stock.')
    expect(LEYENDA_PULSO).toContain('sin cortesías')
  })
})

test.describe('pulso · una sola fuente', () => {
  const RAIZ = path.resolve(__dirname, '..')
  const leer = (r: string) => readFileSync(path.join(RAIZ, r), 'utf8')

  test('la tarjeta del panel y la ruta del bot salen de la MISMA lectura, y la tarjeta esta aislada', () => {
    const panel = leer('app/panel/_panel/PanelMando.tsx')
    const ruta = leer('app/api/bot/pulso/route.ts')
    const lectura = leer('lib/pulso-leer.ts')
    expect(panel).toMatch(/leerPulso\(client\)\.then\(\s*\(datos\) => \(\{ datos, error: undefined/)
    expect(panel).toContain('<CardPulso datos={pulso.datos} error={pulso.error} />')
    const tarjeta = leer('components/v2/panel/CardPulso.tsx')
    expect(tarjeta).toContain('if (!datos)')
    expect(tarjeta).toContain('card-pulso-error')
    expect(tarjeta).toContain('{LEYENDA_PULSO}')
    expect(ruta).toContain('leerPulso(supabase)')
    expect(ruta).toContain('textoPulso(datos)')
    expect(ruta).not.toMatch(/\.from\(/)
    expect(tarjeta).not.toMatch(/\.from\(/)
    expect(lectura).toContain('armarPulso(')
    // Solo lectura: ningun verbo de escritura en la puerta.
    expect(lectura).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/)
  })

  test('el bot tiene /pulso y la ruta es de solo lectura en ensayo', () => {
    const bot = leer('bot/bot_gastos.py')
    expect(bot).toContain('CommandHandler("pulso", comando_pulso)')
    expect(bot).toContain('_post("/api/bot/pulso"')
    expect(bot).toMatch(/RUTAS_SOLO_LECTURA = frozenset\([\s\S]*"\/api\/bot\/pulso"[\s\S]*?\)\)/)
  })
})
