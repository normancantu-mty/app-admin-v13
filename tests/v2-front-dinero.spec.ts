/**
 * Front v2 — la aritmetica del dinero que pintan las pantallas `/v2`.
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 * Proyecto `puras`: sin base ni red.
 *
 * Lo que protege: que la regla de `lib/v2/dinero.ts` siga siendo la de
 * `public.saldo_cuenta(uuid)`. Si divergen, la pantalla pinta un saldo y el
 * libro dice otro.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import {
  cascadaDeCaja,
  corteDeArranque,
  cuadra,
  dineroPorMes,
  efectoEnCuenta,
  egresosPorCategoria,
  gastosDesdeCorte,
  saldoDesdeMovimientos,
  CATEGORIA_QUE_NO_CUENTA,
  STATUS_QUE_CUENTAN,
  TIPOS_EGRESO,
  TIPOS_INGRESO,
  type MovimientoDinero
} from '@/lib/v2/dinero'
import { esRutaProtegida } from '@/lib/puerta-dashboard'

const EF = 'cuenta-efectivo'
const FI = 'cuenta-fresnillo'
const TR = 'cuenta-transferencias'
const GI = 'cuenta-gilberto'
const MATRIZ = new Set([EF, FI, TR, GI])

let n = 0
function mov(p: Partial<MovimientoDinero>): MovimientoDinero {
  n += 1
  return {
    id: `m${n}`,
    tipo_movimiento: 'GASTO_OPERATIVO',
    monto: 0,
    status: 'ACTIVO',
    categoria: null,
    subcategoria: null,
    categoria_gasto: null,
    descripcion: null,
    fecha_movimiento: '2026-10-28T05:59:00Z',
    id_cuenta_origen: null,
    id_cuenta_destino: null,
    id_entidad_relacionada: null,
    usuario_creador: null,
    ...p
  }
}

// La foto real del arranque conciliado (base local 2026-10-29).
const ARRANQUE = [
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 4690, id_cuenta_destino: EF, categoria: 'ARRANQUE' }),
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 12059.33, id_cuenta_destino: FI, categoria: 'ARRANQUE' }),
  mov({ tipo_movimiento: 'SALDO_INICIAL', monto: 599, id_cuenta_destino: TR, categoria: 'ARRANQUE' }),
  // CARGO_DEUDA de la cartera: no toca cuentas de la matriz
  mov({ tipo_movimiento: 'CARGO_DEUDA', monto: 11327, categoria: 'ARRANQUE' })
]

// ── Paridad con la funcion SQL ──────────────────────────────────────────────
// Se busca la definicion VIGENTE de `saldo_cuenta` en TODAS las migraciones (la
// ultima por nombre de archivo que la crea o la reemplaza; si despues alguna la
// borra sin recrearla, la prueba falla) y se comparan sus listas de tipos como
// CONJUNTOS con las de `lib/v2/dinero.ts`. Antes solo se miraba que cada tipo
// apareciera entre comillas en un archivo fijo: un tipo cambiado de lista no la
// tumbaba.
const DIR_MIGRACIONES = path.join(process.cwd(), 'supabase/migrations')
const RE_CREA = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?saldo_cuenta\s*\(/gi
const RE_BORRA = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?saldo_cuenta\b/gi

function definicionVigenteDeSaldoCuenta(): { archivo: string; cuerpo: string } {
  const archivos = fs.readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith('.sql')).sort()
  let ultimo: { archivo: string; sql: string; idx: number; tipo: 'crea' | 'borra' } | null = null
  for (const archivo of archivos) {
    const sql = fs.readFileSync(path.join(DIR_MIGRACIONES, archivo), 'utf-8')
    const eventos = [
      ...[...sql.matchAll(RE_CREA)].map((m) => ({ idx: m.index ?? 0, tipo: 'crea' as const })),
      ...[...sql.matchAll(RE_BORRA)].map((m) => ({ idx: m.index ?? 0, tipo: 'borra' as const }))
    ].sort((a, b) => a.idx - b.idx)
    for (const e of eventos) ultimo = { archivo, sql, ...e }
  }
  if (!ultimo) throw new Error('Ninguna migracion crea saldo_cuenta')
  if (ultimo.tipo === 'borra') throw new Error(`${ultimo.archivo} borra saldo_cuenta y nadie la recrea despues`)
  const resto = ultimo.sql.slice(ultimo.idx)
  const cuerpo = /\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/.exec(resto)?.[2]
  if (!cuerpo) throw new Error(`No encontre el cuerpo $$...$$ de saldo_cuenta en ${ultimo.archivo}`)
  return { archivo: ultimo.archivo, cuerpo }
}

/** De `WHEN x.tipo_movimiento IN (...) ... THEN [-]x.monto`: el signo dice la lista. */
function listasDeTipos(cuerpo: string): { ingreso: string[]; egreso: string[] } {
  const re = /WHEN\s+(?:\w+\.)?tipo_movimiento\s+IN\s*\(([^)]*)\)[\s\S]*?THEN\s+(-?)\s*(?:\w+\.)?monto\b/gi
  const ingreso: string[] = []
  const egreso: string[] = []
  for (const m of cuerpo.matchAll(re)) {
    const tipos = [...m[1].matchAll(/'([A-Z_]+)'/g)].map((t) => t[1])
    ;(m[2] === '-' ? egreso : ingreso).push(...tipos)
  }
  return { ingreso: [...new Set(ingreso)].sort(), egreso: [...new Set(egreso)].sort() }
}

function statusQueCuentan(cuerpo: string): string[] {
  const g = /\bstatus\s+IN\s*\(([^)]*)\)/i.exec(cuerpo)?.[1] ?? ''
  return [...g.matchAll(/'([A-Z_]+)'/g)].map((t) => t[1]).sort()
}

const ordenada = (xs: readonly string[]) => [...xs].sort()

test.describe('Front v2 · saldo por cuenta = regla de saldo_cuenta()', () => {
  test('las listas de tipos son, como conjuntos, las de la definicion vigente de saldo_cuenta', () => {
    const { archivo, cuerpo } = definicionVigenteDeSaldoCuenta()
    const sql = listasDeTipos(cuerpo)
    expect(sql.ingreso.length, `sin lista de ingreso en ${archivo}`).toBeGreaterThan(0)
    expect(sql.egreso.length, `sin lista de egreso en ${archivo}`).toBeGreaterThan(0)
    expect(ordenada(TIPOS_INGRESO), `ingreso distinto de ${archivo}`).toEqual(sql.ingreso)
    expect(ordenada(TIPOS_EGRESO), `egreso distinto de ${archivo}`).toEqual(sql.egreso)
  })

  test('el filtro de filas es el de saldo_cuenta: status y ABONO_PENDIENTE', () => {
    const { archivo, cuerpo } = definicionVigenteDeSaldoCuenta()
    expect(ordenada(STATUS_QUE_CUENTAN), `status distinto de ${archivo}`).toEqual(statusQueCuentan(cuerpo))
    expect(cuerpo).toMatch(new RegExp(`categoria\\s+IS\\s+DISTINCT\\s+FROM\\s+'${CATEGORIA_QUE_NO_CUENTA}'`, 'i'))
  })

  test('control negativo: un tipo movido de lista en la SQL ya no casa', () => {
    const { cuerpo } = definicionVigenteDeSaldoCuenta()
    // CARGO_DEUDA sale de la lista de egreso y entra a la de ingreso (en memoria).
    const movido = cuerpo
      .replace("'GASTO_OPERATIVO', 'CARGO_DEUDA',", "'GASTO_OPERATIVO',")
      .replace("'SALDO_INICIAL')", "'SALDO_INICIAL', 'CARGO_DEUDA')")
    expect(movido).not.toBe(cuerpo)
    const sql = listasDeTipos(movido)
    expect(sql.ingreso).toContain('CARGO_DEUDA')
    expect(ordenada(TIPOS_INGRESO)).not.toEqual(sql.ingreso)
    expect(ordenada(TIPOS_EGRESO)).not.toEqual(sql.egreso)
  })

  test('el arranque da los 4 saldos reales y suma 17,348.33', () => {
    expect(saldoDesdeMovimientos(ARRANQUE, EF)).toBe(4690)
    expect(saldoDesdeMovimientos(ARRANQUE, FI)).toBe(12059.33)
    expect(saldoDesdeMovimientos(ARRANQUE, TR)).toBe(599)
    expect(saldoDesdeMovimientos(ARRANQUE, GI)).toBe(0)
    const pasos = cascadaDeCaja(ARRANQUE, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'))
    expect(pasos[0]).toEqual({ etiqueta: 'Inicio', valor: 0, tipo: 'inicio' })
    expect(pasos.at(-1)?.valor).toBe(17348.33)
  })

  test('egreso usa COALESCE(origen, destino); ingreso solo destino', () => {
    expect(efectoEnCuenta(mov({ monto: 100, id_cuenta_origen: EF }), EF)).toBe(-100)
    expect(efectoEnCuenta(mov({ monto: 100, id_cuenta_destino: EF }), EF)).toBe(-100)
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 599, id_cuenta_origen: EF }), EF)).toBe(0)
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'INGRESO_VENTA', monto: 599, id_cuenta_destino: EF }), EF)).toBe(599)
  })

  test('ANULADO y ABONO_PENDIENTE no cuentan (control negativo)', () => {
    expect(efectoEnCuenta(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 50, id_cuenta_destino: EF, status: 'ANULADO' }), EF)).toBe(0)
    expect(
      efectoEnCuenta(mov({ tipo_movimiento: 'ABONO_DEUDA', monto: 50, id_cuenta_destino: EF, categoria: 'ABONO_PENDIENTE' }), EF)
    ).toBe(0)
  })
})

test.describe('Front v2 · conversion 95/5 en la cascada y por mes', () => {
  // Las tres filas TAL COMO las inserta `convertir_transferencias` (migracion
  // 20261028120300, lineas 144-149): id_cuenta_origen NULL en las tres; el
  // EGRESO_TRASPASO y el gasto llevan destino = Transferencias (saldo_cuenta los
  // resta por COALESCE(origen, destino)) y el INGRESO_TRASPASO destino = Efectivo.
  const conv = [
    ...ARRANQUE,
    mov({
      tipo_movimiento: 'EGRESO_TRASPASO',
      monto: 569.05,
      categoria: 'TRANSFERENCIA',
      id_cuenta_origen: null,
      id_cuenta_destino: TR,
      fecha_movimiento: '2026-10-29T18:00:00Z'
    }),
    mov({
      tipo_movimiento: 'INGRESO_TRASPASO',
      monto: 569.05,
      categoria: 'TRANSFERENCIA',
      id_cuenta_origen: null,
      id_cuenta_destino: EF,
      fecha_movimiento: '2026-10-29T18:00:00Z'
    }),
    mov({
      tipo_movimiento: 'GASTO_OPERATIVO',
      monto: 29.95,
      id_cuenta_origen: null,
      id_cuenta_destino: TR,
      categoria: 'Financieros',
      subcategoria: 'Comisión por conversión de transferencias',
      fecha_movimiento: '2026-10-29T18:00:00Z'
    })
  ]

  test('los traspasos se netean y la comision aparece como gasto Financieros', () => {
    const pasos = cascadaDeCaja(conv, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'))
    const final = pasos.at(-1)!.valor
    expect(cuadra(final, 17348.33 - 29.95)).toBe(true)
    expect(pasos.find((p) => p.etiqueta === 'Financieros')?.valor).toBe(-29.95)
    expect(pasos.find((p) => p.etiqueta === 'Traspasos (neto)')).toBeUndefined()
  })

  test('por mes: el saldo de arranque y los traspasos no son entrada ni salida', () => {
    const [oct] = dineroPorMes(conv, MATRIZ, ['2026-10'])
    expect(oct.entro).toBe(0)
    expect(oct.salio).toBeCloseTo(29.95, 2)
    expect(oct.egresoPorCategoria).toEqual({ Financieros: 29.95 })
  })

  test('egresos por categoria agrupan subcategoria', () => {
    expect(saldoDesdeMovimientos(conv, TR)).toBe(0)
    expect(saldoDesdeMovimientos(conv, EF)).toBe(5259.05)
    const cats = egresosPorCategoria(conv, TR)
    expect(cats).toHaveLength(1)
    expect(cats[0].categoria).toBe('Financieros')
    expect(cats[0].subcategorias[0].subcategoria).toBe('Comisión por conversión de transferencias')
  })
})

test.describe('Front v2 · gastos capturados desde el corte', () => {
  test('el corte es el SALDO_INICIAL mas antiguo; sin SALDO_INICIAL no hay corte', () => {
    expect(corteDeArranque(ARRANQUE)).toBe('2026-10-28T05:59:00Z')
    expect(corteDeArranque([mov({ tipo_movimiento: 'CARGO_DEUDA' })])).toBeNull()
  })

  test('cuenta desde la fecha del corte (no solo el mes) con el filtro de saldo_cuenta', () => {
    const corte = '2026-10-28T05:59:00Z'
    const movs = [
      ...ARRANQUE,
      mov({ monto: 10, id_cuenta_origen: EF, fecha_movimiento: '2026-10-29T12:00:00Z' }), // cuenta
      mov({ tipo_movimiento: 'COMPRA_INSUMOS', monto: 10, id_cuenta_origen: EF, status: 'APPROVED', fecha_movimiento: '2026-11-03T12:00:00Z' }), // cuenta, otro mes
      mov({ monto: 10, id_cuenta_origen: EF, status: 'ANULADO', fecha_movimiento: '2026-10-29T12:00:00Z' }), // no
      mov({ monto: 10, id_cuenta_origen: EF, categoria: 'ABONO_PENDIENTE', fecha_movimiento: '2026-10-29T12:00:00Z' }), // no
      mov({ monto: 10, id_cuenta_origen: EF, fecha_movimiento: '2026-10-27T12:00:00Z' }), // antes del corte: no
      mov({ tipo_movimiento: 'EGRESO_TRASPASO', monto: 10, id_cuenta_destino: TR, fecha_movimiento: '2026-10-29T12:00:00Z' }) // no es gasto
    ]
    expect(gastosDesdeCorte(movs, corte)).toBe(2)
  })
})

test.describe('Front v2 · la puerta cubre /v2', () => {
  test('/v2 y sus subrutas son protegidas, /v2x no', () => {
    expect(esRutaProtegida('/v2')).toBe(true)
    expect(esRutaProtegida('/v2/cartera')).toBe(true)
    expect(esRutaProtegida('/v2x')).toBe(false)
  })
})
