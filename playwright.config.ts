import { defineConfig } from '@playwright/test'

/**
 * Las pruebas de tests/calculo.spec.ts son puras: no piden el fixture `page`,
 * asi que Playwright no lanza ningun navegador para correrlas.
 * Chromium ya vive en %LOCALAPPDATA%\ms-playwright; no hace falta
 * `playwright install`. Los e2e que si necesitan navegador y dev server
 * estan marcados con test.describe.skip.
 *
 * `tests/humo-dashboards.spec.ts` es la excepcion: SI necesita navegador y app
 * corriendo, pero se salta sola si no hay `E2E_ADMIN_EMAIL` y
 * `E2E_ADMIN_PASSWORD`. Por eso el `webServer` de abajo solo se arma cuando esas
 * dos variables existen: en CI, y en un `npm test` normal, esta config sigue
 * siendo la de antes y no levanta nada.
 */

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000'

/** ¿Hay credenciales para la prueba de humo? Si no, no se levanta el servidor. */
const CORRE_HUMO = Boolean(process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD)

/** Con `E2E_BASE_URL` el servidor ya lo levanto el usuario; no se arranca otro. */
const LEVANTAR_SERVIDOR = CORRE_HUMO && !process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  // Las puras terminan en milisegundos; la de humo levanta navegador, hace
  // login y renderiza dos tableros que releen el ledger completo.
  timeout: CORRE_HUMO ? 120_000 : 30_000,
  use: {
    baseURL: BASE_URL
  },
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
