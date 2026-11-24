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
 */
export function esAbonoPorSurtirLocal(m: {
  tipo_movimiento?: string | null
  categoria?: string | null
  monto?: number | string | null
}): boolean {
  return m.tipo_movimiento === TIPO_ABONO_LOCAL && m.categoria === CATEGORIA_ABONO_LOCAL && Number(m.monto) < 0
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
  fecha: string
  usuario: string
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

/** Las lineas que se quedan sin abono y por que. */
export function piezasSinAbono(e: EntradaAbonoLocal): Array<{ etiqueta: string; cantidad: number; motivo: string }> {
  const faltan: Array<{ etiqueta: string; cantidad: number; motivo: string }> = []
  for (const p of e.piezas) {
    const pp = e.precioPublico.get(p.idProducto)
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) {
      faltan.push({ etiqueta: p.etiqueta, cantidad: p.cantidad, motivo: 'cantidad no entera' })
    } else if (!pp || !Number.isFinite(pp) || pp <= 0) {
      faltan.push({ etiqueta: p.etiqueta, cantidad: p.cantidad, motivo: 'sin precio de lista' })
    }
  }
  return faltan
}

/** La fila de `finanzas_ledger`, o null si no hay nada que abonar. */
export function construirAbonoLocal(e: EntradaAbonoLocal) {
  const { local, red, base, enRango } = porcentajesDe(e)
  if (!enRango) return null

  const lineas: string[] = []
  let total = 0
  for (const p of e.piezas) {
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) continue
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
    const subtotal = unitario * p.cantidad
    total += subtotal
    lineas.push(`${p.cantidad}x ${p.etiqueta} ($${unitario} c/u) = $${subtotal}`)
  }
  if (total <= 0) return null

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
    monto: -total,
    categoria_gasto: [`Abono por surtir a ${e.nombreLocal} - Ticket #${folio}`, ...lineas].join('\n'),
    descripcion:
      `Baja la deuda del distribuidor: local ${porciento(local)} + red ${porciento(red)} - base ${porciento(base)}, ` +
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
