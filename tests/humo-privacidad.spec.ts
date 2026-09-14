import { test, expect, Page } from '@playwright/test'
import { correnLasDeHumo, motivoDeSalto } from './humo-entorno'

/**
 * El ojito, contra el navegador de verdad.
 *
 * La funcion pura ya esta probada en `privacidad.spec.ts` con sus 14 controles
 * negativos. **Esto prueba lo otro**, que es donde de verdad se puede romper:
 * que el recorrido de nodos de texto alcance lo que hay en pantalla, que el
 * observador vuelva a tapar cuando React repinta, y sobre todo **que al
 * destapar vuelva el numero de verdad y no un valor caduco**.
 *
 * Ese ultimo es el modo de fallo caro de este patron: un ERP que despues de
 * apagar el modo privado ensenia cifras viejas es peor que uno sin modo
 * privado, porque miente en silencio.
 */

const TAPA = /[•]/

async function textoDelTablero(page: Page): Promise<string> {
  return (await page.locator('main').innerText()) ?? ''
}

async function ponerOjito(page: Page, encendido: boolean) {
  const boton = page.getByTestId('ojito-privacidad')
  await expect(boton).toBeVisible()
  const estaPrendido = (await boton.getAttribute('aria-pressed')) === 'true'
  if (estaPrendido !== encendido) await boton.click()
  await expect(boton).toHaveAttribute('aria-pressed', String(encendido))
}

test.describe('modo privado en pantalla', () => {
  test.skip(!correnLasDeHumo(), motivoDeSalto())

  test('el ojito tapa las cifras y las devuelve intactas', async ({ page }) => {
    await page.goto('/dashboard/finanzas')
    await page.waitForLoadState('networkidle')

    await ponerOjito(page, false)
    const original = await textoDelTablero(page)

    // Control de la prueba: si el tablero no trae ni una cifra, esta prueba no
    // esta midiendo nada y hay que decirlo, no pasar en verde.
    expect(original, 'el tablero no trae ninguna cifra que tapar').toMatch(/\$\s?\d/)
    expect(original).not.toMatch(TAPA)

    await ponerOjito(page, true)
    const tapado = await textoDelTablero(page)
    expect(tapado, 'con el ojito encendido sigue habiendo digitos con $').not.toMatch(/\$\s?\d/)
    expect(tapado).toMatch(TAPA)

    await ponerOjito(page, false)
    const devuelto = await textoDelTablero(page)
    expect(devuelto, 'al destapar no volvio el texto original').toBe(original)
  })

  test('lo que React pinta DESPUES tambien sale tapado', async ({ page }) => {
    await page.goto('/dashboard/finanzas')
    await page.waitForLoadState('networkidle')
    await ponerOjito(page, true)

    // Navegar dentro del dashboard monta pantallas nuevas sin recargar: es el
    // caso que un enmascarado de una sola pasada dejaria escapar.
    await page.goto('/dashboard/cartera')
    await page.waitForLoadState('networkidle')

    const tapado = await textoDelTablero(page)
    expect(tapado, 'la pantalla nueva se pinto con las cifras a la vista').not.toMatch(/\$\s?\d/)
  })

  test('el modo sobrevive a recargar la pagina', async ({ page }) => {
    await page.goto('/dashboard/finanzas')
    await page.waitForLoadState('networkidle')
    await ponerOjito(page, true)

    await page.reload()
    await page.waitForLoadState('networkidle')

    await expect(page.getByTestId('ojito-privacidad')).toHaveAttribute('aria-pressed', 'true')
    expect(await textoDelTablero(page)).not.toMatch(/\$\s?\d/)
  })
})
