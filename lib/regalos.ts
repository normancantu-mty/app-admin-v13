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

// ─── Quien regalo ───────────────────────────────────────────────────────────

/** Los del equipo; cualquier otro nombre entra como texto libre. */
export const QUIENES_CONOCIDOS = ['Norman', 'Kevin', 'Cristian', 'Gilberto', 'Luis'] as const

function aplanar(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/** "kevin" -> "Kevin"; "  Juan Perez " -> "Juan Perez"; vacio -> "". **Pura.** */
export function normalizarQuien(texto: unknown): string {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  if (limpio === '') return ''
  const plano = aplanar(limpio)
  for (const q of QUIENES_CONOCIDOS) if (plano === aplanar(q)) return q
  return limpio
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
}

export interface PresentacionCartera {
  id_producto: string
  producto: string
  ml_por_unidad: number | null
}

export interface GrupoCartera {
  clave: string
  piezasPorProducto: Record<string, number>
  piezas: number
}

export interface RegistroCartera {
  id_regalo: string
  fecha: string
  quien_regalo: string
  motivo: string
  usuario_creador: string | null
  piezasPorProducto: Record<string, number>
  piezas: number
}

export interface Cartera {
  presentaciones: PresentacionCartera[]
  porPersona: GrupoCartera[]
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
export function armarCartera(lineas: readonly LineaCartera[]): Cartera {
  const pres = new Map<string, PresentacionCartera>()
  const personas = new Map<string, GrupoCartera>()
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
        piezasPorProducto: {},
        piezas: 0
      })
    }
    sumar(personas.get(quien)!, l)
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
    porMes: [...meses.values()].sort((a, b) => b.clave.localeCompare(a.clave)),
    total,
    registros: [...regs.values()].sort((a, b) => b.fecha.localeCompare(a.fecha) || a.id_regalo.localeCompare(b.id_regalo))
  }
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

/** El renglon de una persona: "Kevin: 12 botellas (5 de 750ml, …)". **Pura.** */
export function renglonDePersona(c: Cartera, quien: string): string {
  const g = c.porPersona.find((x) => aplanar(x.clave) === aplanar(quien)) ?? vacio(normalizarQuien(quien))
  return renglonContador(g, c.presentaciones)
}

/**
 * El contador: botellas por persona, por presentacion y total. Con `quien`, la
 * cuenta de esa persona y cada regalo con su razon. Nunca dinero. **Pura.**
 */
export function textoContador(c: Cartera, quien: string): string {
  if (quien !== '') {
    const suyos = c.registros.filter((r) => aplanar(r.quien_regalo) === aplanar(quien))
    const lista = suyos
      .slice(0, REGISTROS_EN_CHAT)
      .map((r) => `- ${r.fecha}: ${detalleTexto(r.piezasPorProducto, c.presentaciones)}. ${r.motivo}`)
    const mas = suyos.length > REGISTROS_EN_CHAT ? [`… y ${suyos.length - REGISTROS_EN_CHAT} mas en el panel (Regalos).`] : []
    return ['REGALOS de ' + renglonDePersona(c, quien), ...lista, ...mas].join('\n')
  }
  if (c.registros.length === 0) return 'Todavia no hay regalos registrados.'
  return [
    'REGALOS (botellas por persona)',
    ...c.porPersona.map((g) => renglonContador(g, c.presentaciones)),
    renglonContador({ ...c.total, clave: 'TOTAL' }, c.presentaciones)
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

export type LecturaRegalo =
  | { ok: true; quien: string; piezas: PiezaDictada[]; motivo: string; diasAtras: number }
  | { ok: false; falta: 'no_es_regalo' }
  | { ok: false; falta: 'uno_por_mensaje' }
  | { ok: false; falta: 'piezas' }
  | { ok: false; falta: 'quien' | 'motivo'; piezas: PiezaDictada[]; quien: string; motivo: string; diasAtras: number }
  | { ok: false; falta: 'tamano'; dicho: string }

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
 * - Quien: lo que va antes del verbo, o un nombre del equipo pegado al verbo o a
 *   la ultima pieza; "yo"/"regale"/"regalamos"/"Regalo 2…" = quien dicta.
 * - Fecha: "ayer"/"antier" en `diasAtras`; si no, hoy.
 * Si falta UNA cosa, se dice cual. **Pura.**
 */
export function leerRegalo(texto: string, productos: readonly ProductoRegalo[], quienDicta: string): LecturaRegalo {
  // NFC: asi `aplanar` conserva las posiciones (una letra acentuada = una letra).
  let original = String(texto ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  const orden = ORDEN_DE_ANOTAR.exec(aplanar(original))
  if (orden) original = original.slice(orden[0].length)
  const plano = aplanar(original)
  const limpiarMotivo = (t: string) =>
    t.replace(/^[\s:,.;\-]+/, '').replace(/^(y|para|por|en|motivo)\b[\s:,-]*/i, '').trim().slice(0, 300)

  // 0. Verbo.
  const marcaMotivo = /\bmotivo\b\s*(?:es|fue)?\s*[:,-]?\s*/.exec(plano)
  const fin = marcaMotivo ? marcaMotivo.index : plano.length
  const verbos = verbosDeRegalo(plano.slice(0, fin))
  if (verbos.length === 0) return { ok: false, falta: 'no_es_regalo' }
  if (verbos.length > 1) return { ok: false, falta: 'uno_por_mensaje' }
  const regalo = verbos[0]
  const diasAtras = diasAtrasDe(plano.slice(0, fin))

  // 1. Motivo explicito: se corta para que sus numeros no cuenten como piezas.
  let motivo = marcaMotivo ? limpiarMotivo(original.slice(marcaMotivo.index + marcaMotivo[0].length)) : ''

  // 2. Piezas.
  const piezas: PiezaDictada[] = []
  let finUltimaPieza = -1
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
    finUltimaPieza = inicio + p[0].length
    const ya = piezas.find((x) => x.producto.id === candidatos[0].id)
    if (ya) ya.cantidad += cantidad
    else piezas.push({ producto: candidatos[0], cantidad })
  }
  if (piezas.length === 0) return { ok: false, falta: 'piezas' }

  // 3. Quien lo dice DESPUES del verbo: "regalo una grande de norman en…" (pegado
  //    a la ultima pieza) o "regalo Kevin 2 grandes", "regalo de Luis: 3 minis"
  //    (pegado al verbo). "en la boda de Kevin" NO: eso es la razon.
  const verbo = regalo[1] ?? ''
  const primeraPersona = /^(e|amos)$/.test(verbo)
  const nombres = QUIENES_CONOCIDOS.map((q) => aplanar(q)).join('|')
  const trasPieza = new RegExp(`^[\\s,]*(?:de|por|lo\\s+dio)\\s+(?:parte\\s+de\\s+)?(${nombres})\\b`).exec(tramo.slice(finUltimaPieza))
  const trasVerbo = new RegExp(`^\\s*(?:de\\s+)?(?:parte\\s+de\\s+)?(${nombres})\\b`).exec(tramo.slice(regalo.index + regalo[0].length))
  const dichoDespues = primeraPersona ? null : (trasVerbo ?? trasPieza)

  // Dos personas (o una venta y un regalo) en el mismo mensaje: uno por mensaje,
  // para no cargarle a una las botellas de la otra.
  const despues = tramo.slice(regalo.index + regalo[0].length, finUltimaPieza + (trasPieza?.[0].length ?? 0))
  const nombrados = new Set([...despues.matchAll(new RegExp(`\\b(${nombres})\\b`, 'g'))].map((m) => m[1]))
  const otroPegado = new RegExp(`^[\\s,]*(?:y|e)\\s+(?:de\\s+)?(${nombres})\\b`).test(tramo.slice(finUltimaPieza + (trasPieza?.[0].length ?? 0)))
  if (nombrados.size > 1 || (trasPieza && otroPegado) || /\b(vend|venta)\w*/.test(plano.slice(0, regalo.index))) {
    return { ok: false, falta: 'uno_por_mensaje' }
  }

  // 4. Motivo implicito: lo que queda despues de la ultima pieza (y de ese nombre).
  if (!marcaMotivo) {
    const desde = finUltimaPieza + (!primeraPersona && trasPieza ? trasPieza[0].length : 0)
    motivo = limpiarMotivo(original.slice(desde))
  }

  // 5. Quien.
  let quien = ''
  const sujeto = plano
    .slice(0, regalo.index)
    .replace(/\b(hoy|ayer|antier|anteayer|antes|de|ya|se|le|les|nos|me|que|el|la)\b/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const abreElMensaje = plano.slice(0, regalo.index).trim() === ''
  const conAcento = /ó/i.test(original.slice(regalo.index, regalo.index + regalo[0].length))
  if (sujeto === '' && dichoDespues) {
    quien = normalizarQuien(dichoDespues[1])
  } else if (
    sujeto === 'yo' ||
    (sujeto === '' && primeraPersona) ||
    // "Regalo 2 minis en la expo" (sin acento y abriendo el mensaje): es de quien dicta.
    // La propuesta ensena QUIEN antes del VA. "Regaló 2…" sin nombre si se pregunta.
    (abreElMensaje && !conAcento && /^(o|os|itos?)$/.test(verbo))
  ) {
    quien = normalizarQuien(quienDicta)
  } else if (sujeto !== '') {
    const conocidos = QUIENES_CONOCIDOS.filter((q) => sujeto.split(' ').includes(aplanar(q)))
    // Uno solo de los tres: su nombre. Dos o mas ("Norman y Kevin"): el texto tal cual.
    if (conocidos.length === 1 && sujeto.split(' ').length <= 2) quien = conocidos[0]
    else {
      const ini = plano.indexOf(sujeto)
      quien = normalizarQuien(ini >= 0 ? original.slice(ini, ini + sujeto.length) : sujeto)
    }
  }

  if (quien === '') return { ok: false, falta: 'quien', piezas, quien, motivo, diasAtras }
  if (motivo.length < 3) return { ok: false, falta: 'motivo', piezas, quien, motivo, diasAtras }
  return { ok: true, quien, piezas, motivo, diasAtras }
}

/** "Regale una botella en la expo": es un regalo de producto al que le falta el tamano. **Pura.** */
export function nombraBotella(texto: unknown): boolean {
  return /\b(botellas?|botes?|piezas?)\b/.test(aplanar(texto))
}

const SIN_RAZON = /^(solo\s+|nomas\s+|ya\s+)*(registra\w*|guarda\w*|anota\w*|sin\s+(motivo|razon)|ningun[oa]?|nada|ninguna razon)\b/

/**
 * El dictado a medias + la respuesta a la UNICA pregunta = el dictado completo,
 * que se vuelve a leer entero con `leerRegalo`. "Solo registralo" como respuesta
 * a la razon no bloquea: queda "sin motivo dicho". **Pura.**
 */
export function completarRegalo(texto: string, falta: string, dicho: string): string {
  const t = String(texto ?? '').replace(/\s+/g, ' ').trim()
  const d = String(dicho ?? '').replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  if (d === '') return t
  if (falta === 'motivo') {
    const limpio = d.replace(/^(por|porque|para|en|fue|el motivo (es|fue)|motivo:?)\s+/i, '')
    return `${t.replace(/[,.\s]+$/, '')}, motivo: ${SIN_RAZON.test(aplanar(d)) ? 'sin motivo dicho' : limpio}`
  }
  if (falta === 'quien') {
    const quien = d.replace(/^(fue|lo dio|las dio|lo regalo|lo regaló|de)\s+/i, '')
    if (/^yo$/i.test(quien)) return t.replace(/^(se|le|les|nos)?\s*(regal|obsequi)\w*/i, 'yo regalé')
    return t.replace(/^(?:(?:se|le|les|nos)\s+)?((?:regal|obsequi)\S*)/i, `${quien} regaló`)
  }
  if (falta === 'piezas') {
    const conNumero = new RegExp(`\\b(?:(?:${NUMERO})\\s+)?(?:botellas?|botes?|piezas?)\\b`, 'i')
    const trae = new RegExp(`^(?:${NUMERO})\\s`, 'i').test(aplanar(d))
    return trae ? t.replace(conNumero, d) : t.replace(/\b(?:botellas?|botes?|piezas?)\b/i, d)
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
    /^(?:oye |bot )*(?:cuant|quien|quienes|cuales|que (?:ha|he|hemos|regal)|contador|cuenta de|lista de|total de|dame |pasame |muestra|ensena|ver )/.test(plano)
  if (!abre) return null
  // Con piezas ("regalos Kevin 2 grandes en la expo") es un registro.
  if (new RegExp(`\\b(?:${NUMERO})\\s+(?:botellas?\\s+)?(?:de\\s+)?(?:grand|chic|mini|median|peque|\\d{2,4})`).test(plano)) return null
  if (/^(?:mis regalos)|\b(?:llevo|regalado yo|he regalado)\b/.test(plano)) return { quien: normalizarQuien(quienDicta) }
  for (const n of [...QUIENES_CONOCIDOS, ...otros]) {
    if (new RegExp(`\\b${aplanar(n).replace(/[^a-z0-9 ]/g, ' ')}\\b`).test(plano)) return { quien: normalizarQuien(n) }
  }
  return { quien: '' }
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
