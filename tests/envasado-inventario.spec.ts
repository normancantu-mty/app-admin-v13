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

// ============================================================================
// Fase 9, D92 — el STOCK del empaque, en dos lados: `stock_de_insumos`
// (Postgres; lo usa `registrar_en_lote` para bloquear) y `stockDesdeLedger`
// (TS; lo usa la propuesta, que en ensayo no puede llamar `rpc`). Sobre el
// ledger REAL de la matriz, insumo por insumo. Solo lee.
// ============================================================================

import { stockDesdeLedger, type FilaLedgerStock } from '../lib/bot-envasado'

async function idAdmin(): Promise<string> {
  const { data, error } = await cliente().from('entidades').select('id').eq('rol', 'ADMIN').limit(1).single()
  if (error || !data) throw new Error(error?.message ?? 'sin ADMIN')
  return data.id as string
}

async function stockTsDe(admin: string, ids: string[]): Promise<Map<string, number>> {
  const { data, error } = await cliente()
    .from('inventario_ledger')
    .select('id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino, status')
    .in('id_producto', ids)
    .or(`id_entidad_destino.eq.${admin},id_entidad_origen.eq.${admin}`)
  if (error) throw new Error(error.message)
  return stockDesdeLedger((data ?? []) as FilaLedgerStock[], admin)
}

test.describe('D92 — stock del empaque: Postgres y TS dicen lo mismo', () => {
  test.skip(SALTO, motivoDeSalto())

  test('para cada insumo del catalogo, el stock de la matriz es el mismo en los dos lados', async () => {
    const admin = await idAdmin()
    const { data: insumos } = await cliente().from('catalogo_productos').select('id').eq('tipo', 'INSUMO')
    const ids = (insumos ?? []).map((i) => i.id as string)
    // Hoy hay 13; que no pase en vacio.
    expect(ids.length).toBeGreaterThanOrEqual(5)
    const { data: sql, error } = await cliente().rpc('stock_de_insumos', { p_id_entidad: admin, p_ids: ids })
    if (error) throw new Error(error.message)
    const deSql = new Map(((sql ?? []) as { id_producto: string; stock: number }[]).map((f) => [f.id_producto, Number(f.stock)]))
    const deTs = await stockTsDe(admin, ids)
    // Al menos un insumo con movimientos, o la comparacion no prueba nada.
    expect(deSql.size).toBeGreaterThan(0)
    for (const id of ids) {
      expect(deTs.get(id) ?? 0, `insumo ${id}`).toBe(deSql.get(id) ?? 0)
    }
  })

  test('CONTROL: la comparacion SI detecta una diferencia (contra un ledger vacio)', async () => {
    const admin = await idAdmin()
    const { data: insumos } = await cliente().from('catalogo_productos').select('id').eq('tipo', 'INSUMO')
    const ids = (insumos ?? []).map((i) => i.id as string)
    const deTs = await stockTsDe(admin, ids)
    const conEntrada = [...deTs.values()].some((v) => v !== 0)
    // Si todo estuviera en 0 este control no distinguiria nada: se exige lo contrario.
    expect(conEntrada).toBe(true)
    const falsa = stockDesdeLedger([], admin)
    expect([...deTs.entries()].every(([id, v]) => (falsa.get(id) ?? 0) === v)).toBe(false)
  })
})
