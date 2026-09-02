import { defineConfig, devices } from '@playwright/test'
import {
  ARCHIVOS_DE_HUMO,
  ARCHIVO_SESION,
  correnLasDeHumo,
  faltantesDeHumo
} from './tests/humo-entorno'

/**
 * Tres proyectos, con fronteras nitidas:
 *
 * - `puras`   — aritmetica y lectura de codigo fuente. Sin navegador, sin red,
 *               sin base, sin sesion. Es lo que corre `npm test` y lo que corre
 *               CI en cada push. Aqui vive `tests/arquitectura.spec.ts`, la
 *               prueba que atrapa la causa del incidente del 2026-09-02.
 * - `sesion`  — `tests/auth.setup.ts`: entra una vez y guarda las cookies.
 * - `humo`    — abre los tableros con esa sesion y exige que pinten cifras.
 *               Es `npm run test:humo`. Atrapa el sintoma.
 *
 * Sin credenciales, `sesion` y `humo` se SALTAN con el motivo escrito (ver
 * `tests/humo-entorno.ts`), nunca fallan en rojo: el CI publico no tiene ni
 * base ni contrasenas. Las credenciales se leen de `.env.test.local`, que esta
 * en `.gitignore`; el ejemplo sin valores es `.env.test.local.example`.
 */

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'

/** ¿Hay credenciales? Si no, no se levanta servidor ni se carga la sesion. */
const CORRE_HUMO = correnLasDeHumo()

/** Con `E2E_BASE_URL` el servidor ya lo levanto el usuario; no se arranca otro. */
const LEVANTAR_SERVIDOR = CORRE_HUMO && !process.env.E2E_BASE_URL

if (!CORRE_HUMO) {
  // Un aviso en la consola, aparte del "skipped" del reporte. Que falte una
  // credencial tiene que verse; ese silencio es lo que dejo el hueco abierto.
  console.warn(
    `[playwright] Pruebas de humo desactivadas: faltan ${faltantesDeHumo().join(' y ')}. ` +
      'Ver .env.test.local.example'
  )
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  // Las puras terminan en milisegundos; las de humo levantan navegador, hacen
  // login y renderizan tableros que releen el ledger completo.
  timeout: 30_000,
  use: {
    baseURL: BASE_URL
  },
  projects: [
    {
      name: 'puras',
      testIgnore: ARCHIVOS_DE_HUMO
    },
    {
      name: 'sesion',
      testMatch: /auth\.setup\.ts/,
      timeout: 120_000,
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'humo',
      testMatch: ARCHIVOS_DE_HUMO,
      // Sin credenciales no se encadena el setup: sus pruebas se saltan solas.
      dependencies: CORRE_HUMO ? ['sesion'] : [],
      timeout: 120_000,
      use: {
        ...devices['Desktop Chrome'],
        ...(CORRE_HUMO ? { storageState: ARCHIVO_SESION } : {})
      }
    }
  ],
  ...(LEVANTAR_SERVIDOR
    ? {
        webServer: {
          command: 'npm run dev',
          url: BASE_URL,
          reuseExistingServer: true,
          timeout: 180_000
        }
      }
    : {})
})
