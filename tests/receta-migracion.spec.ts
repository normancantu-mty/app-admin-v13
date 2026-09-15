import { test, expect } from '@playwright/test'
import { recetaDeRecuperacion } from './receta-migracion'

/**
 * CENTINELA DE ERP-83.
 *
 * Un mensaje de error que nadie ejecuta es codigo sin probar, y ya costo una vez
 * (`E-296`: se valido la SINTAXIS de un script y el defecto estaba en un valor
 * vacio, que la sintaxis no mira). Aqui se comprueba lo que de verdad importa:
 * que la receta traiga la version correcta y la ruta correcta, y que un repo
 * sano no produzca ruido.
 *
 * Puro: sin navegador, sin base, sin sesion.
 */

const HUERFANA = '20260914215544_agente_reglas_vivas'

test.describe('ERP-83 - la receta de recuperacion', () => {
  test('trae la version, el nombre completo y la ruta destino', () => {
    const receta = recetaDeRecuperacion([HUERFANA])

    expect(receta).toContain("version = '20260914215544'")
    expect(receta).toContain(`supabase/migrations/${HUERFANA}.sql`)
    expect(receta).toContain('supabase_migrations.schema_migrations')
    expect(receta).toContain('md5')
  })

  test('la version es SOLO el timestamp, no el nombre entero', () => {
    // El defecto realista: partir mal y mandar a buscar
    // version = '20260914215544_agente_reglas_vivas', que no existe en la tabla
    // y devuelve cero filas sin decir por que.
    const receta = recetaDeRecuperacion([HUERFANA])
    expect(receta).not.toContain("version = '20260914215544_agente")
  })

  test('un nombre con varios guiones bajos no se parte de mas', () => {
    const receta = recetaDeRecuperacion(['20260915000928_erp16_entidad_obligatoria_en_inventario'])
    expect(receta).toContain("version = '20260915000928'")
    expect(receta).toContain(
      'supabase/migrations/20260915000928_erp16_entidad_obligatoria_en_inventario.sql'
    )
  })

  test('varias huerfanas producen una entrada por cada una', () => {
    const receta = recetaDeRecuperacion([HUERFANA, '20260912223650_agente_persistencia'])
    expect(receta).toContain("version = '20260914215544'")
    expect(receta).toContain("version = '20260912223650'")
    expect([...receta.matchAll(/recupera su SQL/g)]).toHaveLength(2)
  })

  test('CONTROL NEGATIVO - sin huerfanas la receta es vacia', () => {
    // Sin esto, una receta que SIEMPRE dijera algo daria el mismo verde arriba,
    // y el mensaje de exito de un repo sano vendria con instrucciones para
    // arreglar un problema que no existe.
    expect(recetaDeRecuperacion([])).toBe('')
  })

  test('CONTROL NEGATIVO - la receta no inventa una migracion que no le pasaron', () => {
    const receta = recetaDeRecuperacion(['20260101000000_una_sola'])
    expect(receta).not.toContain('20260914215544')
    expect([...receta.matchAll(/recupera su SQL/g)]).toHaveLength(1)
  })
})
