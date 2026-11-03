/**
 * Correcciones del ADMIN (`/panel/correcciones`, migracion 20261103120000).
 * Escrito el 2026-11-03 por el agente de la ruta admin. PURAS: sin base ni red.
 *
 * 1. La aritmetica de la diferencia y la doble confirmacion (`lib/ajustes-admin.ts`).
 * 2. Vista y TypeScript cambian juntos: las listas de ENTRADAS/SALIDAS de la
 *    migracion (v_stock_por_cubeta, stock_ajustable, stock_en_cubeta,
 *    stock_de_insumos) son las de `lib/inventario-types.ts`.
 * 3. La ruta esta escondida (ningun enlace) y cada capa exige ADMIN.
 */

import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import {
  calcularDiferencia,
  claveInventario,
  confirmacionCasa,
  errorDePaso1,
  leerClaveInventario,
  leerNumero,
  mensajeDeErrorRpc,
  validarSolicitudAjuste,
  type SolicitudAjuste
} from '@/lib/ajustes-admin'
import { TIPOS_MOVIMIENTO_ENTRADA, TIPOS_MOVIMIENTO_SALIDA, isTipoMovimientoEntrada } from '@/lib/inventario-types'
import { TIPOS_INGRESO, efectoEnCuenta, saldoDesdeMovimientos, dineroPorMes, type MovimientoDinero } from '@/lib/v2/dinero'

const RAIZ = process.cwd()
const MIGRACION = fs.readFileSync(path.join(RAIZ, 'supabase/migrations/20261103120000_v2_ajustes_admin.sql'), 'utf-8')
const E = '11111111-1111-4111-8111-111111111111'
const P = '22222222-2222-4222-8222-222222222222'
const CTA = '33333333-3333-4333-8333-333333333333'

test.describe('ajustes admin · diferencia', () => {
  test('diferencia = nuevo - actual, redondeada al decimal del ledger', () => {
    expect(calcularDiferencia(12, 20, 'inventario')).toEqual({ actual: 12, nuevo: 20, diferencia: 8, sentido: 'sube' })
    expect(calcularDiferencia(12, 0, 'inventario').diferencia).toBe(-12)
    expect(calcularDiferencia(0.3333, 1, 'inventario').diferencia).toBe(0.6667)
    expect(calcularDiferencia(4690, 4500.555, 'saldo')).toMatchObject({ nuevo: 4500.56, diferencia: -189.44, sentido: 'baja' })
    expect(calcularDiferencia(10.1, 10.1, 'saldo').sentido).toBe('igual')
  })

  test('leerNumero acepta formatos claros y rechaza los ambiguos', () => {
    expect(leerNumero('1,234.50')).toBe(1234.5)
    expect(leerNumero('$ 1,234.50')).toBe(1234.5)
    expect(leerNumero('-20')).toBe(-20)
    expect(leerNumero('7')).toBe(7)
    expect(leerNumero('12,5')).toBeNull()
    expect(leerNumero('')).toBeNull()
    expect(leerNumero('1.2.3')).toBeNull()
    expect(leerNumero('abc')).toBeNull()
  })

  test('paso 1: valor valido, distinto del actual, no negativo en inventario y motivo', () => {
    const ok = { clase: 'inventario' as const, actual: 5, nuevoTexto: '8', motivo: 'conteo fisico' }
    expect(errorDePaso1(ok)).toBeNull()
    expect(errorDePaso1({ ...ok, nuevoTexto: 'x' })).toMatch(/número válido/)
    expect(errorDePaso1({ ...ok, nuevoTexto: '-1' })).toMatch(/negativo/)
    expect(errorDePaso1({ ...ok, nuevoTexto: '5' })).toMatch(/igual/)
    expect(errorDePaso1({ ...ok, motivo: '  ab ' })).toMatch(/motivo/)
    // Un saldo SI puede quedar negativo (sobregiro): no se bloquea.
    expect(errorDePaso1({ clase: 'saldo', actual: 5, nuevoTexto: '-3', motivo: 'corte de caja' })).toBeNull()
  })
})

test.describe('ajustes admin · doble confirmacion', () => {
  const base: SolicitudAjuste = {
    clase: 'inventario',
    clave: claveInventario({ idEntidad: E, idProducto: P, cubeta: 'PAGADO' }),
    visto: 12,
    nuevo: 20,
    motivo: 'conteo fisico 3 nov',
    paso1: true,
    confirmacion: '20'
  }

  test('con las dos confirmaciones pasa', () => {
    expect(validarSolicitudAjuste(base)).toBeNull()
    expect(validarSolicitudAjuste({ ...base, confirmacion: '20.0000' })).toBeNull()
    expect(validarSolicitudAjuste({ ...base, clase: 'saldo', clave: CTA, nuevo: 1234.5, confirmacion: '1,234.50' })).toBeNull()
  })

  test('sin la primera confirmacion NO se escribe (control negativo)', () => {
    expect(validarSolicitudAjuste({ ...base, paso1: false })).toMatch(/primera confirmación/)
  })

  test('sin la segunda, o con otro numero, NO se escribe (control negativo)', () => {
    expect(validarSolicitudAjuste({ ...base, confirmacion: '' })).toMatch(/segunda confirmación/)
    expect(validarSolicitudAjuste({ ...base, confirmacion: '21' })).toMatch(/segunda confirmación/)
    expect(validarSolicitudAjuste({ ...base, confirmacion: 'CONFIRMAR' })).toMatch(/segunda confirmación/)
    expect(confirmacionCasa('20.00001', 20, 'inventario')).toBe(true) // 4 decimales: es el mismo numero en el ledger
    expect(confirmacionCasa('20.001', 20, 'inventario')).toBe(false)
  })

  test('motivo, clave, negativos y diferencia cero se rechazan', () => {
    expect(validarSolicitudAjuste({ ...base, motivo: ' ' })).toMatch(/motivo/)
    expect(validarSolicitudAjuste({ ...base, clave: 'x|y|PAGADO' })).toMatch(/inválido/)
    expect(validarSolicitudAjuste({ ...base, clase: 'saldo', clave: 'no-uuid' })).toMatch(/inválido/)
    expect(validarSolicitudAjuste({ ...base, nuevo: -1, confirmacion: '-1' })).toMatch(/negativo/)
    expect(validarSolicitudAjuste({ ...base, nuevo: 12, confirmacion: '12' })).toMatch(/diferencia/)
    expect(validarSolicitudAjuste({ ...base, clase: 'otra' as never })).toMatch(/inválido/)
  })

  test('la clave de inventario va y vuelve, y la cubeta es cerrada', () => {
    expect(leerClaveInventario(claveInventario({ idEntidad: E, idProducto: P, cubeta: 'CONSIGNADO' }))).toEqual({
      idEntidad: E,
      idProducto: P,
      cubeta: 'CONSIGNADO'
    })
    expect(leerClaveInventario(`${E}|${P}|OTRA`)).toBeNull()
  })

  test('los errores de la RPC se vuelven legibles', () => {
    expect(mensajeDeErrorRpc('CAMBIO_CONCURRENTE: el stock de X es 3 y tu viste 4. Recarga')).toMatch(/^el stock de X es 3.*no se escribió nada/)
    expect(mensajeDeErrorRpc('SIN_CAMBIO: el stock ya es 3')).toBe('Sin cambio: el stock ya es 3')
  })
})

/** Listas de tipos de las expresiones `destino ... ANY (ARRAY[...])` / `origen ...`. */
function listasDeLaMigracion(bloque: string) {
  const entradas = [...bloque.matchAll(/id_entidad_destino\s*=\s*[\w.]+\s+(?:AND|and)\s+il\.tipo_movimiento::text\s*=\s*(?:ANY|any)\s*\(\s*(?:ARRAY|array)\[([^\]]*)\]/g)]
  const salidas = [...bloque.matchAll(/id_entidad_origen\s*=\s*[\w.]+\s+(?:AND|and)\s+il\.tipo_movimiento::text\s*=\s*(?:ANY|any)\s*\(\s*(?:ARRAY|array)\[([^\]]*)\]/g)]
  const tipos = (m: RegExpMatchArray) => [...m[1].matchAll(/'([A-Z_]+)'/g)].map((t) => t[1]).sort()
  return { entradas: entradas.map(tipos), salidas: salidas.map(tipos) }
}

test.describe('ajustes admin · la vista y el TypeScript cambian juntos', () => {
  test('las 4 lecturas de stock de la migracion usan las listas de lib/inventario-types.ts', () => {
    const { entradas, salidas } = listasDeLaMigracion(MIGRACION)
    // v_stock_por_cubeta, v_insumos_en_negativo, stock_de_insumos, stock_ajustable, stock_en_cubeta
    expect(entradas.length).toBe(5)
    expect(salidas.length).toBe(5)
    for (const l of entradas) expect(l).toEqual([...TIPOS_MOVIMIENTO_ENTRADA].sort())
    for (const l of salidas) expect(l).toEqual([...TIPOS_MOVIMIENTO_SALIDA].sort())
    expect(isTipoMovimientoEntrada('AJUSTE_INVENTARIO')).toBe(true)
  })

  test('el CHECK de tipos y la entidad obligatoria conocen el ajuste', () => {
    expect(MIGRACION).toMatch(/'EGRESO_TRASPASO',\s*'AJUSTE_INVENTARIO'\s*\)\)/)
    expect(MIGRACION).toMatch(/'ENTRADA_CONCESION', 'AJUSTE_INVENTARIO'\)\s*THEN id_entidad_destino IS NOT NULL/)
    expect(MIGRACION).toMatch(/'SALDO_INICIAL', 'AJUSTE_SALDO'\s*\]::text\[\]/)
  })

  test('AJUSTE_SALDO suma con signo en el destino, y no es entrada/salida del mes', () => {
    expect(TIPOS_INGRESO).toContain('AJUSTE_SALDO')
    const mov = (monto: number): MovimientoDinero => ({
      id: String(monto),
      tipo_movimiento: 'AJUSTE_SALDO',
      monto,
      status: 'ACTIVO',
      categoria: 'AJUSTE',
      subcategoria: null,
      categoria_gasto: null,
      descripcion: null,
      fecha_movimiento: '2026-11-03T18:00:00Z',
      id_cuenta_origen: null,
      id_cuenta_destino: CTA,
      id_entidad_relacionada: null,
      usuario_creador: 'a@b.c'
    })
    expect(efectoEnCuenta(mov(-189.44), CTA)).toBe(-189.44)
    expect(saldoDesdeMovimientos([mov(500), mov(-189.44)], CTA)).toBe(310.56)
    const idx = { categorias: [], porCategoria: new Map(), porSubcategoria: new Map() } as never
    const [mes] = dineroPorMes([mov(500), mov(-189.44)], new Set([CTA]), ['2026-11'], idx)
    expect(mes).toMatchObject({ entro: 0, salio: 0 })
  })

  test('v_movimiento_clasificado no se toca: un ajuste no es ingreso ni egreso del negocio', () => {
    expect(MIGRACION).not.toMatch(/VIEW\s+public\.v_movimiento_clasificado/i)
    // El prefijo no cae en las reglas starts_with de es_egreso_admin.
    for (const p of ['EGRESO_', 'GASTO_', 'CARGO_']) expect('AJUSTE_SALDO'.startsWith(p)).toBe(false)
  })
})

test.describe('ajustes admin · ruta escondida y solo ADMIN', () => {
  const DIR = path.join(RAIZ, 'app/panel/correcciones')
  const leer = (f: string) => fs.readFileSync(path.join(RAIZ, f), 'utf-8')

  test('ningun archivo fuera de la ruta la enlaza', () => {
    const hallados: string[] = []
    const recorrer = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (p.startsWith(DIR) || e.name === 'node_modules' || e.name.startsWith('.')) continue
          recorrer(p)
        } else if (/\.(tsx?|mjs)$/.test(e.name) && fs.readFileSync(p, 'utf-8').includes('/correcciones')) {
          hallados.push(path.relative(RAIZ, p))
        }
      }
    }
    for (const d of ['app', 'components', 'lib']) recorrer(path.join(RAIZ, d))
    // La server action revalida su propia ruta y la logica pura la nombra en un comentario: no son enlaces.
    const permitidos = [path.join('app', 'actions', 'ajustes-admin.ts'), path.join('lib', 'ajustes-admin.ts')]
    expect(hallados.filter((h) => !permitidos.includes(h))).toEqual([])
  })

  test('layout y pagina pasan por la puerta ADMIN (404 a los demas)', () => {
    for (const f of ['layout.tsx', 'page.tsx']) {
      const fuente = leer(`app/panel/correcciones/${f}`)
      expect(fuente, f).toMatch(/const usuario = await exigirSesionV2\(\)\s+if \(usuario\.rol !== 'ADMIN'\) notFound\(\)/)
    }
  })

  test('la server action exige ADMIN y las dos confirmaciones; las RPC exigen ADMIN', () => {
    const accion = leer('app/actions/ajustes-admin.ts')
    expect(accion).toMatch(/usuario\.rol !== 'ADMIN'/)
    expect(accion).toMatch(/validarSolicitudAjuste\(s\)/)
    expect(accion).not.toMatch(/SERVICE_ROLE/)
    const rpcs = MIGRACION.match(/IF public\.mi_rol\(\) IS DISTINCT FROM 'ADMIN' THEN/g) ?? []
    expect(rpcs.length).toBe(2)
    expect(MIGRACION).toMatch(/LOCK TABLE public\.inventario_ledger IN SHARE ROW EXCLUSIVE MODE/)
    expect(MIGRACION).toMatch(/LOCK TABLE public\.finanzas_ledger IN SHARE ROW EXCLUSIVE MODE/)
  })
})
