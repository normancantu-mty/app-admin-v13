import { test, expect } from '@playwright/test'
import { correnLasDeHumo, motivoDeSalto } from './humo-entorno'

/**
 * TKT-006 — el desglose por categoria pinta sus barras de Tailwind.
 *
 * QUE LE FALTABA: estaba en `test.describe.skip` a secas, sin condicion y sin
 * fecha de caducidad. Abria `/dashboard/finanzas` sin sesion, asi que la app la
 * rebotaba a `/login` y sus cuatro aserciones eran inalcanzables. Nunca hubo
 * forma de correrla; el `.skip` no era temporal, era permanente.
 *
 * Ahora corre en el proyecto `humo`, que arranca con la sesion de ADMIN que
 * guarda `tests/auth.setup.ts`. Ver `tests/humo-entorno.ts`.
 *
 * `CategoryBreakdown` es la barra de progreso nativa de Tailwind que exige
 * `CONVENTIONS.md` en vez de una libreria de graficas: comprobar que renderiza
 * es comprobar esa decision.
 */

test.describe('Dashboard Financiero', () => {
  test.skip(!correnLasDeHumo(), motivoDeSalto())

  test('TKT-006: Desglose de categorias renderiza correctamente barras de progreso', async ({
    page,
    context
  }) => {
    // El desglose se calcula sobre el rango del filtro global, que las pantallas
    // leen de la cookie `global_rango` (default ESTE_MES). Con `TODO` no hay
    // filtro de fechas: si el ledger tiene un solo gasto en su historia, hay
    // categoria y hay barra. Sin esto la prueba dependeria del mes en curso.
    const base = process.env.E2E_BASE_URL || 'http://localhost:3000'
    await context.addCookies([{ name: 'global_rango', value: 'TODO', url: base }])

    await page.goto('/dashboard/finanzas', { waitUntil: 'networkidle' })
    expect(
      page.url(),
      '/dashboard/finanzas reboto a login: la sesion de ADMIN no viajo'
    ).not.toContain('/login')

    // El contenedor del desglose existe.
    await expect(page.locator('text="Desglose por Categoría"')).toBeVisible()

    // Al menos una barra de progreso de Tailwind fue inyectada.
    await expect(page.locator('.bg-blue-600.rounded-full').first()).toBeVisible()

    // Y se muestran montos y porcentajes.
    await expect(page.locator('text=/\\$[0-9,.]+/').first()).toBeVisible()
    await expect(page.locator('text=/[0-9]+%/').first()).toBeVisible()
  })
})
