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
 * - La cartera: piezas por persona, por mes y por presentacion, y su valor a
 *   costo del catalogo (si el producto tiene costo capturado).
 */

import { candidatosPorTamano } from '@/lib/bot-tamanos'

// ─── Quien regalo ───────────────────────────────────────────────────────────

/** Los tres de siempre; cualquier otro nombre entra como texto libre. */
export const QUIENES_CONOCIDOS = ['Norman', 'Kevin', 'Gilberto'] as const

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
 * PAGADO primero, lo que falte de CONSIGNADO, y si aun falta, de PAGADO otra
 * vez (queda negativo). Un stock negativo se trata como 0 para repartir.
 * Misma regla que la rama ERP-11b (`calcularDeduccionCascada` sin el alto). **Pura.**
 */
export function repartoRegalo(cantidad: number, stock: StockCelda) {
  const pagado = Math.max(0, Number(stock.pagado) || 0)
  const consignado = Math.max(0, Number(stock.consignado) || 0)
  const deConsignado = Math.min(Math.max(0, cantidad - Math.min(cantidad, pagado)), consignado)
  const dePagado = cantidad - deConsignado
  const faltante = Math.max(0, cantidad - pagado - consignado)
  return { dePagado, deConsignado, faltante }
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
      const hay = Math.max(0, stock.pagado) + Math.max(0, stock.consignado)
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
  costo_unitario: number | null
  costo_cero_confirmado: boolean | null
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
  /** Valor a costo de lo que SI tiene costo. */
  costo: number
  /** Piezas de productos sin costo capturado (costo 0 no confirmado). */
  piezasSinCosto: number
}

export interface RegistroCartera {
  id_regalo: string
  fecha: string
  quien_regalo: string
  motivo: string
  usuario_creador: string | null
  piezasPorProducto: Record<string, number>
  piezas: number
  costo: number
  piezasSinCosto: number
}

export interface Cartera {
  presentaciones: PresentacionCartera[]
  porPersona: GrupoCartera[]
  porMes: GrupoCartera[]
  total: GrupoCartera
  registros: RegistroCartera[]
}

function sinCosto(l: LineaCartera): boolean {
  return !(Number(l.costo_unitario) > 0) && !l.costo_cero_confirmado
}

function vacio(clave: string): GrupoCartera {
  return { clave, piezasPorProducto: {}, piezas: 0, costo: 0, piezasSinCosto: 0 }
}

function sumar(g: { piezasPorProducto: Record<string, number>; piezas: number; costo: number; piezasSinCosto: number }, l: LineaCartera) {
  const n = Number(l.piezas) || 0
  g.piezasPorProducto[l.id_producto] = (g.piezasPorProducto[l.id_producto] ?? 0) + n
  g.piezas += n
  if (sinCosto(l)) g.piezasSinCosto += n
  else g.costo = Math.round((g.costo + n * (Number(l.costo_unitario) || 0)) * 100) / 100
}

/**
 * Totales por persona y por mes (AAAA-MM de la fecha del regalo), en piezas por
 * presentacion y a costo; y la lista de registros, el mas reciente primero.
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
        piezas: 0,
        costo: 0,
        piezasSinCosto: 0
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

// ─── Lo que se dicta al bot ─────────────────────────────────────────────────

/** ¿El texto habla de regalar? Antes de gastar una peticion. **Pura.** */
export const PATRON_REGALO = /\b(regal\w*|obsequi\w*)\b/

export function hablaDeRegalo(texto: unknown): boolean {
  return PATRON_REGALO.test(aplanar(texto))
}

const PALABRAS_NUMERO: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, quince: 15, veinte: 20
}

export interface PiezaDictada {
  producto: ProductoRegalo
  cantidad: number
}

export type LecturaRegalo =
  | { ok: true; quien: string; piezas: PiezaDictada[]; motivo: string }
  | { ok: false; falta: 'piezas' }
  | { ok: false; falta: 'quien' | 'motivo'; piezas: PiezaDictada[]; quien: string; motivo: string }
  | { ok: false; falta: 'tamano'; dicho: string }

/**
 * "Kevin regalo 5 grandes, 5 chicas y 2 minis, motivo: evento X".
 *
 * - Piezas: cada "<numero> <tamano>" ("5 grandes", "dos de 750", "2 minis"),
 *   resuelto con el vocabulario de `lib/bot-tamanos.ts` (D53: chica = 250,
 *   mini = 50). Un tamano que no empata con el catalogo NO se adivina.
 * - Motivo: lo que sigue a "motivo"; si no lo hay, lo que sigue a la ultima
 *   pieza ("... 2 minis en la boda de Juan" -> "la boda de Juan").
 * - Quien: lo que va antes de "regalo"; "yo"/"regale"/"regalamos" = quien
 *   dicta (`quienDicta`); Norman/Kevin/Gilberto se normalizan, otro nombre va
 *   como texto libre.
 * Si falta UNA cosa, se dice cual. **Pura.**
 */
export function leerRegalo(texto: string, productos: readonly ProductoRegalo[], quienDicta: string): LecturaRegalo {
  // NFC: asi `aplanar` conserva las posiciones (una letra acentuada = una letra).
  const original = String(texto ?? '').normalize('NFC').replace(/\s+/g, ' ').trim()
  const plano = aplanar(original)
  const limpiarMotivo = (t: string) =>
    t.replace(/^[\s:,.;\-]+/, '').replace(/^(y|para|por|en|motivo)\b[\s:,-]*/i, '').trim().slice(0, 300)

  // 1. Motivo explicito: se corta para que sus numeros no cuenten como piezas.
  let motivo = ''
  let fin = plano.length
  const marca = /\bmotivo\b\s*(?:es|fue)?\s*[:,-]?\s*/.exec(plano)
  if (marca) {
    motivo = limpiarMotivo(original.slice(marca.index + marca[0].length))
    fin = marca.index
  }

  // 2. Piezas.
  const piezas: PiezaDictada[] = []
  let finUltimaPieza = -1
  const patron =
    /\b(\d{1,4}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte)\s+(?:botellas?\s+|piezas?\s+)?(?:de\s+(?:la\s+|las\s+)?)?(\d{2,4}\s*ml\b|\d{2,4}\b|[a-z]+)/g
  for (const p of plano.slice(0, fin).matchAll(patron)) {
    const cantidad = /^\d+$/.test(p[1]) ? Number(p[1]) : PALABRAS_NUMERO[p[1]]
    const dicho = p[2]
    const candidatos = candidatosPorTamano(dicho, productos)
    if (candidatos.length !== 1) {
      // "regale 3 a Juan" no es un tamano y se ignora; "3 de 500" es un tamano que no existe: se pregunta.
      if (/^\d/.test(dicho) || /^(grande|chic|mini|median|peque)/.test(dicho)) return { ok: false, falta: 'tamano', dicho }
      continue
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) continue
    finUltimaPieza = (p.index ?? 0) + p[0].length
    const ya = piezas.find((x) => x.producto.id === candidatos[0].id)
    if (ya) ya.cantidad += cantidad
    else piezas.push({ producto: candidatos[0], cantidad })
  }
  if (piezas.length === 0) return { ok: false, falta: 'piezas' }

  // 3. Motivo implicito: lo que queda despues de la ultima pieza.
  if (!marca) motivo = limpiarMotivo(original.slice(finUltimaPieza))

  // 4. Quien.
  let quien = ''
  const regalo = /\bregal(\w*)|\bobsequi(\w*)/.exec(plano)
  const verbo = regalo ? (regalo[1] ?? regalo[2] ?? '') : ''
  const sujeto = regalo
    ? plano.slice(0, regalo.index).replace(/\b(hoy|ayer|ya|se|le|les|nos|me|que|el|la)\b/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  if (sujeto === 'yo' || (sujeto === '' && /^(e|amos)$/.test(verbo))) {
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

  if (quien === '') return { ok: false, falta: 'quien', piezas, quien, motivo }
  if (motivo.length < 3) return { ok: false, falta: 'motivo', piezas, quien, motivo }
  return { ok: true, quien, piezas, motivo }
}

export function piezasTexto(n: number): string {
  return `${n} ${n === 1 ? 'pieza' : 'piezas'}`
}
