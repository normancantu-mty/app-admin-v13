/**
 * REGALOS — el lado PURO (sin red ni base). Escrito el 2026-11-20 por un
 * ejecutor del Socio. Se prueba en `tests/regalos.spec.ts`.
 *
 * Encargo de Norman (voz, 2026-11-20): «Kevin regalo cinco grandes, cinco
 * chicas y dos minis, y luego voy a decir el motivo… que haya un contador, una
 * cartera… y obviamente que baje el inventario».
 *
 * - El inventario baja con filas `MERMA` + `id_regalo` (ver la migracion
 *   20261120120000_regalos.sql: por que no un tipo nuevo).
 * - El reparto es la cascada de siempre (PAGADO primero, luego CONSIGNADO),
 *   PERO sin bloquear: si no alcanza, el faltante sale de PAGADO, la
 *   existencia queda negativa y se AVISA. Regla de Norman: el ERP avisa y
 *   nunca bloquea (2026-11-11).
 * - La cartera cuenta BOTELLAS y guarda la razon: por persona, por mes y por
 *   presentacion. Sin costo ni precio en ninguna parte (Norman, voz 2026-11-23:
 *   «me esta preguntando el costo… nomas deben de sumar las botellas y ya, y la
 *   razon»).
 */

import { candidatosPorTamano } from '@/lib/bot-tamanos'
import { calcularDeduccionCascada } from '@/lib/inventario-auditoria'
import {
  EQUIPO,
  QUIENES_CONOCIDOS,
  buscarQuien,
  esDeLaRed,
  leerNombre,
  mencionaA,
  normalizarQuien,
  quienExacto,
  seConfunde,
  sigueOtraPersona,
  type NombreLeido,
  type QuienPermitido
} from '@/lib/regalos-quien'

// ─── Quien regalo: lista cerrada, en `lib/regalos-quien.ts` ─────────────────

export { QUIENES_CONOCIDOS, normalizarQuien, type QuienPermitido }

function aplanar(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

// ─── Validacion de lo que se captura ────────────────────────────────────────

export interface LineaRegalo {
  id_producto: string
  cantidad: number
}

export interface SolicitudRegalo {
  fecha: string
  quien_regalo: string
  motivo: string
  lineas: LineaRegalo[]
  /** A que distribuidor o local se le dio (id en `entidades`). Sin destino: null. */
  id_entidad_destino?: string | null
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

/** El error que impide guardar, o `null`. Nada de existencias aqui: no bloquean. **Pura.** */
export function validarSolicitudRegalo(s: SolicitudRegalo): string | null {
  if (!FECHA.test(String(s.fecha ?? '')) || Number.isNaN(Date.parse(`${s.fecha}T12:00:00Z`))) {
    return 'La fecha no es valida (AAAA-MM-DD).'
  }
  if (normalizarQuien(s.quien_regalo) === '') return 'Falta quien regalo.'
  const motivo = String(s.motivo ?? '').trim()
  if (motivo.length < 3) return 'Falta el motivo o evento (minimo 3 letras).'
  if (motivo.length > 300) return 'El motivo es demasiado largo (maximo 300).'
  const lineas = (s.lineas ?? []).filter((l) => Number(l.cantidad) !== 0)
  if (lineas.length === 0) return 'Pon al menos una pieza.'
  for (const l of lineas) {
    const n = Number(l.cantidad)
    if (!l.id_producto) return 'Hay una linea sin producto.'
    if (!Number.isInteger(n) || n <= 0) return 'Las cantidades son piezas enteras mayores a cero.'
  }
  const ids = lineas.map((l) => l.id_producto)
  if (new Set(ids).size !== ids.length) return 'El mismo producto viene dos veces: suma las piezas en una linea.'
  return null
}

/** Junta lineas del mismo producto y quita las de cero. **Pura.** */
export function juntarLineas(lineas: readonly LineaRegalo[]): LineaRegalo[] {
  const suma = new Map<string, number>()
  for (const l of lineas) {
    const n = Number(l.cantidad) || 0
    if (!l.id_producto || n === 0) continue
    suma.set(l.id_producto, (suma.get(l.id_producto) ?? 0) + n)
  }
  return [...suma.entries()].map(([id_producto, cantidad]) => ({ id_producto, cantidad }))
}

// ─── El reparto: cascada que AVISA y no bloquea ─────────────────────────────

export interface StockCelda {
  pagado: number
  consignado: number
}

/**
 * PAGADO primero, lo que falte de CONSIGNADO (la MISMA `calcularDeduccionCascada`
 * de ventas y merma), y lo que no alcance, de PAGADO otra vez: queda negativo y
 * se avisa. Un stock negativo se trata como 0 para repartir. **Pura.**
 */
export function repartoRegalo(cantidad: number, stock: StockCelda) {
  const pagado = Math.max(0, Number(stock.pagado) || 0)
  const consignado = Math.max(0, Number(stock.consignado) || 0)
  const cubre = Math.min(cantidad, pagado + consignado)
  const { deduccionPagado, deduccionConsignado } = calcularDeduccionCascada({
    cantidadDeducir: cubre,
    stockPagadoActual: pagado,
    stockConsignadoActual: consignado
  })
  const faltante = cantidad - cubre
  return { dePagado: deduccionPagado + faltante, deConsignado: deduccionConsignado, faltante }
}

export interface ProductoRegalo {
  id: string
  nombre: string
  ml_por_unidad: number | null
  costo_unitario: number | null
}

export interface FilaInventarioRegalo {
  id_producto: string
  cubeta: 'PAGADO' | 'CONSIGNADO'
  cantidad: number
  costo_unitario_movimiento: number
  notas: string
}

/**
 * Las filas que van a `registrar_regalo` y los avisos de existencia. **Pura.**
 * `stocks` es por id de producto, en la entidad de la que sale.
 */
export function armarFilasRegalo(
  lineas: readonly LineaRegalo[],
  productos: readonly ProductoRegalo[],
  stocks: ReadonlyMap<string, StockCelda>,
  nota: string
): { filas: FilaInventarioRegalo[]; avisos: string[] } {
  const porId = new Map(productos.map((p) => [p.id, p]))
  const filas: FilaInventarioRegalo[] = []
  const avisos: string[] = []
  for (const l of juntarLineas(lineas)) {
    const p = porId.get(l.id_producto)
    const costo = Number(p?.costo_unitario) || 0
    const stock = stocks.get(l.id_producto) ?? { pagado: 0, consignado: 0 }
    const r = repartoRegalo(l.cantidad, stock)
    if (r.dePagado > 0) filas.push({ id_producto: l.id_producto, cubeta: 'PAGADO', cantidad: r.dePagado, costo_unitario_movimiento: costo, notas: nota })
    if (r.deConsignado > 0) filas.push({ id_producto: l.id_producto, cubeta: 'CONSIGNADO', cantidad: r.deConsignado, costo_unitario_movimiento: costo, notas: nota })
    if (r.faltante > 0) {
      // El stock REAL (puede ser negativo ya), no el recortado a 0 del reparto.
      const hay = (Number(stock.pagado) || 0) + (Number(stock.consignado) || 0)
      avisos.push(
        `${p?.nombre ?? 'Producto'}: hay ${hay} y salen ${l.cantidad}; la existencia queda en ${hay - l.cantidad}. ` +
          'Se guarda de todas formas (el ERP avisa, no bloquea).'
      )
    }
  }
  return { filas, avisos }
}

/** La nota de cada fila del ledger: se ve en "Movimientos de inventario". **Pura.** */
export function notaDeRegalo(quien: string, motivo: string): string {
  return `Regalo de ${normalizarQuien(quien)}: ${String(motivo ?? '').replace(/\s+/g, ' ').trim()}`.slice(0, 240)
}

// ─── La cartera ─────────────────────────────────────────────────────────────

/** Una fila de `v_regalo_lineas` (regalo x producto, solo lo ACTIVO). */
export interface LineaCartera {
  id_regalo: string
  fecha: string
  quien_regalo: string
  motivo: string
  usuario_creador: string | null
  id_producto: string
  producto: string
  ml_por_unidad: number | null
  piezas: number
  /** Cuando se capturo (UTC, como sale de la base). */
  creado_en?: string | null
  /** El distribuidor o local que lo recibio; null = a ninguno de la lista. */
  id_entidad_destino?: string | null
  destino?: string | null
}

export interface PresentacionCartera {
  id_producto: string
  producto: string
  ml_por_unidad: number | null
}

export interface GrupoCartera {
  clave: string
  /** Solo en `porDestino`: el id de la entidad (dos pueden llamarse igual). */
  id?: string
  piezasPorProducto: Record<string, number>
  piezas: number
}

export interface RegistroCartera {
  id_regalo: string
  fecha: string
  quien_regalo: string
  motivo: string
  usuario_creador: string | null
  creado_en: string | null
  id_entidad_destino: string | null
  /** El nombre de quien lo recibio, o "". */
  destino: string
  piezasPorProducto: Record<string, number>
  piezas: number
}

export interface Cartera {
  presentaciones: PresentacionCartera[]
  porPersona: GrupoCartera[]
  /** A que distribuidor o local se le dio. Un regalo sin destino no sale aqui. */
  porDestino: GrupoCartera[]
  /** false: la base todavia no tiene la columna del destino (falta correr su SQL). */
  hayDestinos: boolean
  porMes: GrupoCartera[]
  total: GrupoCartera
  registros: RegistroCartera[]
}

function vacio(clave: string): GrupoCartera {
  return { clave, piezasPorProducto: {}, piezas: 0 }
}

function sumar(g: { piezasPorProducto: Record<string, number>; piezas: number }, l: LineaCartera) {
  const n = Number(l.piezas) || 0
  g.piezasPorProducto[l.id_producto] = (g.piezasPorProducto[l.id_producto] ?? 0) + n
  g.piezas += n
}

/**
 * Totales por persona y por mes (AAAA-MM de la fecha del regalo), en piezas por
 * presentacion; y la lista de registros, el mas reciente primero.
 * Las presentaciones van de mayor a menor (grande, chica, mini, luego sin ml). **Pura.**
 */
export function armarCartera(lineas: readonly LineaCartera[], hayDestinos = true): Cartera {
  const pres = new Map<string, PresentacionCartera>()
  const personas = new Map<string, GrupoCartera>()
  const destinos = new Map<string, GrupoCartera>()
  const meses = new Map<string, GrupoCartera>()
  const regs = new Map<string, RegistroCartera>()
  const total = vacio('Total')
  for (const l of lineas) {
    if (!(Number(l.piezas) > 0)) continue
    if (!pres.has(l.id_producto)) pres.set(l.id_producto, { id_producto: l.id_producto, producto: l.producto, ml_por_unidad: l.ml_por_unidad })
    const quien = normalizarQuien(l.quien_regalo) || '—'
    const mes = String(l.fecha).slice(0, 7)
    if (!personas.has(quien)) personas.set(quien, vacio(quien))
    if (!meses.has(mes)) meses.set(mes, vacio(mes))
    if (!regs.has(l.id_regalo)) {
      regs.set(l.id_regalo, {
        id_regalo: l.id_regalo,
        fecha: String(l.fecha).slice(0, 10),
        quien_regalo: quien,
        motivo: l.motivo,
        usuario_creador: l.usuario_creador,
        creado_en: l.creado_en ?? null,
        id_entidad_destino: l.id_entidad_destino ?? null,
        destino: l.id_entidad_destino ? l.destino || 'Sin nombre' : '',
        piezasPorProducto: {},
        piezas: 0
      })
    }
    sumar(personas.get(quien)!, l)
    if (l.id_entidad_destino) {
      if (!destinos.has(l.id_entidad_destino)) destinos.set(l.id_entidad_destino, { ...vacio(l.destino || 'Sin nombre'), id: l.id_entidad_destino })
      sumar(destinos.get(l.id_entidad_destino)!, l)
    }
    sumar(meses.get(mes)!, l)
    sumar(regs.get(l.id_regalo)!, l)
    sumar(total, l)
  }
  const presentaciones = [...pres.values()].sort(
    (a, b) => (Number(b.ml_por_unidad) || 0) - (Number(a.ml_por_unidad) || 0) || a.producto.localeCompare(b.producto)
  )
  return {
    presentaciones,
    porPersona: [...personas.values()].sort((a, b) => b.piezas - a.piezas || a.clave.localeCompare(b.clave)),
    porDestino: [...destinos.values()].sort((a, b) => b.piezas - a.piezas || a.clave.localeCompare(b.clave)),
    hayDestinos,
    porMes: [...meses.values()].sort((a, b) => b.clave.localeCompare(a.clave)),
    total,
    registros: [...regs.values()].sort((a, b) => b.fecha.localeCompare(a.fecha) || String(b.creado_en ?? '').localeCompare(String(a.creado_en ?? '')) || a.id_regalo.localeCompare(b.id_regalo))
  }
}

/** Las tres de siempre: la ficha las ensena aunque vayan en cero. */
export const PRESENTACIONES_FIJAS = [750, 250, 50] as const

/**
 * Botellas por tamano: 750, 250 y 50 SIEMPRE (aunque sean 0), otros tamanos si
 * los hay y lo que no tiene ml. Suma = total. **Pura.**
 */
export function desglosePorTamano(c: Pick<Cartera, 'presentaciones' | 'total'>): { etiqueta: string; piezas: number }[] {
  const suma = new Map<number, number>()
  for (const p of c.presentaciones) {
    const ml = Number(p.ml_por_unidad) || 0
    suma.set(ml, (suma.get(ml) ?? 0) + (c.total.piezasPorProducto[p.id_producto] ?? 0))
  }
  const otros = [...suma.keys()].filter((ml) => !(PRESENTACIONES_FIJAS as readonly number[]).includes(ml)).sort((a, b) => b - a)
  return [...PRESENTACIONES_FIJAS, ...otros].map((ml) => ({ etiqueta: ml === 0 ? 'Otras' : `${ml} ml`, piezas: suma.get(ml) ?? 0 }))
}

// ─── El contador que contesta el bot ────────────────────────────────────────

export function botellasTexto(n: number): string {
  return `${n} ${n === 1 ? 'botella' : 'botellas'}`
}

/** "3 de 750ml, 2 de 50ml". **Pura.** */
function detalleTexto(piezas: Record<string, number>, pres: readonly PresentacionCartera[]): string {
  return pres
    .filter((p) => (piezas[p.id_producto] ?? 0) > 0)
    .map((p) => `${piezas[p.id_producto]} de ${p.ml_por_unidad ? `${p.ml_por_unidad}ml` : p.producto}`)
    .join(', ')
}

function renglonContador(g: GrupoCartera, pres: readonly PresentacionCartera[]): string {
  const detalle = detalleTexto(g.piezasPorProducto, pres)
  return `${g.clave}: ${botellasTexto(g.piezas)}${detalle ? ` (${detalle})` : ''}`
}

const REGISTROS_EN_CHAT = 15
const ULTIMOS_EN_CHAT = 5

/** "2026-11-25 12:05", hora de Mexico (UTC-6, sin horario de verano). Sin dato: "". **Pura.** */
export function horaCapturaMx(creadoEn: string | null | undefined): string {
  const ms = Date.parse(String(creadoEn ?? ''))
  return Number.isNaN(ms) ? '' : new Date(ms - 6 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
}

/** "telegram:kevin" -> "Kevin (Telegram)"; un correo, tal cual. **Pura.** */
export function capturoTexto(usuario: string | null | undefined): string {
  const u = String(usuario ?? '').trim()
  const m = /^telegram:(.+)$/i.exec(u)
  return m ? `${normalizarQuien(m[1])} (Telegram)` : u
}

/** " [lo capturó Kevin (Telegram), 2026-11-25 12:05]", con lo que haya. **Pura.** */
function rastro(r: RegistroCartera): string {
  const partes = [capturoTexto(r.usuario_creador), horaCapturaMx(r.creado_en)].filter((x) => x !== '')
  return partes.length ? ` [lo capturó ${partes.join(', ')}]` : ''
}

/** "Casa Verde: 3 botellas (3 de 750ml)". **Pura.** */
export function renglonDeGrupo(c: Cartera, g: GrupoCartera): string {
  return renglonContador(g, c.presentaciones)
}

/** El renglon de una persona: "Kevin: 12 botellas (5 de 750ml, …)". **Pura.** */
export function renglonDePersona(c: Cartera, quien: string): string {
  const g = c.porPersona.find((x) => aplanar(x.clave) === aplanar(quien)) ?? vacio(normalizarQuien(quien))
  return renglonContador(g, c.presentaciones)
}

/**
 * Lo que se le ha DADO a un distribuidor o local. Cero tambien se dice. **Pura.**
 */
export function textoRecibidos(c: Cartera, destino: { nombre: string; ids: readonly string[] }): string {
  if (!c.hayDestinos) return `REGALOS para ${destino.nombre}: falta correr el SQL del destino en la base; todavía no se puede contar.`
  const suyos = c.registros.filter((r) => r.id_entidad_destino !== null && destino.ids.includes(r.id_entidad_destino))
  const g = vacio(destino.nombre)
  for (const r of suyos) {
    g.piezas += r.piezas
    for (const [k, n] of Object.entries(r.piezasPorProducto)) g.piezasPorProducto[k] = (g.piezasPorProducto[k] ?? 0) + n
  }
  const lista = suyos
    .slice(0, REGISTROS_EN_CHAT)
    .map((r) => `- ${r.fecha}: ${detalleTexto(r.piezasPorProducto, c.presentaciones)}. ${r.motivo}. Lo dio ${r.quien_regalo}${rastro(r)}`)
  const mas = suyos.length > REGISTROS_EN_CHAT ? [`… y ${suyos.length - REGISTROS_EN_CHAT} mas en su ficha (Regalos).`] : []
  return ['REGALOS que le hemos dado a ' + renglonContador(g, c.presentaciones), ...lista, ...mas].join('\n')
}

/**
 * El contador: botellas por persona, por presentacion y total. Con `quien`, la
 * cuenta de esa persona y cada regalo con su razon, quien lo capturo y a que hora.
 * Sin `quien`, ademas, los ultimos. Nunca dinero. **Pura.**
 */
export function textoContador(c: Cartera, quien: string): string {
  if (quien !== '') {
    const suyos = c.registros.filter((r) => aplanar(r.quien_regalo) === aplanar(quien))
    const lista = suyos
      .slice(0, REGISTROS_EN_CHAT)
      .map((r) => `- ${r.fecha}: ${detalleTexto(r.piezasPorProducto, c.presentaciones)}. ${r.motivo}${r.destino ? ` (para ${r.destino})` : ''}${rastro(r)}`)
    const mas = suyos.length > REGISTROS_EN_CHAT ? [`… y ${suyos.length - REGISTROS_EN_CHAT} mas en el panel (Regalos).`] : []
    return ['REGALOS de ' + renglonDePersona(c, quien), ...lista, ...mas].join('\n')
  }
  if (c.registros.length === 0) return 'Todavia no hay regalos registrados.'
  return [
    'REGALOS (botellas por persona)',
    ...c.porPersona.map((g) => renglonContador(g, c.presentaciones)),
    renglonContador({ ...c.total, clave: 'TOTAL' }, c.presentaciones),
    ...(c.porDestino.length ? ['A QUIEN SE LE HAN DADO', ...c.porDestino.map((g) => renglonContador(g, c.presentaciones))] : []),
    'ULTIMOS',
    ...c.registros
      .slice(0, ULTIMOS_EN_CHAT)
      .map((r) => `- ${r.fecha} ${r.quien_regalo}${r.destino ? ` para ${r.destino}` : ''}: ${detalleTexto(r.piezasPorProducto, c.presentaciones)}. ${r.motivo}${rastro(r)}`)
  ].join('\n')
}

// ─── Lo que se dicta al bot ─────────────────────────────────────────────────

/** ¿El texto habla de regalar? Antes de gastar una peticion. **Pura.** */
export const PATRON_REGALO = /\b(regal\w*|obsequi\w*)\b/

export function hablaDeRegalo(texto: unknown): boolean {
  return PATRON_REGALO.test(aplanar(texto))
}

const UNIDADES: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9
}
const DECENAS: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90
}
const PALABRAS_NUMERO: Record<string, number> = {
  ...UNIDADES,
  ...DECENAS,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24,
  veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, cien: 100
}

/** "treinta y dos" -> 32; "13" -> 13; "trece" -> 13. Lo que no conoce: NaN. **Pura.** */
export function numeroDictado(dicho: string): number {
  const t = dicho.trim()
  if (/^\d+$/.test(t)) return Number(t)
  const [a, b] = t.split(/\s+y\s+/)
  const base = PALABRAS_NUMERO[a]
  if (base === undefined) return NaN
  if (b === undefined) return base
  return DECENAS[a] !== undefined && UNIDADES[b] !== undefined ? base + UNIDADES[b] : NaN
}

const ALT_SUELTOS = Object.keys(PALABRAS_NUMERO).sort((x, y) => y.length - x.length).join('|')
const ALT_DECENAS = Object.keys(DECENAS).join('|')
const ALT_UNIDADES = Object.keys(UNIDADES).sort((x, y) => y.length - x.length).join('|')
const NUMERO = `\\d{1,4}|(?:${ALT_DECENAS})\\s+y\\s+(?:${ALT_UNIDADES})|${ALT_SUELTOS}`

/**
 * "regalo" es verbo ("Kevin regalo") o sustantivo ("iba de regalo", "vendi 3
 * de regalo"). Solo el VERBO hace un regalo: el sustantivo es otra cosa (una
 * venta, una merma) y el mensaje sigue su camino. **Pura.**
 */
const ANTES_DE_SUSTANTIVO = new Set([
  'de', 'del', 'para', 'como', 'un', 'el', 'al', 'mi', 'mis', 'su', 'sus', 'tu', 'tus',
  'otro', 'este', 'ese', 'buen', 'gran', 'en', 'por'
])
/** "oye bot, registra un regalo…" -> "regalo…": la orden de anotar no es parte del regalo. */
const ORDEN_DE_ANOTAR =
  /^(?:oye\s+|bot[\s,]+|por\s+favor\s+)*(?:(?:registra|anota|apunta|agrega|captura|mete|pon)\w*)\s+(?:(?:un|el|los|unos|otro|este)\s+)?(?=regal|obsequi)/

function verbosDeRegalo(plano: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = []
  for (const m of plano.matchAll(/\b(?:regal|obsequi)(\w*)/g)) {
    const sufijo = m[1] ?? ''
    // "regalos", "regalito": sustantivo… salvo que ABRA el mensaje ("Regalos Kevin 2 grandes en la expo").
    if (/^(os|itos?|itas?)$/.test(sufijo) && m.index !== 0) continue
    const previa = plano.slice(0, m.index).trim().split(/\s+/).pop() ?? ''
    if (ANTES_DE_SUSTANTIVO.has(previa)) continue
    out.push(m as RegExpExecArray)
  }
  return out
}

/** "ayer" = 1, "antier"/"anteayer" = 2, si no 0. **Pura.** */
function diasAtrasDe(plano: string): number {
  if (/\b(antier|anteayer|antes de ayer)\b/.test(plano)) return 2
  if (/\bayer\b/.test(plano)) return 1
  return 0
}

/** AAAA-MM-DD menos `dias` dias. **Pura.** */
export function fechaMenosDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - Math.max(0, Math.trunc(dias) || 0))
  return d.toISOString().slice(0, 10)
}

export interface PiezaDictada {
  producto: ProductoRegalo
  cantidad: number
}

export interface DudaQuien {
  dicho: string
  /**
   * `cual`: el mensaje nombra a uno y dice que fue otro ("regale una grande de Kevin").
   * `rol`: "de Gilberto Franco" (distribuidor): ¿lo dio, o era para el? `opciones` trae solo a el.
   */
  motivo: 'ambiguo' | 'desconocido' | 'cual' | 'rol'
  opciones: QuienPermitido[]
  /** `destino`: lo que no queda claro es A QUIEN se le dio. Si no viene: quien lo regalo. */
  sobre?: 'destino'
  /** Donde esta lo dicho dentro del dictado (sin la orden de anotar), para cambiarlo ahi por la respuesta. */
  tramo?: [number, number]
  /** Lo mismo, con su "de" y lo que lo separa: " de Gilberto Franco". */
  trozo?: [number, number]
  /** No esta en la lista, pero se confunde con alguien que si. */
  cerca?: true
}

export type LecturaRegalo =
  | { ok: true; quien: string; destino?: QuienPermitido; piezas: PiezaDictada[]; motivo: string; diasAtras: number }
  | { ok: false; falta: 'no_es_regalo' }
  /** `destinos`: no son dos que regalan, son dos que reciben. */
  | { ok: false; falta: 'uno_por_mensaje'; destinos?: true }
  /** `cuantas`: dijo un numero sin tamano y a quien ("Norman regalo 3 a Casa Verde"): solo falta el tamano. */
  | { ok: false; falta: 'piezas'; cuantas?: number }
  | {
      ok: false
      falta: 'quien' | 'motivo'
      piezas: PiezaDictada[]
      quien: string
      destino?: QuienPermitido
      motivo: string
      diasAtras: number
      /** Solo con falta = 'quien': lo que se oyo, por que no basta y a quien se parece. */
      duda?: DudaQuien
    }
  | { ok: false; falta: 'tamano'; dicho: string }

const SALUDO = /^(?:(?:oye|hola|bot|socio)[\s,]+)+/

/** Sin "registra un…" ni "oye": la orden de anotar no es parte del regalo. **Pura.** */
function quitarOrden(texto: string): string {
  // NFC: asi `aplanar` conserva las posiciones (una letra acentuada = una letra).
  let t = String(texto ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  for (const patron of [ORDEN_DE_ANOTAR, SALUDO, ORDEN_DE_ANOTAR]) {
    const m = patron.exec(aplanar(t))
    if (m) t = t.slice(m[0].length)
  }
  return t
}

/** Lo que puede ir entre la pieza (o el verbo) y "de Fulano" sin ser Fulano. */
const SALTO =
  'plata|destilad[oa]s?|chiles?|guajillo|mezcal|tequila|licor|vidrio|fresnillo|botellas?|botes?|piezas?|productos?|ml|mililitros|' +
  'muestras?|regalos?|obsequios?|cortesia|promocion|prueba|degustacion|hoy|ayer|antier|anteayer|tambien|solo|nomas|ya|mas|\\d{1,4}(?:\\s*ml)?'
const MARCA_FUERTE = '(?:de|por)\\s+parte\\s+de|(?:a|en)\\s+nombre\\s+de|(?:lo|la|los|las)\\s+dio'
/** "para amigos de Kevin", "a un cliente de Casa Verde": ese "de" es del que recibe. */
const COMUN =
  /^(el|la|los|las|un|una|unos|unas|mi|mis|su|sus|clientes?|clientas?|amig[oa]s?|espos[oa]s?|novi[oa]s?|herman[oa]s?|hij[oa]s?|prim[oa]s?|ti[oa]s?|familia|familiares|mama|papa|gente|equipo|emplead[oa]s?|trabajador\w*|personal|invitad[oa]s?|vecin[oa]s?|jefes?|doctora?|maestr[oa]s?|socios?)$/

interface Candidato {
  leido: NombreLeido
  ini: number
  fin: number
  /** Donde empieza el nombre (despues del "de"). */
  nombre: number
  /** "de parte de X", "por X": X es quien lo dio, aunque sea un local. */
  fuerte: boolean
  /** Sin "de" delante: "una grande fany". */
  suelto: boolean
    /** Lo une un "y". */
    conY?: true
  lugar: 'verbo' | 'pieza' | 'ultima' | 'fuerte'
}

/** Alguien a quien se le dio: "a X", "para X", o un local dicho "de X" / pegado a la pieza. */
interface Receptor {
  leido: NombreLeido
  ini: number
  fin: number
  nombre: number
}

const NINGUNO = /^(?:a |para |es |de )*(?:nadie|ningun[oa]?|otr[oa]s?|no|nada|yo|sin (?:local|destino)|no se|no esta(?: en la lista)?|particular|cliente)\b/

/**
 * "Kevin regalo 5 grandes, 5 chicas y 2 minis, motivo: evento X".
 *
 * - Verbo: tiene que haber UN "regalo/regale/regalamos/obsequio" usado como
 *   verbo. "de regalo" (sustantivo) no es regalo: `no_es_regalo`. Dos verbos
 *   ("Kevin regalo 2 y Gilberto regalo 3") piden un regalo por mensaje, para
 *   no cargarle todo al primero.
 * - Piezas: cada "<numero> <tamano>" ("5 grandes", "trece de 750", "treinta y
 *   dos minis"), resuelto con `lib/bot-tamanos.ts` (D53: chica = 250, mini =
 *   50). Un tamano que no empata con el catalogo NO se adivina. "a una chica"
 *   (persona) no cuenta: va despues de "a/para/con".
 * - Motivo: lo que sigue a "motivo"; si no lo hay, lo que sigue a la ultima pieza.
 *   A quien se le dio ("a Casa Verde") se queda ademas en el motivo.
 * - Destino (un distribuidor o local de la lista): "a X", "para X", o "de X" / X
 *   pegado sin que otro reciba. Norman, 2026-11-25: «Regalo una grande de/para Casa
 *   Verde» = se le dio a Casa Verde y lo regala quien dicta. "Casa Verde regalo…" y
 *   "de parte de Casa Verde" = lo regala Casa Verde. Quien recibe y no esta en la
 *   lista ("a un cliente") no es destino: queda en el motivo. Si se confunde con uno
 *   de la lista, se pregunta (`duda.sobre = 'destino'`). Dos destinos: uno por mensaje.
 *   "de <DISTRIBUIDOR>" ("de Gilberto Franco", "de Franco") es una persona: puede ser quien
 *   da o quien recibe. Se pregunta una vez (`duda.motivo = 'rol'`). Con "para/a", o si otro
 *   recibe, no hay duda.
 * - Sin tamano ("Norman regalo 3 a Casa Verde"): si nombra a alguien de la lista, falta =
 *   'piezas' con `cuantas`. Ver `leerSinTamano`.
 * - Quien (lista cerrada, `quienes`; ver `lib/regalos-quien.ts`): lo que va antes
 *   del verbo, o "de X" / X pegado al verbo o a la ultima pieza, o "de parte de X".
 *   "yo"/"regale"/"regalamos"/"Regalo 2…" SIN nombrar a nadie = quien dicta.
 *   Si nombra a alguien que no esta en la lista, empata con dos o no se distingue,
 *   falta = 'quien' con su `duda`: NUNCA se le carga en silencio a quien dicta.
 * - Fecha: "ayer"/"antier" en `diasAtras`; si no, hoy.
 * Si falta UNA cosa, se dice cual. **Pura.**
 */
export function leerRegalo(
  texto: string,
  productos: readonly ProductoRegalo[],
  quienDicta: string,
  quienes: readonly QuienPermitido[] = EQUIPO
): LecturaRegalo {
  const original = quitarOrden(texto)
  const plano = aplanar(original)
  const limpiarMotivo = (t: string) => {
    const sinPuntos = t.replace(/^[\s:,.;\-]+/, '')
    // "para Casa Verde" dice a quien se le dio: el "para" se queda.
    const para = /^para\s+/i.exec(sinPuntos)
    if (para && leerNombre(sinPuntos.slice(para[0].length), quienes)?.clase === 'si') return sinPuntos.trim().slice(0, 300)
    return sinPuntos.replace(/^(y|para|por|en|motivo)\b[\s:,-]*/i, '').trim().slice(0, 300)
  }

  // 0. Verbo.
  const marcaMotivo = /\bmotivo\b\s*(?:es|fue)?\s*[:,-]?\s*/.exec(plano)
  const fin = marcaMotivo ? marcaMotivo.index : plano.length
  const verbos = verbosDeRegalo(plano.slice(0, fin))
  if (verbos.length === 0) return { ok: false, falta: 'no_es_regalo' }
  if (verbos.length > 1) return { ok: false, falta: 'uno_por_mensaje' }
  const regalo = verbos[0]
  const finVerbo = regalo.index + regalo[0].length
  const diasAtras = diasAtrasDe(plano.slice(0, fin))

  // 1. Motivo explicito: se corta para que sus numeros no cuenten como piezas.
  let motivo = marcaMotivo ? limpiarMotivo(original.slice(marcaMotivo.index + marcaMotivo[0].length)) : ''

  // 2. Piezas.
  const piezas: PiezaDictada[] = []
  const tramos: { ini: number; fin: number }[] = []
  const patron = new RegExp(
    `\\b(${NUMERO})\\s+(?:botellas?\\s+|piezas?\\s+)?(?:de\\s+(?:la\\s+|las\\s+)?)?(\\d{2,4}\\s*ml\\b|\\d{2,4}\\b|[a-z]+)`,
    'g'
  )
  const tramo = plano.slice(0, fin)
  for (const p of tramo.matchAll(patron)) {
    const inicio = p.index ?? 0
    // "regalo 2 grandes a una chica": "una chica" es una persona, no una pieza.
    if (/\b(a|para|con)\s$/.test(tramo.slice(Math.max(0, inicio - 6), inicio))) continue
    const cantidad = numeroDictado(p[1])
    const dicho = p[2]
    const candidatos = candidatosPorTamano(dicho, productos)
    if (candidatos.length !== 1) {
      // "regale 3 a Juan" no es un tamano y se ignora; "3 de 500" es un tamano que no existe: se pregunta.
      if (/^\d/.test(dicho) || /^(grande|chic|mini|median|peque)/.test(dicho)) return { ok: false, falta: 'tamano', dicho }
      continue
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) continue
    tramos.push({ ini: inicio, fin: inicio + p[0].length })
    const ya = piezas.find((x) => x.producto.id === candidatos[0].id)
    if (ya) ya.cantidad += cantidad
    else piezas.push({ producto: candidatos[0], cantidad })
  }
  if (piezas.length === 0) return leerSinTamano(original, productos, quienDicta, quienes)
  const finUltimaPieza = tramos[tramos.length - 1].fin

  // 3. Quien lo dice DESPUES del verbo: "regalo una grande de norman en…" (pegado
  //    a una pieza), "regalo Kevin 2 grandes", "regalo de Luis: 3 minis" (pegado al
  //    verbo) o "de parte de X" donde sea. "en la boda de Kevin" NO: es la razon.
  const primeraPersona = /^(e|amos)$/.test(regalo[1] ?? '') || /^é/i.test(original.slice(regalo.index).replace(/^(?:regal|obsequi)/i, ''))
  const producto = new Set(productos.flatMap((p) => aplanar(p.nombre).split(/[^a-z]+/)).filter((w) => w.length >= 3))
  const salto = new RegExp(`^[\\s,.:;-]*(?:del?\\s+(?:la\\s+|las\\s+|los\\s+)?)?(?:${SALTO})\\b`)
  type Hallado = Omit<Candidato, 'lugar'>
  const leerTras = (desde: number, hasta: number): Hallado | null => {
    const cerrado = marcaMotivo !== null && hasta === fin
    let pos = desde
    for (let vuelta = 0; vuelta < 8; vuelta++) {
      const rp = plano.slice(pos, hasta)
      if (/^[\s,]*de\s+(?:(?:mi|nuestra)\s+parte|parte\s+(?:mia|nuestra))\b/.test(rp)) return null
      const de = new RegExp(`^[\\s,.:;-]*(?:(?:(${MARCA_FUERTE})|del|de|(por))\\s+)`).exec(rp)
      if (de) {
        const ini = pos + de[0].length
        const leido = leerNombre(original.slice(ini, hasta), quienes, { producto, cerrado })
        // "por X" sin "motivo:" es la razon, salvo que X este en la lista o parezca un nombre ("por Fany", "por fany").
        const esRazon =
          de[2] !== undefined && !cerrado && leido?.clase === 'duda' && leido.motivo === 'desconocido' && !leido.cerca &&
          !/^(?:\p{L}+|\p{Lu}\p{Ll}+(?: \p{Lu}\p{Ll}+)*)$/u.test(leido.dicho)
        if (leido && !esRazon) return { leido, ini: pos, fin: ini + leido.fin, nombre: ini, fuerte: de[1] !== undefined || de[2] !== undefined, suelto: false }
      } else {
        // Sin "de": "regalo una grande fany", "… la fany", "… (Fany)", "… y fany".
        const orilla = /^[\s,.:;("'-]*([ye]\s+)?/.exec(rp)!
        const hueco = orilla[0].length
        const conY = orilla[1] !== undefined
        // "una grande y una playera": otra cosa, no un nombre.
        if (conY && /^(?:un|una|unos|unas)\s/.test(rp.slice(hueco))) return null
        for (const articulo of ['', /^(?:el|la|los|las|un|una|unos|unas|mi|mis|su|sus|tu|don|dona)\s+/.exec(rp.slice(hueco))?.[0] ?? '']) {
          const ini = pos + hueco + articulo.length
          const leido = leerNombre(original.slice(ini, hasta), quienes, { producto, suelto: true })
          if (leido) return { leido, ini: conY ? pos : pos + hueco, fin: ini + leido.fin, nombre: ini, fuerte: false, suelto: true, ...(conY ? { conY: true as const } : {}) }
        }
      }
      const s = salto.exec(rp)
      if (!s) return null
      pos += s[0].length
    }
    return null
  }

  const candidatos: Candidato[] = []
  const sueltos: Candidato[] = []
  const trasVerbo = leerTras(finVerbo, Math.max(finVerbo, tramos[0].ini))
  if (trasVerbo) candidatos.push({ ...trasVerbo, lugar: 'verbo' })
  tramos.forEach((t, i) => {
    const ultima = i === tramos.length - 1
    const c = leerTras(t.fin, ultima ? fin : tramos[i + 1].ini)
    // Un nombre suelto junto a la pieza se ve aparte: no es tan claro como "de X".
    if (c) (c.suelto ? sueltos : candidatos).push({ ...c, lugar: ultima ? 'ultima' : 'pieza' })
  })
  for (const m of tramo.slice(finVerbo).matchAll(new RegExp(`\\b(?:${MARCA_FUERTE})\\s+`, 'g'))) {
    const ini = finVerbo + (m.index ?? 0)
    if (candidatos.some((c) => ini >= c.ini && ini < c.fin)) continue
    const nombre = ini + m[0].length
    const leido = leerNombre(original.slice(nombre, fin), quienes, { producto, cerrado: marcaMotivo !== null })
    if (leido) candidatos.push({ leido, ini, fin: nombre + leido.fin, nombre, fuerte: true, suelto: false, lugar: 'fuerte' })
  }
  const alFinal = candidatos.find((c) => c.lugar === 'ultima') ?? null

  // 3b. A quien se le dio: "a X", "para X", antes o despues del verbo.
  const explicitos: Receptor[] = []
  const dudasDestino: DudaQuien[] = []
  const deLaRedEn = (l: NombreLeido | null): QuienPermitido | null => (l?.clase === 'si' && esDeLaRed(l.quien) ? l.quien : null)
  const dudaDestino = (l: NombreLeido, nombre: number) => {
    // Solo si se confunde con un distribuidor o local: "a un cliente", "a Juan" no se preguntan.
    if (l.clase !== 'duda' || !l.opciones.some(esDeLaRed) || !(l.motivo === 'ambiguo' || l.cerca)) return
    const ini = original.indexOf(l.dicho, nombre)
    dudasDestino.push({ dicho: l.dicho, motivo: l.motivo, opciones: l.opciones, sobre: 'destino', tramo: [ini, ini + l.dicho.length] })
  }
  const limiteDe = (i: number) => (i < regalo.index ? regalo.index : Math.min(fin, ...tramos.map((x) => x.ini).filter((x) => x >= i)))
  const pegadoA = (i: number) =>
    plano.slice(0, i).trim() === '' ||
    [finVerbo, ...tramos.map((x) => x.fin), ...candidatos.map((c) => c.fin), ...sueltos.map((c) => c.fin)].some((x) => x <= i && /^[\s,.:;-]*$/.test(plano.slice(x, i)))
  const alSon = buscarQuien(limpiarOrillas(original.slice(0, regalo.index)), quienes).ok // "al son regalo 2": ese "al" es de su nombre
  for (const m of tramo.matchAll(/\b(?:a|al|para|pa)\s+/g)) {
    const ini = m.index ?? 0
    if ((alSon && ini < regalo.index) || explicitos.some((r) => ini >= r.ini && ini < r.fin) || candidatos.some((c) => ini >= c.ini && ini < c.fin)) continue
    let nombre = ini + m[0].length
    let leido = leerNombre(original.slice(nombre, limiteDe(nombre)), quienes, { producto })
    const clase = /^(?:(?:el|la|los|las)\s+)?(?:tienda|sucursal|bar|restaurante?|negocio|cliente)\s+/.exec(plano.slice(nombre, limiteDe(nombre)))
    if (clase && leido?.clase !== 'si') {
      const otro = leerNombre(original.slice(nombre + clase[0].length, limiteDe(nombre)), quienes, { producto })
      if (otro?.clase === 'si') {
        nombre += clase[0].length
        leido = otro
      }
    }
    if (leido === null) continue
    if (leido.clase === 'si') explicitos.push({ leido, ini, fin: nombre + leido.fin, nombre })
    else if (pegadoA(ini)) dudaDestino(leido, nombre)
  }
  if (marcaMotivo && explicitos.length === 0) {
    // "Regalo 3 grandes, motivo: para Casa Verde".
    const m = /^(?:a|al|para|pa)\s+/i.exec(motivo)
    const leido = m ? leerNombre(motivo.slice(m[0].length), quienes) : null
    if (deLaRedEn(leido)) explicitos.push({ leido: leido!, ini: fin, fin, nombre: fin })
  }

  // Un local dicho "de X" (o X pegado): es el que RECIBE, salvo que el mensaje ya diga
  // que recibio otro ("de Casa Verde a Gilberto Franco", "de Casa Verde a un cliente").
  const antesDelVerbo = limpiarOrillas(original.slice(0, regalo.index))
  const haySujeto = antesDelVerbo !== '' && !explicitos.some((r) => r.ini < regalo.index) && !/^(?:a|al|para)\s/i.test(antesDelVerbo)
  const recibeOtro = (c: Candidato, quien: QuienPermitido) => {
    if (haySujeto) return false
    if (explicitos.some((r) => r.leido.clase === 'si' && r.leido.quien.nombre !== quien.nombre)) return true
    const enseguida = /^[\s,]*(?:a|al)\s+/.exec(plano.slice(c.fin, fin))
    const antes = /^[\s,]*(?:a|al)\s+/.exec(plano.slice(finVerbo, Math.max(finVerbo, tramos[0].ini)))
    const alguien = (t: string) => {
      const l = leerNombre(t, quienes, { producto })
      return l !== null && !(l.clase === 'si' && l.quien.nombre === quien.nombre)
    }
    return (enseguida !== null && alguien(original.slice(c.fin + enseguida[0].length, fin))) || (antes !== null && alguien(original.slice(finVerbo + antes[0].length, tramos[0].ini)))
  }
  const implicitos = [...candidatos, ...sueltos].filter((c) => {
    const q = deLaRedEn(c.leido)
    return q !== null && !c.fuerte && !recibeOtro(c, q)
  })
  const receptores: Receptor[] = [...explicitos, ...implicitos].filter((r) => deLaRedEn(r.leido) !== null)
  if (haySujeto) for (const c of [...candidatos, ...sueltos]) if (!c.fuerte) dudaDestino(c.leido, c.nombre)
  const nombresDestino = new Set(receptores.map((r) => deLaRedEn(r.leido)!.nombre))
  const enMedio = (r: Receptor) => tramos.length > 1 && r.ini >= tramos[0].fin && r.ini < tramos[tramos.length - 1].ini
  const otroDestino = receptores.some((r) => {
    if (r.ini >= fin || implicitos.includes(r as Candidato)) return false
    const coma = /^\s*,\s*(?:a\s+|al\s+|para\s+)?/.exec(plano.slice(r.fin, fin))
    const otro = coma ? deLaRedEn(leerNombre(original.slice(r.fin + coma[0].length, fin), quienes, { suelto: true })) : null
    return sigueOtraPersona(original.slice(r.fin, limiteDe(r.fin)), quienes) || (otro !== null && !nombresDestino.has(otro.nombre))
  })
  if (nombresDestino.size > 1 || otroDestino || (receptores.length > 0 && receptores.every(enMedio))) {
    return { ok: false, falta: 'uno_por_mensaje', destinos: true }
  }
  const destino = receptores.length > 0 ? deLaRedEn(receptores[0].leido) : null

  // Dos personas (o una venta y un regalo) en el mismo mensaje: uno por mensaje,
  // para no cargarle a una las botellas de la otra.
  const nombres = QUIENES_CONOCIDOS.map((q) => aplanar(q)).join('|') + '|cris'
  // "a Luis Rodriguez" es el que recibe, no Luis el del equipo.
  let sinReceptores = tramo
  for (const r of receptores) if (r.ini < fin) sinReceptores = sinReceptores.slice(0, r.ini) + ' '.repeat(r.fin - r.ini) + sinReceptores.slice(r.fin)
  const despues = sinReceptores.slice(finVerbo, alFinal ? alFinal.fin : finUltimaPieza)
  const nombrados = new Set([...despues.matchAll(new RegExp(`\\b(${nombres})\\b`, 'g'))].map((m) => normalizarQuien(m[1])))
  const otroPegado = [...candidatos, ...sueltos].some((c) => c.lugar !== 'fuerte' && sigueOtraPersona(original.slice(c.fin, fin), quienes))
  // "Regalo una grande en la boda, Fany 2 chicas", "una grande y fany 2 chicas": el segundo nombre, pegado a la segunda pieza.
  const otroEnMedio = tramos.slice(1).some((t, i) => {
    const m = /(?:^\s*,?\s*y\s+|[,;.]\s*(?:y\s+)?)(?:de\s+)?((?:\p{L}+\s+){1,3})$/u.exec(original.slice(tramos[i].fin, t.ini))
    return m !== null && leerNombre(m[1], quienes, { producto, suelto: true }) !== null
  })
  const seguros = new Set(candidatos.flatMap((c) => (c.leido.clase === 'si' ? [c.leido.quien.nombre] : [])))
  if (nombrados.size > 1 || seguros.size > 1 || otroPegado || otroEnMedio || /\b(vend|venta)\w*/.test(plano.slice(0, regalo.index))) {
    return { ok: false, falta: 'uno_por_mensaje' }
  }

  // 4. Quien.
  const deEtiqueta = quienExacto(normalizarQuien(quienDicta), quienes.filter((q) => q.tipo === 'equipo'))
  const hallazgoDicta = deEtiqueta ? null : buscarQuien(quienDicta, quienes)
  const dicta = deEtiqueta ?? (hallazgoDicta?.ok ? hallazgoDicta.quien : null)
  const noEsta = (dicho: string): DudaQuien => {
    const h = buscarQuien(dicho, quienes)
    const cerca = seConfunde(dicho, quienes).length > 0 ? { cerca: true as const } : {}
    return { dicho: dicho.trim().slice(0, 60), motivo: h.ok ? 'cual' : h.motivo, opciones: h.ok ? [h.quien] : h.opciones, ...cerca }
  }

  let quien = ''
  let duda: DudaQuien | undefined
  const antes = original.slice(0, regalo.index)
  let crudo = antesDelVerbo
  // "a Casa Verde le regalé 3", "Norman a Casa Verde le regaló 3", "a fany le regalé una": eso es a quien, no quien.
  let recibeAntes = ''
  if (!alSon) {
    const a = /(?:^|\s)((?:a|al|para)\s+.+)$/i.exec(crudo)
    if (a) {
      recibeAntes = a[1]
      crudo = crudo.slice(0, a.index).replace(/[\s,.;:]+$/, '')
    }
  }
  // "en la feria regalé…": eso es el lugar, no quien. "él regaló": no dice quien.
  if (/^(en|por|para|durante|con|desde)\s/i.test(crudo) || /^(el|ella|ellos|ellas|nosotros|nosotras)$/.test(aplanar(crudo))) crudo = ''
  const abreElMensaje = antes.trim() === ''
  const conAcento = /ó/i.test(original.slice(regalo.index, regalo.index + regalo[0].length + 1))

  if (crudo !== '' && aplanar(crudo) !== 'yo') {
    const h = buscarQuien(crudo, quienes)
    if (h.ok) quien = h.quien.nombre
    else {
      const partes = crudo.split(/\s+(?:y|e)\s+|\s*,\s*/i).filter((x) => x !== '')
      if (partes.length > 1 && partes.some((x) => buscarQuien(x, quienes).ok)) return { ok: false, falta: 'uno_por_mensaje' }
      duda = noEsta(crudo)
    }
  } else if (crudo === '') {
    // Un local dicho "de X" ya es el destino: no cuenta como quien lo regalo.
    const firmes = candidatos.filter((c) => c.leido.clase === 'si' && !implicitos.includes(c))
    const firme = firmes.find((c) => c.lugar !== 'pieza') ?? null
    const dudoso = candidatos.find((c) => c.leido.clase === 'duda') ?? null
    const delQueRecibe = firme || dudoso || implicitos.length > 0 ? null : deDelQueRecibe()
    if (firme && firme.leido.clase === 'si') {
      // "regalé una grande de Kevin", dicho por Norman: ¿quien de los dos?
      if (primeraPersona && firme.leido.quien.nombre !== dicta?.nombre) duda = cual(firme.leido.quien, firme.leido.dicho)
      else quien = firme.leido.quien.nombre
    } else if (dudoso && dudoso.leido.clase === 'duda') {
      duda = dudaEn(dudoso)
    } else if (firmes.length > 0 && firmes[0].leido.clase === 'si' && firmes[0].leido.quien.nombre !== dicta?.nombre) {
      // "una grande de Kevin y 2 chicas": ¿las chicas tambien son de Kevin?
      duda = cual(firmes[0].leido.quien, firmes[0].leido.dicho)
    } else if (delQueRecibe) {
      duda = delQueRecibe
    } else if (firmes.length === 0) {
      // "Regalo una grande, Fany" / "… una grande fany en la feria": un nombre suelto, sin "de" y en minuscula
      // o mayuscula. ¿De quien? Nunca se le carga en silencio a quien dicta.
      const suelto = sueltos.find((c) => !implicitos.includes(c)) ?? null
      if (suelto?.leido.clase === 'si') {
        if (suelto.leido.quien.nombre !== dicta?.nombre) duda = cual(suelto.leido.quien, suelto.leido.dicho)
      } else if (suelto) duda = dudaEn(suelto)
    }
  }
  // "de Gilberto Franco": un distribuidor es una persona. ¿Lo dio, o era para el? No se decide en silencio.
  // "una grande y Casa Verde": tampoco se sabe que hizo. "de Casa Verde" (local) si: es el destino.
  const deRol = implicitos.find((c) => {
    const q = deLaRedEn(c.leido)
    return q !== null && (q.tipo === 'distribuidor' || c.conY === true) && !explicitos.some((r) => deLaRedEn(r.leido)?.nombre === q.nombre)
  })
  const dudaDeRol: DudaQuien | undefined =
    deRol && deRol.leido.clase === 'si' ? { dicho: deRol.leido.dicho, motivo: 'rol', opciones: [deRol.leido.quien], trozo: [deRol.ini, deRol.fin] } : undefined
  duda ??= dudaDeRol
  if (quien === '' && duda === undefined && (aplanar(crudo) === 'yo' || (crudo === '' && primeraPersona) ||
    // "Regalo 2 minis en la expo" (sin acento, abriendo el mensaje y sin nombrar a nadie): es de quien
    // dicta. La propuesta ensena QUIEN antes del VA. "Regaló 2…" sin nombre si se pregunta.
    (abreElMensaje && !conAcento && /^(o|os|itos?)$/.test(regalo[1] ?? '')))) {
    if (dicta) quien = dicta.nombre
    else duda = noEsta(quienDicta)
  }

  function dudaEn(c: Candidato): DudaQuien {
    if (c.leido.clase !== 'duda') return noEsta('')
    const ini = original.indexOf(c.leido.dicho, c.nombre)
    return {
      dicho: c.leido.dicho, motivo: c.leido.motivo, opciones: c.leido.opciones, tramo: [ini, ini + c.leido.dicho.length], trozo: [c.ini, c.fin],
      ...(c.leido.cerca ? { cerca: true as const } : {})
    }
  }

  function cual(otro: QuienPermitido, dicho: string): DudaQuien {
    return { dicho, motivo: 'cual', opciones: dicta ? [otro, dicta] : [otro] }
  }

  /** "Regalo una grande a Juan de Kevin": ¿Juan de Kevin, o lo regalo Kevin? Se pregunta. */
  function deDelQueRecibe(): DudaQuien | null {
    for (const [desde, hasta] of [[finVerbo, tramos[0].ini], [finUltimaPieza, fin]]) {
      const a = /^[\s,]*(?:a|para)\s+/.exec(plano.slice(desde, hasta))
      if (!a) continue
      const resto = original.slice(desde + a[0].length, hasta)
      const recibe = leerNombre(resto, quienes, { producto })
      if (recibe === null || COMUN.test(aplanar(resto).split(/[^a-z]/)[0])) continue
      let corte = recibe.fin
      if (recibe.clase === 'duda' && recibe.motivo === 'desconocido') {
        const de = /\s(?:del|de)\s/.exec(aplanar(recibe.dicho))
        if (!de) continue
        corte = resto.indexOf(recibe.dicho) + de.index
      }
      const cola = /^\s+(?:del|de)\s+/.exec(aplanar(resto.slice(corte)))
      if (!cola) continue
      const otro = leerNombre(resto.slice(corte + cola[0].length), quienes, { producto, suelto: true })
      if (otro === null) continue
      return otro.clase === 'si' ? cual(otro.quien, otro.dicho) : { dicho: otro.dicho, motivo: otro.motivo, opciones: otro.opciones }
    }
    return null
  }

  // 5. Motivo implicito: lo que queda despues de la ultima pieza (y del nombre que ya se uso).
  const esSuyo = (c: Candidato | null) =>
    c !== null &&
    (implicitos.includes(c) ||
    quien !== '' &&
    (c.leido.clase === 'si' ? c.leido.quien.nombre === quien : c.leido.opciones.some((o) => o.nombre === quien)))
  if (!marcaMotivo) {
    let cola = original.slice(finUltimaPieza)
    const usados = [...candidatos, ...sueltos.filter((c) => implicitos.includes(c))].filter((c) => (c.lugar === 'ultima' || c.lugar === 'fuerte') && c.ini >= finUltimaPieza && esSuyo(c))
    for (const c of usados.sort((x, y) => y.ini - x.ini)) {
      cola = cola.slice(0, c.ini - finUltimaPieza) + cola.slice(c.fin - finUltimaPieza)
    }
    motivo = limpiarMotivo(cola)
  }

  // 6. A quien se le dio, si no quedo ya en el motivo: "3 grandes a Casa Verde, motivo: apertura".
  const recibe = (desde: number, hasta: number) =>
    (/^[\s,]*((?:a|al|para)\s[^,.;:]+)/i.exec(original.slice(desde, hasta))?.[1] ?? '')
      .replace(new RegExp(`\\s+(?:${MARCA_FUERTE})\\b.*$`, 'i'), '')
      .trim()
      .slice(0, 80)
  const aQuien = recibeAntes || recibe(finVerbo, Math.max(finVerbo, tramos[0].ini)) || (marcaMotivo ? recibe(finUltimaPieza, fin) : '')
  if (aQuien !== '') motivo = motivo.length < 3 && !marcaMotivo ? aQuien : motivo.length >= 3 ? `${motivo} (${aQuien})`.slice(0, 300) : motivo
  // "Regalo una grande de Casa Verde" y "… para Casa Verde" son lo mismo: la razon, si no se dijo otra, es a quien.
  if (destino && motivo.length < 3 && !marcaMotivo) motivo = `para ${destino.nombre}`

  const conDestino = destino ? { destino } : {}
  if (quien === '') return { ok: false, falta: 'quien', piezas, quien, ...(duda?.motivo === 'rol' ? {} : conDestino), motivo, diasAtras, ...(duda ? { duda } : {}) }
  // "Norman regalo una grande de Gilberto Franco": se sabe quien dicen que fue, pero no que hizo el otro.
  if (dudaDeRol) return { ok: false, falta: 'quien', piezas, quien, motivo, diasAtras, duda: dudaDeRol }
  // Ya se sabe quien; falta saber a cual de los dos se le dio. Un destino dudoso no se adivina.
  if (destino === null && dudasDestino.length > 0) return { ok: false, falta: 'quien', piezas, quien, ...conDestino, motivo, diasAtras, duda: dudasDestino[0] }
  if (motivo.length < 3) return { ok: false, falta: 'motivo', piezas, quien, ...conDestino, motivo, diasAtras }
  return { ok: true, quien, ...conDestino, piezas, motivo, diasAtras }
}

/** Con esto en el mensaje se habla de dinero, no de botellas. */
const DINERO = /\$|\b(?:pesos?|mxn|varos?|lana|dinero|efectivo|propinas?|limosnas?|cost(?:o|aron|ando)|mil)\b/
/** Antes del verbo: es una venta, un gasto o una compra que ademas menciona un regalo. Sigue su camino. */
const OTRA_OPERACION = /\b(?:vend|venta|pag[aoue]|gast|compr|deposit|cobr|transf|abon|cost)\w*/
/** Lo que no puede ir antes del numero de piezas: "a las 3", "el 3", "a 3 clientes", "por sus 15". */
const ANTES_DE_OTRO_NUMERO = /(?:^|\s)(?:de|del|el|la|los|las|a|al|para|pa|en|por|con|dia|numero|no|sus?|mis?|tus?|hasta|desde|cada)\s*$/
const PRODUCTO_SUELTO = 'destilad[oa]s?|mezcal(?:es)?|tequilas?|platas?|licor(?:es)?'
/** Regalar mas de esto sin decir el tamano es dinero, no botellas. */
const MAX_SIN_TAMANO = 99
/** "Regalo 20 para Kevin" (sin verbo conjugado) se parece a un gasto: aqui el tope es mas bajo. */
const MAX_SIN_TAMANO_ORDEN = 24

/** "Regalo 3…", "regalos 3…" abriendo el mensaje y sin acento: la orden, no "el regalo" ni "regalé". */
function esOrdenDeRegalo(original: string, verbo: RegExpExecArray): boolean {
  return original.slice(0, verbo.index).trim() === '' && /^(o|os|itos?)$/.test(verbo[1] ?? '') && !/ó/i.test(original.slice(verbo.index, verbo.index + verbo[0].length + 1))
}

/**
 * Los numeros de piezas dichos SIN tamano: "regalo 3 a Casa Verde", "le regale tres". No
 * cuenta una fecha, una hora, un precio ni el numero de un nombre ("Delirio 85"). `texto`,
 * ya sin la orden de anotar. **Pura.**
 */
export function numerosSueltos(texto: string, quienes: readonly QuienPermitido[]): { ini: number; fin: number; cuantas: number }[] {
  let plano = aplanar(texto)
  for (const q of quienes) {
    const f = aplanar(q.nombre)
    if (!/\d/.test(f)) continue
    for (let i = plano.indexOf(f); i >= 0; i = plano.indexOf(f, i + f.length)) plano = plano.slice(0, i) + 'x'.repeat(f.length) + plano.slice(i + f.length)
  }
  const marca = /\bmotivo\b/.exec(plano)
  const tramo = plano.slice(0, marca ? marca.index : plano.length)
  const verbos = verbosDeRegalo(tramo)
  if (verbos.length !== 1 || DINERO.test(tramo) || OTRA_OPERACION.test(tramo.slice(0, verbos[0].index))) return []
  const finVerbo = verbos[0].index + verbos[0][0].length
  const tope = esOrdenDeRegalo(texto, verbos[0]) ? MAX_SIN_TAMANO_ORDEN : MAX_SIN_TAMANO
  const out: { ini: number; fin: number; cuantas: number }[] = []
  for (const m of tramo.matchAll(new RegExp(`\\b(?:${NUMERO})\\b`, 'g'))) {
    const ini = m.index ?? 0
    const fin = ini + m[0].length
    const cuantas = numeroDictado(m[0])
    if (ini < finVerbo || !Number.isInteger(cuantas) || cuantas < 1 || cuantas > tope) continue
    const entre = tramo.slice(finVerbo, ini)
    if (/[\d.,$#]$/.test(entre) || (ANTES_DE_OTRO_NUMERO.test(entre) && !/^\s*(?:los|las)\s*$/.test(entre))) continue
    const resto = tramo.slice(fin).replace(new RegExp(`^\\s+(?:${PRODUCTO_SUELTO})\\b`), '')
    const corte = tramo.length - resto.length
    const nombre = (desde: number) => {
      const l = leerNombre(texto.slice(desde, tramo.length), quienes, { suelto: true })
      return l !== null && (l.clase === 'si' || l.motivo === 'ambiguo' || l.cerca === true)
    }
    // "3 de Casa Verde", "3 de plata"; "una de sus camisas" y "2 de diciembre" no.
    const de = /^\s+del?\s+(?:(?:la|el|los|las)\s+)?/.exec(resto)
    const sigue = de
      ? new RegExp(`^(?:${PRODUCTO_SUELTO})\\b`).test(resto.slice(de[0].length)) || nombre(corte + de[0].length) || /^parte\b/.test(resto.slice(de[0].length))
      : /^\s*(?:$|[;:)!]|[.,](?!\d)|\s(?:a|al|para|pa|en|por|y|e|con|hoy|ayer|antier|anteayer|tambien|mas)\b)/.test(resto) || nombre(corte)
    if (sigue) out.push({ ini, fin, cuantas })
  }
  return out
}

/**
 * "Norman regalo 3 a Casa Verde": verbo de regalo, numero y alguien de la lista, sin tamano.
 * Antes no se registraba ni se preguntaba y caia al modelo de gastos. Se lee como si hubiera
 * dicho "3 grandes" SOLO para saber si nombra a alguien; si si, se pregunta el tamano. **Pura.**
 */
function leerSinTamano(original: string, productos: readonly ProductoRegalo[], quienDicta: string, quienes: readonly QuienPermitido[]): LecturaRegalo {
  const nada: LecturaRegalo = { ok: false, falta: 'piezas' }
  const numeros = numerosSueltos(original, quienes)
  if (numeros.length === 0) return nada
  const n = numeros[0]
  const marca = /\bmotivo\b/.exec(aplanar(original))
  const tramo = original.slice(0, marca ? marca.index : original.length)
  const verbo = verbosDeRegalo(aplanar(tramo))[0]
  const prueba = leerRegalo(`${original.slice(0, n.fin)} grandes${original.slice(n.fin)}`, productos, quienDicta, quienes)
  const menciona = mencionaA(tramo, quienes)
  if (!prueba.ok && (prueba.falta === 'tamano' || prueba.falta === 'piezas' || prueba.falta === 'no_es_regalo')) return nada
  if (!prueba.ok && prueba.falta === 'uno_por_mensaje') return menciona ? prueba : nada
  const duda = prueba.ok ? undefined : prueba.duda
  const dudaConocida = duda !== undefined && (duda.motivo !== 'desconocido' || duda.sobre === 'destino' || duda.cerca === true)
  // En la orden ("Regalo 20…") quien dicta no cuenta como nombrado: puede ser un gasto.
  const diceQuien = prueba.quien !== '' && !esOrdenDeRegalo(original, verbo)
  if (!(menciona || diceQuien || prueba.destino !== undefined || dudaConocida)) return nada
  // "Norman regalo 3 y Kevin 2": completar el primero perderia el segundo.
  return numeros.length > 1 ? { ok: false, falta: 'uno_por_mensaje' } : { ...nada, cuantas: n.cuantas }
}

/** Lo que va antes del verbo sin "ayer", "ya", "le", "se"… **Pura.** */
function limpiarOrillas(antes: string): string {
  const orillas = 'antes de ayer|antier|anteayer|ayer|hoy|ya|que|pues|bueno|entonces|tambien|también|se|les?|nos|me|l[oa]s?'
  let crudo = antes.trim()
  for (let previo = ''; previo !== crudo; ) {
    previo = crudo
    crudo = crudo
      .replace(new RegExp(`^(?:antes de ayer|antier|anteayer|ayer|hoy|ya|que|pues|bueno|entonces)(?=[\\s,]|$)[\\s,]*`, 'i'), '')
      .replace(new RegExp(`(?:^|[\\s,]+)(?:${orillas})[\\s,]*$`, 'i'), '')
      .replace(/^[\s,.;:]+|[\s,.;:]+$/g, '')
  }
  return crudo
}

/**
 * La respuesta a una duda de nombre. Si lo dudoso es A QUIEN se le dio, o si lo que
 * contestan es un distribuidor o local, la respuesta se pone EN SU LUGAR dentro del
 * dictado ("una grande de casa berde" -> "… de Casa Verde"): asi se lee igual que si
 * lo hubieran dictado bien. Si es una persona, va como quien regalo. **Pura.**
 */
export function contestarDuda(texto: string, duda: DudaQuien | undefined, dicho: string, quienes: readonly QuienPermitido[]): string {
  const d = String(dicho ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  if (d === '') return texto
  if (duda?.motivo === 'rol' && duda.trozo) return contestarRol(texto, duda.opciones[0], duda.trozo, d, quienes)
  const limpio = buscarQuien(d, quienes).ok ? d : d.replace(/^(?:(?:fue|es|era|se le dio|para|al?|del?)\s+)+/i, '')
  const h = buscarQuien(limpio, quienes)
  const enSuLugar = (x: string) => {
    const base = quitarOrden(texto)
    return duda?.tramo ? base.slice(0, duda.tramo[0]) + x + base.slice(duda.tramo[1]) : base
  }
  if (duda?.sobre === 'destino') {
    // Entre «»: ya no se vuelve a leer como alguien de la lista. Queda en el motivo.
    if (!h.ok && NINGUNO.test(aplanar(d))) return enSuLugar(`«${duda.dicho}»`)
    return enSuLugar(limpio)
  }
  if (duda?.tramo && h.ok && esDeLaRed(h.quien)) {
    // A "¿quien fue?" un distribuidor contesta quien lo dio; si contestan "para X", es a quien. No se vuelve a preguntar.
    if (h.quien.tipo === 'distribuidor' && duda.trozo) return contestarRol(texto, h.quien, duda.trozo, RESPONDE_PARA.test(aplanar(d)) ? 'para el' : 'lo dio', quienes)
    return enSuLugar(limpio)
  }
  // "de Gilberto" -> "Gilberto (equipo)": ya dijo cual; si se queda en el texto se volveria a preguntar.
  if (duda?.trozo && duda.sobre !== 'destino' && h.ok && duda.opciones.some((o) => o.nombre === h.quien.nombre)) {
    const base = quitarOrden(texto)
    return completarRegalo((base.slice(0, duda.trozo[0]) + base.slice(duda.trozo[1])).trim(), 'quien', dicho)
  }
  return completarRegalo(texto, 'quien', dicho)
}

/** "para él", "era para Franco", "no, a él", "él lo recibió", "se lo dimos". */
const RESPONDE_PARA = /^(?:(?:no|si|es|era|eran|fue|fueron|son)[\s,]+)*(?:para|pa|a|al)\b|\brecib\w+|\b(?:se l[aeo]s?|les?) (?:di|dio|dimos|regal\w+)\b/
const RELLENO_ROL = /^(?:si|fue|es|era|lo|la|los|las|dio|dieron|el|ella|mismo|de|parte|que|regal\w*|obsequi\w*)$/

/**
 * La respuesta a "¿lo regalo Gilberto Franco o era para el?". El dictado se reescribe sin la
 * ambiguedad: "… para Gilberto Franco", o "Gilberto Franco regaló …". Si contestan otro
 * nombre ("yo", "Kevin"), ese lo dio y era para el. Lo que no se entiende no cambia nada. **Pura.**
 */
function contestarRol(texto: string, quien: QuienPermitido, [ini, fin]: [number, number], dicho: string, quienes: readonly QuienPermitido[]): string {
  const base = quitarOrden(texto)
  const con = (x: string) => (base.slice(0, ini) + x + base.slice(fin)).trim()
  const recibe = con(` para ${quien.nombre}`)
  const p = aplanar(dicho)
  if (RESPONDE_PARA.test(p)) return recibe
  const resto = p.split(/[\s,]+/).filter((w) => w !== '' && !RELLENO_ROL.test(w)).join(' ')
  const h = buscarQuien(resto, quienes)
  const esEl = resto === '' || (h.ok ? h.quien.nombre === quien.nombre : h.motivo === 'ambiguo' && h.opciones.some((o) => o.nombre === quien.nombre))
  if (esEl) return resto === '' && /^(?:si|es|era|no)?$/.test(p) ? texto : completarRegalo(con(''), 'quien', quien.nombre)
  if (resto === 'yo') return completarRegalo(recibe, 'quien', 'yo')
  if (h.ok) return completarRegalo(recibe, 'quien', h.quien.nombre)
  return NINGUNO.test(p) ? con(` «${quien.nombre}»`) : texto
}

/** "Regale una botella en la expo": es un regalo de producto al que le falta el tamano. **Pura.** */
export function nombraBotella(texto: unknown): boolean {
  return /\b(botellas?|botes?|piezas?)\b/.test(aplanar(texto))
}

const TALLA = 'grand\\w*|chic[ao]\\w*|chiquit\\w*|mini\\w*|median\\w*|pequen\\w*|\\d{2,4}(?:\\s*ml\\b)?'
const TALLA_SOLA = new RegExp(`\\b(?:${TALLA})`, 'g')
const CUENTA_CON_TALLA = new RegExp(`\\b(?:${NUMERO})\\s+(?:botellas?\\s+|piezas?\\s+)?(?:de\\s+(?:la\\s+|las\\s+)?)?(?:${TALLA})`, 'g')

const SIN_RAZON = /^(solo\s+|nomas\s+|ya\s+)*(registra\w*|guarda\w*|anota\w*|sin\s+(motivo|razon)|ningun[oa]?|nada|ninguna razon)\b/

/**
 * El dictado a medias + la respuesta a la UNICA pregunta = el dictado completo,
 * que se vuelve a leer entero con `leerRegalo`. "Solo registralo" como respuesta
 * a la razon no bloquea: queda "sin motivo dicho". **Pura.**
 */
export function completarRegalo(texto: string, falta: string, dicho: string, quienes: readonly QuienPermitido[] = EQUIPO): string {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim()
  const d = String(dicho ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  if (d === '') return t
  if (falta === 'motivo') {
    const limpio = d.replace(/^(por|porque|para|en|fue|el motivo (es|fue)|motivo:?)\s+/i, '')
    return `${t.replace(/[,.\s]+$/, '')}, motivo: ${SIN_RAZON.test(aplanar(d)) ? 'sin motivo dicho' : limpio}`
  }
  if (falta === 'quien') {
    const quien = d.replace(/^(fue|lo dio|las dio|lo regalo|lo regaló|de)\s+/i, '')
    // Lo que iba antes del verbo se va (era un nombre que no se reconocio), menos "ayer"/"antier".
    const base = quitarOrden(t)
    const plano = aplanar(base)
    const verbo = verbosDeRegalo(plano)[0]
    if (!verbo || /^(si|no|ok|va)$/i.test(aplanar(quien))) return t
    const tras = base.slice(verbo.index).replace(/^\p{L}+/u, '')
    const cuando = ['', 'ayer ', 'antier '][diasAtrasDe(plano.slice(0, verbo.index))]
    return cuando + (/^yo$/i.test(quien) ? 'yo regalé' : `${quien} regaló`) + tras
  }
  if (falta === 'piezas') {
    // "2 grandes y 1 chica" trae su cuenta y manda; "grandes", "las chicas" o "750" es solo el tamano: el numero ya se dijo.
    const a = aplanar(d.normalize('NFC'))
    const cuentas = [...a.matchAll(CUENTA_CON_TALLA)]
    const tallas = [...new Set(a.match(TALLA_SOLA) ?? [])]
    const ultima = cuentas[cuentas.length - 1]
    const conCuenta = cuentas.length > 0
    const pieza = conCuenta ? a.slice(cuentas[0].index, (ultima.index ?? 0) + ultima[0].length) : tallas.length === 1 ? tallas[0] : ''
    if (pieza === '') return t
    const base = quitarOrden(t)
    const n = numerosSueltos(base, quienes)[0]
    if (n) return conCuenta ? base.slice(0, n.ini) + pieza + base.slice(n.fin) : `${base.slice(0, n.fin)} ${pieza}${base.slice(n.fin)}`
    if (conCuenta) return t.replace(new RegExp(`\\b(?:(?:${NUMERO})\\s+)?(?:botellas?|botes?|piezas?)\\b`, 'i'), pieza)
    // Sin numero dicho, el tamano solo no basta: se queda como estaba.
    return t.replace(new RegExp(`\\b((?:${NUMERO})\\s+)(?:botellas?|botes?|piezas?)\\b`, 'i'), `$1${pieza}`)
  }
  return t
}

/**
 * "regalos", "cuantos regalos lleva Kevin", "mis regalos": se CONSULTA el
 * contador. `null` = no es consulta. `quien: ''` = todos. `otros`: personas que
 * ya estan en la cartera ademas de las del equipo. **Pura.**
 */
export function leerConsultaRegalos(texto: string, quienDicta: string, otros: readonly string[]): { quien: string } | null {
  const plano = aplanar(texto).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!PATRON_REGALO.test(plano)) return null
  const abre =
    /^(?:oye |bot )*(?:los |mis |de )*regalos\b/.test(plano) ||
    /^(?:oye |bot )*(?:cuant|quien|quienes|cuales|que (?:ha|he|hemos|regal)|contador|historial|cuenta de|lista de|total de|dame |pasame |muestra|ensena|ver )/.test(plano)
  if (!abre) return null
  // Con piezas ("regalos Kevin 2 grandes en la expo") es un registro.
  if (new RegExp(`\\b(?:${NUMERO})\\s+(?:botellas?\\s+)?(?:de\\s+)?(?:grand|chic|mini|median|peque|\\d{2,4})`).test(plano)) return null
  if (/^(?:mis regalos)|\b(?:llevo|regalado yo|he regalado)\b/.test(plano)) return { quien: normalizarQuien(quienDicta) }
  // El nombre mas largo primero: "regalos de Gilberto Franco" no es la cuenta de Gilberto.
  for (const n of [...QUIENES_CONOCIDOS, 'Cris', ...otros].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${aplanar(n).replace(/[^a-z0-9 ]/g, ' ')}\\b`).test(plano)) return { quien: normalizarQuien(n) }
  }
  return { quien: '' }
}

/** Lo mismo, con la columna del destino (2026-11-25): sin ella se lee y se escribe como antes. **Pura.** */
export function faltaColumnaDestino(error: unknown): boolean {
  const m =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '')
  return /id_entidad_destino/.test(m) && /does not exist|no existe|42703|schema cache/i.test(m)
}

/**
 * ¿Ya hay uno igual? Mismo dia, mismo destino y mismas piezas: puede ser el mismo
 * regalo dictado dos veces ("Norman regalo 3 a Casa Verde" y "Regalo 3 de Casa
 * Verde"). Solo se AVISA. **Pura.**
 */
export function regaloParecido(
  c: Cartera,
  nuevo: { fecha: string; id_entidad_destino?: string | null; lineas: readonly LineaRegalo[] }
): RegistroCartera | null {
  if (!nuevo.id_entidad_destino) return null
  const piezas = new Map(juntarLineas(nuevo.lineas).map((l) => [l.id_producto, l.cantidad]))
  return (
    c.registros.find(
      (r) =>
        r.fecha === nuevo.fecha &&
        r.id_entidad_destino === nuevo.id_entidad_destino &&
        Object.keys(r.piezasPorProducto).length === piezas.size &&
        [...piezas].every(([id, n]) => r.piezasPorProducto[id] === n)
    ) ?? null
  )
}

/**
 * Borrar un distribuidor o local con regalos: la base lo detiene (llave foranea) para no
 * perder el historial. El texto que se ensena en vez del error crudo; `null` si es otra cosa. **Pura.**
 */
export function mensajeAlBorrarConRegalos(error: { code?: string; message?: string; details?: string | null } | null): string | null {
  if (!error || !/"regalos"|\bregalos_id_entidad\w*/.test(`${error.message ?? ''} ${error.details ?? ''}`)) return null
  if (error.code !== '23503' && !/foreign key/i.test(String(error.message))) return null
  return 'No se borró: tiene regalos registrados y se perdería su historial. Se queda como está; puedes cambiarle el nombre o dejar de usarlo.'
}

/**
 * Si el codigo sale ANTES que la migracion, PostgREST contesta "column
 * inventario_ledger.id_regalo does not exist". Las pantallas que ya existian
 * (Inventario, Feed, KPI de merma) reintentan sin la columna en vez de
 * quedarse en 0 en silencio. **Pura.**
 */
export function faltaColumnaRegalo(error: unknown): boolean {
  const m =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error ?? '')
  return /id_regalo/.test(m) && /does not exist|no existe|42703|schema cache/i.test(m)
}

export function piezasTexto(n: number): string {
  return `${n} ${n === 1 ? 'pieza' : 'piezas'}`
}
