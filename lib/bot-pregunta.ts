/**
 * PREGUNTAS LIBRES AL ERP DESDE EL BOT — el lado puro (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 2). Sin red ni base: se prueba en `tests/bot-pregunta.spec.ts`.
 *
 * **Aqui no hay modelo.** El texto de quien pregunta se trata como DATO: se
 * normaliza y se compara contra palabras fijas y contra los nombres de las
 * cuentas que vienen de la base. Lo que no casa con una pregunta conocida NO se
 * adivina: sale `ninguna` y el bot dice que no la puede contestar con certeza.
 * Asi ninguna cifra la escribe un LLM: el numero sale de la base o no sale.
 *
 * Lo que contesta (lo demas sigue en `/api/bot/consulta`):
 *  - `saldo_cuenta`        "¿cuanto hay en Spin?"          -> rpc saldo_cuenta
 *  - `saldos`              "¿cuanto dinero hay?"           -> saldo de cada cuenta propia
 *  - `movimientos_cuenta`  "movimientos de Efectivo de ayer"
 *  - `ventas_periodo`      "ventas de la semana"           -> misma regla que v_ventas_por_mes
 *  - `detalle_ticket`      "detalle del ticket 1A2B3C4D"
 */

import { sumarDias, fechaHoraParaPersona, fechaParaPersona } from '@/lib/fechas'
import { efectoEnCuenta, type MovimientoDinero } from '@/lib/v2/dinero'
import { pesos } from '@/lib/bot-consultas'
import { interpretarClientesEInventario, type NombresDelErp, type PreguntaErp } from '@/lib/bot-pregunta-erp'

export interface CuentaDePregunta {
  id: string
  nombre: string
}

/** Un rango de dias de calendario de Mexico, AMBOS inclusive (`AAAA-MM-DD`). */
export interface Periodo {
  etiqueta: string
  desde: string
  hasta: string
}

export type Pregunta =
  | { tipo: 'saldo_cuenta'; cuenta: CuentaDePregunta }
  | { tipo: 'saldos' }
  | { tipo: 'movimientos_cuenta'; cuenta: CuentaDePregunta; periodo: Periodo; periodoDicho: boolean }
  | { tipo: 'ventas_periodo'; periodo: Periodo }
  | { tipo: 'detalle_ticket'; folio: string }
  | { tipo: 'ninguna'; motivo: 'no_reconocida' | 'cuenta_ambigua' | 'falta_cuenta'; opciones?: string[] }
  | PreguntaErp

/** minusculas, sin acentos, sin signos; espacios simples. */
export function normalizar(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tiene(t: string, ...palabras: string[]): boolean {
  return palabras.some((p) => new RegExp(`(^|\\s)${p}(\\s|$)`).test(t))
}

// ─── El periodo ─────────────────────────────────────────────────────────────

/** Lunes de la semana de `fecha` (semana lunes-domingo, como se habla en Mexico). */
function lunesDe(fecha: string): string {
  const [y, m, d] = fecha.split('-').map(Number)
  const dia = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = domingo
  return sumarDias(fecha, -((dia + 6) % 7))
}

/** El periodo dicho, o `null` si el texto no nombra ninguno. **Pura.** */
export function periodoDe(texto: string, hoy: string): Periodo | null {
  const t = normalizar(texto)
  const ultimos = /ultimos (\d{1,3}) dias/.exec(t)
  if (ultimos) {
    const n = Math.max(1, Math.min(366, Number(ultimos[1])))
    return { etiqueta: `los ultimos ${n} dias`, desde: sumarDias(hoy, -(n - 1)), hasta: hoy }
  }
  if (tiene(t, 'antier', 'anteayer')) {
    const d = sumarDias(hoy, -2)
    return { etiqueta: `antier (${fechaParaPersona(d)})`, desde: d, hasta: d }
  }
  if (tiene(t, 'ayer')) {
    const d = sumarDias(hoy, -1)
    return { etiqueta: `ayer (${fechaParaPersona(d)})`, desde: d, hasta: d }
  }
  if (tiene(t, 'hoy')) return { etiqueta: `hoy (${fechaParaPersona(hoy)})`, desde: hoy, hasta: hoy }
  if (/semana pasada/.test(t)) {
    const lunes = sumarDias(lunesDe(hoy), -7)
    return { etiqueta: 'la semana pasada', desde: lunes, hasta: sumarDias(lunes, 6) }
  }
  if (tiene(t, 'semana')) return { etiqueta: 'esta semana', desde: lunesDe(hoy), hasta: hoy }
  if (/mes pasado/.test(t)) {
    const primero = hoy.slice(0, 8) + '01'
    const finAnterior = sumarDias(primero, -1)
    return { etiqueta: 'el mes pasado', desde: finAnterior.slice(0, 8) + '01', hasta: finAnterior }
  }
  if (tiene(t, 'mes')) return { etiqueta: 'este mes', desde: hoy.slice(0, 8) + '01', hasta: hoy }
  return null
}

// ─── La cuenta ──────────────────────────────────────────────────────────────

/**
 * Las formas en que se nombra una cuenta: "Cuenta Spin" -> "cuenta spin",
 * "spin"; "Efectivo (Aeropuerto)" -> "efectivo aeropuerto", "efectivo de
 * aeropuerto" (NUNCA "aeropuerto" solo: eso es el cliente, y "cuanto debe
 * Aeropuerto" es cartera, no saldo).
 */
export function clavesDeCuenta(nombre: string): string[] {
  const n = normalizar(nombre)
  const claves = new Set<string>([n])
  const parentesis = /^(.*)\s*\((.*)\)\s*$/.exec(String(nombre ?? ''))
  if (parentesis) {
    const base = normalizar(parentesis[1])
    const de = normalizar(parentesis[2])
    claves.add(`${base} ${de}`)
    claves.add(`${base} de ${de}`)
  } else if (n.startsWith('cuenta ')) {
    claves.add(n.slice('cuenta '.length))
  }
  return [...claves].filter((c) => c.length >= 3)
}

/**
 * La cuenta nombrada: la de la clave MAS LARGA que aparece completa en el texto
 * ("efectivo de aeropuerto" le gana a "efectivo"). Empate entre dos cuentas:
 * ambigua, y se dice cuales. **Pura.**
 */
export function cuentaNombrada(
  texto: string,
  cuentas: readonly CuentaDePregunta[]
): { cuenta: CuentaDePregunta } | { ambiguas: CuentaDePregunta[] } | null {
  const t = normalizar(texto)
  let mejor = 0
  let ganadoras: CuentaDePregunta[] = []
  for (const c of cuentas) {
    const largo = Math.max(0, ...clavesDeCuenta(c.nombre).filter((k) => tiene(t, k)).map((k) => k.length))
    if (largo === 0) continue
    if (largo > mejor) {
      mejor = largo
      ganadoras = [c]
    } else if (largo === mejor) {
      ganadoras.push(c)
    }
  }
  if (ganadoras.length === 0) return null
  return ganadoras.length === 1 ? { cuenta: ganadoras[0] } : { ambiguas: ganadoras }
}

// ─── La pregunta ────────────────────────────────────────────────────────────

const FOLIO = /(?:^|\s)(?:tck-?)?([0-9a-f]{8})(?:\s|$)/

/**
 * Decide que se pregunto. `cuentas`: las que esta persona puede consultar,
 * leidas de la base. `hoy`: `AAAA-MM-DD` de Mexico. **Pura.**
 */
export function interpretarPregunta(
  texto: string,
  cuentas: readonly CuentaDePregunta[],
  hoy: string,
  /**
   * Fase 6: entidades y productos de la base. Sin ellos no se reconoce cartera
   * ni inventario (no hay con que casar un nombre) y todo queda como la Fase 2.
   */
  nombres?: NombresDelErp
): Pregunta {
  const t = normalizar(texto)
  if (t === '') return { tipo: 'ninguna', motivo: 'no_reconocida' }

  // 1. Ticket: hace falta la palabra Y el folio de 8 (los 8 primeros del id).
  if (tiene(t, 'ticket', 'tickets', 'folio', 'tck') || /(^|\s)tck-[0-9a-f]{8}/.test(t)) {
    const m = FOLIO.exec(t)
    if (m) return { tipo: 'detalle_ticket', folio: m[1].toUpperCase() }
  }

  const periodo = periodoDe(t, hoy)

  // 2. Movimientos de una cuenta.
  const pideMovs =
    tiene(t, 'movimientos', 'movimiento', 'entradas', 'salidas') ||
    /estado de cuenta|que entro|que salio|que ha entrado|que ha salido/.test(t)
  // 3. Saldo de una cuenta, o de todas.
  const pideSaldo =
    tiene(t, 'saldo', 'saldos') ||
    /cuanto (dinero )?(hay|tengo|tenemos|queda|quedan|trae|traigo)( en)?/.test(t)
  if (pideMovs || pideSaldo) {
    const nombrada = cuentaNombrada(t, cuentas)
    if (nombrada && 'ambiguas' in nombrada) {
      return { tipo: 'ninguna', motivo: 'cuenta_ambigua', opciones: nombrada.ambiguas.map((c) => c.nombre) }
    }
    if (nombrada) {
      if (pideMovs) {
        return {
          tipo: 'movimientos_cuenta',
          cuenta: nombrada.cuenta,
          periodo: periodo ?? { etiqueta: 'los ultimos 7 dias', desde: sumarDias(hoy, -6), hasta: hoy },
          periodoDicho: periodo !== null
        }
      }
      return { tipo: 'saldo_cuenta', cuenta: nombrada.cuenta }
    }
  }

  // Fase 6: cartera de un cliente, cartera total, stock, inventario, lo que se
  // acaba. Va DESPUES de la cuenta nombrada ("movimientos de Efectivo" sigue
  // siendo de la cuenta) y ANTES de "¿de que cuenta?".
  if (nombres) {
    const erp = interpretarClientesEInventario(t, nombres)
    if (erp) return erp
  }

  if (pideMovs || pideSaldo) {
    if (pideSaldo && (tiene(t, 'saldos', 'cuentas', 'dinero') || /^(cual es (el|mi) )?saldo$/.test(t))) {
      return { tipo: 'saldos' }
    }
    if (pideMovs) return { tipo: 'ninguna', motivo: 'falta_cuenta', opciones: cuentas.map((c) => c.nombre) }
  }

  // 4. Ventas de un periodo (sin periodo, la consulta de siempre: por mes).
  if (periodo && (tiene(t, 'venta', 'ventas', 'vendimos', 'vendi', 'vendio', 'vendieron', 'vendido') || /se vendio/.test(t))) {
    return { tipo: 'ventas_periodo', periodo }
  }

  return { tipo: 'ninguna', motivo: 'no_reconocida' }
}

// ─── Las respuestas (texto ya formateado; el bot solo lo reenvia) ───────────

export const LO_QUE_CONTESTO =
  'Lo que si te contesto, con el numero de la base. Por ejemplo:\n' +
  '- cuanto debe Aeropuerto / quien me debe mas\n' +
  '- ultimos movimientos de Delirio\n' +
  '- cuantas botellas de 750 hay / que hay en la matriz\n' +
  '- inventario total / insumos / que se esta acabando\n' +
  'Tambien: cuanto hay en Spin, saldos, movimientos de Efectivo de ayer, ventas de la semana, detalle del ticket 1A2B3C4D, precios, produccion, gastos del mes.'

export function textoDeNinguna(p: Extract<Pregunta, { tipo: 'ninguna' }>): string {
  if (p.motivo === 'cuenta_ambigua') {
    return `Esa cuenta puede ser ${(p.opciones ?? []).join(' o ')}. Dime cual, con su nombre completo.`
  }
  if (p.motivo === 'falta_cuenta') {
    return `¿De que cuenta o de que cliente? Las cuentas que puedo leer: ${(p.opciones ?? []).join(', ')}.`
  }
  if (p.motivo === 'cliente_ambiguo') {
    return `¿Cual de ellos? ${p.candidatos.map((c) => c.nombre).join(', ')}.`
  }
  if (p.motivo === 'cliente_no_encontrado') {
    return `No tengo a "${p.dicho}" entre los clientes (distribuidores y locales). Pregunta "quien me debe" para ver la lista.`
  }
  if (p.motivo === 'entidad_ambigua') {
    return `Ese lugar puede ser ${p.opciones.join(' o ')}. Dime cual, con su nombre completo.`
  }
  return 'Esa no la puedo contestar con certeza, y no voy a adivinar una cifra.\n\n' + LO_QUE_CONTESTO
}

export function textoSaldo(cuenta: CuentaDePregunta, saldo: number | null): string {
  if (saldo === null) return `No pude leer el saldo de ${cuenta.nombre}. No es que sea cero: la base no contesto.`
  return `${cuenta.nombre}: ${pesos(saldo)}`
}

export function textoSaldos(filas: { nombre: string; saldo: number | null }[]): string {
  if (filas.length === 0) return 'Tu alta no tiene cuentas que leer.'
  const leidas = filas.filter((f) => f.saldo !== null)
  const lineas = filas.map((f) => `${f.nombre}: ${f.saldo === null ? 'no se pudo leer' : pesos(f.saldo)}`)
  const total = leidas.reduce((s, f) => s + (f.saldo as number), 0)
  const pie =
    leidas.length === filas.length
      ? `\nTOTAL: ${pesos(total)}`
      : `\nTOTAL de las que se leyeron (${leidas.length} de ${filas.length}): ${pesos(total)}`
  return 'SALDOS:\n' + lineas.join('\n') + pie
}

export const TOPE_MOVIMIENTOS = 30

/**
 * Los movimientos de UNA cuenta con el efecto que `saldo_cuenta` les da
 * (`efectoEnCuenta`, la misma regla): lo que no mueve la cuenta no sale.
 */
export function textoMovimientos(
  cuenta: CuentaDePregunta,
  periodo: Periodo,
  movs: readonly MovimientoDinero[],
  periodoDicho = true
): string {
  const conEfecto = movs
    .map((m) => ({ m, efecto: efectoEnCuenta(m, cuenta.id) }))
    .filter((x) => x.efecto !== 0)
    .sort((a, b) => String(a.m.fecha_movimiento).localeCompare(String(b.m.fecha_movimiento)))
  const cabeza = `MOVIMIENTOS DE ${cuenta.nombre.toUpperCase()}, ${periodo.etiqueta}` +
    (periodoDicho ? '' : ' (no dijiste periodo)')
  if (conEfecto.length === 0) return `${cabeza}:\nNinguno. No hay filas que muevan esta cuenta en ese periodo.`
  const entra = conEfecto.filter((x) => x.efecto > 0).reduce((s, x) => s + x.efecto, 0)
  const sale = conEfecto.filter((x) => x.efecto < 0).reduce((s, x) => s - x.efecto, 0)
  const lineas = conEfecto.slice(-TOPE_MOVIMIENTOS).map(({ m, efecto }) => {
    const signo = efecto > 0 ? '+' : '-'
    const que = (m.descripcion || m.subcategoria || m.categoria || '').trim()
    return `${fechaHoraParaPersona(m.fecha_movimiento)}  ${signo}${pesos(Math.abs(efecto))}  ${m.tipo_movimiento}${que ? '  ' + que : ''}`
  })
  const omitidos = conEfecto.length - lineas.length
  return (
    `${cabeza}:\n` +
    (omitidos > 0 ? `(${omitidos} mas antiguos no se ensenan; los totales SI los cuentan)\n` : '') +
    lineas.join('\n') +
    `\n\nENTRO: ${pesos(entra)}   SALIO: ${pesos(sale)}   NETO: ${pesos(entra - sale)}   (${conEfecto.length} movimientos)`
  )
}

export interface TicketDeVenta {
  id: string
  fecha_transaccion: string | null
  total_cobrado_real: number | null
  condicion_pago: string | null
  status: string | null
  id_comprador: string | null
}

/** La regla de `v_ventas_por_mes`, sobre un periodo: solo ACTIVO, total cobrado. */
export function resumenDeVentas(tickets: readonly TicketDeVenta[]) {
  const activos = tickets.filter((t) => t.status === 'ACTIVO')
  const suma = (xs: readonly TicketDeVenta[]) => xs.reduce((s, t) => s + (Number(t.total_cobrado_real) || 0), 0)
  const concesion = activos.filter((t) => t.condicion_pago === 'CONCESION')
  return {
    tickets: activos.length,
    vendido: suma(activos),
    contado: suma(activos.filter((t) => t.condicion_pago === 'CONTADO')),
    concesion: suma(concesion),
    ticketsConcesion: concesion.length,
    compradores: new Set(activos.map((t) => t.id_comprador).filter(Boolean)).size
  }
}

export function textoVentasPeriodo(periodo: Periodo, tickets: readonly TicketDeVenta[]): string {
  const r = resumenDeVentas(tickets)
  if (r.tickets === 0) return `VENTAS, ${periodo.etiqueta}: ninguna. No hay tickets activos en ese periodo.`
  return (
    `VENTAS, ${periodo.etiqueta}:\n` +
    `Vendido: ${pesos(r.vendido)} en ${r.tickets} ${r.tickets === 1 ? 'ticket' : 'tickets'}, ${r.compradores} ${r.compradores === 1 ? 'comprador' : 'compradores'}\n` +
    `  contado: ${pesos(r.contado)}\n` +
    `  concesion: ${pesos(r.concesion)} (${r.ticketsConcesion} ${r.ticketsConcesion === 1 ? 'ticket' : 'tickets'})`
  )
}

export interface DetalleDeTicket {
  cantidad: number | null
  precio_unitario: number | null
  subtotal_linea: number | null
  producto: string
}

/** Lo que se dice cuando la base trae un nulo: nunca un 0 inventado. */
export const SIN_DATO = 'sin dato'

/** Un numero de la base, o null si viene nulo o no es numero. **Pura.** */
export function cifraDeLaBase(x: unknown): number | null {
  if (x === null || x === undefined || x === '') return null
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function pesosOSinDato(x: unknown): string {
  const n = cifraDeLaBase(x)
  return n === null ? SIN_DATO : pesos(n)
}

export function textoTicket(
  t: TicketDeVenta & { vendedor: string; comprador: string; usuario_creador: string | null },
  lineas: readonly DetalleDeTicket[]
): string {
  const folio = t.id.slice(0, 8).toUpperCase()
  // Un nulo sale "sin dato", no 0 (auditoria 2026-11-07).
  const cuerpo = lineas.length
    ? lineas
        .map((l) => {
          const cantidad = cifraDeLaBase(l.cantidad)
          return `  ${cantidad === null ? SIN_DATO : cantidad} x ${l.producto} a ${pesosOSinDato(l.precio_unitario)} = ${pesosOSinDato(l.subtotal_linea)}`
        })
        .join('\n')
    : '  (sin renglones de detalle)'
  return (
    `TICKET ${folio}${t.status && t.status !== 'ACTIVO' ? ` (${t.status})` : ''}\n` +
    `Fecha: ${fechaHoraParaPersona(t.fecha_transaccion)}\n` +
    `Vende: ${t.vendedor}   Compra: ${t.comprador}\n` +
    `Condicion: ${t.condicion_pago ?? '—'}\n` +
    `${cuerpo}\n` +
    `TOTAL COBRADO: ${pesosOSinDato(t.total_cobrado_real)}` +
    (t.usuario_creador ? `\nCapturo: ${t.usuario_creador}` : '')
  )
}

/** Los tickets cuyo id empieza con el folio (8 hex). **Pura.** */
export function ticketsDelFolio<T extends { id: string }>(folio: string, tickets: readonly T[]): T[] {
  const f = folio.toLowerCase()
  return tickets.filter((t) => t.id.toLowerCase().startsWith(f))
}
