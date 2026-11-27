/**
 * LA COMISION ESCRITA POR UNA PERSONA -> LA FRACCION QUE GUARDA LA BASE.
 *
 * Modulo PURO (sin `node:crypto`, sin Supabase): lo importan el bot
 * (`lib/bot-entidad.ts`), los Server Actions y los formularios del navegador.
 *
 * ─── POR QUE EXISTE (2026-11-27) ────────────────────────────────────────────
 *
 * Norman, de voz, el 27-nov: «dejalos asi como con puntos... que sea la
 * excepcion». Los distribuidores de Gilberto van a 17.5% y sus locales a
 * 12.5%. Hasta hoy la columna era `numeric(5,2)` guardando FRACCION (20% =
 * `0.20`), asi que solo cabian porcentajes enteros: el bot guardaba 18/13 con
 * aviso y la web RECHAZABA 17.5 al editar.
 *
 * La migracion `20261127120000_comision_con_decimales.sql` pasa las cuatro
 * columnas `entidades.comision_*` a `numeric(7,4)`: cuatro decimales de
 * fraccion = **porcentaje con dos decimales** (17.5% = `0.1750`, 12.25% =
 * `0.1225`). Todo lo que cabia en `numeric(5,2)` cabe exacto en `numeric(7,4)`.
 *
 * ─── LA REGLA "EL ERP AVISA, NUNCA BLOQUEA" ─────────────────────────────────
 *
 * - Mas de dos decimales de porcentaje (17.555) -> se redondea a 17.56 y
 *   **se avisa**; se guarda.
 * - Mas de la mitad del precio (> 50%) -> **se avisa** y se guarda.
 * - Lo que NO es una comision (texto que no es numero, negativo, > 100%) no
 *   se puede guardar como comision: una comision de 150% vuelve negativo el
 *   precio del distribuidor. El bot no corta la alta por eso: **vuelve a
 *   preguntar** el numero diciendo por que.
 */

/** Decimales de FRACCION que guarda `numeric(7,4)`: 4 = porcentaje con 2. */
export const DECIMALES_EN_LA_BASE = 4

/** Arriba de esta fraccion se avisa (no se bloquea). */
export const UMBRAL_DE_AVISO = 0.5

/**
 * Lee un numero escrito por una persona: acepta coma o punto decimal, `%`,
 * "por ciento", espacios. `'17,5 %'` -> 17.5, `'12.5'` -> 12.5, `20` -> 20.
 * Devuelve `NaN` si no es un numero (nunca un 0 callado).
 */
export function leerNumeroEscrito(valor: unknown): number {
  if (typeof valor === 'number') return valor
  if (valor === null || valor === undefined) return Number.NaN
  const limpio = String(valor)
    .toLowerCase()
    .replace(/por\s*ciento|porciento|%/g, '')
    .replace(/\s+/g, '')
  if (!/^-?\d+([.,]\d+)?$|^-?[.,]\d+$/.test(limpio)) return Number.NaN
  return Number(limpio.replace(',', '.'))
}

/**
 * La fraccion redondeada a lo que guarda la columna (4 decimales), half-up
 * como Postgres. El `1e-6` absorbe el ruido del float: 17.555 / 100 es
 * `0.17554999999999998` en JavaScript y sin el saldria 17.55 en vez de 17.56.
 */
export function redondearFraccion(fraccion: number): number {
  const factor = 10 ** DECIMALES_EN_LA_BASE
  return Math.round(fraccion * factor + 1e-6) / factor
}

/**
 * `0.175` -> `"17.5%"`, `0.2` -> `"20%"`, `0.1225` -> `"12.25%"`.
 * Hasta dos decimales de porcentaje, sin inventar ceros. **Nunca se le ensena
 * una fraccion a nadie.**
 */
export function porcentajeParaMostrar(fraccion: number): string {
  const porciento = Math.round(fraccion * 10000) / 100
  return `${porciento.toLocaleString('es-MX', { maximumFractionDigits: 2, useGrouping: false })}%`
}

/** La fraccion guardada -> el texto que va en el campo del formulario (`0.175` -> `"17.5"`). */
export function porcentajeParaCampo(fraccion: number | null | undefined): string {
  if (!fraccion) return ''
  return String(Math.round(Number(fraccion) * 10000) / 100)
}

/**
 * Lo que escribio una persona en un campo de formulario, en el numero que el
 * Server Action espera (porcentaje, "17.5"). Vacio -> 0 (como siempre). Algo
 * que no es numero -> `null`, para que el formulario lo diga en vez de mandar
 * un 0 callado (eso hacia `parseFloat('abc') || 0`).
 */
export function porcentajeDeCampo(texto: string): number | null {
  if (String(texto ?? '').trim() === '') return 0
  const n = leerNumeroEscrito(texto)
  return Number.isFinite(n) ? n : null
}
