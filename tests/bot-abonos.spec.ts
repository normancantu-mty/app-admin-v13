/**
 * AG-02 Fase 2 — Pruebas puras de la cobranza por Telegram.
 *
 * ─── DE DONDE SALEN LOS FIXTURES ────────────────────────────────────────────
 * **Los numeros de aqui se COPIARON de produccion el 2026-09-12**, no se
 * inventaron. Es la regla que nacio de E-243: el bot decia "1% pagado" donde lo
 * real era 75.7%, y **la prueba pasaba en verde** porque el fixture se escribio
 * suponiendo la escala del campo en vez de mirarla.
 *
 * Los deudores reales, con su deuda: Delirio 85 $19,476 (LOC) · Al son del
 * Mezcal $11,852.01 (LOC) · Martin Reyes $11,327 (DST) · David Flores $9,012.93
 * (DST) · Gilberto Franco $8,496 (DST) · Nuevo Ideal $4,416 · Dulceria el Eden
 * $3,610 · Dulceria ruiz $3,118 · Ale Ortega Expressate $2,040. Total
 * $73,347.94 en 9 deudores.
 */

import { expect, test } from '@playwright/test'
import {
  buscarDeudor,
  filasDeAbono,
  LLAVES_ABONO,
  mensajeDeConfirmacionAbono,
  normalizarAbono,
  normalizarMetodo,
  normalizarNombre,
  normalizarReferencia,
  referenciaEsInocua,
  REFERENCIA_POR_DEFECTO,
  REFERENCIAS_ABONO,
  sellarAbono,
  selloAbonoCoincide,
  sumaCuadra,
  type ContextoAbono,
  type Deudor,
  type PayloadAbono,
  type TicketAbierto
} from '@/lib/bot-abonos'
import { DISPARADORES_FISCALES, LLAVES_PAYLOAD, payloadCanonico, sellarPayload } from '@/lib/bot-gastos'
import { canonizar, sellar } from '@/lib/bot-sello'
import { aCentavos, aPesos, METODOS_PAGO, netearAbonosSinPedido } from '@/lib/abonos'
import { createHash } from 'node:crypto'

// ─── Fixtures copiados de produccion ────────────────────────────────────────

const DEUDORES: Deudor[] = [
  { id_entidad: 'e-delirio', nombre: 'Delirio 85', rol: 'LOC', deuda: 19476.0, dias_sin_abono: 18 },
  { id_entidad: 'e-alson', nombre: 'Al son del Mezcal', rol: 'LOC', deuda: 11852.01, dias_sin_abono: 43 },
  { id_entidad: 'e-martin', nombre: 'Martin Reyes', rol: 'DST', deuda: 11327.0, dias_sin_abono: 88 },
  { id_entidad: 'e-david', nombre: 'David Flores', rol: 'DST', deuda: 9012.93, dias_sin_abono: 25 },
  { id_entidad: 'e-gilberto', nombre: 'Gilberto Franco', rol: 'DST', deuda: 8496.0, dias_sin_abono: 12 },
  { id_entidad: 'e-ideal', nombre: 'Nuevo Ideal', rol: 'LOC', deuda: 4416.0, dias_sin_abono: 12 },
  { id_entidad: 'e-eden', nombre: 'Dulceria el Eden', rol: 'LOC', deuda: 3610.0, dias_sin_abono: 53 },
  { id_entidad: 'e-ruiz', nombre: 'Dulceria ruiz', rol: 'LOC', deuda: 3118.0, dias_sin_abono: 25 },
  { id_entidad: 'e-ale', nombre: 'Ale Ortega Expressate', rol: 'DST', deuda: 2040.0, dias_sin_abono: 5 }
]

const AHORA = new Date('2026-09-12T18:00:00.000Z')

/** Gilberto Franco: un solo pedido en concesion, saldo $8,496 (medido). */
const TICKETS_GILBERTO: TicketAbierto[] = [
  { id_ticket: 't-gil-1', fecha: '2026-08-31T18:00:00.000Z', saldo: 8496.0 }
]

/**
 * Delirio 85, **ESCENARIO INVENTADO**, y hay que decirlo porque la cabecera de
 * este archivo promete fixtures copiados de produccion.
 *
 * Estos tres saldos los construi yo para que **sumaran su deuda de cartera**
 * ($19,476), suponiendo que "los pedidos abiertos suman lo que debe". **Medido
 * el 2026-09-12 contra produccion: es falso.** Delirio tiene 8 pedidos abiertos
 * que suman **$68,708** contra una deuda real de **$7,992** — la diferencia son
 * abonos "a cuenta" (`id_ticket` NULL) que ni el bot ni la accion original del
 * ERP restan de ningun pedido. Ver `TICKETS_DELIRIO_REALES` aqui abajo y E-246.
 *
 * Se queda **para las pruebas de reparto**, donde lo que importa es la aritmetica
 * del FIFO y no de donde salen los numeros, pero **con el nombre que le toca**:
 * un escenario, no una copia.
 */
const TICKETS_DELIRIO: TicketAbierto[] = [
  { id_ticket: 't-del-1', fecha: '2026-06-09T18:00:00.000Z', saldo: 4000.0 },
  { id_ticket: 't-del-2', fecha: '2026-07-18T18:00:00.000Z', saldo: 6476.0 },
  { id_ticket: 't-del-3', fecha: '2026-08-25T18:00:00.000Z', saldo: 9000.0 }
]

/**
 * Delirio 85 **COMO ES**, copiado de `transacciones_tickets` el 2026-09-12
 * despues del primer abono real por Telegram. Ocho pedidos, $68,708 de saldo.
 */
const TICKETS_DELIRIO_REALES: TicketAbierto[] = [
  { id_ticket: '9d31dd82', fecha: '2026-05-23T01:04:50.710Z', saldo: 3924.0 },
  { id_ticket: '84251bf0', fecha: '2026-06-01T21:07:02.762Z', saldo: 16208.0 },
  { id_ticket: 'a91d7ec1', fecha: '2026-06-23T01:24:43.694Z', saldo: 12664.0 },
  { id_ticket: '3403735a', fecha: '2026-07-17T22:54:41.198Z', saldo: 8832.0 },
  { id_ticket: 'a6b26a43', fecha: '2026-07-18T01:33:51.179Z', saldo: 3248.0 },
  { id_ticket: 'ff74f26e', fecha: '2026-08-11T17:28:00.392Z', saldo: 7680.0 },
  { id_ticket: 'e7f3484f', fecha: '2026-08-11T19:52:06.423Z', saldo: 8160.0 },
  { id_ticket: '74a0f1b7', fecha: '2026-08-26T22:21:30.493Z', saldo: 7992.0 }
]
/** Su deuda real en `v_cartera` el 2026-09-12, despues del abono de $11,484. */
const DEUDA_REAL_DELIRIO = 7992.0

function contexto(deudor: Deudor, tickets: TicketAbierto[]): ContextoAbono {
  return {
    deudor,
    idCuentaOrigen: 'c-deudor',
    nombreCuentaOrigen: `Efectivo (${deudor.nombre})`,
    idCuentaDestino: 'c-admin',
    nombreCuentaDestino: 'Efectivo',
    etiqueta: 'norman',
    tickets
  }
}

function abonoDe(deudor: Deudor, tickets: TicketAbierto[], monto: number, extra = {}) {
  const r = normalizarAbono({ monto, nota: 'abono', ...extra }, contexto(deudor, tickets), AHORA)
  if (!r.ok) throw new Error('la normalizacion fallo: ' + r.error)
  return r
}

// ─── 1. La lista cerrada de `referencia`: la trampa fiscal de la fase ───────

test('toda referencia de la lista cerrada es inocua para v_pasivo_fiscal', () => {
  for (const referencia of REFERENCIAS_ABONO) {
    expect(referenciaEsInocua(referencia), `"${referencia}" dispara la vista fiscal`).toBe(true)
  }
})

test('la referencia NUNCA sale de lo que manden: cae al valor del servidor', () => {
  // El control positivo del mismo instrumento: las seis subcadenas que SI
  // disparan la vista. Si alguna se colara a `referencia`, el ERP daria por
  // pagado un impuesto que nadie pago.
  for (const veneno of DISPARADORES_FISCALES) {
    expect(normalizarReferencia(veneno)).toBe(REFERENCIA_POR_DEFECTO)
    expect(referenciaEsInocua(normalizarReferencia(veneno))).toBe(true)
  }
  expect(normalizarReferencia('lo que sea')).toBe(REFERENCIA_POR_DEFECTO)
  expect(normalizarReferencia(null)).toBe(REFERENCIA_POR_DEFECTO)
  // Y el control NEGATIVO al lado, en la misma pasada: un valor que SI esta en
  // la lista se conserva. Sin esto, una funcion que siempre devuelve el default
  // pasaria la prueba de arriba sin hacer nada.
  expect(normalizarReferencia(REFERENCIA_POR_DEFECTO)).toBe(REFERENCIA_POR_DEFECTO)
})

test('una nota con texto fiscal se desactiva y se avisa, no se rechaza', () => {
  // "pago IVA de agosto" SI dispara; "pago del IVA de agosto" NO (la subcadena
  // literal es `PAGO IVA`). Se usa la que dispara de verdad: una prueba con la
  // frase equivocada pasa en verde sin probar nada (E-238).
  const r = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000, { nota: 'pago IVA de agosto' })
  expect(r.payload.nota).not.toContain('IVA')
  expect(r.payload.nota).toContain('I.V.A.')
  expect(r.notaOriginal).toBe('pago IVA de agosto')
  expect(r.avisos.some((a) => a.includes('impuesto'))).toBe(true)
  // El control positivo: una nota inocua pasa intacta.
  const limpio = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000, { nota: 'me pago en la ruta' })
  expect(limpio.payload.nota).toBe('me pago en la ruta')
})

// ─── 2. El deudor: se empata o se pregunta, nunca se adivina ────────────────

test('empata el nombre incompleto que dice la gente', () => {
  for (const [dicho, esperado] of [
    ['Gilberto Franco', 'e-gilberto'],
    ['gilberto', 'e-gilberto'],
    ['GILBERTO', 'e-gilberto'],
    ['Delirio 85', 'e-delirio'],
    ['delirio', 'e-delirio'],
    ['Martin', 'e-martin'],
    ['al son del mezcal', 'e-alson']
  ] as const) {
    const r = buscarDeudor(dicho, DEUDORES)
    expect(r.ok, `no empato "${dicho}"`).toBe(true)
    if (r.ok) expect(r.deudor.id_entidad, `"${dicho}"`).toBe(esperado)
  }
})

test('NO adivina cuando hay dos que se parecen: devuelve los candidatos', () => {
  // "Dulceria" son dos: el Eden y ruiz. Elegir uno escribiria dinero en la
  // entidad equivocada, y eso solo se corrige anulando la fila.
  const r = buscarDeudor('Dulceria', DEUDORES)
  expect(r.ok).toBe(false)
  if (!r.ok) {
    expect(r.motivo).toBe('ambiguo')
    expect(r.candidatos.map((d) => d.id_entidad).sort()).toEqual(['e-eden', 'e-ruiz'])
  }
})

test('una palabra vacia no empata con nadie por accidente', () => {
  // "el" aparece en "Dulceria el Eden". Si los tokens cortos contaran, empataria
  // cualquier frase que lleve un articulo.
  const r = buscarDeudor('el', DEUDORES)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.motivo).toBe('no-encontrado')
})

test('sin nombre no se elige al primero de la lista', () => {
  for (const vacio of ['', '   ', null, undefined]) {
    const r = buscarDeudor(vacio, DEUDORES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivo).toBe('sin-nombre')
  }
})

test('normalizarNombre quita acentos y puntuacion', () => {
  expect(normalizarNombre('Dulcería el Edén')).toBe('dulceria el eden')
  expect(normalizarNombre('  MARTIN   REYES  ')).toBe('martin reyes')
  expect(normalizarNombre('Ale Ortega (Expressate)')).toBe('ale ortega expressate')
})

// ─── 3. El reparto FIFO y su invariante ────────────────────────────────────

test('un abono parcial cubre el pedido mas viejo primero', () => {
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 5000)
  expect(r.payload.aplicaciones).toEqual([
    { id_ticket: 't-del-1', monto: 4000 },
    { id_ticket: 't-del-2', monto: 1000 }
  ])
  expect(r.payload.sobrante).toBe(0)
  expect(sumaCuadra(r.payload)).toBe(true)
})

test('la suma de las filas escritas es EXACTAMENTE el monto capturado', () => {
  // El invariante del que depende `v_cartera`: suma los ABONO_DEUDA por entidad
  // sin mirar `id_ticket`, asi que partir el abono en filas no mueve un saldo
  // mientras la suma cuadre. Se prueba con montos que rompen en centavos.
  for (const monto of [0.01, 1, 1234.56, 4000, 4000.01, 10476, 19476, 25000, 11852.01]) {
    const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, monto)
    const total = filasDeAbono(r.payload).reduce((s, f) => s + Math.round(f.monto * 100), 0)
    expect(total, `monto ${monto}`).toBe(Math.round(monto * 100))
    expect(sumaCuadra(r.payload), `monto ${monto}`).toBe(true)
  }
})

test('lo que sobra entra como fila SIN pedido, y se avisa', () => {
  const r = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 10000) // debe 8496
  expect(r.payload.sobrante).toBe(1504)
  expect(r.avisos.some((a) => a.includes('a cuenta'))).toBe(true)
  expect(r.avisos.some((a) => a.includes('MAS de lo que debe'))).toBe(true)

  const filas = filasDeAbono(r.payload)
  expect(filas).toHaveLength(2)
  expect(filas[0].id_ticket).toBe('t-gil-1')
  expect(filas[0].monto).toBe(8496)
  expect(filas[1].id_ticket).toBeNull()
  expect(filas[1].monto).toBe(1504)
})

test('sin pedidos abiertos el abono entero entra a cuenta, en UNA fila', () => {
  const r = abonoDe(DEUDORES[6], [], 3610)
  expect(r.payload.aplicaciones).toEqual([])
  expect(r.payload.sobrante).toBe(3610)
  const filas = filasDeAbono(r.payload)
  expect(filas).toHaveLength(1)
  expect(filas[0].id_ticket).toBeNull()
  expect(filas[0].monto).toBe(3610)
})

test('todas las filas escritas son ABONO_DEUDA, ACTIVO y ABONO_REAL', () => {
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 25000)
  const filas = filasDeAbono(r.payload)
  expect(filas.length).toBeGreaterThan(1)
  for (const fila of filas) {
    expect(fila.tipo_movimiento).toBe('ABONO_DEUDA')
    expect(fila.status).toBe('ACTIVO')
    // Nunca ABONO_PENDIENTE: `v_cartera` NO cuenta esas como abonado, y una
    // fila pendiente que nadie aprueba es dinero cobrado que no baja la deuda.
    expect(fila.categoria).toBe('ABONO_REAL')
    expect(fila.categoria_gasto).toBe(REFERENCIA_POR_DEFECTO)
    expect(fila.id_cuenta_origen).toBe('c-deudor')
    expect(fila.id_cuenta_destino).toBe('c-admin')
    expect(fila.id_entidad_relacionada).toBe('e-delirio')
    expect(fila.usuario_creador).toBe('telegram:norman')
  }
})

// ─── 4. El sello ───────────────────────────────────────────────────────────

test('mover dinero de un pedido a otro CAMBIA el sello, aunque el total no cambie', () => {
  const base = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 5000).payload
  const movido: PayloadAbono = {
    ...base,
    aplicaciones: [
      { id_ticket: 't-del-1', monto: 3000 },
      { id_ticket: 't-del-2', monto: 2000 }
    ]
  }
  expect(movido.monto).toBe(base.monto)
  expect(sellarAbono(movido)).not.toBe(sellarAbono(base))
  expect(selloAbonoCoincide(movido, sellarAbono(base))).toBe(false)
})

test('el orden de las llaves no cambia el sello, pero el contenido si', () => {
  const a = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000).payload
  const b: PayloadAbono = JSON.parse(JSON.stringify({ ...a }))
  // Mismo objeto, llaves reordenadas a mano.
  const reordenado = {} as Record<string, unknown>
  for (const k of [...LLAVES_ABONO].reverse()) reordenado[k] = (b as unknown as Record<string, unknown>)[k]
  expect(sellarAbono(reordenado as unknown as PayloadAbono)).toBe(sellarAbono(a))
  expect(sellarAbono({ ...a, monto: 1000.01 })).not.toBe(sellarAbono(a))
})

test('el sello es un sha256 hex de 64: lo que exige el CHECK de bot_borradores', () => {
  const sello = sellarAbono(abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000).payload)
  expect(sello).toMatch(/^[0-9a-f]{64}$/)
})

test('el sello del GASTO no cambio al compartir la primitiva', () => {
  // Regresion de la Fase 1: `sellarPayload` ahora delega en `lib/bot-sello.ts`.
  // Se recalcula el hash a mano, con la definicion de siempre, para que un
  // cambio en el modulo compartido no pueda pasar en silencio — los borradores
  // PENDIENTES de produccion dejarian de poder confirmarse.
  const fila = {
    tipo_movimiento: 'GASTO_OPERATIVO' as const,
    categoria: 'Logistica_Envios',
    categoria_gasto: null,
    descripcion: 'gasolina a Zacatecas',
    monto: 340,
    fecha_movimiento: '2026-09-12T18:00:00.000Z',
    id_cuenta_destino: 'c-admin',
    id_cuenta_origen: null,
    usuario_creador: 'telegram:norman',
    status: 'ACTIVO' as const
  }
  const aMano = createHash('sha256')
    .update(
      JSON.stringify({
        categoria: fila.categoria,
        categoria_gasto: fila.categoria_gasto,
        descripcion: fila.descripcion,
        fecha_movimiento: fila.fecha_movimiento,
        id_cuenta_destino: fila.id_cuenta_destino,
        id_cuenta_origen: fila.id_cuenta_origen,
        monto: fila.monto,
        status: fila.status,
        tipo_movimiento: fila.tipo_movimiento,
        usuario_creador: fila.usuario_creador
      }),
      'utf8'
    )
    .digest('hex')
  expect(sellarPayload(fila)).toBe(aMano)
  expect(payloadCanonico(fila)).toBe(canonizar(fila, LLAVES_PAYLOAD))
  expect(sellar(fila, LLAVES_PAYLOAD)).toBe(aMano)
})

// ─── 5. El metodo de pago: etiqueta, nunca motivo de rechazo ───────────────

test('el metodo hablado se mapea al catalogo que acepta el CHECK de la base', () => {
  for (const [dicho, esperado] of [
    ['efectivo', 'EFECTIVO'],
    ['en efectivo', 'EFECTIVO'],
    ['me lo dio en mano', 'EFECTIVO'],
    ['transferencia', 'TRANSFERENCIA'],
    ['por transferencia bancaria', 'TRANSFERENCIA'],
    ['spei', 'TRANSFERENCIA'],
    ['deposito', 'DEPOSITO'],
    ['me deposito', 'DEPOSITO'],
    ['cheque', 'CHEQUE'],
    ['OTRO', 'OTRO']
  ] as const) {
    const r = normalizarMetodo(dicho)
    expect(r.metodo, `"${dicho}"`).toBe(esperado)
    expect(r.noReconocido).toBeNull()
    expect((METODOS_PAGO as readonly string[]).includes(r.metodo as string)).toBe(true)
  }
})

test('un metodo que no se reconoce NO tumba el abono: entra sin metodo y avisa', () => {
  const r = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000, { metodo_pago: 'me lo mando por paloma' })
  expect(r.payload.metodo_pago).toBeNull()
  expect(r.avisos.some((a) => a.includes('paloma'))).toBe(true)
  expect(r.payload.monto).toBe(1000) // el abono SI se registra
})

// ─── 6. Los rechazos que si tienen que serlo ──────────────────────────────

test('un monto que no es monto se rechaza, no se inventa', () => {
  for (const malo of [0, -5, 'muchos', null, undefined, NaN]) {
    const r = normalizarAbono({ monto: malo }, contexto(DEUDORES[4], TICKETS_GILBERTO), AHORA)
    expect(r.ok, `monto ${String(malo)}`).toBe(false)
  }
})

test('un abono absurdo por chat se rechaza y se manda a la pantalla', () => {
  const r = normalizarAbono({ monto: 600000 }, contexto(DEUDORES[4], TICKETS_GILBERTO), AHORA)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('pantalla')
})

test('una fecha futura se ancla a hoy y se dice', () => {
  const r = abonoDe(DEUDORES[4], TICKETS_GILBERTO, 1000, { fecha: '2027-01-01' })
  expect(new Date(r.payload.fecha_movimiento).getTime()).toBe(AHORA.getTime())
  expect(r.avisos.some((a) => a.includes('futura'))).toBe(true)
})

// ─── 7. El mensaje que la persona lee antes de decir VA ───────────────────

test('la confirmacion ensena a QUE pedidos se aplica, no solo el total', () => {
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 5000)
  const texto = mensajeDeConfirmacionAbono(
    r.payload,
    {
      deudor: DEUDORES[0],
      nombreCuentaOrigen: 'Efectivo (Delirio 85)',
      nombreCuentaDestino: 'Efectivo',
      desglose: r.desglose
    },
    r.avisos
  )
  // El dato que de verdad puede estar mal no es el monto: es a que pedido se
  // aplica. Un abono aplicado al pedido equivocado deja la cartera cuadrada en
  // total y mentirosa por pedido, y eso solo se revisa viendolo.
  expect(texto).toContain('Delirio 85')
  expect(texto).toContain('$5,000.00')
  expect(texto).toContain('$4,000.00 de $4,000.00')
  expect(texto).toContain('lo salda')
  expect(texto).toContain('$1,000.00 de $6,476.00')
  expect(texto).toContain('parcial')
  // Debia 19,476 y abona 5,000 -> queda debiendo 14,476.
  expect(texto).toContain('queda debiendo $14,476.00')
  expect(texto).toContain('VA')
})

test('la confirmacion nunca imprime un pedido que no se toca', () => {
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 1000)
  const texto = mensajeDeConfirmacionAbono(
    r.payload,
    {
      deudor: DEUDORES[0],
      nombreCuentaOrigen: 'Efectivo (Delirio 85)',
      nombreCuentaDestino: 'Efectivo',
      desglose: r.desglose
    },
    r.avisos
  )
  expect(texto).toContain('$1,000.00 de $4,000.00')
  expect(texto).not.toContain('$6,476.00')
  expect(texto).not.toContain('$9,000.00')
})

// ─── EL VIAJE DE IDA Y VUELTA POR LA BASE ───────────────────────────────────
// Estas cuatro no existian, y por eso las 24 de arriba pasaban en verde
// mientras la Fase 2 era **incapaz de confirmar un solo abono** contra
// produccion. El sello se guarda en `bot_borradores.payload`, que es `jsonb`, y
// `jsonb` reacomoda las llaves de cada objeto. Un sello que tiene que
// sobrevivir a un almacen se prueba contra la forma en que ese almacen
// devuelve las cosas, no contra el objeto recien construido en memoria.

/** Lo que le hace `jsonb` a un objeto: reordena por longitud y luego alfabetico. */
function comoLoDevuelveJsonb<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(comoLoDevuelveJsonb) as unknown as T
  if (valor !== null && typeof valor === 'object') {
    const entradas = Object.entries(valor as Record<string, unknown>)
    entradas.sort(([a], [b]) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : 1))
    const salida: Record<string, unknown> = {}
    for (const [k, v] of entradas) salida[k] = comoLoDevuelveJsonb(v)
    return salida as unknown as T
  }
  return valor
}

test('el sello sobrevive el viaje por jsonb: las llaves ANIDADAS cambian de orden', () => {
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 5000)
  const vuelto = comoLoDevuelveJsonb(r.payload)
  // El control de que la prueba mide lo que cree medir: si jsonb NO hubiera
  // movido nada, esta prueba pasaria sola y no probaria nada.
  expect(Object.keys(vuelto.aplicaciones[0])).toEqual(['monto', 'id_ticket'])
  expect(Object.keys(r.payload.aplicaciones[0])).toEqual(['id_ticket', 'monto'])

  expect(sellarAbono(vuelto)).toBe(sellarAbono(r.payload))
  expect(selloAbonoCoincide(vuelto, sellarAbono(r.payload))).toBe(true)
})

test('el orden de jsonb es el REAL, copiado de produccion el 2026-09-12', () => {
  // Esto no es una simulacion: es el texto que devolvio
  // `select jsonb_pretty(payload->'abono'->'aplicaciones')` del borrador
  // 30f48ea1-db82-4838-a71c-ae1452767cb9, escrito por la corrida punta a punta.
  const deLaBase = JSON.parse('[{"monto": 1.23, "id_ticket": "a58d762e-9d3b-4120-a47e-5daab6a7b709"}]')
  const enMemoria = [{ id_ticket: 'a58d762e-9d3b-4120-a47e-5daab6a7b709', monto: 1.23 }]
  expect(Object.keys(deLaBase[0])).not.toEqual(Object.keys(enMemoria[0]))
  expect(canonizar({ aplicaciones: deLaBase }, ['aplicaciones'])).toBe(
    canonizar({ aplicaciones: enMemoria }, ['aplicaciones'])
  )
})

test('pero un VALOR anidado distinto si mueve el sello — el control negativo', () => {
  // Lo de arriba podria lograrse con un canonizador que tirara las llaves
  // anidadas a la basura. Esto es lo que prueba que no lo hace: mover un peso
  // de un pedido a otro tiene que cambiar el hash.
  const r = abonoDe(DEUDORES[0], TICKETS_DELIRIO, 5000)
  const manoseado = JSON.parse(JSON.stringify(r.payload)) as PayloadAbono
  manoseado.aplicaciones[0].monto -= 1
  manoseado.aplicaciones[1].monto += 1
  expect(sellarAbono(manoseado)).not.toBe(sellarAbono(r.payload))
})

test('el JSON canonico del abono, a la vista y clavado', () => {
  // Un hash no se puede leer. Si algun dia este formato cambia, lo que se ve en
  // el diff tiene que ser la CADENA, no 64 caracteres distintos de hexadecimal:
  // asi se puede juzgar de un vistazo si el cambio era el que se queria.
  const payload: PayloadAbono = {
    id_entidad: 'e-1',
    id_cuenta_origen: 'c-1',
    id_cuenta_destino: 'c-2',
    monto: 100,
    fecha_movimiento: '2026-09-12T18:00:00.000Z',
    metodo_pago: 'EFECTIVO',
    referencia: REFERENCIA_POR_DEFECTO,
    nota: 'abono',
    usuario_creador: 'telegram:norman',
    aplicaciones: [{ id_ticket: 't-1', monto: 60 }],
    sobrante: 40
  }
  expect(canonizar(payload, LLAVES_ABONO)).toBe(
    '{"aplicaciones":[{"id_ticket":"t-1","monto":60}],' +
      '"fecha_movimiento":"2026-09-12T18:00:00.000Z",' +
      '"id_cuenta_destino":"c-2","id_cuenta_origen":"c-1","id_entidad":"e-1",' +
      '"metodo_pago":"EFECTIVO","monto":100,"nota":"abono",' +
      '"referencia":"' + REFERENCIA_POR_DEFECTO + '",' +
      '"sobrante":40,"usuario_creador":"telegram:norman"}'
  )
})


// ─── LO QUE EL BOT VE DE MAS: los abonos "a cuenta" no bajan ningun pedido ───
// E-246. Esto NO prueba que el codigo este bien: **clava lo que hace hoy**, que
// es lo unico honesto mientras la decision de fondo (si un abono sin pedido debe
// atribuirse a los pedidos viejos) es de Norman y no mia.

test('el universo de pedidos que ve el bot es 8.6 veces la deuda real de Delirio', () => {
  const sumaPedidos = TICKETS_DELIRIO_REALES.reduce((t, x) => t + x.saldo, 0)
  expect(sumaPedidos).toBeCloseTo(68708.0, 2)
  expect(DEUDA_REAL_DELIRIO).toBeCloseTo(7992.0, 2)
  // La cifra que importa: el bot cree que hay 60,716 pesos de pedidos abiertos
  // que la cartera ya da por cobrados. Son los abonos con `id_ticket` NULL.
  expect(sumaPedidos - DEUDA_REAL_DELIRIO).toBeCloseTo(60716.0, 2)
})

test('pagar la deuda ENTERA no salda ningun pedido, y por eso no avisa de sobrante', () => {
  // Norman abona exactamente lo que Delirio debe. La cartera queda en cero...
  const r = abonoDe(
    { ...DEUDORES[0], deuda: DEUDA_REAL_DELIRIO },
    TICKETS_DELIRIO_REALES,
    DEUDA_REAL_DELIRIO
  )
  // ...pero el reparto lo mete en los dos pedidos mas viejos y **no sobra nada**,
  // porque quedan 60,716 de pedidos que el bot cree abiertos.
  expect(r.payload.sobrante).toBe(0)
  expect(r.payload.aplicaciones.length).toBe(2)
  // El total SIEMPRE cuadra: eso es lo que hace que el dinero nunca se pierda.
  expect(sumaCuadra(r.payload)).toBe(true)
})

test('el aviso de "es MAS de lo que debe" SI funciona: es la red que queda puesta', () => {
  // El control positivo de la red de seguridad. Aunque el universo de pedidos
  // este inflado, pasarse de la deuda de cartera **si se avisa**, porque ese
  // aviso se calcula contra `v_cartera` y no contra los pedidos.
  const r = abonoDe(
    { ...DEUDORES[0], deuda: DEUDA_REAL_DELIRIO },
    TICKETS_DELIRIO_REALES,
    DEUDA_REAL_DELIRIO + 5000
  )
  expect(r.avisos.some((a) => a.includes('MAS de lo que debe'))).toBe(true)
  // Y el control negativo, en la misma pasada: justo la deuda NO avisa.
  const justo = abonoDe(
    { ...DEUDORES[0], deuda: DEUDA_REAL_DELIRIO },
    TICKETS_DELIRIO_REALES,
    DEUDA_REAL_DELIRIO
  )
  expect(justo.avisos.some((a) => a.includes('MAS de lo que debe'))).toBe(false)
})

// ─── EL NETEO DE LO COBRADO "A CUENTA" (decision de Norman, 2026-09-12) ──────

test('lo cobrado a cuenta se come los pedidos mas viejos, y puede partir el segundo', () => {
  const crudos = TICKETS_DELIRIO_REALES.map((t) => ({
    id_ticket: t.id_ticket,
    saldo_centavos: aCentavos(t.saldo)
  }))
  // Los $13,188 que Delirio abono sin decir de que pedido eran.
  const neto = netearAbonosSinPedido(crudos, aCentavos(13188))

  // El mas viejo queda saldado...
  expect(neto[0].saldo_centavos).toBe(0)
  // ...y el segundo sale A LA MITAD, que es lo que Norman dijo que pasa:
  // "muchas veces puede ser la mezcla de 2".
  expect(aPesos(neto[1].saldo_centavos)).toBeCloseTo(6944.0, 2)
  // Del tercero en adelante, intactos.
  expect(aPesos(neto[2].saldo_centavos)).toBeCloseTo(12664.0, 2)

  // Y el invariante: no se crea ni se destruye dinero.
  const antes = crudos.reduce((t, x) => t + x.saldo_centavos, 0)
  const despues = neto.reduce((t, x) => t + x.saldo_centavos, 0)
  expect(antes - despues).toBe(aCentavos(13188))
})

test('despues del neteo, los pedidos abiertos cuadran con la cartera y lo de CONTADO', () => {
  // El careo que cierra el diagnostico de E-246, con los dos numeros de
  // produccion del 2026-09-12:
  //   pedidos abiertos crudos        $68,708
  //   menos abonos a cuenta          $13,188  -> $55,520
  //   deuda que muestra el ERP        $7,992
  //   pagos de ventas de CONTADO     $47,528  -> $55,520
  // Que las dos restas caigan en el MISMO numero es lo que demuestra que la
  // diferencia entera son esas dos cosas y no una tercera sin identificar.
  const crudos = TICKETS_DELIRIO_REALES.map((t) => ({
    id_ticket: t.id_ticket,
    saldo_centavos: aCentavos(t.saldo)
  }))
  const neto = netearAbonosSinPedido(crudos, aCentavos(13188))
  const abiertoTrasNeteo = aPesos(neto.reduce((t, x) => t + x.saldo_centavos, 0))

  expect(abiertoTrasNeteo).toBeCloseTo(55520.0, 2)
  expect(DEUDA_REAL_DELIRIO + 47528.0).toBeCloseTo(abiertoTrasNeteo, 2)
})

test('netear no rompe al que no debe nada a cuenta: control negativo', () => {
  // Ale Ortega no tiene un solo abono sin pedido. Netear cero tiene que ser
  // exactamente no hacer nada, o la correccion estaria moviendo saldos ajenos.
  const crudos = [{ id_ticket: 't-ale', saldo_centavos: aCentavos(2040) }]
  expect(netearAbonosSinPedido(crudos, 0)).toEqual(crudos)
})

test('a cuenta mayor que todos los pedidos: los deja en cero y no en negativo', () => {
  const crudos = [
    { id_ticket: 'a', saldo_centavos: aCentavos(100) },
    { id_ticket: 'b', saldo_centavos: aCentavos(200) }
  ]
  const neto = netearAbonosSinPedido(crudos, aCentavos(5000))
  expect(neto.every((t) => t.saldo_centavos === 0)).toBe(true)
})
