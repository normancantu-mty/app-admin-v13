import { test, expect } from '@playwright/test'
import { fetchTodasLasFilas, TAMANO_PAGINA, type ConsultaPaginable } from '@/lib/paginacion'

/**
 * ERP-25 · los BORDES del paginador, con datos sinteticos.
 *
 * Por que existe, y por que no lo cubria nada:
 * `tests/paginacion-ledger.spec.ts` es un analizador de CODIGO FUENTE — vigila
 * que ninguna lectura de ledger se escriba sin paginar. Eso protege los sitios
 * de llamada, pero **no ejecuta `fetchTodasLasFilas` ni una sola vez**.
 *
 * El defecto clasico de un paginador no es "no pagina": es que **pierde o
 * duplica la fila del limite** por un off-by-one en `.range()`, que en
 * PostgREST es inclusivo en los DOS extremos. Ese defecto es invisible contra
 * produccion, donde hoy hay 484 filas: hace falta fabricar 999, 1000, 1001 y
 * 2000. Escrito el 2026-09-15 por el Socio, al auditar la corrida desatendida.
 */

/** Filas sinteticas numeradas: la identidad de cada una es su indice. */
const filasFalsas = (n: number) => Array.from({ length: n }, (_, i) => ({ i }))

/**
 * Doble de PostgREST: `.range(desde, hasta)` inclusivo en ambos extremos, y
 * nunca devuelve mas de `TAMANO_PAGINA` filas aunque se le pida un tramo mayor
 * — que es justo lo que hace el de verdad, y en silencio.
 */
function baseFalsa(total: number, fallarEnPagina = -1) {
  let llamadas = 0
  const construir = (): ConsultaPaginable<{ i: number }> => ({
    range(desde: number, hasta: number) {
      const pagina = llamadas++
      if (pagina === fallarEnPagina) {
        return Promise.resolve({ data: null, error: { message: 'se cayo la pagina' } })
      }
      const tope = Math.min(hasta, desde + TAMANO_PAGINA - 1, total - 1)
      return Promise.resolve({ data: filasFalsas(total).slice(desde, tope + 1), error: null })
    }
  })
  return { construir, cuantasLlamadas: () => llamadas }
}

test.describe('ERP-25 · fetchTodasLasFilas en los bordes', () => {
  for (const total of [0, 1, 999, 1000, 1001, 1999, 2000, 2001]) {
    test(`${total} filas: llegan todas, en orden, sin perder ni duplicar`, async () => {
      const { construir } = baseFalsa(total)
      const filas = await fetchTodasLasFilas(construir, `sintetico-${total}`)

      expect(filas.length).toBe(total)
      // La prueba de que no hay off-by-one: cada fila esta en su sitio.
      expect(filas.map((f) => f.i)).toEqual(filasFalsas(total).map((f) => f.i))
      expect(new Set(filas.map((f) => f.i)).size).toBe(total)
    })
  }

  test('en el multiplo exacto pide una pagina de mas, y por eso no se corta', async () => {
    // Si parara al ver una pagina llena, con 2000 filas devolveria 2000 por
    // casualidad pero con 1000 exactas jamas sabria que ya no hay mas.
    const dosMil = baseFalsa(2000)
    expect((await fetchTodasLasFilas(dosMil.construir, 'x')).length).toBe(2000)
    expect(dosMil.cuantasLlamadas()).toBe(3)

    const novecientos = baseFalsa(999)
    expect((await fetchTodasLasFilas(novecientos.construir, 'x')).length).toBe(999)
    expect(novecientos.cuantasLlamadas()).toBe(1)
  })

  test('CONTROL NEGATIVO: un error a media paginacion LANZA, no devuelve lo acumulado', async () => {
    // Devolver 1000 de 2000 sin avisar es el defecto que este modulo existe
    // para evitar: una suma incompleta que nadie distingue de una completa.
    const { construir } = baseFalsa(2000, 1)
    await expect(fetchTodasLasFilas(construir, 'ledger-de-prueba')).rejects.toThrow(
      /ledger-de-prueba: se cayo la pagina/
    )
  })

  test('CONTROL NEGATIVO: la consulta se reconstruye por pagina, no se reusa', async () => {
    // Un PostgrestFilterBuilder es un thenable de un solo uso: reusarlo
    // devolveria la primera pagina para siempre y el bucle no terminaria.
    const { construir, cuantasLlamadas } = baseFalsa(2500)
    const filas = await fetchTodasLasFilas(construir, 'x')
    expect(filas.length).toBe(2500)
    expect(cuantasLlamadas()).toBe(3)
  })
})
