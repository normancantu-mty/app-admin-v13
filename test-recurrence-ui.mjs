import { test, expect } from '@playwright/test'

test('Verificar campos de recurrencia', async ({ page }) => {
  await page.goto('/dashboard/finanzas/nuevo')
  
  // Seleccionar tipo de movimiento como egreso
  await page.selectOption('select[name="tipo_movimiento"]', 'egreso')
  
  // Verificar que el checkbox de recurrencia existe
  const recurrenceCheckbox = page.locator('input[name="es_recurrente"]')
  await expect(recurrenceCheckbox).toBeVisible()
  
  // Marcar el checkbox
  await recurrenceCheckbox.check()
  
  // Verificar que los campos de frecuencia aparecen
  await expect(page.locator('select[name="frecuencia"]')).toBeVisible()
  await expect(page.locator('input[name="duracion_meses"]')).toBeVisible()
})
