/**
 * EL ERP AVISA, NUNCA BLOQUEA, POR FALTA DE EXISTENCIA (2026-11-24).
 *
 * Reglas de Norman: "el ERP avisa, nunca bloquea" y "no quiero mover el
 * inventario si no es cierto". Las dos juntas son este archivo:
 *   - la venta o la salida entra completa y el saldo queda negativo, como es;
 *   - nadie inventa una entrada ni un ajuste para tapar el faltante;
 *   - se dice al capturar (pieza, hay X, pides Y, quedara -Z) y queda un aviso
 *     W20 en la cola para que alguien cuente.
 *
 * Puro: no importa nada, para que lo usen la venta, la salida y el bot.
 */

export interface FaltanteStock {
  idProducto: string
  pieza: string
  /** El saldo del libro ANTES, con su signo. Puede ya venir negativo. */
  hay: number
  pide: number
  /** El saldo DESPUES. Siempre negativo: si no, no hay faltante. */
  queda: number
}

/** `inventario_ledger.cantidad` es numeric(10,4). Sin esto, 0.3 - 0.1 - 0.2 "falta". */
function redondear4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** `null` si alcanza. No recorta: un saldo que ya era -2 se dice -2. */
export function faltanteDeStock(
  hay: number,
  pide: number
): { hay: number; pide: number; queda: number } | null {
  const queda = redondear4(hay - pide)
  return pide > 0 && queda < 0 ? { hay: redondear4(hay), pide: redondear4(pide), queda } : null
}

/**
 * De que cubeta sale: primero lo PAGADO, lo que sobre de lo CONSIGNADO que haya,
 * y el faltante se queda en PAGADO (que queda negativo). Una cubeta que ya es
 * negativa no tiene nada que dar. Lo que sale suma SIEMPRE lo pedido.
 */
export function repartirCascada(
  cantidad: number,
  pagado: number,
  consignado: number
): { deduccionPagado: number; deduccionConsignado: number } {
  const sobraDePagado = Math.max(0, cantidad - Math.max(0, pagado))
  const deduccionConsignado = Math.min(sobraDePagado, Math.max(0, consignado))
  return { deduccionPagado: cantidad - deduccionConsignado, deduccionConsignado }
}

export function textoFaltantes(faltantes: readonly FaltanteStock[]): string {
  return faltantes
    .map((f) => `${f.pieza}: hay ${f.hay}, pides ${f.pide}, quedará ${f.queda}`)
    .join('; ')
}

/** El mismo texto en la pantalla, en el bot y en la cola de avisos. */
export function mensajeFaltaStock(
  que: 'La venta' | 'La salida',
  lugar: string,
  faltantes: readonly FaltanteStock[],
  notas: ReadonlyArray<string | null> = []
): string {
  const mensaje =
    `${que} pide más de lo que marca el sistema en ${lugar}. ${textoFaltantes(faltantes)}. ` +
    `${que} SÍ entró y el inventario no se ajustó para taparlo: hay que contar.`
  return [mensaje, ...notas.filter(Boolean)].join(' ')
}

/** El corte del local espera PAGADO + CONSIGNADO con su signo: el negativo le resta. */
export function notaCorteLocal(rol: string | null | undefined): string | null {
  return rol === 'LOC' ? 'Ese saldo baja lo que cobra el próximo corte del local.' : null
}

/**
 * El distribuidor surtio a su local piezas que el sistema no le tenia cargadas: esas
 * no se abonan (la regla del abono no cambia) y cargarlas despues no lo recupera.
 * Solo cuenta lo que falta de existencia Y ademas se quedo sin cargo por abonar.
 */
export function notaAbonoSinCarga(
  faltantes: readonly FaltanteStock[],
  sinCargo: ReadonlyMap<string, number>
): string | null {
  const lineas = faltantes
    .map((f) => ({ pieza: f.pieza, piezas: Math.min(sinCargo.get(f.idProducto) ?? 0, f.pide, -f.queda) }))
    .filter((x) => x.piezas > 0)
    .map((x) => `${x.piezas}x ${x.pieza}`)
  if (lineas.length === 0) return null
  return (
    `Este abono no se dio por falta de carga (${lineas.join('; ')}): captura la carga primero. ` +
    'Cargar después no abona esta entrega.'
  )
}
