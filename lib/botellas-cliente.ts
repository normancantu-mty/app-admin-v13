/**
 * Botellas por semana y por mes de cada local y distribuidor. Escrito el
 * 2026-11-08 por un ejecutor del Socio (encargo de Norman: "que sea muy visible
 * la metrica de las botellas por semana y por mes de cada local y distribuidor").
 *
 * **Todo puro**: sin base, sin red, sin `Date.now()`. Lo leen DOS salidas —la
 * tarjeta de arriba del panel (`components/v2/panel/CardBotellas.tsx`) y el
 * comando `/botellas` del bot (`app/api/bot/botellas/route.ts`)— y las dos pasan
 * por `leerBotellasPorCliente` (`lib/botellas-leer.ts`), que llama a
 * `armarBotellasPorCliente` de aqui. Un solo calculo, dos formatos.
 *
 * QUE MIDE, y no hay otra lectura:
 *  - **Sell-in**: piezas que salieron en un ticket ACTIVO hacia el cliente
 *    (`transacciones_tickets.id_comprador`), de contado o en concesion. Una
 *    entrega en concesion CUENTA: es botella que llego al local. Se ve aparte
 *    (columna `concesion`) porque todavia no esta pagada.
 *  - "Botella" = linea cuyo producto dice `NNN ml` en el nombre (750/250/50).
 *    La pasta y cualquier otro terminado no son botellas: se cuentan aparte en
 *    `excluidas.noBotella`, no se tiran en silencio.
 *  - Cortesia = linea con `subtotal_linea <= 0` (el agente de venta escribe el
 *    regalo con precio 0). No entra a `botellas`; se cuenta en `cortesias`.
 *  - Anulado = ticket con `status != 'ACTIVO'`. No entra; se cuenta en
 *    `excluidas.anulados` para que se vea que existio.
 *
 * QUE NO MIDE: el **sell-out** (lo que el local le vendio al publico). Ese dato
 * solo lo da un conteo fisico de la concesion, y hoy no hay conteos. Tampoco
 * mide la carga inicial del 2026-10-28 (las ENTRADA_CONCESION sin ticket): no
 * fue una venta, fue el inventario que ya estaba en cada local.
 *
 * Semana = lunes a domingo; mes = calendario. Los dos en hora de Mexico
 * (`America/Mexico_City`), con intervalo semiabierto [inicio 00:00 MX, fin+1
 * 00:00 MX), la misma regla de `lib/date-format.ts`.
 */

import { hoyEnMX, medianocheMXaISO } from '@/lib/date-format'
import { sumarDias } from '@/lib/fechas'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '@/lib/avisos'

export const CLAVES_PERIODO = ['semana', 'semanaAnterior', 'mes', 'mesAnterior'] as const
export type ClavePeriodo = (typeof CLAVES_PERIODO)[number]

/**
 * Fila de los tickets sin cliente (venta directa, al publico) o con el
 * comprador centinela `ENTIDAD_PENDIENTE_DE_ASIGNAR` (`lib/avisos.ts`): ese nace
 * con `rol = 'LOC'` pero no es un local, asi que no tiene fila propia ni cuenta
 * entre los "sin botellas".
 */
export const SIN_CLIENTE = '_directa'

/** Lo que dice la tarjeta y el bot sobre lo que NO se cuenta. */
export const LEYENDA_EXCLUSIONES =
  'No cuenta cortesías (precio 0), pasta ni anulados; la tarjeta «Vendido y cobrado» sí cuenta cortesías y pasta en sus piezas.'

export interface Periodo {
  /** `AAAA-MM-DD`, primer dia, en hora de Mexico. */
  desdeDia: string
  /** `AAAA-MM-DD`, ultimo dia INCLUSIVE, en hora de Mexico. */
  hastaDia: string
  /** Instante ISO (UTC) de la medianoche MX del primer dia. */
  desde: string
  /** Instante ISO (UTC) de la medianoche MX del dia siguiente al ultimo (exclusivo). */
  hasta: string
}

export type Periodos = Record<ClavePeriodo, Periodo>

// ── Filas crudas ──

export interface LineaBotellas {
  id_producto: string | null
  cantidad: number | string | null
  subtotal_linea: number | string | null
}

export interface TicketBotellas {
  id: string
  fecha_transaccion: string | null
  status: string | null
  condicion_pago: string | null
  id_comprador: string | null
  id_vendedor: string | null
  ticket_detalles: LineaBotellas[] | null
}

export interface EntidadBotellas {
  id: string
  nombre: string
  rol: string | null
}

export interface ProductoBotellas {
  id: string
  nombre: string
}

// ── Resultado ──

export interface Conteo {
  botellas: number
  /** Clave = mililitros como texto (`'750'`). */
  porPresentacion: Record<string, number>
  contado: number
  concesion: number
  cortesias: number
  /** Tickets que aportaron al menos una botella. */
  tickets: number
}

export interface FilaCliente {
  /** `id_entidad`, o `SIN_CLIENTE`. */
  clave: string
  nombre: string
  rol: 'LOC' | 'DST' | null
  periodos: Record<ClavePeriodo, Conteo>
}

export interface BotellasPorCliente {
  periodos: Periodos
  filas: FilaCliente[]
  /** Mililitros presentes en el catalogo de botellas, de mayor a menor. */
  presentaciones: string[]
  /** Botellas que vendio la MATRIZ (vendedor ADMIN). Es el total que no cuenta dos veces. */
  totalMatriz: Record<ClavePeriodo, number>
  /** Botellas que un DST/LOC le vendio a otro (ya contadas al salir de la matriz). */
  totalEntreNodos: Record<ClavePeriodo, number>
  excluidas: Record<ClavePeriodo, { anulados: number; noBotella: number }>
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

/** `750` de "Destilado Plata 750ml"; `null` si el nombre no dice mililitros. */
export function presentacionDe(nombre: string | null | undefined): string | null {
  const m = /(\d+)\s*ml\b/i.exec(nombre ?? '')
  return m ? String(Number(m[1])) : null
}

function diaDeLaSemanaLunesCero(dia: string): number {
  const [y, m, d] = dia.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function primerDiaDelMes(dia: string, desplazamiento: number): string {
  const [y, m] = dia.split('-').map(Number)
  const t = y * 12 + (m - 1) + desplazamiento
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}

function periodo(desdeDia: string, hastaDia: string): Periodo {
  return {
    desdeDia,
    hastaDia,
    desde: medianocheMXaISO(desdeDia) as string,
    hasta: medianocheMXaISO(hastaDia, 1) as string
  }
}

/**
 * Las cuatro ventanas, a partir del instante `ahora`. El dia de hoy se toma en
 * hora de Mexico: el domingo a las 23:00 MX (lunes 05:00 UTC) sigue siendo la
 * semana que termina ese domingo.
 */
export function periodosDe(ahora: Date): Periodos {
  const hoy = hoyEnMX(ahora)
  const lunes = sumarDias(hoy, -diaDeLaSemanaLunesCero(hoy))
  const mes1 = primerDiaDelMes(hoy, 0)
  const mesSig = primerDiaDelMes(hoy, 1)
  const mesAnt = primerDiaDelMes(hoy, -1)
  return {
    semana: periodo(lunes, sumarDias(lunes, 6)),
    semanaAnterior: periodo(sumarDias(lunes, -7), sumarDias(lunes, -1)),
    mes: periodo(mes1, sumarDias(mesSig, -1)),
    mesAnterior: periodo(mesAnt, sumarDias(mes1, -1))
  }
}

/** El instante mas viejo que hay que leer de la base para llenar las cuatro ventanas. */
export function desdeDondeLeer(p: Periodos): string {
  return CLAVES_PERIODO.map((k) => p[k].desde).reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a))
}

function conteoVacio(): Conteo {
  return { botellas: 0, porPresentacion: {}, contado: 0, concesion: 0, cortesias: 0, tickets: 0 }
}

function porPeriodo<T>(f: () => T): Record<ClavePeriodo, T> {
  return { semana: f(), semanaAnterior: f(), mes: f(), mesAnterior: f() }
}

const esNodo = (rol: string | null | undefined): rol is 'LOC' | 'DST' => rol === 'LOC' || rol === 'DST'

/** Un local o distribuidor de verdad: el centinela "pendiente de asignar" no lo es. */
const esCliente = (e: EntidadBotellas | undefined): e is EntidadBotellas & { rol: 'LOC' | 'DST' } =>
  !!e && esNodo(e.rol) && e.id !== ENTIDAD_PENDIENTE_DE_ASIGNAR

/**
 * Agrupa los tickets por cliente y por ventana. Cada local y distribuidor sale
 * aunque no tenga botellas (un local en cero es justo lo que hay que ver).
 */
export function armarBotellasPorCliente(
  tickets: TicketBotellas[],
  entidades: EntidadBotellas[],
  productos: ProductoBotellas[],
  periodos: Periodos
): BotellasPorCliente {
  const porId = new Map(entidades.map((e) => [e.id, e]))
  const presentacionDeProducto = new Map(productos.map((p) => [p.id, presentacionDe(p.nombre)]))
  const presentaciones = [
    ...new Set([...presentacionDeProducto.values()].filter((x): x is string => x !== null))
  ].sort((a, b) => Number(b) - Number(a))

  const filas = new Map<string, FilaCliente>()
  for (const e of entidades) {
    if (esCliente(e)) filas.set(e.id, { clave: e.id, nombre: e.nombre, rol: e.rol, periodos: porPeriodo(conteoVacio) })
  }
  const filaSinCliente = (): FilaCliente => {
    let f = filas.get(SIN_CLIENTE)
    if (!f) {
      f = { clave: SIN_CLIENTE, nombre: 'Sin cliente / pendiente de asignar', rol: null, periodos: porPeriodo(conteoVacio) }
      filas.set(SIN_CLIENTE, f)
    }
    return f
  }

  const totalMatriz = porPeriodo(() => 0)
  const totalEntreNodos = porPeriodo(() => 0)
  const excluidas = porPeriodo(() => ({ anulados: 0, noBotella: 0 }))
  const limites = CLAVES_PERIODO.map((k) => [k, Date.parse(periodos[k].desde), Date.parse(periodos[k].hasta)] as const)

  for (const t of tickets) {
    if (!t.fecha_transaccion) continue
    const instante = Date.parse(t.fecha_transaccion)
    if (!Number.isFinite(instante)) continue
    const dentro = limites.filter(([, a, b]) => instante >= a && instante < b).map(([k]) => k)
    if (dentro.length === 0) continue

    if (t.status !== 'ACTIVO') {
      for (const k of dentro) excluidas[k].anulados++
      continue
    }

    const comprador = t.id_comprador ? porId.get(t.id_comprador) : undefined
    const fila = esCliente(comprador) ? filas.get(comprador.id)! : filaSinCliente()
    const vendioLaMatriz = porId.get(t.id_vendedor ?? '')?.rol === 'ADMIN'
    const concesion = t.condicion_pago === 'CONCESION'

    let botellasDelTicket = 0
    const porPres: Record<string, number> = {}
    let cortesias = 0
    let noBotella = 0
    for (const l of t.ticket_detalles ?? []) {
      const cantidad = n(l.cantidad)
      const pres = l.id_producto ? presentacionDeProducto.get(l.id_producto) ?? null : null
      if (pres === null) {
        noBotella += cantidad
        continue
      }
      if (n(l.subtotal_linea) <= 0) {
        cortesias += cantidad
        continue
      }
      botellasDelTicket += cantidad
      porPres[pres] = (porPres[pres] ?? 0) + cantidad
    }

    for (const k of dentro) {
      const c = fila.periodos[k]
      excluidas[k].noBotella += noBotella
      c.cortesias += cortesias
      if (botellasDelTicket === 0) continue
      c.botellas += botellasDelTicket
      c.tickets++
      if (concesion) c.concesion += botellasDelTicket
      else c.contado += botellasDelTicket
      for (const [p, x] of Object.entries(porPres)) c.porPresentacion[p] = (c.porPresentacion[p] ?? 0) + x
      if (vendioLaMatriz) totalMatriz[k] += botellasDelTicket
      else totalEntreNodos[k] += botellasDelTicket
    }
  }

  const ordenadas = [...filas.values()].sort((a, b) => {
    if (a.clave === SIN_CLIENTE) return 1
    if (b.clave === SIN_CLIENTE) return -1
    for (const k of ['mes', 'mesAnterior', 'semana', 'semanaAnterior'] as const) {
      const d = b.periodos[k].botellas - a.periodos[k].botellas
      if (d !== 0) return d
    }
    return a.nombre.localeCompare(b.nombre, 'es')
  })

  return { periodos, filas: ordenadas, presentaciones, totalMatriz, totalEntreNodos, excluidas }
}

/** Diferencia contra el periodo anterior. `pct` es `null` si el anterior fue 0. */
export function cambio(actual: number, anterior: number): { dif: number; pct: number | null } {
  return { dif: actual - anterior, pct: anterior === 0 ? null : Math.round(((actual - anterior) / anterior) * 100) }
}

export function sinMovimiento(f: FilaCliente): boolean {
  return CLAVES_PERIODO.every((k) => f.periodos[k].botellas === 0 && f.periodos[k].cortesias === 0)
}

// ── Formato (lo comparten la tarjeta y el bot) ──

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** `02/11–08/11` */
export function rotuloSemana(p: Periodo): string {
  const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
  return `${dm(p.desdeDia)}–${dm(p.hastaDia)}`
}

/** `noviembre 2026` */
export function rotuloMes(p: Periodo): string {
  return `${MESES[Number(p.desdeDia.slice(5, 7)) - 1]} ${p.desdeDia.slice(0, 4)}`
}

const signo = (x: number) => (x > 0 ? `+${x}` : `${x}`)

/** `750ml 8 · 250ml 12` (solo las presentaciones con piezas). */
export function textoPresentaciones(c: Conteo, presentaciones: string[]): string {
  return presentaciones
    .filter((p) => (c.porPresentacion[p] ?? 0) > 0)
    .map((p) => `${p}ml ${c.porPresentacion[p]}`)
    .join(' · ')
}

/**
 * El texto del comando `/botellas`. Corto: una linea de semana y mes por
 * cliente con movimiento; los que estan en cero en las cuatro ventanas, juntos
 * en una sola linea al final (que se vean, pero que no tapen a los que venden).
 */
export function textoBotellas(d: BotellasPorCliente): string {
  const { semana, semanaAnterior, mes, mesAnterior } = d.periodos
  const L: string[] = []
  L.push('BOTELLAS POR CLIENTE (vendidas en ticket: contado + concesion)')
  L.push(LEYENDA_EXCLUSIONES)
  L.push(`Semana ${rotuloSemana(semana)} vs ${rotuloSemana(semanaAnterior)}`)
  L.push(`Mes ${rotuloMes(mes)} vs ${rotuloMes(mesAnterior)} (el periodo actual va en curso)`)
  L.push('')
  const conMovimiento = d.filas.filter((f) => !sinMovimiento(f))
  const quietos = d.filas.filter((f) => sinMovimiento(f) && f.clave !== SIN_CLIENTE)
  if (conMovimiento.length === 0) L.push('Nadie tiene botellas en estas cuatro ventanas.')
  for (const f of conMovimiento) {
    const s = f.periodos.semana.botellas
    const sa = f.periodos.semanaAnterior.botellas
    const m = f.periodos.mes.botellas
    const ma = f.periodos.mesAnterior.botellas
    L.push(`${f.nombre}${f.rol ? ` · ${f.rol}` : ''}`)
    L.push(`  semana ${s} (antes ${sa}, ${signo(s - sa)}) · mes ${m} (antes ${ma}, ${signo(m - ma)})`)
    const pres = textoPresentaciones(f.periodos.mes, d.presentaciones)
    const extra = [
      pres ? `mes: ${pres}` : '',
      f.periodos.mes.concesion > 0 ? `${f.periodos.mes.concesion} en concesion` : '',
      f.periodos.mes.cortesias > 0 ? `${f.periodos.mes.cortesias} cortesias aparte` : ''
    ].filter(Boolean)
    if (extra.length) L.push(`  ${extra.join(' · ')}`)
  }
  L.push('')
  L.push(
    `Total que salio de la matriz: semana ${d.totalMatriz.semana} (antes ${d.totalMatriz.semanaAnterior}) · mes ${d.totalMatriz.mes} (antes ${d.totalMatriz.mesAnterior})`
  )
  if (d.totalEntreNodos.mes > 0 || d.totalEntreNodos.semana > 0) {
    L.push(
      `Ademas, de distribuidor a sus locales: semana ${d.totalEntreNodos.semana} · mes ${d.totalEntreNodos.mes} (no se suman: ya salieron de la matriz)`
    )
  }
  if (quietos.length) L.push(`Sin botellas en las 4 ventanas (${quietos.length}): ${quietos.map((f) => f.nombre).join(', ')}`)
  return L.join('\n')
}
