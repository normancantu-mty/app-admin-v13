import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { correnLasDeEquivalencia, llaveServiceRole, motivoDeSalto, urlSupabase } from './vistas-entorno'

/**
 * Fase 8, D84-D85 — el costo COMPLETO por botella y su margen.
 *
 * La aritmetica vive en Postgres (`costo_completo_de`, pura: no lee tablas) y
 * `v_costo_completo` solo le pasa los numeros. Por eso la prueba tiene dos
 * mitades:
 *
 * 1. FIXTURES: la funcion con numeros redondos inventados para la prueba
 *    (costo conocido -> margen conocido), y el CONTROL NEGATIVO del brief: sin
 *    la linea del liquido el margen vuelve a salir NULL.
 * 2. LA VISTA DE HOY: las tres presentaciones con margen no NULL, todo costo sin
 *    dato declarado en `faltan`, y el total igual a la suma de sus partes.
 *
 * Necesita base (service role), asi que vive en el proyecto `equivalencia`.
 */

const SALTO = !correnLasDeEquivalencia()

function cliente(): SupabaseClient {
  return createClient(urlSupabase()!, llaveServiceRole()!, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
}

type Fila = {
  costo_liquido: number | null
  costo_mano_obra: number | null
  costo_total: number | null
  precio_distribuidor: number | null
  base_fiscal: number | null
  margen_publico: number | null
  margen_publico_pct: number | null
  margen_distribuidor: number | null
  margen_distribuidor_pct: number | null
  margen_publico_fiscal: number | null
  margen_publico_fiscal_pct: number | null
  faltan: string[]
  costo_completo: boolean
}

// 1000 ml, empaque $10, liquido $0.05/ml ($50), mano de obra $0.02/ml ($20),
// marbete $5, caja sin dato; publico $200, comision 20%, factor fiscal 2.
const FIXTURE = {
  p_ml: 1000,
  p_empaque: 10,
  p_liquido_por_ml: 0.05,
  p_mo_por_ml: 0.02,
  p_marbete: 5,
  p_caja: null as number | null,
  p_precio_publico: 200,
  p_comision_dst: 0.2,
  p_factor_fiscal: 2
}

async function calcular(args: typeof FIXTURE | Record<string, number | null>): Promise<Fila> {
  const { data, error } = await cliente().rpc('costo_completo_de', args)
  if (error) throw new Error(error.message)
  const fila = (data as Record<string, unknown>[])[0]
  const n = (v: unknown) => (v === null ? null : Number(v))
  return {
    costo_liquido: n(fila.costo_liquido),
    costo_mano_obra: n(fila.costo_mano_obra),
    costo_total: n(fila.costo_total),
    precio_distribuidor: n(fila.precio_distribuidor),
    base_fiscal: n(fila.base_fiscal),
    margen_publico: n(fila.margen_publico),
    margen_publico_pct: n(fila.margen_publico_pct),
    margen_distribuidor: n(fila.margen_distribuidor),
    margen_distribuidor_pct: n(fila.margen_distribuidor_pct),
    margen_publico_fiscal: n(fila.margen_publico_fiscal),
    margen_publico_fiscal_pct: n(fila.margen_publico_fiscal_pct),
    faltan: fila.faltan as string[],
    costo_completo: fila.costo_completo as boolean
  }
}

test.describe('D85 · costo_completo_de sobre fixtures', () => {
  test.skip(SALTO, motivoDeSalto())

  test('costo conocido -> margen conocido', async () => {
    const r = await calcular(FIXTURE)
    expect(r.costo_liquido).toBe(50)
    expect(r.costo_mano_obra).toBe(20)
    expect(r.costo_total).toBe(85) // 10 + 50 + 20 + 5; la caja NULL no suma
    expect(r.precio_distribuidor).toBe(160)
    expect(r.base_fiscal).toBe(100)
    expect(r.margen_publico).toBe(115)
    expect(r.margen_publico_pct).toBe(57.5)
    expect(r.margen_distribuidor).toBe(75)
    expect(r.margen_distribuidor_pct).toBe(46.9) // 75/160 = 46.875
    expect(r.margen_publico_fiscal).toBe(15)
    expect(r.margen_publico_fiscal_pct).toBe(15)
    expect(r.faltan).toEqual(['caja'])
    expect(r.costo_completo).toBe(false)
  })

  test('con todos los datos, costo_completo = true y faltan vacio', async () => {
    const r = await calcular({ ...FIXTURE, p_caja: 3 })
    expect(r.costo_total).toBe(88)
    expect(r.faltan).toEqual([])
    expect(r.costo_completo).toBe(true)
  })

  test('el precio de distribuidor sube al peso: $599 -> $480, $179 -> $144, $69 -> $56', async () => {
    for (const [pp, dst] of [[599, 480], [179, 144], [69, 56]]) {
      const r = await calcular({ ...FIXTURE, p_precio_publico: pp })
      expect(r.precio_distribuidor).toBe(dst)
    }
  })

  test('CONTROL NEGATIVO: sin la linea del liquido, el margen vuelve a NULL', async () => {
    const r = await calcular({ ...FIXTURE, p_liquido_por_ml: null })
    expect(r.costo_total).toBeNull()
    expect(r.margen_publico).toBeNull()
    expect(r.margen_distribuidor).toBeNull()
    expect(r.margen_publico_fiscal).toBeNull()
    expect(r.faltan).toContain('liquido')
  })

  test('CONTROL NEGATIVO: sin mano de obra o sin empaque, tambien NULL', async () => {
    expect((await calcular({ ...FIXTURE, p_mo_por_ml: null })).margen_publico).toBeNull()
    expect((await calcular({ ...FIXTURE, p_empaque: null })).margen_publico).toBeNull()
  })
})

test.describe('D85 · v_costo_completo sobre la base de hoy', () => {
  test.skip(SALTO, motivoDeSalto())

  test('las tres presentaciones con margen no NULL y el hueco dicho', async () => {
    const { data, error } = await cliente()
      .from('v_costo_completo')
      .select('sku, costo_empaque, costo_liquido, costo_mano_obra, costo_marbete, costo_caja, costo_total, margen_publico, margen_distribuidor, fuente_costo_liquido, faltan, costo_completo')
    expect(error).toBeNull()
    const filas = data ?? []
    expect(filas.map((f) => f.sku).sort()).toEqual(['plata-250ml', 'plata-50ml', 'plata-750ml'])

    for (const f of filas) {
      expect(f.margen_publico, f.sku).not.toBeNull()
      expect(f.margen_distribuidor, f.sku).not.toBeNull()
      expect(['ESTANDAR', 'LOTE_REAL']).toContain(f.fuente_costo_liquido)
      // Invariante, no foto de hoy: un costo sin dato esta en `faltan`, y
      // `costo_completo` es exactamente "no falta nada". Hoy (2026-09-22)
      // marbete y caja no tienen dato; el dia que Norman lo de, esto sigue verde.
      expect(f.faltan.includes('marbete'), f.sku).toBe(f.costo_marbete === null)
      expect(f.faltan.includes('caja'), f.sku).toBe(f.costo_caja === null)
      expect(f.costo_completo, f.sku).toBe(f.faltan.length === 0)
      // El total es la suma de sus partes (tolerancia: el redondeo de cada parte).
      const suma =
        Number(f.costo_empaque) + Number(f.costo_liquido) + Number(f.costo_mano_obra) +
        Number(f.costo_marbete ?? 0) + Number(f.costo_caja ?? 0)
      expect(Math.abs(suma - Number(f.costo_total)), f.sku).toBeLessThanOrEqual(0.02)
    }
  })
})
