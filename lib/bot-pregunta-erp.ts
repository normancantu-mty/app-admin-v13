/**
 * PREGUNTAS DE CARTERA E INVENTARIO DESDE EL BOT — el lado puro (2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 6). Sin red ni base: se prueba en `tests/bot-pregunta-erp.spec.ts`.
 *
 * **Aqui tampoco hay modelo.** El texto se normaliza y se compara contra
 * palabras fijas y contra los nombres de entidades y productos que vienen de
 * la base. Lo que no casa no se adivina.
 *
 * Lo que contesta (lo llama `interpretarPregunta` de `lib/bot-pregunta.ts`):
 *  - `deuda_cliente`        "cuanto debe Aeropuerto"         -> v_cartera
 *  - `movimientos_cliente`  "ultimos movimientos de Delirio" -> tickets, abonos, cargos, entregas y devoluciones
 *  - `cartera_total`        "quien me debe mas"              -> v_cartera ordenada por deuda
 *  - `stock`                "cuantas botellas de 750 hay"    -> v_stock_por_cubeta
 *  - `inventario`           "inventario total", "insumos"    -> v_stock_por_cubeta + insumos (regla de v_insumos_en_negativo)
 *  - `se_acaba`             "que se esta acabando"           -> v_insumos_en_negativo; el ERP NO tiene minimos
 *
 * Las cifras: deuda = `v_cartera` (la misma fila que la pantalla de Cartera);
 * stock terminado = `v_stock_por_cubeta` (la del /panel); insumos = la regla de
 * `v_insumos_en_negativo` SIN su `HAVING stock < 0` (ver `stockDeInsumos`).
 */

import { buscarPorNombre, normalizarNombre, PALABRAS_VACIAS } from '@/lib/bot-nombres'
import { pesos, piezas, sinDatos } from '@/lib/bot-consultas'
import { fechaHoraParaPersona, fechaParaPersona } from '@/lib/fechas'
import { folioDeTicket } from '@/lib/documento'
import type { FilaCarteraVista, FilaStockPorCubeta } from '@/lib/vistas'

export interface EntidadDePregunta {
  id: string
  nombre: string
  rol: string
}

export interface ProductoDePregunta {
  id: string
  nombre: string
  tipo: string
  unidad_medida?: string | null
  ml_por_unidad?: number | string | null
}

/** Los nombres que la base sabe: con esto se reconoce de quien o de que se habla. */
export interface NombresDelErp {
  entidades: readonly EntidadDePregunta[]
  productos: readonly ProductoDePregunta[]
}

export type PreguntaErp =
  | { tipo: 'deuda_cliente'; cliente: EntidadDePregunta }
  | { tipo: 'movimientos_cliente'; cliente: EntidadDePregunta; n: number }
  | { tipo: 'cartera_total' }
  | { tipo: 'stock'; productos: ProductoDePregunta[]; entidad: EntidadDePregunta | null; matriz: boolean }
  | { tipo: 'inventario'; soloInsumos: boolean }
  | { tipo: 'se_acaba' }
  | { tipo: 'ninguna'; motivo: 'cliente_ambiguo'; para: 'deuda' | 'movimientos'; candidatos: EntidadDePregunta[] }
  | { tipo: 'ninguna'; motivo: 'cliente_no_encontrado'; dicho: string }
  | { tipo: 'ninguna'; motivo: 'entidad_ambigua'; opciones: string[] }

export const MOVIMIENTOS_POR_DEFECTO = 10
export const TOPE_MOVIMIENTOS_CLIENTE = 30
const ROLES_CLIENTE = new Set(['DST', 'LOC'])

function tiene(t: string, ...palabras: string[]): boolean {
  return palabras.some((p) => new RegExp(`(^|\\s)${p}(\\s|$)`).test(t))
}

/** Palabras de la pregunta que nunca son nombre de nadie. */
const GENERICAS = new Set([
  ...PALABRAS_VACIAS,
  'hay', 'cuanto', 'cuanta', 'cuantas', 'cuantos', 'debe', 'deben', 'debo', 'deuda', 'botellas', 'botella',
  'piezas', 'pieza', 'stock', 'inventario', 'movimientos', 'movimiento', 'ultimos', 'ultimas', 'saldo', 'mas',
  'todo', 'todos', 'total', 'tiene', 'tienen', 'queda', 'quedan', 'historial', 'abonos', 'tickets', 'compras',
  'destilado', 'plata', 'pasta', 'guajillo', 'admin', 'ceo', 'matriz', 'cartera', 'quien', 'quienes'
])

/** Lo que sobra de un fragmento "debe <...>" antes de buscar el nombre. */
const VACIAS_FRAGMENTO = new Set([
  ...GENERICAS,
  'me', 'nos', 'te', 'le', 'les', 'a', 'al', 'el', 'la', 'de', 'en', 'y', 'o', 'hoy', 'ahorita', 'ahora',
  'nada', 'dinero', 'pesos', 'lana', 'semana', 'mes', 'ayer', 'este', 'esta', 'pasada', 'pasado', 'dias',
  'cobrar', 'por', 'ya', 'aun', 'todavia', 'cuenta', 'estado'
])

function tokensUtiles(nombre: string): string[] {
  return normalizarNombre(nombre)
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERICAS.has(t) && !/^\d+$/.test(t))
}

/**
 * La entidad nombrada en el texto. Primero el nombre completo (el mas largo
 * gana); luego una palabra que solo esa entidad tiene ("gilberto" -> Gilberto
 * Franco). Dos o mas: ambigua, y se dice cuales. **Pura.**
 */
export function entidadNombrada(
  t: string,
  entidades: readonly EntidadDePregunta[]
): { entidad: EntidadDePregunta } | { ambiguas: EntidadDePregunta[] } | null {
  const texto = normalizarNombre(t)
  let mejor = 0
  let completas: EntidadDePregunta[] = []
  for (const e of entidades) {
    const n = normalizarNombre(e.nombre)
    if (n.length < 3 || !tiene(texto, n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))) continue
    if (n.length > mejor) {
      mejor = n.length
      completas = [e]
    } else if (n.length === mejor) {
      completas.push(e)
    }
  }
  if (completas.length === 1) return { entidad: completas[0] }
  if (completas.length > 1) return { ambiguas: completas }
  const palabras = new Set(texto.split(' '))
  const porPalabra = entidades.filter((e) => tokensUtiles(e.nombre).some((tk) => palabras.has(tk)))
  if (porPalabra.length === 1) return { entidad: porPalabra[0] }
  if (porPalabra.length > 1) return { ambiguas: porPalabra }
  return null
}

const FRAGMENTO =
  /(?:debe|deben|debia|adeuda|deuda de|deuda del|movimientos de|movimientos del|historial de|historial del|abonos de|abonos del|tickets de|tickets del|compras de|compras del|estado de cuenta de|estado de cuenta del|saldo de|saldo del)\s+(.*)$/

/** Lo que se dijo como nombre despues de "debe ..."; '' si no queda nada util. */
export function fragmentoDeNombre(t: string): string {
  const m = FRAGMENTO.exec(normalizarNombre(t))
  if (!m) return ''
  return m[1]
    .split(' ')
    .filter((w) => w !== '' && !VACIAS_FRAGMENTO.has(w) && !/^\d+$/.test(w))
    .join(' ')
}

type ResultadoCliente =
  | { cliente: EntidadDePregunta }
  | { ambiguos: EntidadDePregunta[] }
  | { noEncontrado: string }
  | null

/** El cliente (DST o LOC): nombre en el texto, o `buscarPorNombre` sobre el fragmento. **Pura.** */
export function clienteNombrado(t: string, entidades: readonly EntidadDePregunta[]): ResultadoCliente {
  const clientes = entidades.filter((e) => ROLES_CLIENTE.has(String(e.rol)))
  const enTexto = entidadNombrada(t, clientes)
  if (enTexto && 'entidad' in enTexto) return { cliente: enTexto.entidad }
  if (enTexto) return { ambiguos: enTexto.ambiguas }
  const dicho = fragmentoDeNombre(t)
  if (!dicho) return null
  const hallazgo = buscarPorNombre(dicho, clientes, (e) => [e.nombre])
  if (hallazgo.ok) return { cliente: hallazgo.elegido }
  if (hallazgo.motivo === 'ambiguo') return { ambiguos: hallazgo.candidatos }
  return { noEncontrado: dicho }
}

/** El ml de un producto: su `ml_por_unidad`, o el "250ml" de su nombre. */
function mlDe(p: ProductoDePregunta): number | null {
  const ml = Number(p.ml_por_unidad)
  if (Number.isFinite(ml) && ml > 0) return ml
  const m = /(\d+)\s*ml/.exec(normalizarNombre(p.nombre))
  return m ? Number(m[1]) : null
}

/**
 * Los productos terminados que el texto nombra: por palabra ("pasta",
 * "plata") y por presentacion ("750", "250 ml"). Ninguno = sin filtro. **Pura.**
 */
export function productosNombrados(t: string, productos: readonly ProductoDePregunta[]): ProductoDePregunta[] {
  const texto = normalizarNombre(t)
  const palabras = new Set(texto.split(' '))
  const terminados = productos.filter((p) => p.tipo === 'TERMINADO')
  const porPalabra = terminados.filter((p) =>
    normalizarNombre(p.nombre)
      .split(/[\s-]+/)
      .some((w) => w.length >= 4 && !/\d/.test(w) && palabras.has(w))
  )
  const numeros = new Set([...texto.matchAll(/(?:^|\s)(\d{2,4})\s*(?:ml)?(?=\s|$)/g)].map((m) => Number(m[1])))
  const base = porPalabra.length > 0 ? porPalabra : terminados
  if (numeros.size > 0) {
    const porMl = base.filter((p) => {
      const ml = mlDe(p)
      return ml !== null && numeros.has(ml)
    })
    if (porMl.length > 0) return porMl
  }
  return porPalabra
}

/**
 * Cartera, movimientos de un cliente, stock, inventario, lo que se acaba.
 * `t` ya normalizado. `null` = no es de estas (sigue la Fase 2). **Pura.**
 */
export function interpretarClientesEInventario(t: string, nombres: NombresDelErp): PreguntaErp | null {
  const pideDeuda =
    tiene(t, 'debe', 'deben', 'debo', 'debes', 'debia', 'adeuda', 'deuda', 'deudas', 'deudores', 'deudor', 'cartera') ||
    /por cobrar/.test(t)
  const pideMovs =
    tiene(t, 'movimientos', 'movimiento', 'historial', 'abonos', 'tickets', 'compras') || /estado de cuenta/.test(t)
  const pideSaldo = tiene(t, 'saldo')

  if (pideDeuda || pideMovs || pideSaldo) {
    const r = clienteNombrado(t, nombres.entidades)
    const para = pideMovs ? 'movimientos' : 'deuda'
    if (r && 'ambiguos' in r) return { tipo: 'ninguna', motivo: 'cliente_ambiguo', para, candidatos: r.ambiguos }
    if (r && 'cliente' in r) {
      if (pideMovs) {
        const m = /ultim[oa]s (\d{1,3})/.exec(t)
        const n = m ? Math.max(1, Math.min(TOPE_MOVIMIENTOS_CLIENTE, Number(m[1]))) : MOVIMIENTOS_POR_DEFECTO
        return { tipo: 'movimientos_cliente', cliente: r.cliente, n }
      }
      return { tipo: 'deuda_cliente', cliente: r.cliente }
    }
    if (pideDeuda) {
      if (r && 'noEncontrado' in r) return { tipo: 'ninguna', motivo: 'cliente_no_encontrado', dicho: r.noEncontrado }
      return { tipo: 'cartera_total' }
    }
    // Movimientos o saldo sin cliente: es de una cuenta, lo sigue la Fase 2.
    return null
  }

  if (
    /se (esta|estan|va|van) (acabando|agotando|a acabar|a agotar)|por acabarse|por agotarse|se acaba|se acaban|se agota|se agotan|en negativo|en rojo|hay que (comprar|resurtir)|bajo (el )?minimo|debajo del minimo/.test(
      t
    ) ||
    tiene(t, 'resurtir', 'reabastecer', 'agotado', 'agotados', 'negativos')
  ) {
    return { tipo: 'se_acaba' }
  }

  const pideStock =
    tiene(t, 'botellas', 'botella', 'piezas', 'stock', 'existencia', 'existencias', 'inventario', 'insumo', 'insumos') ||
    /materia prima/.test(t)
  if (!pideStock) return null
  if (tiene(t, 'insumo', 'insumos', 'vacia', 'vacias') || /materia prima/.test(t)) {
    return { tipo: 'inventario', soloInsumos: true }
  }
  const productos = productosNombrados(t, nombres.productos)
  const matriz = tiene(t, 'matriz', 'almacen', 'bodega', 'fabrica')
  let entidad: EntidadDePregunta | null = null
  if (!matriz) {
    const e = entidadNombrada(t, nombres.entidades)
    if (e && 'ambiguas' in e) return { tipo: 'ninguna', motivo: 'entidad_ambigua', opciones: e.ambiguas.map((x) => x.nombre) }
    entidad = e ? e.entidad : null
  }
  if (tiene(t, 'inventario') && productos.length === 0 && !entidad && !matriz) {
    return { tipo: 'inventario', soloInsumos: false }
  }
  return { tipo: 'stock', productos, entidad, matriz }
}

// ─── Las respuestas ─────────────────────────────────────────────────────────

/** 12.5, 3, -0.25: hasta 4 decimales, sin ceros de cola. */
export function cantidad(n: number): string {
  return Number(n).toLocaleString('es-MX', { maximumFractionDigits: 4 })
}

function unidad(u: string | null | undefined): string {
  const x = String(u ?? '').toUpperCase()
  if (x === 'KILOGRAMOS') return 'kg'
  if (x === 'GRAMOS') return 'g'
  if (x === 'LITROS') return 'L'
  if (x === 'PIEZAS') return 'pzas'
  return x.toLowerCase()
}

/** Deuda de UN cliente, de su fila de `v_cartera`. `null` = no esta en la cartera. **Pura.** */
export function textoDeudaCliente(cliente: EntidadDePregunta, fila: FilaCarteraVista | null): string {
  if (!fila) {
    return (
      `${cliente.nombre} no aparece en la cartera (v_cartera solo lista a quien ha recibido mercancia en concesion). ` +
      'No le invento una deuda.'
    )
  }
  const deuda = Number(fila.deuda)
  const lineas = [
    deuda > 0.005
      ? `${fila.nombre} (${fila.rol}) debe ${pesos(deuda)} de concesion.`
      : `${fila.nombre} (${fila.rol}) no debe nada de concesion hoy${deuda < -0.005 ? ` (saldo a su favor ${pesos(-deuda)})` : ''}.`
  ]
  const pagado =
    fila.porcentaje_pagado === null || fila.porcentaje_pagado === undefined
      ? ''
      : ` (${(Number(fila.porcentaje_pagado) * 100).toFixed(1)}% pagado)`
  lineas.push(`Generado ${pesos(Number(fila.generado))} · abonado ${pesos(Number(fila.abonado))}${pagado}`)
  lineas.push(
    fila.ultimo_abono
      ? `Ultimo abono: ${fechaParaPersona(fila.ultimo_abono)}${fila.dias_sin_abono !== null && fila.dias_sin_abono !== undefined ? ` (hace ${fila.dias_sin_abono} d)` : ''}`
      : 'Nunca ha abonado.'
  )
  if (fila.id_acreedor) lineas.push('(esta deuda es con su distribuidor, no con la matriz)')
  return lineas.join('\n')
}

// Movimientos de un cliente --------------------------------------------------

export interface TicketDelCliente {
  id: string
  fecha_transaccion: string | null
  total_cobrado_real: number | string | null
  monto_base_ingreso: number | string | null
  condicion_pago: string | null
  status: string | null
}
export interface DineroDelCliente {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string
  monto: number | string | null
  categoria: string | null
  status: string | null
  es_entrega_efectivo?: boolean | null
}
export interface PiezasDelCliente {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string
  cantidad: number | string | null
  id_producto: string | null
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  status: string | null
}

export interface EventoDelCliente {
  fecha: string
  texto: string
}

const anulado = (s: string | null | undefined) => String(s ?? 'ACTIVO').toUpperCase() === 'ANULADO'

/**
 * Los movimientos de un cliente, con las MISMAS reglas que `v_cartera`:
 * tickets no anulados (concesion suma: DST su `monto_base_ingreso`, LOC su
 * `total_cobrado_real`), CARGO_DEUDA suma, ABONO_DEUDA resta salvo
 * ABONO_PENDIENTE, nada con `es_entrega_efectivo`. Mas las piezas: entregas en
 * concesion y devoluciones fisicas (las del mismo momento se juntan). **Pura.**
 */
export function eventosDelCliente(
  cliente: EntidadDePregunta,
  tickets: readonly TicketDelCliente[],
  dinero: readonly DineroDelCliente[],
  piezasMovs: readonly PiezasDelCliente[],
  nombreProducto: ReadonlyMap<string, string>
): EventoDelCliente[] {
  const eventos: EventoDelCliente[] = []
  for (const t of tickets) {
    if (anulado(t.status) || !t.fecha_transaccion) continue
    const folio = folioDeTicket(t.id)
    if (t.condicion_pago === 'CONCESION') {
      const suma = cliente.rol === 'DST' ? t.monto_base_ingreso : t.total_cobrado_real
      eventos.push({ fecha: t.fecha_transaccion, texto: `Ticket ${folio} en concesion: suma ${pesos(Number(suma ?? 0))} a la deuda` })
    } else {
      eventos.push({
        fecha: t.fecha_transaccion,
        texto: `Ticket ${folio} ${String(t.condicion_pago ?? '').toLowerCase() || 'sin condicion'}: ${pesos(Number(t.total_cobrado_real ?? 0))} (no suma a la deuda)`
      })
    }
  }
  for (const d of dinero) {
    if (anulado(d.status) || d.es_entrega_efectivo || !d.fecha_movimiento) continue
    if (d.tipo_movimiento === 'ABONO_DEUDA') {
      eventos.push({
        fecha: d.fecha_movimiento,
        texto:
          d.categoria === 'ABONO_PENDIENTE'
            ? `Abono pendiente de confirmar: ${pesos(Number(d.monto ?? 0))} (todavia no resta)`
            : `Abono: resta ${pesos(Number(d.monto ?? 0))}`
      })
    } else if (d.tipo_movimiento === 'CARGO_DEUDA') {
      eventos.push({
        fecha: d.fecha_movimiento,
        texto: `Cargo${d.categoria ? ` (${d.categoria.toLowerCase()})` : ''}: suma ${pesos(Number(d.monto ?? 0))} a la deuda`
      })
    }
  }
  const grupos = new Map<string, { fecha: string; etiqueta: string; total: number; porProducto: Map<string, number> }>()
  for (const p of piezasMovs) {
    if (anulado(p.status) || !p.fecha_movimiento) continue
    let etiqueta: string | null = null
    if (p.tipo_movimiento === 'ENTRADA_CONCESION' && p.id_entidad_destino === cliente.id) etiqueta = 'Entrega en concesion'
    if (p.tipo_movimiento === 'DEVOLUCION_FISICA' && p.id_entidad_origen === cliente.id) etiqueta = 'Devolucion'
    if (!etiqueta) continue
    const k = `${p.fecha_movimiento}|${etiqueta}`
    const g = grupos.get(k) ?? { fecha: p.fecha_movimiento, etiqueta, total: 0, porProducto: new Map<string, number>() }
    const c = Math.abs(Number(p.cantidad ?? 0))
    const nombre = (p.id_producto && nombreProducto.get(p.id_producto)) || '(producto no encontrado)'
    g.total += c
    g.porProducto.set(nombre, (g.porProducto.get(nombre) ?? 0) + c)
    grupos.set(k, g)
  }
  for (const g of grupos.values()) {
    const detalle = [...g.porProducto.entries()].map(([n, c]) => `${cantidad(c)} ${n}`).join(', ')
    eventos.push({ fecha: g.fecha, texto: `${g.etiqueta}: ${piezas(g.total)} (${detalle})` })
  }
  return eventos.sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha))
}

export function textoMovimientosCliente(
  cliente: EntidadDePregunta,
  fila: FilaCarteraVista | null,
  eventos: readonly EventoDelCliente[],
  n: number
): string {
  const cabeza = `ULTIMOS MOVIMIENTOS — ${cliente.nombre} (${cliente.rol})`
  const deuda = fila ? `Debe hoy: ${pesos(Number(fila.deuda))} (v_cartera)` : 'No aparece en la cartera (v_cartera).'
  if (eventos.length === 0) return `${cabeza}\n${deuda}\n\nNo encuentro movimientos de ${cliente.nombre}.`
  const lineas = [cabeza, deuda, '']
  for (const e of eventos.slice(0, n)) lineas.push(`${fechaHoraParaPersona(e.fecha)}  ${e.texto}`)
  if (eventos.length > n) lineas.push(`... y ${eventos.length - n} mas antes. Pide "ultimos ${Math.min(TOPE_MOVIMIENTOS_CLIENTE, eventos.length)} movimientos de ${cliente.nombre}".`)
  return lineas.join('\n')
}

// Stock e inventario -----------------------------------------------------------

function sumarPor<T>(filas: readonly T[], llave: (f: T) => string, valor: (f: T) => number): Map<string, number> {
  const m = new Map<string, number>()
  for (const f of filas) m.set(llave(f), (m.get(llave(f)) ?? 0) + valor(f))
  return m
}

const ordenDesc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'))

/**
 * "Cuantas botellas hay": total, por producto y por lugar, de
 * `v_stock_por_cubeta` (solo TERMINADO, solo stock > 0). **Pura.**
 */
export function textoBotellas(
  todas: readonly FilaStockPorCubeta[],
  p: Extract<PreguntaErp, { tipo: 'stock' }>,
  rolDe: ReadonlyMap<string, string>
): string {
  const esMatriz = (id: string) => rolDe.get(id) === 'ADMIN'
  const idsProd = new Set(p.productos.map((x) => x.id))
  const filas = todas.filter(
    (f) =>
      Number(f.stock) > 0 &&
      (idsProd.size === 0 || idsProd.has(f.id_producto)) &&
      (p.entidad ? f.id_entidad === p.entidad.id : p.matriz ? esMatriz(f.id_entidad) : true)
  )
  const donde = p.entidad ? ` en ${p.entidad.nombre}` : p.matriz ? ' en la matriz' : ''
  const que = p.productos.length > 0 ? p.productos.map((x) => x.nombre).join(', ') : 'producto terminado'
  if (filas.length === 0) {
    return `${que}${donde}: no hay existencia. (v_stock_por_cubeta solo lista stock mayor que cero; si no sale, no hay piezas ahi.)`
  }
  const total = filas.reduce((s, f) => s + Number(f.stock), 0)
  const lineas = [`BOTELLAS — ${que}${donde}: ${piezas(total)}`]
  const porProducto = sumarPor(filas, (f) => f.producto, (f) => Number(f.stock))
  if (porProducto.size > 1 || p.entidad || p.matriz) {
    lineas.push('', 'Por producto:')
    for (const [n, c] of ordenDesc(porProducto)) lineas.push(`   ${n}: ${piezas(c)}`)
  }
  if (!p.entidad && !p.matriz) {
    const porLugar = sumarPor(filas, (f) => `${f.entidad}${esMatriz(f.id_entidad) ? ' (matriz)' : ''}`, (f) => Number(f.stock))
    lineas.push('', 'Por lugar:')
    for (const [n, c] of ordenDesc(porLugar)) lineas.push(`   ${n}: ${piezas(c)}`)
  } else {
    const porCubeta = sumarPor(filas, (f) => f.cubeta, (f) => Number(f.stock))
    lineas.push('', `Cubeta: ${ordenDesc(porCubeta).map(([c, n]) => `${c} ${cantidad(n)}`).join(' · ')}`)
  }
  return lineas.join('\n')
}

/** Las listas de `v_insumos_en_negativo` (y de `v_stock_por_cubeta`), tal cual. */
export const ENTRADAS_DE_LA_VISTA = new Set([
  'ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION', 'AJUSTE_INVENTARIO'
])
export const SALIDAS_DE_LA_VISTA = new Set([
  'SALIDA_VENTA', 'MERMA', 'TRASPASO', 'EGRESO_TRASPASO', 'SALIDA_CONCESION', 'DEVOLUCION_FISICA'
])
export const STATUS_DE_LA_VISTA = ['ACTIVO', 'APPROVED'] as const

export interface MovimientoDeInsumo {
  id_producto: string | null
  tipo_movimiento: string | null
  cantidad: number | string | null
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  status: string | null
}

export interface StockDeInsumo {
  id_entidad: string
  entidad: string
  id_producto: string
  insumo: string
  unidad_medida: string | null
  stock: number
}

/**
 * Stock de cada insumo por entidad: el cuerpo de `v_insumos_en_negativo` SIN su
 * `HAVING stock < 0`. Suma en destino lo que es entrada, resta en origen lo que
 * es salida (un traslado cae en las dos), solo ACTIVO/APPROVED, redondeo a 4.
 * Contrastada con datos reales el 2026-11-07 (SELECT de solo lectura): 15/15
 * insumos iguales al cuerpo de la vista sin el HAVING; tabla en
 * Socio/planes/DESDE_EJECUTOR_bot_erp_paridad_web_2026-11-07.md (Auditoria). **Pura.**
 */
export function stockDeInsumos(
  movs: readonly MovimientoDeInsumo[],
  insumos: readonly ProductoDePregunta[],
  entidades: readonly EntidadDePregunta[]
): StockDeInsumo[] {
  const insumo = new Map(insumos.filter((p) => p.tipo === 'INSUMO').map((p) => [p.id, p]))
  const nombreEnt = new Map(entidades.map((e) => [e.id, e.nombre]))
  const acumulado = new Map<string, number>()
  const sumar = (idEnt: string | null, idProd: string, x: number) => {
    if (!idEnt || !nombreEnt.has(idEnt)) return
    const k = `${idEnt}|${idProd}`
    acumulado.set(k, (acumulado.get(k) ?? 0) + x)
  }
  for (const m of movs) {
    if (!m.id_producto || !insumo.has(m.id_producto)) continue
    if (!STATUS_DE_LA_VISTA.includes(String(m.status) as (typeof STATUS_DE_LA_VISTA)[number])) continue
    const tipo = String(m.tipo_movimiento ?? '')
    const c = Number(m.cantidad ?? 0)
    if (ENTRADAS_DE_LA_VISTA.has(tipo)) sumar(m.id_entidad_destino, m.id_producto, c)
    if (SALIDAS_DE_LA_VISTA.has(tipo)) sumar(m.id_entidad_origen, m.id_producto, -c)
  }
  return [...acumulado.entries()]
    .map(([k, stock]) => {
      const [idEnt, idProd] = k.split('|')
      const p = insumo.get(idProd)!
      return {
        id_entidad: idEnt,
        entidad: nombreEnt.get(idEnt) ?? '?',
        id_producto: idProd,
        insumo: p.nombre,
        unidad_medida: p.unidad_medida ?? null,
        stock: Math.round(stock * 10000) / 10000
      }
    })
    .sort((a, b) => a.insumo.localeCompare(b.insumo, 'es') || a.entidad.localeCompare(b.entidad, 'es'))
}

function lineaInsumo(i: StockDeInsumo, esMatriz: boolean): string {
  const donde = esMatriz ? '' : ` (en ${i.entidad})`
  const aviso = i.stock < 0 ? '  ⚠️ negativo' : ''
  return `   ${i.insumo}${donde}: ${cantidad(i.stock)} ${unidad(i.unidad_medida)}${aviso}`
}

/** "Inventario total": terminado por producto (matriz y red) + insumos. **Pura.** */
export function textoInventario(
  terminado: readonly FilaStockPorCubeta[],
  insumos: readonly StockDeInsumo[],
  catalogo: readonly ProductoDePregunta[],
  rolDe: ReadonlyMap<string, string>,
  soloInsumos: boolean
): string {
  const esMatriz = (id: string) => rolDe.get(id) === 'ADMIN'
  const lineas: string[] = ['INVENTARIO']
  if (!soloInsumos) {
    const filas = terminado.filter((f) => Number(f.stock) > 0)
    const total = filas.reduce((s, f) => s + Number(f.stock), 0)
    const enMatriz = filas.filter((f) => esMatriz(f.id_entidad)).reduce((s, f) => s + Number(f.stock), 0)
    lineas.push('', `Producto terminado: ${piezas(total)} (${cantidad(enMatriz)} en la matriz, ${cantidad(total - enMatriz)} en la red)`)
    const porProducto = sumarPor(filas, (f) => f.producto, (f) => Number(f.stock))
    const porProductoMatriz = sumarPor(filas.filter((f) => esMatriz(f.id_entidad)), (f) => f.producto, (f) => Number(f.stock))
    for (const [n, c] of ordenDesc(porProducto)) lineas.push(`   ${n}: ${piezas(c)} (${cantidad(porProductoMatriz.get(n) ?? 0)} en la matriz)`)
    const sinExistencia = catalogo.filter((p) => p.tipo === 'TERMINADO' && !porProducto.has(p.nombre)).map((p) => p.nombre)
    if (sinExistencia.length) lineas.push(`   Sin existencia en ningun lado: ${sinExistencia.join(', ')}`)
  }
  lineas.push('', 'Insumos:')
  if (insumos.length === 0) lineas.push('   ' + sinDatos('insumos'))
  for (const i of insumos) lineas.push(lineaInsumo(i, esMatriz(i.id_entidad)))
  const conMovimiento = new Set(insumos.map((i) => i.id_producto))
  const sinMov = catalogo.filter((p) => p.tipo === 'INSUMO' && !conMovimiento.has(p.id)).map((p) => p.nombre)
  if (sinMov.length) lineas.push(`   Sin un solo movimiento (no se sabe cuanto hay): ${sinMov.join(', ')}`)
  return lineas.join('\n')
}

export interface InsumoNegativo {
  entidad: string
  insumo: string
  unidad_medida: string | null
  stock: number | string
  faltante: number | string
}

export const NO_HAY_MINIMOS =
  'El ERP no tiene un minimo de reorden por producto, asi que no te digo "por debajo del minimo": no hay umbral con que comparar.'

/** "Que se esta acabando": negativos de la vista + lo que menos queda en la matriz. **Pura.** */
export function textoSeAcaba(
  negativos: readonly InsumoNegativo[],
  terminado: readonly FilaStockPorCubeta[],
  insumos: readonly StockDeInsumo[],
  catalogo: readonly ProductoDePregunta[],
  rolDe: ReadonlyMap<string, string>
): string {
  const esMatriz = (id: string) => rolDe.get(id) === 'ADMIN'
  const lineas = ['LO QUE SE ESTA ACABANDO', '']
  if (negativos.length === 0) {
    lineas.push('En negativo (v_insumos_en_negativo): ninguno.')
  } else {
    lineas.push(`En negativo (v_insumos_en_negativo): ${negativos.length}`)
    for (const n of negativos) {
      lineas.push(`   ${n.insumo} en ${n.entidad}: ${cantidad(Number(n.stock))} ${unidad(n.unidad_medida)} (se consumio ${cantidad(Number(n.faltante))} mas de lo que se capturo)`)
    }
  }
  lineas.push('', NO_HAY_MINIMOS)
  const enMatriz: { nombre: string; c: number; u: string }[] = []
  const termMatriz = sumarPor(terminado.filter((f) => esMatriz(f.id_entidad) && Number(f.stock) > 0), (f) => f.producto, (f) => Number(f.stock))
  for (const [n, c] of termMatriz) enMatriz.push({ nombre: n, c, u: 'pzas' })
  for (const i of insumos) if (esMatriz(i.id_entidad) && i.stock >= 0) enMatriz.push({ nombre: i.insumo, c: i.stock, u: unidad(i.unidad_medida) })
  const sinExistencia = catalogo.filter((p) => p.tipo === 'TERMINADO' && !termMatriz.has(p.nombre)).map((p) => p.nombre)
  if (sinExistencia.length) lineas.push('', `Terminado sin existencia en la matriz: ${sinExistencia.join(', ')}`)
  if (enMatriz.length) {
    // Auditoria 2026-11-07: 180 g no es "menos" que 5 kg ni que 30 pzas. Se
    // ordena DENTRO de cada unidad, nunca entre unidades.
    lineas.push('', 'Lo que menos queda en la matriz, por unidad (solo el orden, sin umbral):')
    const porUnidad = new Map<string, typeof enMatriz>()
    for (const x of enMatriz) porUnidad.set(x.u, [...(porUnidad.get(x.u) ?? []), x])
    for (const [u, xs] of [...porUnidad].sort((a, b) => a[0].localeCompare(b[0]))) {
      lineas.push(`   En ${u}:`)
      for (const x of xs.sort((a, b) => a.c - b.c).slice(0, 3)) lineas.push(`      ${x.nombre}: ${cantidad(x.c)} ${x.u}`)
    }
  }
  return lineas.join('\n')
}
