import { defineConfig } from '@playwright/test'

/**
 * Las pruebas de tests/calculo.spec.ts son puras: no piden el fixture `page`,
 * asi que Playwright no lanza ningun navegador para correrlas.
 * Chromium ya vive en %LOCALAPPDATA%\ms-playwright; no hace falta
 * `playwright install`. Los e2e que si necesitan navegador y dev server
 * estan marcados con test.describe.skip.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list'
})
