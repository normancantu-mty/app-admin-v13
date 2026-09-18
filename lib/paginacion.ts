/**
 * Paginacion de PostgREST — ERP-25.
 *
 * PostgREST **corta en 1000 filas sin avisar**. No devuelve error, no pone una
 * bandera, no deja rastro: devuelve 1000 filas y se calla. Una lectura de
 * ledger que se va a SUMAR y llega truncada no produce un fallo, produce un
 * **numero falso en pantalla** — el caso de fallo silencioso mas caro del ERP.
 *
 * Por eso esta funcion vive en su propio modulo y sin una sola dependencia:
 * `lib/dashboard-utils.ts` es server-only (`next/headers`) y `lib/vistas.ts` no
 * puede importarlo sin volverse server-only tambien. Tenian una copia cada uno.
 * Ahora la implementacion es UNA y los dos la importan.
 *
 * Regla: **toda consulta cuyo resultado se vaya a sumar, contar o replayar
 * pasa por aqui.** La vigila `tests/paginacion-ledger.spec.ts`, que lee el
 * codigo fuente y se pone roja si aparece una lectura de ledger sin paginar.
 */

/** Tope duro de PostgREST: sin `.range()` explicito nunca devuelve mas de esto. */
export const TAMANO_PAGINA = 1000

export interface ConsultaPaginable<T> {
  range(desde: number, hasta: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/**
 * Trae **todas** las filas de una consulta, paginando con `.range()`.
 *
 * `construirConsulta` se llama una vez por pagina a proposito: un
 * `PostgrestFilterBuilder` es un thenable de un solo uso, asi que reutilizar el
 * mismo objeto devolveria la primera pagina para siempre.
 *
 * Si una pagina falla se **lanza** el error. Devolver lo acumulado seria
 * exactamente el defecto que este modulo existe para evitar: una suma
 * incompleta que nadie distingue de una completa.
 */
export async function fetchTodasLasFilas<T>(
  construirConsulta: () => ConsultaPaginable<T>,
  etiqueta: string
): Promise<T[]> {
  const filas: T[] = []

  for (let desde = 0; ; desde += TAMANO_PAGINA) {
    const { data, error } = await construirConsulta().range(desde, desde + TAMANO_PAGINA - 1)

    if (error) {
      throw new Error(`${etiqueta}: ${error.message}`)
    }

    const pagina = data ?? []
    filas.push(...pagina)
    if (pagina.length < TAMANO_PAGINA) return filas
  }
}
