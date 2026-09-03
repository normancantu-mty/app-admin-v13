import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Lo que necesita `tests/vistas-equivalencia.spec.ts` para hablar con la base.
 *
 * No es un `.spec`: el `testMatch` por defecto de Playwright no lo recoge, asi
 * que no cuenta como prueba.
 *
 * POR QUE ESTA PRUEBA NO PUEDE SER PURA
 *
 * Las otras pruebas de calculo del repo son aritmetica sobre datos inventados.
 * Esta no puede serlo: su trabajo es comprobar que las **vistas canonicas** de
 * Postgres dan, al centavo, lo mismo que las funciones de TypeScript **sobre
 * los datos reales de hoy**. Una vista solo existe dentro de la base; una
 * funcion de TypeScript solo corre en Node. Compararlas exige las dos a la vez.
 *
 * Por eso vive en su propio proyecto de Playwright (`equivalencia`) y no en
 * `puras`, que es y sigue siendo "sin navegador, sin red, sin base, sin sesion".
 *
 * Lee con SERVICE ROLE a proposito: las dos partes de la comparacion tienen que
 * ver exactamente las mismas filas. Que el RLS se respete es otra prueba —la
 * del criterio 3, que se corre a mano contra la base con la sesion de un DST y
 * cuya salida quedo escrita al pie de la migracion.
 */

export const RAIZ = path.resolve(__dirname, '..')

/**
 * El proyecto `equivalencia`: los archivos que necesitan base de datos.
 *
 * - `vistas-equivalencia.spec.ts` compara VISTA contra FUNCION de TypeScript.
 * - `cableado-pantallas.spec.ts` compara PANTALLA contra PANTALLA: cada cifra
 *   que ve un ADMIN con rango "TODO", calculada por el camino viejo y por el
 *   nuevo. Es la red del cableado del prompt 16.
 *
 * Los dos leen con service role y ninguno abre navegador.
 */
export const ARCHIVOS_DE_EQUIVALENCIA = [
  '**/vistas-equivalencia.spec.ts',
  '**/cableado-pantallas.spec.ts'
]

export const VARIABLES_DE_EQUIVALENCIA = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const

/**
 * Lee `.env` si existe. Sin dependencia nueva: `dotenv` seria un paquete mas
 * para parsear cuatro lineas, y `next dev` ya lo lee solo.
 *
 * Lo que ya esta en el entorno manda sobre el archivo, para que CI pueda
 * inyectar las variables por `secrets` sin que un archivo local las pise.
 * `.env` NUNCA se commitea.
 */
export function cargarEnvDeLaApp(): void {
  const archivo = path.join(RAIZ, '.env')
  if (!existsSync(archivo)) return

  for (const linea of readFileSync(archivo, 'utf8').split('\n')) {
    const limpia = linea.trim()
    if (!limpia || limpia.startsWith('#')) continue

    const corte = limpia.indexOf('=')
    if (corte < 1) continue

    const nombre = limpia.slice(0, corte).trim()
    if (process.env[nombre]) continue

    process.env[nombre] = limpia
      .slice(corte + 1)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
}

// Se carga al importar, antes de que nadie mire `process.env`.
cargarEnvDeLaApp()

/** La URL de Supabase, por cualquiera de sus dos nombres. */
export function urlSupabase(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
}

export function llaveServiceRole(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY
}

/** Que variables faltan, por nombre. Vacio = la prueba de equivalencia corre. */
export function faltantesDeEquivalencia(): string[] {
  const faltan: string[] = []
  if (!urlSupabase()) faltan.push('NEXT_PUBLIC_SUPABASE_URL')
  if (!llaveServiceRole()) faltan.push('SUPABASE_SERVICE_ROLE_KEY')
  return faltan
}

export function correnLasDeEquivalencia(): boolean {
  return faltantesDeEquivalencia().length === 0
}

/**
 * El motivo del salto, dicho completo. Saltarse en silencio es exactamente lo
 * que volvio inutiles a las pruebas de humo durante meses.
 */
export function motivoDeSalto(): string {
  return (
    `SALTADA — faltan ${faltantesDeEquivalencia().join(' y ')} en el entorno o en \`.env\`. ` +
    'Mientras se salte, NADIE comprueba que las vistas canonicas de Postgres y las funciones ' +
    'de TypeScript den la misma cifra. No es un fallo, es un hueco: el dia que diverjan, un ' +
    'reporte automatico le dara a un inversionista un numero distinto al de la pantalla.'
  )
}
