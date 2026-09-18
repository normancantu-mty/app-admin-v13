/**
 * CENTINELA — el documento termico se define UNA vez.
 *
 * El mismo comprobante se pinta con dos motores distintos: la pagina web con
 * Tailwind y la imagen PNG con Satori (`next/og`), que no sabe pintar Tailwind.
 * Que las PINTURAS sean dos es inevitable y esta aceptado. Que los DATOS sean
 * dos no: seria un comprobante en pantalla y otro en el telefono del cliente,
 * con cifras distintas y ninguna forma de saber cual manda.
 *
 * Por eso estas pruebas son estaticas, sobre el texto de los archivos: no
 * necesitan navegador ni base, y fallan en el momento en que alguien vuelve a
 * resolver los datos por su cuenta.
 */
import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

const RAIZ = join(__dirname, '..')

const PAGINA = join(RAIZ, 'app', 'ticket', '[id]', 'page.tsx')
const IMAGEN = join(RAIZ, 'app', 'api', 'documento', '[id]', 'imagen', 'route.tsx')
const FUENTE_DE_DATOS = join(RAIZ, 'lib', 'documento.ts')

function leer(ruta: string): string {
  return readFileSync(ruta, 'utf-8')
}

/** Quita comentarios para no juzgar codigo por lo que dice la prosa que lo explica. */
function sinComentarios(fuente: string): string {
  return fuente
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n')
}

test.describe('el documento termico se define una sola vez', () => {
  test('las dos pinturas piden sus datos a lib/documento', () => {
    for (const ruta of [PAGINA, IMAGEN]) {
      const fuente = sinComentarios(leer(ruta))
      expect(
        fuente,
        `${ruta} tiene que armar su documento con armarDocumentoDeTicket`
      ).toContain('armarDocumentoDeTicket')
    }
  })

  test('ninguna pintura consulta las tablas de la venta por su cuenta', () => {
    // Si una pintura vuelve a hacer su propio .from('transacciones_tickets'),
    // ya tiene una segunda definicion del documento aunque hoy coincida.
    const TABLAS = ['transacciones_tickets', 'ticket_detalles', 'finanzas_ledger']
    for (const ruta of [PAGINA, IMAGEN]) {
      const fuente = sinComentarios(leer(ruta))
      for (const tabla of TABLAS) {
        expect(fuente, `${ruta} no debe consultar ${tabla} directamente`).not.toContain(
          `from('${tabla}')`
        )
      }
    }
  })

  test('control positivo: lib/documento SI consulta esas tablas', () => {
    // Sin esto, la prueba de arriba pasaria igual si alguien borrara la
    // consulta de todos lados y el documento quedara vacio.
    const fuente = sinComentarios(leer(FUENTE_DE_DATOS))
    expect(fuente).toContain("from('transacciones_tickets')")
    expect(fuente).toContain("from('ticket_detalles')")
  })

  test('la imagen exige el token del bot antes de leer nada', () => {
    // La ruta corre con la llave de servicio y salta la RLS: el token es lo
    // unico que la separa de ser una fuga de todos los tickets.
    const fuente = sinComentarios(leer(IMAGEN))
    expect(fuente).toContain('tokenValido')

    const posicionToken = fuente.indexOf('tokenValido(request)')
    const posicionLectura = fuente.indexOf('armarDocumentoDeTicket(')
    expect(posicionToken, 'no se encontro la guarda del token').toBeGreaterThan(-1)
    expect(
      posicionToken,
      'el token se tiene que revisar ANTES de tocar la base'
    ).toBeLessThan(posicionLectura)
  })

  test('control negativo: el centinela detecta una pintura que se salta la fuente', () => {
    const impostora = "const { data } = await supabase.from('transacciones_tickets').select('*')"
    expect(impostora).toContain("from('transacciones_tickets')")
    expect(impostora).not.toContain('armarDocumentoDeTicket')
  })
})
