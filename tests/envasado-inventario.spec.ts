import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { movimientosDeEnvasado, type MovimientoEnvasado } from '../lib/bot-envasado'
import { correnLasDeEquivalencia, llaveServiceRole, motivoDeSalto, urlSupabase } from './vistas-entorno'

/**
 * Fase 8, D82 — la MISMA aritmetica del envasado en dos lados:
 * `movimientos_de_envasado` (Postgres; la usa `registrar_en_lote`, que es lo
 * que escribe) y `movimientosDeEnvasado` (TS; la usa la propuesta, que en
 * ensayo no puede llamar `rpc`). Esta prueba las amarra renglon por renglon
 * sobre la receta REAL de cada terminado. Solo lee: `movimientos_de_envasado`
 * es `stable` y no toca tablas mas que para leer la receta.
 *
 * Necesita base (service role), asi que vive en el proyecto `equivalencia`.
 */

const SALTO = !correnLasDeEquivalencia()

function cliente(): SupabaseClient {
  return createClient(urlSupabase()!, llaveServiceRole()!, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

const ordenar = (m: MovimientoEnvasado[]) =>
  [...m].sort((a, b) =>
    (a.tipo_movimiento + a.id_producto).localeCompare(b.tipo_movimiento + b.id_producto)
  )

async function desdeSql(idProducto: string, botellas: number): Promise<MovimientoEnvasado[]> {
  const { data, error } = await cliente().rpc('movimientos_de_envasado', {
    p_id_producto: idProducto,
    p_botellas: botellas
  })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Record<string, unknown>[]).map((f) => ({
    id_producto: String(f.id_producto),
    tipo_movimiento: f.tipo_movimiento as MovimientoEnvasado['tipo_movimiento'],
    cantidad: Number(f.cantidad)
  }))
}

test.describe('D82 — envasado: Postgres y TS dicen lo mismo', () => {
  test.skip(SALTO, motivoDeSalto())

  test('para cada terminado con receta, 24 botellas mueven lo mismo en los dos lados', async () => {
    const db = cliente()
    const { data: receta, error } = await db
      .from('recetas_produccion')
      .select('id_producto_terminado, id_insumo, cantidad_requerida')
    if (error) throw new Error(error.message)
    const terminados = [...new Set((receta ?? []).map((r) => r.id_producto_terminado as string))]
    // Hoy son las tres presentaciones de Plata; si alguien borra recetas la
    // prueba no debe pasar en vacio.
    expect(terminados.length).toBeGreaterThanOrEqual(3)

    for (const id of terminados) {
      const suya = (receta ?? [])
        .filter((r) => r.id_producto_terminado === id)
        .map((r) => ({ id_insumo: r.id_insumo as string | null, cantidad_requerida: Number(r.cantidad_requerida) }))
      const ts = movimientosDeEnvasado(id, 24, suya)
      const sql = await desdeSql(id, 24)
      expect(ts.length).toBeGreaterThan(1) // PRODUCCION + al menos un insumo
      expect(ordenar(sql), `terminado ${id}`).toEqual(ordenar(ts))
    }
  })

  test('CONTROL: cero botellas no mueve nada en ninguno de los dos lados', async () => {
    const { data } = await cliente().from('recetas_produccion').select('id_producto_terminado').limit(1)
    const id = String(data?.[0]?.id_producto_terminado)
    expect(await desdeSql(id, 0)).toEqual([])
    expect(movimientosDeEnvasado(id, 0, [{ id_insumo: 'x', cantidad_requerida: 1 }])).toEqual([])
  })

  test('CONTROL: la comparacion SI detecta una diferencia (una botella de mas)', async () => {
    const { data } = await cliente()
      .from('recetas_produccion')
      .select('id_producto_terminado, id_insumo, cantidad_requerida')
    const id = String(data?.[0]?.id_producto_terminado)
    const suya = (data ?? [])
      .filter((r) => r.id_producto_terminado === id)
      .map((r) => ({ id_insumo: r.id_insumo as string | null, cantidad_requerida: Number(r.cantidad_requerida) }))
    expect(ordenar(await desdeSql(id, 24))).not.toEqual(ordenar(movimientosDeEnvasado(id, 25, suya)))
  })
})
