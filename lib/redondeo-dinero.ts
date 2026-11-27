/**
 * REDONDEO DE DINERO CUANDO UN PORCENTAJE MULTIPLICA UN PRECIO.
 *
 * Escrito el 2026-11-27 junto con las comisiones con decimales (17.5% / 12.5%).
 *
 * ─── EL PROBLEMA, MEDIDO ────────────────────────────────────────────────────
 *
 * La regla de redondeo del ERP (CLAUDE.md, regla 7) no cambia: lo de la Matriz
 * sube al PESO entero (`Math.ceil`), lo del nodo baja al peso (`Math.floor`).
 * Lo que cambia es que con 17.5% el float de JavaScript da numeros como
 * `40 x 69 x 0.175 = 482.99999999999994` cuando la cuenta exacta es **483**:
 * `Math.floor` le quitaba un peso al distribuidor. Medido con los precios
 * reales de `listas_precios` (69, 99, 130, 179, 199, 599, 799) y cantidades de
 * 1 a 200: 16 casos asi con 17.5%, cero con los porcentajes enteros de hoy.
 *
 * ─── LA REGLA ───────────────────────────────────────────────────────────────
 *
 * 1. `techoPeso` / `pisoPeso`: el mismo ceil/floor de siempre, pero un valor
 *    que esta a menos de una millonesima de peso de un entero SE TOMA COMO ESE
 *    ENTERO (es ruido del float, no dinero). Un valor con centavos de verdad
 *    (479.20, 270.0023) se redondea igual que antes: **ningun resultado con
 *    porcentaje entero cambia** (lo comprueba `tests/comision-decimal.spec.ts`).
 * 2. `aCentavo`: cuando NO aplica el redondeo al peso
 *    (`aplica_redondeo_costo = false`), el dinero se deja en centavos
 *    (half-up, dos decimales), nunca en un float con cola.
 */

/** Por debajo de esto, la diferencia contra un entero es ruido del float. */
const RUIDO = 1e-6

/** Sube al peso entero (lo de la Matriz). 482.99999999999994 -> 483, 479.2 -> 480. */
export function techoPeso(valor: number): number {
  const entero = Math.round(valor)
  if (Math.abs(valor - entero) < RUIDO) return entero
  return Math.ceil(valor)
}

/** Baja al peso entero (lo del nodo). 482.99999999999994 -> 483, 119.8 -> 119. */
export function pisoPeso(valor: number): number {
  const entero = Math.round(valor)
  if (Math.abs(valor - entero) < RUIDO) return entero
  return Math.floor(valor)
}

/** Dos decimales, half-up sobre el valor ya limpio de ruido. 494.17499999 -> 494.18. */
export function aCentavo(valor: number): number {
  return Math.round(valor * 100 + RUIDO) / 100
}
