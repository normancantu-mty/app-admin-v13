import { test, expect, type Page } from '@playwright/test'
import { correnLasDeHumo, motivoDeSalto } from './humo-entorno'

/**
 * PRUEBA DE HUMO — el sintoma.
 *
 * El 2026-09-02 el ERP paso dias con `/dashboard/general` y
 * `/dashboard/distribuidores` en ceros y todos los semaforos rojos, sin un solo
 * error visible: modulos de servidor usaban el cliente de Supabase de
 * NAVEGADOR, la base contestaba `permission denied` y un `try/catch` lo
 * convertia en `[]`. `tsc`, `lint`, `npm test` y `npm run build` pasaban.
 *
 * Esta prueba es deliberadamente burda: no comprueba que los numeros sean
 * CORRECTOS (para eso estan las cifras de control del README), comprueba que
 * EXISTAN.
 *
 * La causa la atrapa `tests/arquitectura.spec.ts`, que no necesita nada y corre
 * siempre. Esta necesita app, base y sesion, asi que corre cuando hay
 * credenciales:
 *
 *   npm run test:humo        (lee `.env.test.local`)
 *
 * La sesion la deja `tests/auth.setup.ts` en `tests/.auth/admin.json`; el
 * proyecto `humo` de `playwright.config.ts` la carga como `storageState`, asi
 * que aqui ya se llega autenticado. Con `E2E_BASE_URL` se apunta a un servidor
 * ya levantado; sin ella, la config arranca `npm run dev`.
 */

test.describe('humo: los tableros no pintan ceros con sesion de ADMIN', () => {
  test.skip(!correnLasDeHumo(), motivoDeSalto())

  /** Todas las cifras con signo de pesos que haya en la pantalla. */
  function montosDeTexto(texto: string): number[] {
    const encontrados = texto.match(/\$\s?-?[\d,]+(?:\.\d+)?/g) ?? []
    return encontrados
      .map((crudo) => Number(crudo.replace(/[^0-9.-]/g, '')))
      .filter((valor) => Number.isFinite(valor))
  }

  /**
   * Abre la ruta ya autenticado y devuelve el texto del `<body>`.
   * Si la sesion no viajo, la app rebota a /login: eso se reporta como tal en
   * vez de disfrazarse de "no habia numeros".
   */
  async function textoDeRuta(page: Page, ruta: string): Promise<string> {
    await page.goto(ruta, { waitUntil: 'networkidle' })
    expect(page.url(), `${ruta} reboto a login: la sesion de ADMIN no viajo`).not.toContain('/login')
    return (await page.locator('body').innerText()) ?? ''
  }

  test('/dashboard/general muestra cifras reales', async ({ page }) => {
    const texto = await textoDeRuta(page, '/dashboard/general')

    const montos = montosDeTexto(texto)
    expect(montos.length, '/dashboard/general no pinto ninguna cifra en pesos').toBeGreaterThan(0)
    expect(
      montos.some((monto) => monto !== 0),
      `/dashboard/general esta TODO en $0 (${montos.length} cifras, todas cero). ` +
        'Sintoma exacto de la regresion de 2026-09-02: lectura de servidor con el cliente ' +
        'de navegador -> permission denied -> [] en silencio.'
    ).toBe(true)
  })

  test('/dashboard/distribuidores muestra cifras reales', async ({ page }) => {
    const texto = await textoDeRuta(page, '/dashboard/distribuidores')

    const montos = montosDeTexto(texto)
    expect(montos.length, '/dashboard/distribuidores no pinto ninguna cifra en pesos').toBeGreaterThan(0)
    expect(
      montos.some((monto) => monto !== 0),
      '/dashboard/distribuidores esta TODO en $0. Revisa que `lib/risk-utils.ts` y ' +
        '`lib/dashboard-utils.ts` reciban un cliente de servidor con la sesion.'
    ).toBe(true)
  })
})
