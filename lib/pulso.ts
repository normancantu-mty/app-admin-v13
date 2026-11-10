/**
 * "Pulso": que reponer y a quien llamar esta semana. Escrito el 2026-11-08 por
 * un ejecutor del Socio (encargo de Norman, despues de la metrica de botellas:
 * "y cualquier otra metrica que creas importante"; criterio del planeador: la
 * restriccion es DEMANDA y COBRANZA, y una metrica entra solo si cambia una
 * accion de esta semana).
 *
 * **Todo puro**: sin base, sin red, sin `Date.now()`. Lo leen DOS salidas —la
 * tarjeta "Pulso" del panel (`components/v2/panel/CardPulso.tsx`) y el comando
 * `/pulso` del bot (`app/api/bot/pulso/route.ts`)— y las dos pasan por
 * `leerPulso` (`lib/pulso-leer.ts`), que llama a `armarPulso` de aqui.
 *
 * DOS metricas, y las reglas de la tarjeta de botellas (`lib/botellas-cliente.ts`)
 * valen aqui tal cual: botella = producto con `NNN ml` en el nombre; cortesia
 * (`subtotal_linea <= 0`), pasta y tickets no ACTIVO no cuentan; el centinela
 * `ENTIDAD_PENDIENTE_DE_ASIGNAR` no es cliente; dias en hora de Mexico.
 *
 * 1. COBERTURA de producto terminado en la matriz, por presentacion:
 *    `stock en la matriz / botellas que vendio la matriz por semana`. El ritmo
 *    es el sell-in de la tarjeta de botellas (tickets ACTIVO con vendedor ADMIN,
 *    a cliente o directa) en los ultimos 28 dias MOVILES (no 4 semanas de
 *    calendario). Si el arranque del sistema (el SALDO_INICIAL mas viejo, el
 *    mismo corte del panel) es mas reciente, la ventana se RECORTA al arranque:
 *    con la historia del 2026-11-08 (11.87 dias), dividir entre 28 dias
 *    subestimaria el ritmo 28 / 11.87 = 2.36 veces. Con menos de 7 dias de historia no
 *    hay ritmo (`null`), no un numero inventado.
 *    NO mide: el stock en la red (concesion en los locales) ni lo que el local
 *    vendio al publico; las cortesias tambien salen del almacen y no estan en el
 *    ritmo (lo hacen un poco optimista; se cuentan aparte en `cortesiasFuera`).
 *
 * 2. DIAS SIN SURTIR de cada local y distribuidor: dias desde la ultima vez que
 *    le llego botella —una compra en ticket ACTIVO con al menos una botella
 *    cobrada, o una ENTRADA_CONCESION viva de botellas (la carga inicial del
 *    2026-10-28 es una)—. Atrasado = pasa su ritmo habitual (mediana de dias
 *    entre compras en ticket, con 3+ compras en dias distintos) o, sin esa
 *    historia, `UMBRAL_DIAS_SIN_SURTIR` (21). NO mide sell-out: un local con
 *    piso lleno puede no necesitar pedir; eso solo lo dice un conteo fisico.
 */

import { diasDesde } from '@/lib/actividad'
import { hoyEnMX } from '@/lib/date-format'
import { ENTIDAD_PENDIENTE_DE_ASIGNAR } from '@/lib/avisos'
import { presentacionDe, type EntidadBotellas, type ProductoBotellas, type TicketBotellas } from '@/lib/botellas-cliente'

/** Sin ritmo propio, un cliente esta atrasado si pasa de estos dias sin surtir. */
export const UMBRAL_DIAS_SIN_SURTIR = 21
/** Compras en ticket (en dias distintos) que hacen falta para tener ritmo propio. */
export const MIN_COMPRAS_PARA_RITMO = 3
/** Ventana del ritmo de venta. */
export const VENTANA_COBERTURA_DIAS = 28
/** Con menos historia que esto, no se calcula ritmo. */
export const MIN_DIAS_HISTORIA = 7
/**
 * ⚠️ SUPUESTO: debajo de estas semanas de cobertura se marca "reponer". No hay
 * dato del tiempo de envasado a entrega; 2 semanas es el umbral elegido, no
 * medido. Cambiarlo es cambiar esta linea.
 */
export const SEMANAS_ALERTA_COBERTURA = 2

const DIA_MS = 86_400_000

// ── Filas crudas (ademas de las de botellas) ──

/** Una fila de `v_stock_por_cubeta`. */
export interface StockPulso {
  id_entidad: string
  id_producto: string
  producto: string | null
  stock: number | string | null
}

/** Una fila ENTRADA_CONCESION de `inventario_ledger`. */
export interface EntregaPulso {
  id_entidad_destino: string | null
  id_producto: string | null
  fecha_movimiento: string | null
  status: string | null
}

export interface EntradaPulso {
  tickets: TicketBotellas[]
  entidades: EntidadBotellas[]
  productos: ProductoBotellas[]
  stock: StockPulso[]
  entregas: EntregaPulso[]
  /** El SALDO_INICIAL mas viejo (arranque del sistema), o null. */
  corte: string | null
}

// ── Resultado ──

export interface FilaCobertura {
  /** Mililitros como texto (`'750'`). */
  presentacion: string
  stock: number
  /** Botellas que vendio la matriz en la ventana. */
  vendidas: number
  /** `null` si no hay historia suficiente. */
  porSemana: number | null
  /** `null` si no hay ritmo (sin historia o sin ventas en la ventana). */
  semanas: number | null
  reponer: boolean
}

export interface Cobertura {
  /** ISO del inicio de la ventana. */
  desde: string
  /** ISO de `ahora`. */
  hasta: string
  /** Dias (con fraccion) que abarca la ventana. */
  dias: number
  /** La ventana empezo en el arranque y no 28 dias atras. */
  recortadaAlArranque: boolean
  historiaInsuficiente: boolean
  filas: FilaCobertura[]
  /** Piezas regaladas (precio 0) por la matriz en la ventana: salieron del almacen y no estan en el ritmo. */
  cortesiasFuera: number
}

export type FuenteSurtido = 'ticket' | 'entrega'

export interface FilaSinSurtir {
  id: string
  nombre: string
  rol: 'LOC' | 'DST'
  /** ISO de la ultima vez que le llego botella; null = nunca. */
  ultima: string | null
  fuente: FuenteSurtido | null
  dias: number | null
  /** Compras en ticket con botella, contadas por dia distinto. */
  compras: number
  /** Mediana de dias entre compras; null sin `MIN_COMPRAS_PARA_RITMO`. */
  ritmo: number | null
  umbral: number
  atrasado: boolean
  /**
   * Su ultima botella es una entrega sin ticket fechada en el arranque del
   * sistema o antes (la carga inicial): los dias son un MINIMO, no la fecha de
   * una entrega real. La marca de atrasado no cambia.
   */
  desdeArranque: boolean
}

export interface SinSurtir {
  /** Con fecha, ordenados: atrasados primero, luego por dias de mas a menos. */
  filas: FilaSinSurtir[]
  /** Clientes a los que nunca les ha llegado botella. */
  nunca: FilaSinSurtir[]
  atrasados: number
}

export interface Pulso {
  ahora: string
  cobertura: Cobertura
  sinSurtir: SinSurtir
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

const esCliente = (e: EntidadBotellas): e is EntidadBotellas & { rol: 'LOC' | 'DST' } =>
  (e.rol === 'LOC' || e.rol === 'DST') && e.id !== ENTIDAD_PENDIENTE_DE_ASIGNAR

/** Botellas cobradas y cortesias de un ticket (pasta y otros terminados fuera). */
function botellasDe(t: TicketBotellas, pres: Map<string, string | null>) {
  const porPres: Record<string, number> = {}
  let cobradas = 0
  let cortesias = 0
  for (const l of t.ticket_detalles ?? []) {
    const p = l.id_producto ? pres.get(l.id_producto) ?? null : null
    if (p === null) continue
    const c = n(l.cantidad)
    if (n(l.subtotal_linea) <= 0) {
      cortesias += c
      continue
    }
    cobradas += c
    porPres[p] = (porPres[p] ?? 0) + c
  }
  return { porPres, cobradas, cortesias }
}

function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function diasEntre(a: string, b: string): number {
  const ms = (d: string) => {
    const [y, m, dd] = d.split('-').map(Number)
    return Date.UTC(y, m - 1, dd)
  }
  return Math.round((ms(b) - ms(a)) / DIA_MS)
}

export function armarCobertura(e: EntradaPulso, ahora: Date): Cobertura {
  const pres = new Map(e.productos.map((p) => [p.id, presentacionDe(p.nombre)]))
  const presentaciones = [...new Set([...pres.values()].filter((x): x is string => x !== null))].sort((a, b) => Number(b) - Number(a))
  const admins = new Set(e.entidades.filter((x) => x.rol === 'ADMIN').map((x) => x.id))

  const hastaMs = ahora.getTime()
  const hace28 = hastaMs - VENTANA_COBERTURA_DIAS * DIA_MS
  const corteMs = e.corte ? Date.parse(e.corte) : NaN
  const recortada = Number.isFinite(corteMs) && corteMs > hace28
  const desdeMs = recortada ? Math.min(corteMs, hastaMs) : hace28
  const dias = (hastaMs - desdeMs) / DIA_MS
  const historiaInsuficiente = dias < MIN_DIAS_HISTORIA

  const stock: Record<string, number> = {}
  for (const s of e.stock) {
    if (!admins.has(s.id_entidad)) continue
    const p = pres.get(s.id_producto) ?? presentacionDe(s.producto)
    if (p === null || p === undefined) continue
    stock[p] = (stock[p] ?? 0) + n(s.stock)
  }

  const vendidas: Record<string, number> = {}
  let cortesiasFuera = 0
  for (const t of e.tickets) {
    if (t.status !== 'ACTIVO' || !t.fecha_transaccion) continue
    if (!admins.has(t.id_vendedor ?? '')) continue
    const ms = Date.parse(t.fecha_transaccion)
    if (!(ms >= desdeMs && ms < hastaMs)) continue
    const b = botellasDe(t, pres)
    cortesiasFuera += b.cortesias
    for (const [p, c] of Object.entries(b.porPres)) vendidas[p] = (vendidas[p] ?? 0) + c
  }

  const filas: FilaCobertura[] = presentaciones.map((p) => {
    const st = stock[p] ?? 0
    const v = vendidas[p] ?? 0
    const porSemana = historiaInsuficiente ? null : v / (dias / 7)
    const semanas = porSemana === null || porSemana === 0 ? null : st / porSemana
    // Reponer: menos de SEMANAS_ALERTA_COBERTURA al ritmo actual (agotado con ventas incluido).
    const reponer = semanas !== null && semanas < SEMANAS_ALERTA_COBERTURA
    return { presentacion: p, stock: st, vendidas: v, porSemana, semanas, reponer }
  })

  return {
    desde: new Date(desdeMs).toISOString(),
    hasta: ahora.toISOString(),
    dias,
    recortadaAlArranque: recortada,
    historiaInsuficiente,
    filas,
    cortesiasFuera
  }
}

export function armarSinSurtir(e: EntradaPulso, ahora: Date): SinSurtir {
  const pres = new Map(e.productos.map((p) => [p.id, presentacionDe(p.nombre)]))
  const clientes = e.entidades.filter(esCliente)
  const ids = new Set(clientes.map((c) => c.id))
  const corteMs = e.corte ? Date.parse(e.corte) : NaN

  const diasCompra = new Map<string, Set<string>>()
  const ultTicket = new Map<string, number>()
  for (const t of e.tickets) {
    if (t.status !== 'ACTIVO' || !t.fecha_transaccion || !t.id_comprador || !ids.has(t.id_comprador)) continue
    const ms = Date.parse(t.fecha_transaccion)
    if (!Number.isFinite(ms) || ms > ahora.getTime()) continue
    if (botellasDe(t, pres).cobradas <= 0) continue
    const set = diasCompra.get(t.id_comprador) ?? new Set<string>()
    set.add(hoyEnMX(new Date(ms)))
    diasCompra.set(t.id_comprador, set)
    if (ms > (ultTicket.get(t.id_comprador) ?? -Infinity)) ultTicket.set(t.id_comprador, ms)
  }

  const ultEntrega = new Map<string, number>()
  for (const x of e.entregas) {
    if (!x.id_entidad_destino || !ids.has(x.id_entidad_destino) || !x.fecha_movimiento) continue
    // Universo canonico del ledger: status IN ('ACTIVO','APPROVED'); NULL, ANULADO o pendiente no cuentan.
    if (x.status !== 'ACTIVO' && x.status !== 'APPROVED') continue
    if ((x.id_producto ? pres.get(x.id_producto) ?? null : null) === null) continue
    const ms = Date.parse(x.fecha_movimiento)
    if (!Number.isFinite(ms) || ms > ahora.getTime()) continue
    if (ms > (ultEntrega.get(x.id_entidad_destino) ?? -Infinity)) ultEntrega.set(x.id_entidad_destino, ms)
  }

  const todas: FilaSinSurtir[] = clientes.map((c) => {
    const tk = ultTicket.get(c.id)
    const en = ultEntrega.get(c.id)
    // Empate (el ticket a concesion escribe su ENTRADA_CONCESION en el mismo instante): gana el ticket.
    const fuente: FuenteSurtido | null = tk !== undefined && (en === undefined || tk >= en) ? 'ticket' : en !== undefined ? 'entrega' : null
    const ultimaMs = fuente === 'ticket' ? tk! : fuente === 'entrega' ? en! : null
    const ultima = ultimaMs === null ? null : new Date(ultimaMs).toISOString()
    const dias = ultima === null ? null : diasDesde(ultima, ahora)
    const diasOrdenados = [...(diasCompra.get(c.id) ?? [])].sort()
    const intervalos = diasOrdenados.slice(1).map((d, i) => diasEntre(diasOrdenados[i], d))
    const ritmo = diasOrdenados.length >= MIN_COMPRAS_PARA_RITMO ? mediana(intervalos) : null
    const umbral = ritmo ?? UMBRAL_DIAS_SIN_SURTIR
    return {
      id: c.id,
      nombre: c.nombre,
      rol: c.rol,
      ultima,
      fuente,
      dias,
      compras: diasOrdenados.length,
      ritmo,
      umbral,
      atrasado: dias !== null && dias > umbral,
      desdeArranque: fuente === 'entrega' && Number.isFinite(corteMs) && ultimaMs! <= corteMs
    }
  })

  const filas = todas
    .filter((f) => f.dias !== null)
    .sort((a, b) => Number(b.atrasado) - Number(a.atrasado) || b.dias! - a.dias! || a.nombre.localeCompare(b.nombre, 'es'))
  const nunca = todas.filter((f) => f.dias === null).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
  return { filas, nunca, atrasados: filas.filter((f) => f.atrasado).length }
}

export function armarPulso(e: EntradaPulso, ahora: Date): Pulso {
  return { ahora: ahora.toISOString(), cobertura: armarCobertura(e, ahora), sinSurtir: armarSinSurtir(e, ahora) }
}

// ── Formato (lo comparten la tarjeta y el bot) ──

/** `27/10` en hora de Mexico. */
export function diaMesMX(iso: string): string {
  const d = hoyEnMX(new Date(iso))
  return `${d.slice(8, 10)}/${d.slice(5, 7)}`
}

/** Un decimal, sin `.0` de mas. */
export function uno(x: number): string {
  const r = Math.round(x * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export function textoVentana(c: Cobertura): string {
  return `${diaMesMX(c.desde)}–${diaMesMX(c.hasta)} (${uno(c.dias)} días${c.recortadaAlArranque ? ', desde el arranque del sistema' : ''})`
}

export function textoSemanas(f: FilaCobertura, historiaInsuficiente: boolean): string {
  if (historiaInsuficiente) return 'sin ritmo (menos de 7 días de historia)'
  if (f.semanas === null) return 'sin ventas en la ventana'
  return `${uno(f.semanas)} sem`
}

export function textoUltima(f: FilaSinSurtir): string {
  if (!f.ultima) return 'nunca'
  if (f.desdeArranque) return 'desde el arranque'
  return `${f.fuente === 'ticket' ? 'compra' : 'entrega sin ticket'} ${diaMesMX(f.ultima)}`
}

/** `12 d (compra 04/11)`, o `desde el arranque (>=12 d)` si la ultima fue la carga inicial. */
export function textoDias(f: FilaSinSurtir): string {
  if (f.dias === null) return 'nunca'
  if (f.desdeArranque) return `desde el arranque (>=${f.dias} d)`
  return `${f.dias} d (${textoUltima(f)})`
}

export function textoUmbral(f: FilaSinSurtir): string {
  return f.ritmo !== null ? `su ritmo ${uno(f.ritmo)} d` : `umbral ${f.umbral} d`
}

export const LEYENDA_PULSO =
  'Ritmo = botellas que vendió la matriz (sell-in, sin cortesías, pasta ni anulados). Surtir = compra en ticket o entrega a concesión de botellas. No mide lo que el local le vendió al público.'

/** El texto del comando `/pulso`. */
export function textoPulso(p: Pulso): string {
  const { cobertura: c, sinSurtir: s } = p
  const L: string[] = []
  L.push('PULSO: que reponer y a quien llamar')
  L.push('')
  L.push('PRODUCTO TERMINADO EN LA MATRIZ, semanas que alcanza')
  L.push(`Ritmo: ventas de la matriz ${textoVentana(c)}`)
  for (const f of c.filas) {
    const ritmo = f.porSemana === null ? '' : ` · ${uno(f.porSemana)}/sem`
    L.push(`  ${f.presentacion}ml: ${f.stock} pzas${ritmo} · ${textoSemanas(f, c.historiaInsuficiente)}${f.reponer ? '  <- REPONER' : ''}`)
  }
  if (c.cortesiasFuera > 0) L.push(`  (${c.cortesiasFuera} cortesias tambien salieron y no estan en el ritmo)`)
  L.push(`REPONER = menos de ${SEMANAS_ALERTA_COBERTURA} semanas al ritmo actual (umbral supuesto, no medido).`)
  L.push('')
  L.push('DIAS SIN SURTIR (ultima compra en ticket o entrega a concesion)')
  L.push(`Atrasado = pasa su ritmo habitual (con ${MIN_COMPRAS_PARA_RITMO}+ compras) o, sin historia, ${UMBRAL_DIAS_SIN_SURTIR} dias.`)
  L.push(`Atrasados: ${s.atrasados}${s.atrasados ? '' : ' (nadie)'}`)
  for (const f of s.filas) {
    const marca = f.atrasado ? '! ' : '  '
    const falta = f.atrasado ? `pasa por ${f.dias! - f.umbral} d` : `faltan ${f.umbral - f.dias! + 1} d`
    L.push(`${marca}${f.nombre} · ${f.rol}: ${textoDias(f)} · ${textoUmbral(f)}, ${falta}`)
  }
  if (s.nunca.length) L.push(`Nunca surtidos (${s.nunca.length}): ${s.nunca.map((f) => f.nombre).join(', ')}`)
  L.push('')
  L.push('Cobranza: /cartera. Piezas en concesion por punto de venta: /stock.')
  return L.join('\n')
}
