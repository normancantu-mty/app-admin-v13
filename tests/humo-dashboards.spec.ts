import { test, expect, type Page } from '@playwright/test'

/**
 * PRUEBA DE HUMO — la que faltaba.
 *
 * El 2026-09-02 el ERP paso dias con `/dashboard/general` y
 * `/dashboard/distribuidores` en ceros y todos los semaforos rojos, sin un solo
 * error visible: modulos de servidor usaban el cliente de Supabase de
 * NAVEGADOR, la base contestaba `permission denied` y un `try/catch` lo
 * convertia en `[]`. `tsc`, `lint`, `npm test` y `npm run build` pasaban.
 *
 * Ninguna prueba de funcion pura puede atrapar eso. Esta si: levanta la app,
 * inicia sesion como ADMIN y exige que las dos pantallas pinten al menos una
 * cifra distinta de cero. Es deliberadamente burda — no comprueba que los
 * numeros sean CORRECTOS (para eso estan las cifras de control del README),
 * comprueba que EXISTAN.
 *
 * COMO CORRERLA (necesita credenciales reales; por eso no corre en CI):
 *
 *   E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... npm test
 *
 * Opcional: `E2E_BASE_URL` para apuntar a un servidor ya levantado. Sin
 * `E2E_BASE_URL`, `playwright.config.ts` arranca `npm run dev` por su cuenta.
 * Requiere Chromium instalado (`npx playwright install chromium`).
 *
 * Sin las dos variables la prueba se SALTA con aviso, nunca falla en rojo: el
 * CI publico no tiene ni base ni contrasenas.
 */

const VARIABLES_REQUERIDAS = ['E2E_ADMIN_EMAIL', 'E2E_ADMIN_PASSWORD'] as const

const FALTANTES = VARIABLES_REQUERIDAS.filter((nombre) => !process.env[nombre])

const MOTIVO_SALTO =
  `Prueba de humo saltada: faltan ${FALTANTES.join(' y ')}. ` +
  'Corre `E2E_ADMIN_EMAIL=... E2E_ADMIN_PASSWORD=... npm test` con una cuenta ADMIN ' +
  'para verificar que los tableros no esten en ceros. NO es un fallo.'

/** Todas las cifras con signo de pesos que haya en la pantalla. */
function montosDeTexto(texto: string): number[] {
  const encontrados = texto.match(/\$\s?-?[\d,]+(?:\.\d+)?/g) ?? []
  return encontrados
    .map((crudo) => Number(crudo.replace(/[^0-9.-]/g, '')))
    .filter((valor) => Number.isFinite(valor))
}

async function iniciarSesionAdmin(page: Page): Promise<void> {
  await page.goto('/login')
  await page.locator('#email').fill(process.env.E2E_ADMIN_EMAIL as string)
  await page.locator('#password').fill(process.env.E2E_ADMIN_PASSWORD as string)
  await page.locator('button[type="submit"]').click()

  // Un ADMIN aterriza en /dashboard/finanzas (app/login/page.tsx). Si en vez de
  // eso el formulario pinta su error rojo, se reporta ESE texto: "credencial
  // incorrecta" es un diagnostico, "waitForURL agoto el tiempo" no lo es.
  const errorLogin = page.locator('p.text-red-600')
  const aterrizo = page.waitForURL(/\/dashboard\//, { timeout: 45_000 }).then(() => 'ok' as const)
  const fallo = errorLogin
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => 'error' as const)

  const desenlace = await Promise.race([aterrizo, fallo]).catch(() => 'timeout' as const)

  if (desenlace === 'error') {
    throw new Error(
      `El login rechazó a E2E_ADMIN_EMAIL: "${await errorLogin.innerText()}". ` +
        'Revisa las credenciales; la app no llegó a cargarse.'
    )
  }
  if (desenlace === 'timeout') {
    throw new Error('El login no respondió: ni redirigió al dashboard ni mostró error.')
  }
}

/**
 * Abre la ruta ya autenticado y devuelve el texto del `<body>`.
 * Si la sesion no viajo, la app rebota a /login: eso se reporta como tal en vez
 * de disfrazarse de "no habia numeros".
 */
async function textoDeRuta(page: Page, ruta: string): Promise<string> {
  await page.goto(ruta, { waitUntil: 'networkidle' })
  expect(page.url(), `${ruta} rebotó a login: la sesión de ADMIN no viajó`).not.toContain('/login')
  return (await page.locator('body').innerText()) ?? ''
}

test.describe('humo: los tableros no pintan ceros con sesion de ADMIN', () => {
  test.skip(FALTANTES.length > 0, MOTIVO_SALTO)

  test('/dashboard/general muestra cifras reales', async ({ page }) => {
    await iniciarSesionAdmin(page)
    const texto = await textoDeRuta(page, '/dashboard/general')

    const montos = montosDeTexto(texto)
    expect(montos.length, '/dashboard/general no pintó ninguna cifra en pesos').toBeGreaterThan(0)
    expect(
      montos.some((monto) => monto !== 0),
      `/dashboard/general está TODO en $0 (${montos.length} cifras, todas cero). ` +
        'Sintoma exacto de la regresion de 2026-09-02: lectura de servidor con el cliente ' +
        'de navegador -> permission denied -> [] en silencio.'
    ).toBe(true)
  })

  test('/dashboard/distribuidores muestra cifras reales', async ({ page }) => {
    await iniciarSesionAdmin(page)
    const texto = await textoDeRuta(page, '/dashboard/distribuidores')

    const montos = montosDeTexto(texto)
    expect(montos.length, '/dashboard/distribuidores no pintó ninguna cifra en pesos').toBeGreaterThan(0)
    expect(
      montos.some((monto) => monto !== 0),
      '/dashboard/distribuidores está TODO en $0. Revisa que `lib/risk-utils.ts` y ' +
        '`lib/dashboard-utils.ts` reciban un cliente de servidor con la sesión.'
    ).toBe(true)
  })
})
