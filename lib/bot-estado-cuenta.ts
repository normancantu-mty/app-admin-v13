/**
 * ESTADO DE CUENTA DE UN CLIENTE, PARA LA IMAGEN DEL BOT (2026-11-23) — el lado puro.
 *
 * Escrito el 2026-11-23 por un ejecutor del Socio. Sin red ni base: se prueba en
 * `tests/bot-estado-cuenta.spec.ts`.
 *
 * Las cifras siguen las MISMAS reglas que `v_cartera`: ticket en concesion suma
 * (DST su `monto_base_ingreso`, LOC su `total_cobrado_real`), CARGO_DEUDA suma,
 * ABONO_DEUDA resta salvo ABONO_PENDIENTE, nada anulado, nada con
 * `es_entrega_efectivo`. **El saldo final tiene que ser igual, al centavo, a
 * `v_cartera.deuda`. Si no lo es, no hay imagen: se dice.**
 *
 * Aqui no se inventa: ni precios (salen del detalle del ticket o del costo de la
 * entrega, y SOLO si su suma da el importe), ni fechas, ni nombres. La
 * `descripcion` de los cargos no se lee: trae notas internas del arranque.
 */

import { clienteNombrado, type EntidadDePregunta, type ProductoDePregunta } from '@/lib/bot-pregunta-erp'
import { cuentaNombrada, type CuentaDePregunta } from '@/lib/bot-pregunta'
import { normalizarNombre } from '@/lib/bot-nombres'
import { pesos } from '@/lib/bot-consultas'
import { hoyEnMX } from '@/lib/date-format'
import { folioDeTicket } from '@/lib/documento'
import type { FilaCarteraVista } from '@/lib/vistas'

export interface TicketDeEstado {
  id: string
  fecha_transaccion: string | null
  total_cobrado_real: number | string | null
  monto_base_ingreso: number | string | null
  condicion_pago: string | null
  status: string | null
}
export interface DetalleDeEstado {
  id_ticket: string
  id_producto: string | null
  cantidad: number | string | null
  precio_unitario: number | string | null
  subtotal_linea: number | string | null
}
export interface DineroDeEstado {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string
  monto: number | string | null
  categoria: string | null
  status: string | null
  es_entrega_efectivo?: boolean | null
  metodo_pago?: string | null
}
export interface PiezasDeEstado {
  id: string
  fecha_movimiento: string | null
  tipo_movimiento: string
  cantidad: number | string | null
  id_producto: string | null
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  status: string | null
  costo_unitario_movimiento?: number | string | null
  notas?: string | null
}

export interface PiezaDeMovimiento {
  presentacion: string
  cantidad: number
  /** `null`: el desglose no da el importe del movimiento, asi que no se ensena. */
  precio: number | null
  importe: number | null
}
export interface MovimientoDeEstado {
  tipo: 'inicial' | 'entrega' | 'cargo' | 'abono'
  fecha: string
  concepto: string
  detalle: string
  /** Con signo: los abonos van negativos. */
  importe: number
  saldo: number
  piezas: PiezaDeMovimiento[]
  total_piezas: number
}
export interface EstadoDeCuenta {
  cliente: string
  corte: string
  saldo: number
  movimientos: MovimientoDeEstado[]
  resumen: { inicial: number; entregas: number; otros_cargos: number; abonos: number; piezas: number; saldo: number }
  notas: string[]
}

export type ResultadoEstado =
  | { cuadra: true; estado: EstadoDeCuenta }
  | { cuadra: false; saldoCalculado: number | null; deudaCartera: number; motivo: string }

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

/** `27 oct 2026`, en hora de Mexico. */
export function fechaCorta(instante: string): string {
  const [y, m, d] = hoyEnMX(new Date(instante)).split('-').map(Number)
  return `${d} ${MESES[m - 1].slice(0, 3)} ${y}`
}

/** `23 de noviembre de 2026`, de un `AAAA-MM-DD` de Mexico. */
export function fechaLarga(hoy: string): string {
  const [y, m, d] = hoy.split('-').map(Number)
  return `${d} de ${MESES[m - 1]} de ${y}`
}

const anulado = (s: string | null | undefined) => String(s ?? 'ACTIVO').toUpperCase() === 'ANULADO'
const aCentavos = (x: unknown): number | null => {
  if (x === null || x === undefined || x === '') return null
  const n = Number(x)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

function presentacionDe(p: ProductoDePregunta | undefined): string {
  if (!p) return 'producto sin dato'
  const ml = Number(p.ml_por_unidad)
  if (/^Destilado Plata\b/i.test(p.nombre) && Number.isFinite(ml) && ml > 0) return `${ml} ml`
  return p.nombre
}

interface LineaCruda {
  id_producto: string | null
  cantidad: unknown
  precio: unknown
  importe: unknown
}

/**
 * Las piezas de un movimiento, por presentacion (la grande primero). El precio y
 * el importe van SOLO si la suma de todas las lineas da el importe al centavo.
 */
function piezasDe(lineas: readonly LineaCruda[], centavos: number, productos: ReadonlyMap<string, ProductoDePregunta>): PiezaDeMovimiento[] {
  const grupos = new Map<string, { presentacion: string; ml: number; cantidad: number; precio: number | null; importe: number | null }>()
  for (const l of lineas) {
    const p = l.id_producto ? productos.get(l.id_producto) : undefined
    const c = Math.abs(Number(l.cantidad ?? 0))
    if (!Number.isFinite(c) || c === 0) continue
    const precio = aCentavos(l.precio)
    const importe = aCentavos(l.importe) ?? (precio === null ? null : Math.round(precio * c))
    const k = `${l.id_producto ?? '?'}|${precio ?? '?'}`
    const g = grupos.get(k) ?? { presentacion: presentacionDe(p), ml: Number(p?.ml_por_unidad) || 0, cantidad: 0, precio, importe: 0 as number | null }
    g.cantidad += c
    g.importe = g.importe === null || importe === null ? null : g.importe + importe
    grupos.set(k, g)
  }
  const xs = [...grupos.values()].sort((a, b) => b.ml - a.ml || a.presentacion.localeCompare(b.presentacion, 'es'))
  const suma = xs.reduce<number | null>((s, x) => (s === null || x.importe === null ? null : s + x.importe), 0)
  const daElImporte =
    xs.length > 0 &&
    suma === centavos &&
    xs.every((x) => x.precio !== null && x.importe !== null && Math.round(x.precio * x.cantidad) === x.importe)
  return xs.map((x) => ({
    presentacion: x.presentacion,
    cantidad: x.cantidad,
    precio: daElImporte ? (x.precio as number) / 100 : null,
    importe: daElImporte ? (x.importe as number) / 100 : null
  }))
}

function abonoPor(metodo: string | null | undefined): string {
  const m = String(metodo ?? '').toUpperCase()
  if (m === 'EFECTIVO') return 'Abono en efectivo'
  if (m === 'TRANSFERENCIA') return 'Abono por transferencia'
  return 'Abono'
}

const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

/** El estado de cuenta, o por que no se puede armar. **Pura.** */
export function armarEstadoDeCuenta(d: {
  cliente: EntidadDePregunta
  fila: FilaCarteraVista
  /** Nombre del distribuidor con quien es la deuda (`v_cartera.id_acreedor`), si lo hay. */
  acreedor: string | null
  tickets: readonly TicketDeEstado[]
  detalles: readonly DetalleDeEstado[]
  dinero: readonly DineroDeEstado[]
  piezas: readonly PiezasDeEstado[]
  productos: readonly ProductoDePregunta[]
  hoy: string
}): ResultadoEstado {
  const { cliente, fila } = d
  const deudaCartera = Number(fila.deuda)
  const deudaCentavos = aCentavos(fila.deuda)
  const no = (motivo: string, saldo: number | null): ResultadoEstado => ({
    cuadra: false,
    saldoCalculado: saldo === null ? null : saldo / 100,
    deudaCartera,
    motivo
  })
  if (deudaCentavos === null) return no('la deuda de v_cartera no es un numero', null)

  const productos = new Map(d.productos.map((p) => [p.id, p]))
  const crudos: (Omit<MovimientoDeEstado, 'saldo' | 'fecha' | 'importe'> & { cuando: string; centavos: number })[] = []
  const notas: string[] = []
  let contado = 0

  for (const t of d.tickets) {
    if (anulado(t.status)) continue
    if (t.condicion_pago !== 'CONCESION') {
      contado += 1
      continue
    }
    const centavos = aCentavos(cliente.rol === 'DST' ? t.monto_base_ingreso : t.total_cobrado_real)
    if (centavos === null || !t.fecha_transaccion) return no(`al ticket ${folioDeTicket(t.id)} le falta el importe o la fecha`, null)
    const lineas = d.detalles
      .filter((x) => x.id_ticket === t.id)
      .map((x) => ({ id_producto: x.id_producto, cantidad: x.cantidad, precio: x.precio_unitario, importe: x.subtotal_linea }))
    const piezas = piezasDe(lineas, centavos, productos)
    crudos.push({
      tipo: 'entrega',
      cuando: t.fecha_transaccion,
      concepto: 'Entrega de mercancía',
      detalle: `Folio ${folioDeTicket(t.id)}`,
      centavos,
      piezas,
      total_piezas: piezas.reduce((s, x) => s + x.cantidad, 0)
    })
  }

  // Entradas que no son de un ticket (el arranque): se pegan al cargo del MISMO instante.
  const recibidas = d.piezas.filter(
    (p) =>
      !anulado(p.status) &&
      p.tipo_movimiento === 'ENTRADA_CONCESION' &&
      p.id_entidad_destino === cliente.id &&
      !String(p.notas ?? '').startsWith('ticket:')
  )
  const usadas = new Set<string>()
  let pendiente = 0

  for (const m of d.dinero) {
    if (anulado(m.status) || m.es_entrega_efectivo) continue
    if (m.tipo_movimiento !== 'CARGO_DEUDA' && m.tipo_movimiento !== 'ABONO_DEUDA') continue
    const monto = aCentavos(m.monto)
    if (monto === null || !m.fecha_movimiento) return no('a un movimiento de dinero le falta el monto o la fecha', null)
    if (m.tipo_movimiento === 'ABONO_DEUDA') {
      if (m.categoria === 'ABONO_PENDIENTE') {
        pendiente += monto
        continue
      }
      crudos.push({ tipo: 'abono', cuando: m.fecha_movimiento, concepto: abonoPor(m.metodo_pago), detalle: '', centavos: -monto, piezas: [], total_piezas: 0 })
      continue
    }
    const inicial = m.categoria === 'ARRANQUE'
    const suyas = inicial
      ? recibidas.filter((p) => !usadas.has(p.id) && p.fecha_movimiento && Date.parse(p.fecha_movimiento) === Date.parse(m.fecha_movimiento as string))
      : []
    suyas.forEach((p) => usadas.add(p.id))
    const piezas = piezasDe(
      suyas.map((p) => ({ id_producto: p.id_producto, cantidad: p.cantidad, precio: p.costo_unitario_movimiento, importe: null })),
      monto,
      productos
    )
    crudos.push({
      tipo: inicial ? 'inicial' : 'cargo',
      cuando: m.fecha_movimiento,
      concepto: inicial ? 'Saldo inicial' : 'Cargo a la cuenta',
      detalle: inicial ? 'Registrado en el sistema a esa fecha' : '',
      centavos: monto,
      piezas,
      total_piezas: piezas.reduce((s, x) => s + x.cantidad, 0)
    })
  }

  // Mismo instante: primero lo que suma.
  crudos.sort((a, b) => Date.parse(a.cuando) - Date.parse(b.cuando) || b.centavos - a.centavos)
  let saldo = 0
  const suma = { inicial: 0, entrega: 0, cargo: 0, abono: 0 }
  let piezasTotal = 0
  const movimientos = crudos.map(({ cuando, centavos, ...x }): MovimientoDeEstado => {
    saldo += centavos
    suma[x.tipo] += centavos
    piezasTotal += x.total_piezas
    return { ...x, fecha: fechaCorta(cuando), importe: centavos / 100, saldo: saldo / 100 }
  })
  if (saldo !== deudaCentavos) return no('la suma de los movimientos no da la deuda de la cartera', saldo)

  if (d.acreedor) notas.push(`Este saldo es con su distribuidor: ${d.acreedor}.`)
  if (movimientos.some((m) => m.total_piezas > 0 && m.piezas.some((p) => p.precio === null)))
    notas.push('Sin precio por pieza donde el desglose registrado no da el importe.')
  if (pendiente > 0) notas.push(`Abono pendiente de confirmar: ${pesos(pendiente / 100)} (todavía no resta).`)
  if (contado > 0) notas.push(`No incluye ${plural(contado, 'compra de contado', 'compras de contado')}: no suman al saldo.`)
  const sueltas = recibidas.filter((p) => !usadas.has(p.id)).reduce((s, p) => s + Math.abs(Number(p.cantidad ?? 0)), 0)
  if (sueltas > 0) notas.push(`Hay ${plural(sueltas, 'pieza recibida', 'piezas recibidas')} sin importe registrado.`)
  const devueltas = d.piezas
    .filter((p) => !anulado(p.status) && p.tipo_movimiento === 'DEVOLUCION_FISICA' && p.id_entidad_origen === cliente.id)
    .reduce((s, p) => s + Math.abs(Number(p.cantidad ?? 0)), 0)
  if (devueltas > 0) notas.push(`${plural(devueltas, 'pieza devuelta', 'piezas devueltas')}.`)

  return {
    cuadra: true,
    estado: {
      cliente: cliente.nombre,
      corte: fechaLarga(d.hoy),
      saldo: saldo / 100,
      movimientos,
      resumen: {
        inicial: suma.inicial / 100,
        entregas: suma.entrega / 100,
        otros_cargos: suma.cargo / 100,
        abonos: suma.abono === 0 ? 0 : -suma.abono / 100,
        piezas: piezasTotal,
        saldo: saldo / 100
      },
      notas
    }
  }
}

// ─── De quien se habla ──────────────────────────────────────────────────────

export type QuienEs =
  | { tipo: 'cliente'; cliente: EntidadDePregunta }
  | { tipo: 'ambiguo'; candidatos: EntidadDePregunta[]; cuenta: string | null }
  | { tipo: 'cuenta' }
  | { tipo: 'no_encontrado'; dicho: string | null }

/** Una entidad del sistema, no un cliente. */
const NO_ES_CLIENTE = 'pendiente de asignar'

/** El nombre completo del cliente aparece tal cual. */
function nombreCompleto(texto: string, cliente: EntidadDePregunta): boolean {
  return ` ${normalizarNombre(texto)} `.includes(` ${normalizarNombre(cliente.nombre)} `)
}

/**
 * De quien es el estado de cuenta que se pide. Una CUENTA de dinero ("Efectivo
 * de Aeropuerto", "Spin") no es un cliente: eso lo contesta `/api/bot/pregunta`.
 * "Gilberto" es a la vez una cuenta y un cliente: se pregunta. **Pura.**
 */
export function quienEs(texto: string, entidades: readonly EntidadDePregunta[], cuentas: readonly CuentaDePregunta[]): QuienEs {
  const clientes = entidades.filter((e) => normalizarNombre(e.nombre) !== NO_ES_CLIENTE)
  const r = clienteNombrado(texto, clientes)
  const c = cuentaNombrada(texto, cuentas)
  const cuenta = c === null ? null : 'cuenta' in c ? c.cuenta.nombre : c.ambiguas.map((x) => x.nombre).join(' / ')
  if (r && 'cliente' in r) {
    if (cuenta === null) return { tipo: 'cliente', cliente: r.cliente }
    if (nombreCompleto(texto, r.cliente)) {
      // "efectivo de aeropuerto": el nombre del cliente es parte del de la cuenta.
      return nombreCompleto(cuenta, r.cliente) ? { tipo: 'cuenta' } : { tipo: 'cliente', cliente: r.cliente }
    }
    return { tipo: 'ambiguo', candidatos: [r.cliente], cuenta }
  }
  if (r && 'ambiguos' in r) return { tipo: 'ambiguo', candidatos: r.ambiguos, cuenta }
  if (cuenta !== null) return { tipo: 'cuenta' }
  return { tipo: 'no_encontrado', dicho: r && 'noEncontrado' in r ? r.noEncontrado : null }
}

// ─── Lo que se dice ─────────────────────────────────────────────────────────

export function textoAmbiguo(q: Extract<QuienEs, { tipo: 'ambiguo' }>): string {
  if (q.cuenta !== null && q.candidatos.length === 1) {
    return (
      `"${q.candidatos[0].nombre}" es cliente y tambien hay una cuenta de dinero: ${q.cuenta}. ` +
      `Si es el cliente, toca su boton. Si es la cuenta, pide "movimientos de ${q.cuenta}". Todavia no mando imagen.`
    )
  }
  return `Me da mas de un cliente: ${q.candidatos.map((c) => c.nombre).join(', ')}. ¿Cual de ellos? Todavia no mando imagen.`
}

export function textoNoEncontrado(dicho: string | null): string {
  return dicho
    ? `No encuentro a "${dicho}" entre los clientes del ERP. Dime el nombre como esta en el ERP; no mando imagen de quien no es.`
    : '¿De que cliente? Dime el nombre como esta en el ERP: "estado de cuenta de Aeropuerto".'
}

export function textoSinCartera(cliente: EntidadDePregunta): string {
  return `${cliente.nombre} no aparece en la cartera: no ha recibido mercancia en concesion. No hay estado de cuenta que mandar.`
}

export function textoNoCuadra(cliente: EntidadDePregunta, r: Extract<ResultadoEstado, { cuadra: false }>): string {
  const calculado = r.saldoCalculado === null ? '' : `Los movimientos suman ${pesos(r.saldoCalculado)} y la cartera dice ${pesos(r.deudaCartera)}. `
  return `No mando el estado de cuenta de ${cliente.nombre}: ${r.motivo}. ${calculado}Hay que revisarlo en el ERP.`
}

/** El pie de la foto. Sin pie de consulta largo: Telegram lo corta a 1,024. */
export function leyendaDeEstado(e: EstadoDeCuenta): string {
  return `Estado de cuenta de ${e.cliente}, al ${e.corte}. Saldo por pagar: ${pesos(e.saldo)} (igual a la cartera del ERP).`
}
