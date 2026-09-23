import { test, expect } from '@playwright/test'

import {
  calcularSaldoPendienteInventarioConsignacion,
  type EntidadRolSaldo
} from '../lib/distribuidores-saldos'
import {
  construirCartera,
  type FinanzaCartera,
  type MovimientoInventarioCartera,
  type TicketCartera
} from '../lib/cartera-utils'
import { esPagoImpuestoIeps, esPagoImpuestoIva } from '../lib/finance-utils'

import {
  avisoPasivoFiscal,
  centavos,
  diasCalendarioMx,
  fechaMx,
  ultimoAbonoVistaVsViejo,
  violacionesCarteraSinAbonos,
  violacionesDiasSinAbonar,
  violacionesSaldo,
  type FilaCarteraInvariante,
  type FilaSaldoInvariante
} from './invariantes-vistas'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * D59 (Fase 7) — UNA VENTA Y UN ABONO NO PUEDEN PONER ROJA LA SUITE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * El conteo de D58 es una LECTURA del codigo. Esto es el experimento, y es
 * PURO: sin base, sin red. Camino (a) del encargo — el (b), meter un abono
 * falso en produccion dentro de un BEGIN/ROLLBACK, se descarto: es escribir en
 * produccion aunque se revierta, y los triggers de esas tablas no estan
 * auditados para efectos fuera de la transaccion.
 *
 * Como: un mundo de juguete con el LEDGER CRUDO (tickets, finanzas,
 * inventario). Las filas de las vistas se derivan de ese ledger con las
 * funciones de TypeScript que `vistas-equivalencia.spec.ts` demuestra
 * equivalentes a las vistas al centavo (`calcularSaldoPendiente...`,
 * `construirCartera`). Luego se aplica el EVENTO que antes tumbaba la suite y
 * se corren sobre el mismo mundo:
 *
 * - las invariantes NUEVAS (`tests/invariantes-vistas.ts`) → tienen que pasar;
 * - las aserciones VIEJAS de `fa90aee`, transcritas abajo → tienen que caer.
 *   Ese es el control negativo: sin el, el fixture no simularia nada.
 *
 * Y el control de realismo: ANTES del evento, las viejas pasan. Si no, el
 * mundo de juguete no se parece al de produccion de aquel dia.
 */

// ─── El mundo de juguete ─────────────────────────────────────────────────────

interface Entidad {
  id: string
  nombre: string
  rol: EntidadRolSaldo | 'ADMIN'
}

interface Finanza {
  tipo_movimiento: string
  monto: number
  id_entidad_relacionada: string | null
  categoria: string | null
  categoria_gasto: string | null
  descripcion: string | null
  status: string
  fecha_movimiento: string
}

interface Mundo {
  entidades: Entidad[]
  tickets: (TicketCartera & { status: string })[]
  finanzas: Finanza[]
  inventario: MovimientoInventarioCartera[]
  /** `now()` de la base: el `calculado_en` de las vistas. */
  relojBase: string
  /** `new Date()` del proceso de Node que corre la prueba. */
  relojNode: string
}

const ADMIN = 'e-admin'
const EDEN = 'e-eden'
const DELIRIO = 'e-delirio'
const MARTIN = 'e-martin'

const mov = (m: Partial<Finanza> & Pick<Finanza, 'tipo_movimiento' | 'monto'>): Finanza => ({
  id_entidad_relacionada: null,
  categoria: null,
  categoria_gasto: null,
  descripcion: null,
  status: 'ACTIVO',
  fecha_movimiento: '2026-09-01T18:00:00.000Z',
  ...m
})

const entrada = (destino: string, cantidad: number, fecha: string): MovimientoInventarioCartera => ({
  tipo_movimiento: 'ENTRADA_CONCESION',
  cantidad,
  status: 'ACTIVO',
  id_entidad_origen: ADMIN,
  id_entidad_destino: destino,
  fecha_movimiento: fecha
})

/** Produccion en `fa90aee`, reducida a los cuatro nodos que nombraban las pruebas. */
function mundoBase(): Mundo {
  return {
    entidades: [
      { id: ADMIN, nombre: 'CEO Admin', rol: 'ADMIN' },
      // LOC: su deuda sale de `total_cobrado_real`.
      { id: EDEN, nombre: 'Dulceria el Eden', rol: 'LOC' },
      // DST: su deuda sale de `monto_base_ingreso`.
      { id: DELIRIO, nombre: 'Delirio 85', rol: 'DST' },
      { id: MARTIN, nombre: 'Martin Reyes', rol: 'DST' }
    ],
    tickets: [
      { condicion_pago: 'CONCESION', id_comprador: EDEN, monto_base_ingreso: 3_000, total_cobrado_real: 3_610, status: 'ACTIVO' },
      { condicion_pago: 'CONCESION', id_comprador: DELIRIO, monto_base_ingreso: 19_476, total_cobrado_real: 24_000, status: 'ACTIVO' },
      { condicion_pago: 'CONCESION', id_comprador: MARTIN, monto_base_ingreso: 10_000, total_cobrado_real: 12_000, status: 'ACTIVO' },
      // Una venta de contado del ADMIN: no genera deuda de nadie.
      { condicion_pago: 'CONTADO', id_comprador: null, monto_base_ingreso: 8_832, total_cobrado_real: 8_832, status: 'ACTIVO' }
    ],
    finanzas: [
      mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 8_832 }),
      mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 2_000, id_entidad_relacionada: MARTIN, categoria: 'ABONO_REAL', fecha_movimiento: '2026-06-16T20:00:00.000Z' }),
      mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 11_484, id_entidad_relacionada: DELIRIO, categoria: 'ABONO_REAL', fecha_movimiento: '2026-09-12T17:00:00.000Z' }),
      // Los pasivos que existian eran ANULADO: 0 contra 0.
      mov({ tipo_movimiento: 'PASIVO_IVA', monto: 2_726.62, status: 'ANULADO' })
    ],
    inventario: [
      entrada(EDEN, 20, '2026-07-21T18:00:00.000Z'),
      entrada(DELIRIO, 90, '2026-06-01T18:00:00.000Z'),
      entrada(MARTIN, 40, '2026-05-20T18:00:00.000Z')
    ],
    // Una tarde cualquiera: los dos relojes caen el mismo dia de Mexico.
    relojBase: '2026-09-22T20:00:00.000Z',
    relojNode: '2026-09-22T20:00:01.000Z'
  }
}

const clonar = (m: Mundo): Mundo => JSON.parse(JSON.stringify(m)) as Mundo

// ─── Las vistas, derivadas del ledger ────────────────────────────────────────

const contables = (m: Mundo): Finanza[] =>
  m.finanzas.filter((f) => f.status === 'ACTIVO' || f.status === 'APPROVED')

/** Una fila de `v_saldo_entidad`, como la arma `20260902223147_vistas_canonicas.sql`. */
function filaSaldo(m: Mundo, e: Entidad): FilaSaldoInvariante & { id_entidad: string; calculado_en: string } {
  const nodo = { id: e.id, rol: e.rol as EntidadRolSaldo }
  const fin = contables(m)
  const deEsta = fin.filter((f) => f.id_entidad_relacionada === e.id)
  const abonos = deEsta.filter((f) => f.tipo_movimiento === 'ABONO_DEUDA' && f.categoria !== 'ABONO_PENDIENTE')
  const ultimo = abonos.length
    ? abonos.map((f) => f.fecha_movimiento).reduce((a, b) => (a > b ? a : b))
    : null
  return {
    id_entidad: e.id,
    nombre: e.nombre,
    // Sin ajustes de finanzas, la funcion devuelve solo lo generado por tickets.
    deuda_generada_tickets: calcularSaldoPendienteInventarioConsignacion(nodo, m.tickets, [e.id]),
    cargos_deuda: deEsta.filter((f) => f.tipo_movimiento === 'CARGO_DEUDA').reduce((s, f) => s + f.monto, 0),
    abonos_aprobados: abonos.reduce((s, f) => s + f.monto, 0),
    // El saldo, en cambio, sale de la funcion de referencia COMPLETA.
    saldo_pendiente_consignacion: calcularSaldoPendienteInventarioConsignacion(nodo, m.tickets, [e.id], fin),
    ultimo_abono: ultimo,
    dias_sin_abonar: ultimo ? diasCalendarioMx(ultimo, m.relojBase) : null,
    calculado_en: m.relojBase
  }
}

const vistaSaldo = (m: Mundo) => m.entidades.map((e) => filaSaldo(m, e))

function vistaCartera(m: Mundo): (FilaCarteraInvariante & { abonadoCrudo: number })[] {
  return construirCartera({
    entidades: m.entidades,
    inventario: m.inventario,
    tickets: m.tickets,
    finanzas: m.finanzas as unknown as FinanzaCartera[],
    hoy: m.relojBase
  }).map((f) => ({
    nombre: f.nombre,
    generado: f.generado,
    abonado: f.abonado,
    abonadoCrudo: f.abonado,
    deuda: f.deuda,
    porcentaje_pagado: f.porcentajePagado
  }))
}

function conteoFiscal(m: Mundo): { pasivos: number; pagos: number } {
  const vivos = m.finanzas.filter((f) => f.status === 'ACTIVO')
  return {
    pasivos: vivos.filter((f) => f.tipo_movimiento === 'PASIVO_IVA' || f.tipo_movimiento === 'PASIVO_IEPS').length,
    pagos: vivos.filter((f) => esPagoImpuestoIva(f) || esPagoImpuestoIeps(f)).length
  }
}

// ─── Las NUEVAS: todo lo que `npm run verificar` afirma hoy sobre produccion ──

function violacionesNuevas(m: Mundo): string[] {
  const saldo = vistaSaldo(m)
  const porId = new Map(saldo.map((f) => [f.id_entidad, f]))
  return [
    ...violacionesSaldo(saldo),
    ...violacionesDiasSinAbonar(saldo),
    ...violacionesCarteraSinAbonos(vistaCartera(m)).violaciones,
    ...ultimoAbonoVistaVsViejo(
      m.entidades.filter((e) => e.rol !== 'ADMIN'),
      contables(m),
      (id) => porId.get(id)?.ultimo_abono ?? null
    ).violaciones
  ]
}

// ─── Las VIEJAS: transcritas de `fa90aee`, mas los tres latentes de D58 ───────
// Cada una devuelve su etiqueta si CAE. Las 9 del censo llevan su numero.

function asercionesViejasQueCaen(m: Mundo): string[] {
  const caen: string[] = []
  const saldo = vistaSaldo(m)
  const eden = saldo.find((f) => f.nombre === 'Dulceria el Eden')!
  const edenCartera = vistaCartera(m).find((f) => f.nombre === 'Dulceria el Eden')!

  // vistas-equivalencia.spec.ts @fa90aee — "Dulceria el Eden: nunca abono..."
  if (!(centavos(eden.saldo_pendiente_consignacion) >= centavos(3_610))) caen.push('#1 eden saldo >= 3610')
  if (centavos(eden.abonos_aprobados) !== 0) caen.push('#2 eden abonos = 0')
  if (eden.ultimo_abono !== null) caen.push('#3 eden ultimo_abono null')
  if (eden.dias_sin_abonar !== null) caen.push('#4 eden dias null')
  // vistas-equivalencia.spec.ts @fa90aee — "v_cartera: el Eden nunca abono..."
  if (centavos(edenCartera.abonado) !== 0) caen.push('#5 cartera eden abonado = 0')
  if (centavos(edenCartera.deuda) !== centavos(edenCartera.generado)) caen.push('#6 cartera eden deuda = generado')
  // (la vieja hacia `Number(null)`, que da 0: el null pasaba)
  if (Math.abs(Number(edenCartera.porcentaje_pagado)) > 1e-10) caen.push('#7 cartera eden 0%')
  // vistas-equivalencia.spec.ts @fa90aee — "v_pasivo_fiscal: ... 0 contra 0"
  const { pasivos, pagos } = conteoFiscal(m)
  if (pasivos + pagos !== 0) caen.push('#8 pasivos fiscales vivos = 0')
  // cableado-pantallas.spec.ts @fa90aee — "el ultimo abono de la vista no mueve el semaforo"
  const { avisos } = ultimoAbonoVistaVsViejo(
    m.entidades.filter((e) => e.rol !== 'ADMIN'),
    contables(m),
    (id) => saldo.find((f) => f.id_entidad === id)?.ultimo_abono ?? null
  )
  if (avisos.length) caen.push('#9 ultimo abono vista = logica vieja')

  // LATENTES (D58): `generada - abonos = saldo` sin CARGO_DEUDA, en los casos
  // con nombre de los dos archivos (Delirio, David, Aeropuerto: misma forma).
  const delirio = saldo.find((f) => f.nombre === 'Delirio 85')!
  if (centavos(delirio.saldo_pendiente_consignacion) !== centavos(delirio.deuda_generada_tickets - delirio.abonos_aprobados)) {
    caen.push('L1 delirio generada - abonos = saldo')
  }
  // LATENTE: Martin con el reloj de NODE (vistas-equivalencia:~438 @fa90aee).
  const martin = saldo.find((f) => f.nombre === 'Martin Reyes')!
  const hoyNode = fechaMx(m.relojNode)
  const esperadosNode = Math.round(
    (Date.parse(`${hoyNode}T00:00:00Z`) - Date.parse(`${fechaMx(martin.ultimo_abono!)}T00:00:00Z`)) / 86_400_000
  )
  if (Number(martin.dias_sin_abonar) !== esperadosNode) caen.push('L2 martin dias con reloj de Node')
  return caen
}

// ─── Los eventos ─────────────────────────────────────────────────────────────

interface Evento {
  nombre: string
  aplicar: (m: Mundo) => void
  /** Las viejas que ESTE evento tiene que tumbar (control negativo). */
  tumba: string[]
}

const EVENTOS: Evento[] = [
  {
    nombre: 'primer abono del Eden ($5,413.00, 2026-09-22 — real)',
    aplicar: (m) =>
      m.finanzas.push(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 5_413, id_entidad_relacionada: EDEN, categoria: 'ABONO_REAL', fecha_movimiento: '2026-09-22T16:00:00.000Z' })),
    tumba: ['#1', '#2', '#3', '#4', '#5', '#6', '#7']
  },
  {
    // A fa90aee ninguna de las 9 caia con esto: las igualdades que tumbo
    // (2026-09-07 David `generada = 58,000`; 2026-09-17 Eden `deuda = 3,610`)
    // ya se habian vuelto pisos. Se mide igual: las nuevas no pueden caer.
    nombre: 'venta en concesion al Eden ($1,803.00, 2026-09-15 — real)',
    aplicar: (m) => {
      m.tickets.push({ condicion_pago: 'CONCESION', id_comprador: EDEN, monto_base_ingreso: 1_500, total_cobrado_real: 1_803, status: 'ACTIVO' })
      m.inventario.push(entrada(EDEN, 3, '2026-09-15T18:00:00.000Z'))
    },
    tumba: []
  },
  {
    nombre: 'primer PASIVO_IVA vivo (venta FULL_TAX, lib/venta-servidor.ts:758)',
    aplicar: (m) => {
      m.tickets.push({ condicion_pago: 'CONTADO', id_comprador: null, monto_base_ingreso: 1_000, total_cobrado_real: 1_160, status: 'ACTIVO' })
      m.finanzas.push(mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 1_160 }))
      m.finanzas.push(mov({ tipo_movimiento: 'PASIVO_IVA', monto: 160, categoria_gasto: 'Pasivo fiscal IVA' }))
    },
    tumba: ['#8']
  },
  {
    nombre: 'primer gasto "PAGO IVA"',
    aplicar: (m) =>
      m.finanzas.push(mov({ tipo_movimiento: 'GASTO_OPERATIVO', monto: 700, categoria_gasto: 'PAGO IVA agosto' })),
    tumba: ['#8']
  },
  {
    nombre: 'primer ABONO_PENDIENTE vivo (abono de un no-ADMIN, app/actions/abonos.ts:572)',
    aplicar: (m) =>
      m.finanzas.push(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 1_000, id_entidad_relacionada: MARTIN, categoria: 'ABONO_PENDIENTE', fecha_movimiento: '2026-09-20T18:00:00.000Z' })),
    tumba: ['#9']
  },
  {
    nombre: 'CARGO_DEUDA a Delirio (app/actions/abonos.ts:569)',
    aplicar: (m) =>
      m.finanzas.push(mov({ tipo_movimiento: 'CARGO_DEUDA', monto: 500, id_entidad_relacionada: DELIRIO, fecha_movimiento: '2026-09-21T18:00:00.000Z' })),
    tumba: ['L1']
  },
  {
    // Sin dato nuevo: la base conto a las 23:59:59 de Mexico y Node leyo un
    // segundo despues de medianoche.
    nombre: 'medianoche de Mexico entre la vista y la prueba',
    aplicar: (m) => {
      m.relojBase = '2026-09-23T05:59:59.500Z'
      m.relojNode = '2026-09-23T06:00:00.500Z'
    },
    tumba: ['L2']
  }
]

test.describe('D59 · una venta, un abono o un IVA reales no pueden poner roja la suite', () => {
  test('control de realismo: ANTES de cualquier evento, viejas y nuevas pasan', () => {
    const m = mundoBase()
    expect(asercionesViejasQueCaen(m), 'el mundo base tiene que parecerse a produccion en fa90aee').toEqual([])
    expect(violacionesNuevas(m)).toEqual([])
  })

  for (const evento of EVENTOS) {
    test(`despues de: ${evento.nombre}`, () => {
      const m = clonar(mundoBase())
      evento.aplicar(m)

      // LA PRUEBA: ninguna asercion actual cae.
      expect(violacionesNuevas(m), 'una invariante nueva cayo con actividad normal').toEqual([])

      // EL CONTROL NEGATIVO: las viejas que este evento tumbaba, caen.
      const caen = asercionesViejasQueCaen(m)
      for (const clave of evento.tumba) {
        expect(
          caen.some((c) => c.startsWith(clave)),
          `la vieja ${clave} tenia que caer con "${evento.nombre}"; cayeron: ${caen.join(' | ') || 'ninguna'}`
        ).toBe(true)
      }
      // Y ninguna cae por accidente fuera de las que se esperaban.
      expect(
        caen.map((c) => c.split(' ')[0]).sort(),
        'cayeron viejas que este evento no deberia tocar: el fixture no es limpio'
      ).toEqual([...evento.tumba].sort())
    })
  }

  test('los avisos siguen DETECTANDO lo que las alarmas querian ver (sin bloquear)', () => {
    const base = mundoBase()
    const c0 = conteoFiscal(base)
    expect(avisoPasivoFiscal(c0.pasivos, c0.pagos)).toContain('0 contra 0')

    const conIva = clonar(base)
    EVENTOS[2].aplicar(conIva)
    const c1 = conteoFiscal(conIva)
    expect(avisoPasivoFiscal(c1.pasivos, c1.pagos)).toContain('ya hay 1 pasivo')

    const conPendiente = clonar(base)
    EVENTOS[4].aplicar(conPendiente)
    const saldo = vistaSaldo(conPendiente)
    const { avisos, violaciones } = ultimoAbonoVistaVsViejo(
      conPendiente.entidades.filter((e) => e.rol !== 'ADMIN'),
      contables(conPendiente),
      (id) => saldo.find((f) => f.id_entidad === id)?.ultimo_abono ?? null
    )
    expect(violaciones).toEqual([])
    expect(avisos.length, 'el abono pendiente de Martin se tiene que avisar').toBe(1)
    expect(avisos[0]).toContain('Martin Reyes')
  })

  test('control positivo: las invariantes nuevas SI muerden una vista mal calculada', () => {
    const m = mundoBase()
    const saldo = vistaSaldo(m)

    const unCentavo = saldo.map((f) => ({ ...f }))
    unCentavo[1].saldo_pendiente_consignacion += 0.01
    expect(violacionesSaldo(unCentavo).length, 'un centavo de mas en el saldo').toBeGreaterThan(0)

    const fechaFantasma = saldo.map((f) => ({ ...f }))
    fechaFantasma[1].ultimo_abono = '2026-09-01T00:00:00.000Z' // el Eden no ha abonado
    expect(violacionesSaldo(fechaFantasma).length, 'fecha de abono sin abonos').toBeGreaterThan(0)

    const diaCorrido = saldo.map((f) => ({ ...f }))
    const iMartin = diaCorrido.findIndex((f) => f.nombre === 'Martin Reyes')
    diaCorrido[iMartin].dias_sin_abonar = Number(diaCorrido[iMartin].dias_sin_abonar) + 1
    expect(violacionesDiasSinAbonar(diaCorrido).length, 'un dia de mas').toBeGreaterThan(0)

    const cartera = vistaCartera(m).map((f) => ({ ...f }))
    const iEden = cartera.findIndex((f) => f.nombre === 'Dulceria el Eden')
    cartera[iEden].porcentaje_pagado = null
    const r = violacionesCarteraSinAbonos(cartera)
    expect(r.cubiertas, 'el Eden sin abonos esta cubierto').toBeGreaterThan(0)
    expect(r.violaciones.length, '% pagado null en un deudor sin abonos').toBeGreaterThan(0)
  })
})
