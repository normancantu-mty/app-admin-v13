/**
 * EL DESCUENTO, A NIVEL TICKET, CON UN TOPE QUE NO DECIDE EL MODELO.
 *
 * ─── LO QUE NORMAN PIDIO ────────────────────────────────────────────────────
 *
 *   *"en ocasiones vamos a poner promociones, mi pregunta es si las podemos
 *    meter por medio de este bot. Eso si me interesa."*
 *
 * Hasta hoy `lib/bot-venta.ts` lo decia textual: *"El bot no aplica descuentos:
 * no hay campo donde dictarlos."*
 *
 * ─── LO QUE YA HACIA NORMAN, Y ES EL HALLAZGO QUE FIJA EL TOPE ──────────────
 *
 * Medido contra produccion el 2026-09-19: existe una **entidad** de la red
 * llamada literalmente **`Descuento del 30%`** (rol `LOC`), con **dos ventas
 * vivas** a su nombre — $11,340.00 y $1,470.00. O sea: hoy el descuento se
 * captura **inventandole un cliente**, y el ERP no guarda en ningun lado que
 * hubo descuento. Las dos columnas quedan iguales: **0 de los 67 tickets
 * `ACTIVO` tienen `subtotal_catalogo` distinto de `total_cobrado_real`.**
 *
 * Ese 30% del nombre es el dato con el que se elige el tope. No es una opinion
 * sobre cuanto conviene descontar: es **el descuento mas grande que Norman ya
 * se aplica a si mismo**, escrito por el, en produccion. Un tope por debajo de
 * eso rompe una practica real; uno muy por encima no atrapa nada.
 *
 * ─── POR QUE EL TOPE, Y POR QUE AQUI Y NO EN EL PROMPT ──────────────────────
 *
 * El sello congela lo que Norman vio antes del "va" — pero **Norman ve el
 * numero que el modelo propuso**. Si el modelo calcula mal un 10%, el sello
 * protege fielmente el error. El tope es lo unico que convierte "dinero
 * regalado" en un **422** antes de que nadie lo vea.
 *
 * Y va en codigo, no en el prompt, por la misma razon por la que `_sin_promesas`
 * revisa la respuesta aunque la regla 16 ya la prohiba: **el prompt se negocia,
 * la ruta no.**
 *
 * ─── A NIVEL TICKET, NO POR RENGLON ─────────────────────────────────────────
 *
 * Por renglon pide una columna que la base no tiene. A nivel ticket las dos
 * columnas **ya existen** (`subtotal_catalogo` / `total_cobrado_real`), la
 * pantalla del POS ya las distingue, y no hace falta migracion. Se empieza por
 * lo que la base ya aguanta.
 */

/**
 * **30%.** El numero sale de `entidades`, no de una discusion: ver el bloque de
 * arriba. Para cambiarlo basta cambiar esta constante — y quien lo cambie
 * deberia traer el mismo tipo de dato con el que se puso.
 */
export const TOPE_DESCUENTO_PORCENTAJE = 30

/** Debajo de esto un descuento es ruido de redondeo y no se anuncia. */
export const MINIMO_DESCUENTO_PORCENTAJE = 0.01

/** Lo que el modelo puede mandar. **Ninguno de los dos se escribe crudo.** */
export interface DescuentoDictado {
  /** "con 10% de descuento" → `10`. */
  porcentaje?: unknown
  /** "dejaselo en 5,000" → `5000`. El porcentaje se DERIVA de aqui. */
  total_final?: unknown
  /** "promocion de septiembre" → la etiqueta, que solo viaja al texto. */
  motivo?: unknown
}

export interface DescuentoAplicado {
  ok: true
  /** Lo que cuesta de lista. Es lo que va a `subtotal_catalogo`. */
  subtotal: number
  /** El porcentaje EFECTIVO, ya derivado y ya redondeado. */
  porcentaje: number
  /** Los pesos que se bajan. `subtotal - total`, exacto. */
  importe: number
  /** Lo que se cobra. Es lo que va a `total_cobrado_real`. */
  total: number
  /** La etiqueta de la promocion, o "". Nunca decide dinero. */
  motivo: string
  /** `false` cuando no se dicto nada: el caso normal, y el que no debe cambiar. */
  hay: boolean
}

export interface DescuentoRechazado {
  ok: false
  error: string
}

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function roundTo2(valor: number): number {
  return Number(valor.toFixed(2))
}

/** El resultado neutro: sin descuento las dos columnas quedan IGUALES. */
export function sinDescuento(subtotal: number): DescuentoAplicado {
  const limpio = roundTo2(subtotal)
  return {
    ok: true,
    subtotal: limpio,
    porcentaje: 0,
    importe: 0,
    total: limpio,
    motivo: '',
    hay: false
  }
}

/** El motivo es texto libre del modelo: se recorta y se limpia, nunca se cree. */
const TOPE_MOTIVO = 60

function limpiarMotivo(crudo: unknown): string {
  return String(crudo ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TOPE_MOTIVO)
}

/**
 * Resuelve el descuento sobre un subtotal ya calculado por el servidor.
 *
 * **`subtotal` NUNCA viene del modelo**: sale de `listas_precios` y de la
 * cascada, igual que hoy. Lo unico que aporta el dictado es *cuanto bajarle*, y
 * eso es justo lo que se valida aqui.
 *
 * Las reglas, y lo que costaria cada una si faltara:
 *
 *  1. **Sin dictado → sin descuento.** El camino de siempre, bit por bit: las
 *     dos columnas iguales. Es el control negativo 2 de D57.
 *  2. **Los dos numeros a la vez → error.** Un `porcentaje` y un `total_final`
 *     que no concuerdan son el sintoma exacto del modelo calculando mal. Que
 *     gane uno en silencio es elegir por Norman con la informacion incompleta.
 *  3. **Un descuento que SUBE el precio no es un descuento.** Un `total_final`
 *     arriba del subtotal se rechaza en vez de leerse como recargo.
 *  4. **Arriba del tope → error, con el tope escrito en el mensaje.** Para que
 *     quien lo vea sepa contra que numero choco sin abrir el codigo.
 *  5. **El total cobrado tiene que quedar arriba de cero.** Un 100% no es una
 *     promocion, es una donacion, y esa no se dicta por chat.
 */
export function aplicarDescuento(
  subtotal: number,
  dictado: unknown
): DescuentoAplicado | DescuentoRechazado {
  const base = roundTo2(Number(subtotal))
  if (!Number.isFinite(base) || base <= 0) {
    return {
      ok: false,
      error: 'No puedo aplicar un descuento sobre un total que no es un numero positivo.'
    }
  }

  if (dictado === null || dictado === undefined || typeof dictado !== 'object') {
    return sinDescuento(base)
  }

  const d = dictado as DescuentoDictado
  const motivo = limpiarMotivo(d.motivo)

  const traePorcentaje = d.porcentaje !== null && d.porcentaje !== undefined && d.porcentaje !== ''
  const traeTotal = d.total_final !== null && d.total_final !== undefined && d.total_final !== ''

  if (!traePorcentaje && !traeTotal) return sinDescuento(base)

  if (traePorcentaje && traeTotal) {
    return {
      ok: false,
      error:
        'Me dictaste dos descuentos a la vez (un porcentaje y un total). ' +
        'Dime uno solo: o el porcentaje, o en cuanto se lo dejo.'
    }
  }

  let porcentaje: number
  let total: number

  if (traePorcentaje) {
    const pct = Number(d.porcentaje)
    if (!Number.isFinite(pct) || pct <= 0) {
      return {
        ok: false,
        error: 'No entendi el porcentaje del descuento. Dimelo como numero, por ejemplo "10%".'
      }
    }
    if (pct > TOPE_DESCUENTO_PORCENTAJE) {
      return {
        ok: false,
        error:
          `Un descuento de ${pct}% no lo aplico por chat: el tope es ${TOPE_DESCUENTO_PORCENTAJE}%. ` +
          'Si de verdad va ese, se captura en la pantalla.'
      }
    }
    porcentaje = roundTo2(pct)
    total = roundTo2(base - roundTo2((base * porcentaje) / 100))
  } else {
    const pedido = Number(d.total_final)
    if (!Number.isFinite(pedido) || pedido <= 0) {
      return { ok: false, error: 'No entendi en cuanto se lo dejo. Dimelo como numero.' }
    }
    if (pedido > base) {
      return {
        ok: false,
        error:
          `De lista son ${pesos(base)} y me dijiste ${pesos(pedido)}: ` +
          'eso es un recargo, no un descuento. El bot no sube precios.'
      }
    }
    total = roundTo2(pedido)
    const derivado = roundTo2(((base - total) / base) * 100)
    if (derivado > TOPE_DESCUENTO_PORCENTAJE) {
      return {
        ok: false,
        error:
          `Dejarlo en ${pesos(total)} sobre ${pesos(base)} es un ${derivado}% de descuento, ` +
          `y el tope es ${TOPE_DESCUENTO_PORCENTAJE}%. Si de verdad va ese, se captura en la pantalla.`
      }
    }
    porcentaje = derivado
  }

  if (!(total > 0)) {
    return { ok: false, error: 'Con ese descuento el cobro queda en cero. Eso no lo escribo.' }
  }

  const importe = roundTo2(base - total)
  if (porcentaje < MINIMO_DESCUENTO_PORCENTAJE || importe <= 0) return sinDescuento(base)

  return { ok: true, subtotal: base, porcentaje, importe, total, motivo, hay: true }
}

/**
 * El descuento **reconstruido desde las dos cifras que se van a escribir**.
 *
 * ─── POR QUE EXISTE, SI YA HAY `aplicarDescuento` ───────────────────────────
 * Porque el mensaje que Norman lee tiene que salir de lo MISMO que se sella, no
 * de una variable paralela que viajo al lado. Si el mensaje se armara con el
 * objeto que devolvio `aplicarDescuento` y el payload con otra cuenta, bastaria
 * un renglon movido en medio para que la pantalla ensenara una cifra y la base
 * guardara otra — y el sello protegeria fielmente la equivocada.
 *
 * Asi que el mensaje se arma de `subtotal_catalogo` y `total_cobrado_real`, que
 * son exactamente los dos numeros sellados. Lo unico que entra por fuera es el
 * `motivo`, que es una etiqueta y no decide dinero.
 */
export function descuentoDelPayload(
  subtotal: number,
  cobrado: number,
  motivo = ''
): DescuentoAplicado {
  const base = roundTo2(subtotal)
  const total = roundTo2(cobrado)
  const importe = roundTo2(base - total)
  if (!(base > 0) || !(importe > 0)) return sinDescuento(base)
  return {
    ok: true,
    subtotal: base,
    porcentaje: roundTo2((importe / base) * 100),
    importe,
    total,
    motivo: limpiarMotivo(motivo),
    hay: true
  }
}

/**
 * Las tres lineas que Norman lee antes del "va". **Las dos cifras a la vista**,
 * que es lo que pidio D55: sin el precio de lista al lado, un total mas bajo de
 * lo esperado se lee como un error de precios y no como la promocion que es.
 *
 * Devuelve `[]` cuando no hubo descuento: el mensaje de siempre no cambia ni un
 * caracter, que es el control negativo 2 de D57.
 */
export function lineasDeDescuento(d: DescuentoAplicado): string[] {
  if (!d.hay) return []
  const comoSeLlama = d.motivo === '' ? `Descuento ${d.porcentaje}%` : `${d.motivo} (${d.porcentaje}%)`
  return [
    `Precio de lista:  ${pesos(d.subtotal)}`,
    `${comoSeLlama}:  -${pesos(d.importe)}`,
    `TOTAL A COBRAR:   ${pesos(d.total)}`
  ]
}

/** Lo que queda escrito en `notas` de una cotizacion, para que el papel lo diga. */
export function notaDeDescuento(d: DescuentoAplicado): string {
  if (!d.hay) return ''
  const etiqueta = d.motivo === '' ? 'Descuento' : d.motivo
  return `${etiqueta} ${d.porcentaje}%: de ${pesos(d.subtotal)} a ${pesos(d.total)}.`
}
