import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Lo que comparten `playwright.config.ts`, `tests/auth.setup.ts` y las dos
 * pruebas de humo. No es un `.spec`: el `testMatch` por defecto de Playwright no
 * lo recoge, asi que no cuenta como prueba.
 *
 * QUE LES FALTABA A LAS TRES PRUEBAS QUE SE SALTABAN SIEMPRE
 *
 * 1. `tests/humo-dashboards.spec.ts` (2 pruebas) — pedia `E2E_ADMIN_EMAIL` y
 *    `E2E_ADMIN_PASSWORD` por variable de entorno y nadie las ponia nunca,
 *    porque no habia donde dejarlas: escribirlas a mano en cada `npm test` no
 *    lo hace ningun humano dos veces. Ahora se leen de `.env.test.local`.
 * 2. `tests/finanzas.spec.ts` (1 prueba, TKT-006) — estaba en
 *    `test.describe.skip` a secas, sin condicion. Le faltaba TODO el mecanismo
 *    de sesion: abria `/dashboard/finanzas` sin autenticarse, asi que la app la
 *    rebotaba a `/login` y ninguna de sus cuatro aserciones podia pasar.
 *    Nunca existio una forma de correrla.
 * 3. Las tres, ademas, hacian login por la interfaz en cada prueba. Ahora
 *    `auth.setup.ts` inicia sesion UNA vez y guarda las cookies
 *    (`storageState`); las pruebas arrancan ya autenticadas.
 */

export const RAIZ = path.resolve(__dirname, '..')

/** Donde `auth.setup.ts` deja la sesion de ADMIN. Va en `.gitignore`. */
export const ARCHIVO_SESION = path.join(RAIZ, 'tests', '.auth', 'admin.json')

/** Los dos archivos que necesitan navegador, servidor y sesion. */
export const ARCHIVOS_DE_HUMO = [
  '**/humo-dashboards.spec.ts',
  '**/finanzas.spec.ts',
  '**/humo-privacidad.spec.ts'
]

export const VARIABLES_DE_HUMO = ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD'] as const

/**
 * Lee `.env.test.local` si existe. Sin dependencia nueva: `dotenv` seria un
 * paquete mas para parsear dos lineas.
 *
 * Lo que ya esta en el entorno manda sobre el archivo, para que CI pueda
 * inyectar las credenciales por `secrets` sin que un archivo local las pise.
 * El archivo NUNCA se commitea (`.gitignore`); el ejemplo sin valores vive en
 * `.env.test.local.example`.
 */
export function cargarEnvDePrueba(): void {
  const archivo = path.join(RAIZ, '.env.test.local')
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

// Se carga al importar: la config de Playwright y los workers importan este
// modulo antes de mirar `process.env`.
cargarEnvDePrueba()

/** Que credenciales faltan, por nombre. Vacio = las pruebas de humo corren. */
export function faltantesDeHumo(): string[] {
  return VARIABLES_DE_HUMO.filter((nombre) => !process.env[nombre])
}

export function correnLasDeHumo(): boolean {
  return faltantesDeHumo().length === 0
}

/**
 * El motivo del salto, dicho completo. Saltarse en silencio es exactamente lo
 * que volvio inutiles a estas pruebas: aparecian como "skipped" sin decir que
 * faltaba, y nadie las echo de menos mientras el tablero pintaba ceros.
 */
export function motivoDeSalto(): string {
  return (
    `SALTADA — faltan las credenciales ${faltantesDeHumo().join(' y ')}. ` +
    'Copia `.env.test.local.example` a `.env.test.local`, pon ahi una cuenta ADMIN real y ' +
    'corre `npm run test:humo`. Mientras se salte, NADIE comprueba que los tableros ' +
    'muestren cifras: esa es la regresion del 2026-09-02. No es un fallo, es un hueco.'
  )
}
