/**
 * FASE 9 (D87, D89) — "PUBLICO EN GENERAL" Y "EN 2900": LA COSTURA, NO MAQUINARIA NUEVA.
 *
 * ─── LO QUE NORMAN DIJO ─────────────────────────────────────────────────────
 *   *"cotizame para publico en general, 30 botellas grandes con 15% de
 *    descuento"* y *"vendi 5 botellas grandes a publico en general en 2900"*.
 *
 * El modelo ya las entendia completas (medido por el auditor y otra vez aqui,
 * 2026-09-23). Lo que fallaba era la ruta:
 *   1. **Una palabra.** `buscarPorNombre("publico en general")` buscaba en la
 *      red a alguien llamado asi, no lo hallaba y preguntaba *"No tengo a
 *      'publico en general' en la red"*. Publico no es alguien de la red: es la
 *      AUSENCIA de comprador — lo mismo que ya hacia el boton "Publico en
 *      General" (`publico: true`).
 *   2. **Un campo.** El "en 2900" viajaba como `monto`, que la ruta solo usaba
 *      para avisar *"Dijiste 2900 y me salen 2995. Voy a escribir el mio"*. El
 *      descuento visible (`total_final`, D55) ya existia; faltaba coserlo.
 *
 * Todo aqui es PURO: se prueba sin base (`tests/bot-fase9-publico.spec.ts`).
 */

import { normalizarNombre } from '@/lib/bot-nombres'
import { TOPE_DESCUENTO_PORCENTAJE } from '@/lib/bot-descuento'

/** El nombre con que se guarda un prospecto de mostrador en una cotizacion. */
export const NOMBRE_PUBLICO = 'Publico en general'

/**
 * **UNA sola lista**, usada por venta y cotizacion (D87). Se compara contra el
 * nombre ya normalizado (`normalizarNombre`: sin acentos, sin mayusculas, sin
 * puntuacion), y **completo**, no por subcadena: "Publico Bar" seria un negocio
 * real y no se puede tragar como mostrador.
 */
export const SINONIMOS_PUBLICO: readonly string[] = [
  'publico',
  'publico en general',
  'publico general',
  'el publico',
  'al publico',
  'al publico en general',
  'mostrador',
  'cliente de mostrador',
  'venta de mostrador',
  'venta al publico',
  'cliente final',
  'consumidor final'
]

const SINONIMOS_NORMALIZADOS = new Set(SINONIMOS_PUBLICO.map(normalizarNombre))

/** True si lo dicho es "publico en general" y no un nombre de la red. */
export function esPublicoEnGeneral(dicho: unknown): boolean {
  const n = normalizarNombre(dicho)
  return n !== '' && SINONIMOS_NORMALIZADOS.has(n)
}

// ─── D89: EL PRECIO DICHO ───────────────────────────────────────────────────

/** Arriba de un peso de diferencia se considera que no cuadra (mismo criterio que `TOLERANCIA_MONTO_DICHO`). */
const TOLERANCIA = 1

export type LecturaMontoDicho =
  | { tipo: 'ninguno' }
  /** Cuadra con la lista (±$1): sin descuento, sin aviso. */
  | { tipo: 'igual' }
  /** Mayor que la lista: como hasta hoy, aviso y se escribe la lista. */
  | { tipo: 'mayor' }
  /** El total que se cobra, como descuento visible. `porPieza` si se leyo "cada una". */
  | { tipo: 'descuento'; totalFinal: number; porPieza: number | null; aviso: string | null }

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function roundTo2(valor: number): number {
  return Number(valor.toFixed(2))
}

/** Un total es "razonable" si cae entre la lista menos el tope y la lista. */
function razonable(total: number, lista: number): boolean {
  const piso = lista * (1 - TOPE_DESCUENTO_PORCENTAJE / 100)
  return total >= piso - 0.005 && total <= lista + TOLERANCIA
}

/**
 * Que hacer con el `monto` que dijo la persona. **Pura.**
 *
 * La regla sale de lo MEDIDO con el modelo real (2026-09-23, `_avance` D89):
 * para *"en 2900"*, *"a 580 cada una"* y *"me pagaron 2900 por las 5"* el
 * modelo devolvio `monto: 2900` las tres veces — ya lo da como TOTAL. La
 * lectura "por pieza" es la red de abajo, para cuando el modelo copie el
 * numero crudo (580 por 5 botellas):
 *
 *  1. Sin monto, o con descuento explicito → `ninguno` (manda el descuento).
 *  2. Igual a la lista (±$1) → `igual`: sin linea de descuento.
 *  3. Mayor que la lista → `mayor`: el aviso de siempre, se escribe la lista.
 *  4. Menor, y como TOTAL cae dentro del tope → descuento con `total_final`.
 *  5. Como total NO cae, pero × piezas SI (un solo producto) → "Entendi $580
 *     cada una = $2,900", descuento con ese total.
 *  6. Ninguno de los dos → se manda como total y el tope de `aplicarDescuento`
 *     contesta el 422 con su porcentaje: no se escribe nada que no se vio.
 */
export function leerMontoDicho(
  monto: unknown,
  lista: number,
  piezas: number,
  unSoloProducto: boolean,
  hayDescuentoExplicito: boolean
): LecturaMontoDicho {
  const dicho = Number(monto)
  if (hayDescuentoExplicito) return { tipo: 'ninguno' }
  if (monto === null || monto === undefined || monto === '' || typeof monto === 'boolean') {
    return { tipo: 'ninguno' }
  }
  if (!Number.isFinite(dicho) || dicho <= 0 || !(lista > 0)) return { tipo: 'ninguno' }

  if (Math.abs(dicho - lista) <= TOLERANCIA) return { tipo: 'igual' }
  if (dicho > lista) return { tipo: 'mayor' }

  if (razonable(dicho, lista)) {
    return { tipo: 'descuento', totalFinal: roundTo2(dicho), porPieza: null, aviso: null }
  }

  if (unSoloProducto && piezas > 1) {
    const total = roundTo2(dicho * piezas)
    if (razonable(total, lista)) {
      if (Math.abs(total - lista) <= TOLERANCIA) return { tipo: 'igual' }
      return {
        tipo: 'descuento',
        totalFinal: total,
        porPieza: roundTo2(dicho),
        aviso: `Entendi ${pesos(dicho)} cada una = ${pesos(total)}.`
      }
    }
  }

  return { tipo: 'descuento', totalFinal: roundTo2(dicho), porPieza: null, aviso: null }
}
