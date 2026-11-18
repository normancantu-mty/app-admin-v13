/**
 * Nombres de lote: el actual y los ALIAS (nombres anteriores), y el siguiente
 * numero consecutivo. Escrito el 2026-11-18 por el agente (Cuartel). PURO: sin
 * red ni base; lo usan el bot (rutas de servidor), la pantalla de correcciones
 * (cliente) y las pruebas.
 *
 * Regla de Cris (2026-11-18): al renombrar un lote, el nombre anterior queda
 * como alias y el bot encuentra el lote por su nombre actual o por cualquiera
 * anterior. En Postgres: tabla `lote_alias` + `resolver_lote()` (migracion
 * 20261118192907). Aqui, el espejo para lo que el bot filtra en memoria.
 *
 * Nomenclatura nueva (Cris, 2026-11-18): numeros consecutivos ("136", "137").
 * La FUENTE UNICA de la recomendacion es `siguiente_codigo_lote()` en SQL;
 * `siguienteCodigoNumerico` es su espejo exacto (misma regla, misma prueba)
 * para el bot, que propone el codigo en ensayo antes de escribir.
 */

/** Como compara Postgres los nombres: sin mayusculas ni espacios de los extremos. */
export function normalizarNombreLote(nombre: string | null | undefined): string {
  return String(nombre ?? '').trim().toUpperCase()
}

/** ¿`dicho` es el nombre actual o un alias del lote? */
export function nombreDelLote(dicho: string, lote: { codigo_lote: string; alias?: readonly string[] | null }): boolean {
  const d = normalizarNombreLote(dicho)
  if (d === '') return false
  if (normalizarNombreLote(lote.codigo_lote) === d) return true
  return (lote.alias ?? []).some((a) => normalizarNombreLote(a) === d)
}

/** Fila de `lote_alias` como la lee el bot. */
export interface FilaAlias {
  id_lote: string
  alias: string
}

/** id_lote -> sus alias. */
export function aliasPorLote(filas: readonly FilaAlias[] | null | undefined): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const f of filas ?? []) {
    if (!f || typeof f.alias !== 'string') continue
    const lista = m.get(f.id_lote) ?? []
    lista.push(f.alias)
    m.set(f.id_lote, lista)
  }
  return m
}

/**
 * Todos los nombres TOMADOS (actuales + alias): un lote nuevo no puede usar
 * ninguno, y el consecutivo no reusa un numero ya usado.
 */
export function nombresTomados(codigos: readonly (string | null | undefined)[], alias: readonly FilaAlias[] | null | undefined): string[] {
  return [...codigos, ...(alias ?? []).map((a) => a.alias)].filter((c): c is string => typeof c === 'string' && c.trim() !== '')
}

/** ¿El nombre choca con alguno tomado? */
export function nombreTomado(nombre: string, tomados: readonly string[]): boolean {
  const n = normalizarNombreLote(nombre)
  return n !== '' && tomados.some((t) => normalizarNombreLote(t) === n)
}

const SOLO_DIGITOS = /^\d+$/

export function esCodigoNumerico(nombre: string | null | undefined): boolean {
  return SOLO_DIGITOS.test(String(nombre ?? '').trim())
}

/**
 * Espejo de `siguiente_codigo_lote()`: 1 + el mayor nombre que sea SOLO digitos
 * (comparado como numero) entre los tomados; '1' si no hay ninguno. BigInt para
 * no perder precision con numeros largos (Postgres usa numeric).
 */
export function siguienteCodigoNumerico(tomados: readonly (string | null | undefined)[]): string {
  let mayor = BigInt(0)
  for (const t of tomados) {
    const s = String(t ?? '').trim()
    if (!SOLO_DIGITOS.test(s)) continue
    const n = BigInt(s)
    if (n > mayor) mayor = n
  }
  return (mayor + BigInt(1)).toString()
}

/**
 * Nombre a mano: cualquier texto vale (los viejos siguen validos), pero si es
 * un numero y NO es el recomendado, se AVISA (no se bloquea).
 */
export function avisoDeCodigoNumerico(nombre: string, recomendado: string | null | undefined): string | null {
  const n = String(nombre ?? '').trim()
  if (!esCodigoNumerico(n) || !recomendado) return null
  if (n === String(recomendado).trim()) return null
  return `Ojo: el consecutivo que sigue es ${recomendado}, y escribiste ${n}. Lo dejo así si es a propósito.`
}
