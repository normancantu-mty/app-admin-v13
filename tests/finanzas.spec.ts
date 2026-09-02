import { test, expect } from '@playwright/test'

// e2e: requiere `npm run dev` corriendo y una sesion autenticada.
// Se salta en `npm test` para que la suite no dependa de red ni de la base.
test.describe.skip('Dashboard Financiero', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard/finanzas')
  })

  test('TKT-006: Desglose de categorías renderiza correctamente barras de progreso', async ({ page }) => {
    // Verificar que el contenedor principal del desglose existe
    await expect(page.locator('text="Desglose por Categoría"')).toBeVisible()
    
    // Verificar que al menos una barra de progreso de Tailwind fue inyectada
    await expect(page.locator('.bg-blue-600.rounded-full').first()).toBeVisible()
    
    // Verificar que se muestran montos y porcentajes
    await expect(page.locator('text=/\\$[0-9,.]+/')).toBeVisible()
    await expect(page.locator('text=/[0-9]+%/')).toBeVisible()
  })
})
