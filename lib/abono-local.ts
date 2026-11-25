/**
 * EL ABONO DEL DISTRIBUIDOR QUE SURTE A SU PROPIO LOCAL EN CONCESION.
 *
 * REGLAS_COMERCIALES.md, opcion (i) de Norman: la deuda del DST nace al 80% y
 * baja `(local + red - base) x Base` por botella cuando pasa a su local. "Es un
 * asiento por traspaso DST -> LOC."
 *
 * POR QUE `CARGO_DEUDA` CON MONTO NEGATIVO y no `ABONO_DEUDA`: no es un pago.
 * Un ABONO_DEUDA mueve `ultimo_abono` / `dias_sin_abonar`, infla los abonos del
 * dia, cuenta como cobro del ticket del LOCAL (`app/actions/abonos.ts` suma por
 * `id_ticket`) y esconde la venta del historial.
 *
 * QUE MUEVE, completo: `v_cartera` y `saldo_pendiente_consignacion` (la deuda
 * baja, que es lo que se quiere) Y TAMBIEN `saldo_por_pagar_efectivo`, que suma
 * todo CARGO_DEUDA aunque aqui no haya efectivo. La vista no se toca: las cuatro
 * pantallas que pintan ese saldo lo corrigen con `saldoPorPagarSinAbonoLocal`.
 * Sin cuenta de origen ni de destino: no mueve saldos de cuenta ni impuestos.
 *
 * Puro: sin red y sin base. Lo llaman `lib/venta-servidor.ts` y las pantallas.
 */
import { abonoPorBotellaLocal } from './reglas-comerciales'
import { comisionBaseLocalDecimal } from './comision-base-local'

export const TIPO_ABONO_LOCAL = 'CARGO_DEUDA'
export const CATEGORIA_ABONO_LOCAL = 'COMISION_LOCAL'

/** Como se lee en pantallas, ticket y bot. Un solo texto. */
export const ETIQUETA_ABONO_LOCAL = 'Abono por surtir a sus locales'
export const TIPO_FILA_ABONO_LOCAL = 'ABONO POR SURTIR A SUS LOCALES'

/**
 * ¿Este movimiento BAJA la deuda por surtir a un local? Las tres condiciones: un
 * CARGO_DEUDA negativo de otra categoria es una correccion cualquiera, y un
 * COMISION_LOCAL positivo seria un cargo. Ninguno de los dos se lee como abono.
 * En 0 SI: es la entrega en la que ninguna pieza traia cargo, y el asiento solo lo dice.
 */
export function esAbonoPorSurtirLocal(m: {
  tipo_movimiento?: string | null
  categoria?: string | null
  monto?: number | string | null
}): boolean {
  return m.tipo_movimiento === TIPO_ABONO_LOCAL && m.categoria === CATEGORIA_ABONO_LOCAL && Number(m.monto) <= 0
}

/** Por que el renglon del abono no lleva Anular: cuelga del ticket y arrastraria la venta. */
export const MOTIVO_ABONO_SIN_ANULAR =
  'No se anula desde aquí: anularía la venta completa al local. La reversa del abono se hace por SQL.'

/**
 * Lo que el renglon del abono cambia en el historial de la ficha; se pega al final
 * de la fila generica. No lleva cuenta (sin esto diria "Cuenta Matriz -> Cuenta
 * Matriz") y no se anula solo. Vacio si la fila no es un abono.
 */
export function renglonAbonoLocal(m: Parameters<typeof esAbonoPorSurtirLocal>[0]): {
  cuentaContexto?: undefined
  annulDisabled?: boolean
  annulDisabledReason?: string
} {
  if (!esAbonoPorSurtirLocal(m)) return {}
  return { cuentaContexto: undefined, annulDisabled: true, annulDisabledReason: MOTIVO_ABONO_SIN_ANULAR }
}

/** Concepto para el ticket y el estado de cuenta chico: etiqueta + detalle por botella. */
export function conceptoAbonoLocal(categoriaGasto: string | null | undefined): string {
  const detalle = String(categoriaGasto ?? '').split('\n').slice(1)
  return [ETIQUETA_ABONO_LOCAL, ...detalle].join('\n')
}

export interface FilaAbonoLocal {
  id_entidad_relacionada: string | null
  tipo_movimiento: string | null
  categoria?: string | null
  monto: number | null
  status: string | null
}

/**
 * El "saldo por pagar" es EFECTIVO por entregar. El abono por surtir no es
 * efectivo, asi que se le quita a la cifra de la vista; si no, un DST sin caja
 * pendiente saldria en -1,044 con "Admin le debe efectivo". Solo filas vivas y
 * solo las de esta entidad, igual que la vista.
 */
export function saldoPorPagarSinAbonoLocal(
  saldoDeLaVista: number,
  idEntidad: string,
  filas: readonly FilaAbonoLocal[]
): number {
  let abonos = 0
  for (const f of filas) {
    if (f.id_entidad_relacionada !== idEntidad) continue
    if (f.status !== 'ACTIVO' && f.status !== 'APPROVED') continue
    if (esAbonoPorSurtirLocal(f)) abonos += Number(f.monto)
  }
  return Math.round((saldoDeLaVista - abonos) * 100) / 100
}

/**
 * En CONTADO no: esa venta ya parte el cobro en INGRESO_COMISION +
 * DEUDA_A_MATRIZ, y abonar aqui pagaria dos veces. Con triangulacion tampoco:
 * el bloque 2 ya le paga al DST. Un LOC sin padre o de otro DST no genera nada.
 */
export function correspondeAbonoLocal(v: {
  esConcesion: boolean
  rolVendedor: string
  vendedorId: string
  origenInventarioId: string
  comprador: { rol: string; id_padre: string | null; id_nodo_padre: string | null } | null
}): boolean {
  if (!v.esConcesion || v.rolVendedor !== 'DST' || v.origenInventarioId !== v.vendedorId) return false
  if (!v.comprador || v.comprador.rol !== 'LOC') return false
  return (v.comprador.id_nodo_padre || v.comprador.id_padre) === v.vendedorId
}

/** Precio publico por producto. Si la zona trae dos filas, la mayor. */
export function preciosPublicos(
  filas: ReadonlyArray<{ id_producto: string | null; precio_final: number | string | null }>
): Map<string, number> {
  const precios = new Map<string, number>()
  for (const fila of filas) {
    const precio = Number(fila.precio_final)
    if (!fila.id_producto || !(precio > (precios.get(fila.id_producto) ?? 0))) continue
    precios.set(fila.id_producto, precio)
  }
  return precios
}

export interface EntradaAbonoLocal {
  idTicket: string
  idDistribuidor: string
  nombreLocal: string
  porcentajes: { local: unknown; red: unknown; base: unknown }
  esCuentaFiscal: boolean
  piezas: Array<{ idProducto: string; etiqueta: string; cantidad: number }>
  /** Precio PUBLICO por producto, leido en el servidor. Nunca el del payload. */
  precioPublico: Map<string, number>
  /** Piezas de esta venta sin cargo por abonar (`piezasSinCargo`). Sin dato: ninguna. */
  piezasSinCargo?: ReadonlyMap<string, number>
  fecha: string
  usuario: string
}

/** Lo que se lee de `inventario_ledger`: todo lo del DST, tambien lo anulado. */
export interface MovimientoAbono {
  id_producto: string | null
  tipo_movimiento: string | null
  cantidad: number | null
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  fecha_movimiento: string | null
  costo_unitario_movimiento: number | string | null
  notas: string | null
  status: string | null
}

/** Cargos vivos del DST: sus abonos por surtir y su cargo de arranque. */
export interface CargoAbono {
  id_ticket: string | null
  tipo_movimiento: string | null
  categoria: string | null
  monto: number | string | null
  subcategoria: string | null
}

export interface LibroAbono {
  idDistribuidor: string
  movimientos: readonly MovimientoAbono[]
  cargos: readonly CargoAbono[]
  /** Tickets ACTIVOS en los que el DST es el comprador. */
  ticketsVivos: ReadonlySet<string>
  /** De esos, los de CONTADO: lo que entro con ellos ya esta pagado. */
  ticketsContado: ReadonlySet<string>
}

const ticketDe = (notas: string | null) => /ticket:([0-9a-f-]{36})/i.exec(notas ?? '')?.[1].toLowerCase() ?? null
const enCentavos = (x: unknown) => Math.round(Number(x) * 100)

/**
 * Las piezas que gasto un asiento, de su `subcategoria`: {"id de producto": piezas}.
 * Es lo que escriben `construirAbonoLocal` y el SQL de la regularizacion. `null` si
 * no se puede leer. Campo aparte y no el texto del historial: ese se puede redactar
 * distinto y el nombre del producto puede cambiar.
 */
export function piezasDelAsiento(subcategoria: string | null | undefined): Map<string, number> | null {
  try {
    const x: unknown = JSON.parse(subcategoria ?? '')
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null
    const pares = Object.entries(x as Record<string, unknown>)
    if (!pares.every(([, n]) => typeof n === 'number' && n > 0)) return null
    return new Map(pares as Array<[string, number]>)
  } catch {
    return null
  }
}

function esArranque(l: LibroAbono, m: MovimientoAbono): boolean {
  return (
    m.tipo_movimiento === 'ENTRADA_CONCESION' &&
    m.id_entidad_destino === l.idDistribuidor &&
    m.id_entidad_origen !== l.idDistribuidor &&
    ticketDe(m.notas) === null
  )
}

const cargoDeArranque = (l: LibroAbono) =>
  l.cargos
    .filter((c) => c.tipo_movimiento === 'CARGO_DEUDA' && c.categoria === 'ARRANQUE' && Number(c.monto) > 0)
    .reduce((a, c) => a + enCentavos(c.monto), 0)

/**
 * El cargo de arranque vivo paga TODAS las piezas de arranque del DST, al costo con
 * que se cargo cada una (su renglon; no la lista de hoy)? Si cubre menos, o un
 * renglon no trae costo, el arranque no cuenta.
 */
export function arranqueCubierto(l: LibroAbono): boolean {
  let valor = 0
  for (const m of l.movimientos) {
    if (!esArranque(l, m) || m.status !== 'ACTIVO') continue
    const costo = Number(m.costo_unitario_movimiento)
    if (!(costo > 0)) return false
    valor += enCentavos(costo * Math.max(0, Number(m.cantidad) || 0))
  }
  const cargo = cargoDeArranque(l)
  return valor > 0 && cargo >= valor
}

/**
 * Hay cargo de arranque vivo, pero un renglon no trae con cuanto se cargo: no se pudo
 * juzgar y esta venta se quedo sin abono en piezas que pudieron ser de ese arranque.
 */
export function avisoArranqueSinCosto(
  l: LibroAbono,
  sinCargo: ReadonlyMap<string, number>,
  venta: { idTicket: string; nombreLocal: string; etiquetas: ReadonlyMap<string, string> }
): AvisoAbonoLocal | null {
  const vivos = l.movimientos.filter((m) => esArranque(l, m) && m.status === 'ACTIVO')
  if (cargoDeArranque(l) <= 0 || vivos.every((m) => Number(m.costo_unitario_movimiento) > 0)) return null
  const lineas = Array.from(sinCargo)
    .filter(([id]) => vivos.some((m) => m.id_producto === id))
    .map(([id, piezas]) => ({ etiqueta: venta.etiquetas.get(id) ?? id, piezas }))
  if (lineas.length === 0) return null
  return {
    mensaje:
      `Ticket #${venta.idTicket.slice(0, 8).toUpperCase()} a ${venta.nombreLocal}: revisa el abono. No se abonaron ` +
      `${lineas.map((x) => `${x.piezas}x ${x.etiqueta}`).join('; ')}: el arranque del distribuidor tiene cargo, pero le falta ` +
      'el costo unitario a un renglon y no se sabe si lo cubre.',
    datos: { id_ticket: venta.idTicket, id_distribuidor: l.idDistribuidor, motivo: 'arranque sin costo unitario', lineas }
  }
}

/**
 * CUANTAS PIEZAS DE UN PRODUCTO TIENEN DERECHO A ABONO (Norman, 2026-11-24: lo que
 * nunca se cargo no tiene deuda que bajar). Una sola regla, para cualquier DST:
 * cargadas vivas - ya abonadas vivas - salidas sin abono.
 *
 * Cargadas: ENTRADA_CONCESION activa con `ticket:` cuyo ticket sigue ACTIVO y es del
 * DST. El arranque, solo si su cargo vivo lo paga entero (`arranqueCubierto`).
 * Lo comprado de CONTADO ya se pago y se abona como en la v2; se cuenta en un
 * segundo saldo y vale el mayor, para que una compra vieja no se coma una carga.
 *
 * Ya abonadas: lo que dice cada asiento vivo. El de la v2 no lo dice: cuentan todas
 * las piezas que salieron con su ticket. Si ni eso hay, LANZA y no se abona.
 *
 * Salidas sin abono: TODA otra salida activa (venta al publico, corte, devolucion a
 * la Matriz, merma, ajuste a la baja, surtido sin asiento) desde que existio la
 * primera entrada cargada, aunque esa entrada ya este anulada.
 *
 * Lo que un local devuelve y el ajuste a la alza no dan nada. Anular una entrada y
 * recapturarla no duplica: se compara contra lo abonado. Negativo = se abono de mas.
 * Cada duda cae hacia abonar de menos.
 */
export function derechoAbono(l: LibroAbono, idProducto: string): number {
  const cubierto = arranqueCubierto(l)
  const saldo = (conContado: boolean) => saldoAbono(l, idProducto, cubierto, conContado)
  return Math.floor(Math.max(saldo(false), saldo(true)))
}

function saldoAbono(l: LibroAbono, idProducto: string, cubierto: boolean, conContado: boolean): number {
  const dst = l.idDistribuidor
  const propios = l.movimientos.filter((m) => m.id_producto === idProducto)
  const cuando = (m: MovimientoAbono, siFalta: number) => {
    const n = m.fecha_movimiento ? new Date(m.fecha_movimiento).getTime() : NaN
    return Number.isFinite(n) ? n : siFalta
  }

  let cargadas = 0
  let desde = Infinity
  for (const m of propios) {
    const piezas = Number(m.cantidad) || 0
    const ticket = ticketDe(m.notas)
    const compra = m.tipo_movimiento === 'ENTRADA_COMPRA' && ticket !== null
    if (!(m.tipo_movimiento === 'ENTRADA_CONCESION' || (conContado && compra))) continue
    if (m.id_entidad_destino !== dst || m.id_entidad_origen === dst) continue
    if (piezas <= 0) continue
    if (ticket === null && !cubierto) continue
    desde = Math.min(desde, cuando(m, -Infinity))
    if (m.status !== 'ACTIVO') continue
    if (ticket === null || (compra ? l.ticketsContado : l.ticketsVivos).has(ticket)) cargadas += piezas
  }

  const surtidas = l.movimientos.filter(
    (m) => m.status === 'ACTIVO' && m.id_entidad_origen === dst && m.tipo_movimiento === 'SALIDA_CONCESION'
  )
  const conAsiento = new Set<string | null>()
  let abonadas = 0
  for (const c of l.cargos) {
    if (!esAbonoPorSurtirLocal(c)) continue
    const ticket = (c.id_ticket ?? '').toLowerCase()
    conAsiento.add(ticket)
    const dice = piezasDelAsiento(c.subcategoria)
    if (dice && (dice.size > 0 || Number(c.monto) === 0)) {
      abonadas += dice.get(idProducto) ?? 0
      continue
    }
    const suyas = surtidas.filter((m) => ticketDe(m.notas) === ticket)
    if (suyas.length === 0) throw new Error(`el abono del ticket ${c.id_ticket ?? '(sin ticket)'} no dice que piezas llevo`)
    for (const m of suyas) if (m.id_producto === idProducto) abonadas += Math.abs(Number(m.cantidad) || 0)
  }

  let otras = 0
  for (const m of propios) {
    const piezas = Number(m.cantidad) || 0
    const sale = m.id_entidad_origen === dst || (m.id_entidad_destino === dst && piezas < 0)
    if (!sale || m.status !== 'ACTIVO' || cuando(m, Infinity) < desde) continue
    if (m.tipo_movimiento === 'SALIDA_CONCESION' && conAsiento.has(ticketDe(m.notas))) continue
    otras += Math.abs(piezas)
  }
  return cargadas - abonadas - otras
}

/** Por producto de esta venta, cuantas piezas van SIN abono. No decide si la venta entra. */
export function piezasSinCargo(
  l: LibroAbono,
  piezas: ReadonlyArray<{ idProducto: string; cantidad: number }>
): Map<string, number> {
  const sinCargo = new Map<string, number>()
  for (const p of piezas) {
    const faltan = p.cantidad - Math.min(p.cantidad, Math.max(0, derechoAbono(l, p.idProducto)))
    if (faltan > 0) sinCargo.set(p.idProducto, faltan)
  }
  return sinCargo
}

/**
 * Dos ventas a la vez leen el mismo derecho y las dos abonan. La RPC no tiene candado
 * y ponerlo pide migracion; por eso despues de escribir se vuelve a leer: si lo
 * abonado rebasa lo cargado en un producto que ESTA venta abono, sale W19. La que
 * escribe al ultimo siempre ve a la otra. Avisa, no revierte ni detiene nada.
 */
export function avisoAbonoDeMas(
  l: LibroAbono,
  venta: { idTicket: string; nombreLocal: string; subcategoria: string; etiquetas: ReadonlyMap<string, string> }
): AvisoAbonoLocal | null {
  const lineas = Array.from(piezasDelAsiento(venta.subcategoria)?.keys() ?? [])
    .map((id) => ({ etiqueta: venta.etiquetas.get(id) ?? id, deMas: -derechoAbono(l, id) }))
    .filter((x) => x.deMas > 0)
  if (lineas.length === 0) return null
  return {
    mensaje:
      `Ticket #${venta.idTicket.slice(0, 8).toUpperCase()} a ${venta.nombreLocal}: revisa el abono. Quedaron abonadas mas piezas de las ` +
      `cargadas: ${lineas.map((x) => `${x.deMas}x ${x.etiqueta}`).join('; ')}. Otro movimiento del distribuidor entro al mismo tiempo.`,
    datos: { id_ticket: venta.idTicket, id_distribuidor: l.idDistribuidor, motivo: 'movimientos a la vez', lineas }
  }
}

function porcentajesDe(e: EntradaAbonoLocal) {
  const pct = (x: unknown) => comisionBaseLocalDecimal(x as number | null)
  const local = pct(e.porcentajes.local)
  const red = pct(e.porcentajes.red)
  const base = pct(e.porcentajes.base)
  return { local, red, base, enRango: [local, red, base].every((x) => x >= 0 && x <= 1) }
}

/** ¿Hay algo que abonar por regla? Un neto <= 0 NO es un hueco: no abona y no avisa. */
function netoPositivo(p: { local: number; red: number; base: number }): boolean {
  return Math.round((p.local + p.red - p.base) * 1e6) > 0
}

/** Las piezas de la linea sin cargo por abonar. */
function sinCargoDe(e: EntradaAbonoLocal, p: { idProducto: string; cantidad: number }): number {
  return Math.min(p.cantidad, e.piezasSinCargo?.get(p.idProducto) ?? 0)
}

/** Las lineas que DEBIAN abonarse y no se pudo, y por que. Lo que no trae cargo no entra: no habia que abonarlo. */
export function piezasSinAbono(e: EntradaAbonoLocal): Array<{ etiqueta: string; cantidad: number; motivo: string }> {
  const faltan: Array<{ etiqueta: string; cantidad: number; motivo: string }> = []
  for (const p of e.piezas) {
    const pp = e.precioPublico.get(p.idProducto)
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) {
      faltan.push({ etiqueta: p.etiqueta, cantidad: p.cantidad, motivo: 'cantidad no entera' })
    } else if (p.cantidad > sinCargoDe(e, p) && (!pp || !Number.isFinite(pp) || pp <= 0)) {
      faltan.push({ etiqueta: p.etiqueta, cantidad: p.cantidad - sinCargoDe(e, p), motivo: 'sin precio de lista' })
    }
  }
  return faltan
}

/** La fila de `finanzas_ledger`, o null si no hay nada que abonar. */
export function construirAbonoLocal(e: EntradaAbonoLocal) {
  const { local, red, base, enRango } = porcentajesDe(e)
  if (!enRango || !netoPositivo({ local, red, base })) return null

  const lineas: string[] = []
  const sinDerecho: string[] = []
  const gastadas: Record<string, number> = {}
  let total = 0
  for (const p of e.piezas) {
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) continue
    const sinCargo = sinCargoDe(e, p)
    if (sinCargo > 0) sinDerecho.push(`Sin abono: ${sinCargo}x ${p.etiqueta} (sin cargo por abonar)`)
    const abonables = p.cantidad - sinCargo
    if (abonables <= 0) continue
    // Tambien si no hay precio: se abonara a mano, y no debe abonarse otra vez.
    gastadas[p.idProducto] = abonables
    const pp = e.precioPublico.get(p.idProducto)
    if (!pp || !Number.isFinite(pp) || pp <= 0) continue
    const unitario = abonoPorBotellaLocal({
      pp,
      comisionLocal: local,
      comisionRed: red,
      comisionBase: base,
      esCuentaFiscal: e.esCuentaFiscal
    })
    if (unitario <= 0) continue
    const subtotal = unitario * abonables
    total += subtotal
    lineas.push(`${abonables}x ${p.etiqueta} ($${unitario} c/u) = $${subtotal}`)
  }
  // Ninguna con cargo: asiento en 0. No mueve nada; es lo que el historial ensena.
  if (total <= 0 && sinDerecho.length === 0) return null

  const folio = e.idTicket.slice(0, 8).toUpperCase()
  const porciento = (x: number) => `${Number((x * 100).toFixed(2))}%`
  const faltan = piezasSinAbono(e)
  return {
    id_entidad_relacionada: e.idDistribuidor,
    id_cuenta_origen: null,
    id_cuenta_destino: null,
    id_ticket: e.idTicket,
    tipo_movimiento: TIPO_ABONO_LOCAL,
    categoria: CATEGORIA_ABONO_LOCAL,
    monto: total > 0 ? -total : 0,
    categoria_gasto: [`Abono por surtir a ${e.nombreLocal} - Ticket #${folio}`, ...lineas, ...sinDerecho].join('\n'),
    subcategoria: JSON.stringify(gastadas),
    descripcion:
      `${total > 0 ? 'Baja' : 'No mueve'} la deuda del distribuidor: local ${porciento(local)} + red ${porciento(red)} - base ${porciento(base)}, ` +
      'por botella y truncado a peso (REGLAS_COMERCIALES, opcion i).' +
      (faltan.length ? ` No abonado: ${faltan.map((f) => `${f.etiqueta} (${f.motivo})`).join(', ')}.` : ''),
    status: 'ACTIVO',
    fecha_movimiento: e.fecha,
    usuario_creador: e.usuario
  }
}

export interface AvisoAbonoLocal {
  mensaje: string
  datos: Record<string, unknown>
}

/**
 * El rastro de lo que NO se abono (W19). La venta entra igual: esto avisa, no
 * detiene. Dice que venta, que producto y por que. `null` si todo se abono o si
 * por regla no habia nada que abonar (neto <= 0).
 */
export function avisoAbonoIncompleto(
  e: EntradaAbonoLocal,
  contexto: { zona: string; error: string | null }
): AvisoAbonoLocal | null {
  const p = porcentajesDe(e)
  if (p.enRango && !netoPositivo(p)) return null

  const todas = e.piezas.map((x) => ({ etiqueta: x.etiqueta, cantidad: x.cantidad, motivo: 'no se calculo' }))
  const motivo = contexto.error
    ? `fallo al calcular el abono: ${contexto.error}`
    : !p.enRango
      ? 'un porcentaje del local o del distribuidor esta fuera de rango'
      : null
  // Con motivo general no se vuelve a calcular nada: si algo trono, tronaria otra vez.
  const afectadas = motivo ? todas : piezasSinAbono(e)
  if (afectadas.length === 0) return null

  const folio = e.idTicket.slice(0, 8).toUpperCase()
  const lista = afectadas.map((f) => `${f.cantidad}x ${f.etiqueta} (${f.motivo})`).join('; ')
  return {
    mensaje:
      `Ticket #${folio} a ${e.nombreLocal}: la venta entro, pero ${motivo ? 'SIN el abono al distribuidor' : 'sin abonar estas lineas'}: ${lista}. ` +
      `Zona del local: ${contexto.zona || '(vacia)'}.` +
      (motivo ? ` Motivo: ${motivo}.` : '') +
      ' Su deuda quedo mas alta de lo que marca la regla hasta que se abone a mano.',
    datos: { id_ticket: e.idTicket, id_distribuidor: e.idDistribuidor, zona: contexto.zona, motivo, lineas: afectadas }
  }
}

/** Fila y aviso juntos. Nunca lanza: un error de calculo sale como aviso, la venta entra. */
export function resolverAbonoLocal(e: EntradaAbonoLocal, contexto: { zona: string; error: string | null }) {
  try {
    const fila = contexto.error ? null : construirAbonoLocal(e)
    return { fila, aviso: avisoAbonoIncompleto(e, contexto) }
  } catch (x) {
    const error = x instanceof Error ? x.message : String(x)
    return { fila: null, aviso: avisoAbonoIncompleto(e, { zona: contexto.zona, error }) }
  }
}

/**
 * El corte de un DST a SU local (W18). Solo avisa: no cambia ningun calculo, eso
 * es decision diferida de Norman. Sin deuda de consignacion del DST no hay nada
 * que pueda estar contado dos veces, y no avisa. `null` en la deuda = no se pudo
 * leer, y ahi SI avisa.
 */
export function avisoCorteLocalPropio(c: {
  esLocalPropio: boolean
  montoComision: number
  montoDeudaAMatriz: number
  deudaConsignacion: number | null
}): AvisoAbonoLocal | null {
  if (!c.esLocalPropio) return null
  if (c.deudaConsignacion !== null && !(c.deudaConsignacion > 0)) return null
  const pesos = (x: number) => `$${x.toFixed(2)}`
  const debe =
    c.deudaConsignacion === null
      ? 'no se pudo leer cuanto debe ya en consignacion'
      : `ya debe ${pesos(c.deudaConsignacion)} en consignacion`
  return {
    mensaje:
      `El distribuidor corto un local suyo: se le anotaron ${pesos(c.montoComision)} de comision y ` +
      `${pesos(c.montoDeudaAMatriz)} por entregar a la Matriz, y ${debe}. Si la mercancia del corte venia de esa ` +
      'consignacion, la misma botella puede estar contada dos veces. El corte se registro sin cambios: revisar.',
    datos: {
      comision: c.montoComision,
      deuda_a_matriz: c.montoDeudaAMatriz,
      deuda_consignacion: c.deudaConsignacion
    }
  }
}
