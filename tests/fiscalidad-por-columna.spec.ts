import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * ERP-21 — la fiscalidad se decide por `tipo_fiscalidad`, jamas por el nombre de la cuenta.
 *
 * Por que existe: hasta el 2026-09-14, `pos.ts` resolvia el regimen fiscal con
 * `normalizeText(nombre).includes('fresnillo')`. No era un atajo para leer la columna: era una
 * compuerta que la ANULABA — si el nombre no decia "fresnillo", `tipo_fiscalidad` se tiraba y se
 * devolvia 'LIBRE'. `Cuenta personal` esta marcada IVA_ONLY en la base y el POS la trataba como
 * LIBRE, o sea vendia sin separar IVA; mientras tanto
 * `app/api/finanzas/aprobaciones/route.ts` leia la columna y decia IVA_ONLY para la misma cuenta.
 * Dos verdades sobre el mismo hecho, y renombrar la cuenta cambiaba los impuestos en silencio.
 *
 * Mismo idioma que el centinela de ERP-59 en `avisos.spec.ts`: se lee el fuente y se filtran los
 * comentarios, para exigirselo al codigo vivo y no al texto que lo documenta.
 *
 * El allowlist es a proposito y es su mayor debilidad: `lib/dashboard-utils.ts` tambien compara el
 * nombre, pero para las cubetas de liquidez del tablero, que NO son fiscalidad (eso es ERP-21b).
 * `lib/avisos.ts` y `lib/bot-servidor.ts` tambien lo comparan, y ahi el veto textual es
 * cinturon-y-tirantes deliberado, documentado en `avisos.ts`.
 */

/**
 * ── QUE INVARIANTE VIGILA ESTA LISTA, Y POR QUE CRECIO EN VEZ DE MUDARSE ──
 * El invariante es **ningun archivo que decida fiscalidad lo hace comparando el
 * NOMBRE de la cuenta**. `resolveTipoFiscalidadCuenta` se mudo de
 * `app/actions/pos.ts` a `lib/venta-servidor.ts` el 2026-09-18 al extraer la
 * venta de la sesion, asi que el archivo nuevo entra a la lista: ahi es donde
 * hoy se decide, y ahora lo comparten la pantalla y el bot de Telegram.
 *
 * Y `app/actions/pos.ts` **se queda**, que es la mitad que faltaba. La
 * envoltura no decide fiscalidad hoy; lo que esta prueba impide es que manana
 * alguien le meta un atajo por nombre "nada mas para el POS" y tengamos otra
 * vez dos verdades sobre el mismo hecho — que es literalmente el defecto de
 * ERP-21 que esta prueba nacio para cerrar. Vigilar un archivo que hoy esta
 * limpio no cuesta nada; descubrir que se ensucio cuesta una venta mal cobrada.
 */
const ARCHIVOS_DE_LOGICA_FISCAL = [
  'lib/venta-cuenta-fiscal.ts',
  'lib/venta-servidor.ts',
  'app/actions/pos.ts'
]

// Solo la COMPARACION textual, no el identificador: `finance-utils.ts` tiene una constante
// llamada CUENTA_FRESNILLO que no decide nada fiscal, y un patron mas laxo la marcaba en rojo.
const DECIDE_POR_NOMBRE = /includes\(\s*['"]fresnillo['"]\s*\)/i

function codigoVivo(relativo: string): string {
  return readFileSync(join(process.cwd(), relativo), 'utf-8')
    .split('\n')
    .filter((linea) => {
      const t = linea.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

test.describe('ERP-21 — ningun archivo de logica fiscal decide por el nombre de la cuenta', () => {
  for (const relativo of ARCHIVOS_DE_LOGICA_FISCAL) {
    test(`${relativo} lee la columna, no el nombre`, () => {
      expect(codigoVivo(relativo)).not.toMatch(DECIDE_POR_NOMBRE)
    })
  }

  // Control positivo: el predicado tiene que poder dar VERDE, o no esta midiendo nada.
  test('control positivo: da verde en archivos que ya leen la columna', () => {
    expect(codigoVivo('lib/finance-utils.ts')).not.toMatch(DECIDE_POR_NOMBRE)
    expect(codigoVivo('app/api/finanzas/aprobaciones/route.ts')).not.toMatch(DECIDE_POR_NOMBRE)
  })

  // Control negativo: el predicado tiene que poder dar ROJO, o el verde de arriba no dice nada.
  test('control negativo: el predicado si caza la comparacion textual', () => {
    expect("const esFiscal = normalizeText(n).includes('fresnillo')").toMatch(DECIDE_POR_NOMBRE)
    expect("const CUENTA_FRESNILLO = 'x'").not.toMatch(DECIDE_POR_NOMBRE)
  })
})
