import { test as setup, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { ARCHIVO_SESION, correnLasDeHumo, motivoDeSalto } from './humo-entorno'

/**
 * Inicia sesion UNA vez y guarda las cookies en `tests/.auth/admin.json`.
 * El proyecto `humo` de `playwright.config.ts` depende de este archivo y arranca
 * sus pruebas con esa sesion ya puesta (`storageState`), sin volver a pasar por
 * el formulario.
 *
 * https://playwright.dev/docs/auth
 *
 * El archivo de sesion contiene un token real: esta en `.gitignore` y no debe
 * salir de la maquina.
 */
setup('iniciar sesion como ADMIN y guardar la sesion', async ({ page }) => {
  setup.skip(!correnLasDeHumo(), motivoDeSalto())

  await page.goto('/login')
  await page.locator('#email').fill(process.env.E2E_ADMIN_EMAIL as string)
  await page.locator('#password').fill(process.env.E2E_ADMIN_PASSWORD as string)
  await page.locator('button[type="submit"]').click()

  // Un ADMIN aterriza en /v2 desde el 2026-10-29 (app/login/page.tsx; antes
  // /dashboard/finanzas). Se aceptan las dos zonas. Si en vez de eso el
  // formulario pinta su error rojo, se reporta ESE texto: "credencial
  // incorrecta" es un diagnostico, "waitForURL agoto el tiempo" no lo es.
  const errorLogin = page.locator('p.text-red-600')
  const aterrizo = page.waitForURL(/\/(dashboard\/|v2(\/|$))/, { timeout: 45_000 }).then(() => 'ok' as const)
  const fallo = errorLogin
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'error' as const)

  const desenlace = await Promise.race([aterrizo, fallo]).catch(() => 'timeout' as const)

  if (desenlace === 'error') {
    throw new Error(
      `El login rechazo a E2E_ADMIN_EMAIL: "${await errorLogin.innerText()}". ` +
        'Revisa las credenciales de `.env.test.local`; la app no llego a cargarse.'
    )
  }
  if (desenlace === 'timeout') {
    throw new Error('El login no respondio: ni redirigio al dashboard ni mostro error.')
  }

  // La sesion de Supabase vive en cookies (para el servidor) y en localStorage
  // (para el cliente de navegador). `storageState` guarda ambas.
  await expect(page).toHaveURL(/\/dashboard\//)
  mkdirSync(path.dirname(ARCHIVO_SESION), { recursive: true })
  await page.context().storageState({ path: ARCHIVO_SESION })
})
