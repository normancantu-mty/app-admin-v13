/**
 * Front v2 — la aritmetica del dinero que pintan las pantallas `/panel`.
 * Escrito el 2026-10-29 por el ejecutor del Front v2 (lanzado por el Socio).
 * Proyecto `puras`: sin base ni red.
 *
 * Lo que protege: que la regla de `lib/v2/dinero.ts` siga siendo la de
 * `public.saldo_cuenta(uuid)`. Si divergen, la pantalla pinta un saldo y el
 * libro dice otro.
 */
import { RUTA_BASE } from '@/lib/v2/rutas'
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
  FUERA_DE_LISTA,
  gastosDesdeCorte,
  indiceCategorias,
  clasificarCategoria,
  saldoDesdeMovimientos,
  CATEGORIA_QUE_NO_CUENTA,
  STATUS_QUE_CUENTAN,
  TIPOS_EGRESO,
  TIPOS_INGRESO,
  type MovimientoDinero
} from '@/lib/v2/dinero'
import { esRutaProtegida } from '@/lib/puerta-dashboard'
import { esAdmin, esRolDeMandoV2, puedeCapturarMatriz, puedeVerFinanzas, veLaMatriz } from '@/lib/v2/roles'
import { etiquetaDesdeNombre } from '@/lib/usuarios-roles'

const EF = 'cuenta-efectivo'
const FI = 'cuenta-fresnillo'
const TR = 'cuenta-transferencias'
const GI = 'cuenta-gilberto'
const MATRIZ = new Set([EF, FI, TR, GI])

// Un recorte REAL de categorias_movimiento (base local 2026-10-29, tipo EGRESO).
const LISTA = [
  { categoria: 'Costo de producción', subcategoria: 'chile', orden: 8 },
  { categoria: 'Financieros', subcategoria: 'Comisión por conversión de transferencias (5%)', orden: 51 },
  { categoria: 'Financieros', subcategoria: 'Intereses', orden: 52 }
]
const IDX = indiceCategorias(LISTA)

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
      .replace("'AJUSTE_SALDO')", "'AJUSTE_SALDO', 'CARGO_DEUDA')")
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
    const pasos = cascadaDeCaja(ARRANQUE, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'), IDX)
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
      subcategoria: 'Comisión por conversión de transferencias (5%)',
      fecha_movimiento: '2026-10-29T18:00:00Z'
    })
  ]

  test('los traspasos se netean y la comision aparece como gasto Financieros', () => {
    const pasos = cascadaDeCaja(conv, MATRIZ, new Date('2026-10-01T06:00:00Z'), new Date('2026-11-01T06:00:00Z'), IDX)
    const final = pasos.at(-1)!.valor
    expect(cuadra(final, 17348.33 - 29.95)).toBe(true)
    expect(pasos.find((p) => p.etiqueta === 'Financieros')?.valor).toBe(-29.95)
    expect(pasos.find((p) => p.etiqueta === 'Traspasos (neto)')).toBeUndefined()
  })

  test('por mes: el saldo de arranque y los traspasos no son entrada ni salida', () => {
    const [oct] = dineroPorMes(conv, MATRIZ, ['2026-10'], IDX)
    expect(oct.entro).toBe(0)
    expect(oct.salio).toBeCloseTo(29.95, 2)
    expect(oct.egresoPorCategoria).toEqual({ Financieros: 29.95 })
  })

  test('egresos por categoria agrupan subcategoria', () => {
    expect(saldoDesdeMovimientos(conv, TR)).toBe(0)
    expect(saldoDesdeMovimientos(conv, EF)).toBe(5259.05)
    const cats = egresosPorCategoria(conv, TR, IDX)
    expect(cats).toHaveLength(1)
    expect(cats[0].categoria).toBe('Financieros')
    expect(cats[0].subcategorias[0].subcategoria).toBe('Comisión por conversión de transferencias (5%)')
  })
})

test.describe('Front v2 · categorias de la lista cerrada (categorias_movimiento)', () => {
  test('casa sin importar acentos ni mayusculas y devuelve la etiqueta de la lista', () => {
    expect(clasificarCategoria({ categoria: 'financieros', subcategoria: 'comision por conversion de transferencias (5%)' }, IDX)).toEqual({
      categoria: 'Financieros',
      subcategoria: 'Comisión por conversión de transferencias (5%)',
      fuera: false,
      orden: 51
    })
  })

  test('lo que no casa va a «Fuera de la lista» con su texto original (control negativo)', () => {
    expect(clasificarCategoria({ categoria: 'Gasolina', subcategoria: 'Ruta norte' }, IDX)).toMatchObject({
      categoria: FUERA_DE_LISTA,
      subcategoria: 'Gasolina / Ruta norte',
      fuera: true
    })
    expect(clasificarCategoria({ categoria: null, subcategoria: null }, IDX).categoria).toBe(FUERA_DE_LISTA)
    expect(clasificarCategoria({ categoria: 'ARRANQUE', subcategoria: null }, IDX).categoria).toBe(FUERA_DE_LISTA)
    expect(clasificarCategoria({ categoria: 'Financieros', subcategoria: 'Otra cosa' }, IDX).subcategoria).toBe(
      'Otra cosa (fuera de la lista)'
    )
  })

  test('egresos por categoria: en el orden de la lista y «Fuera de la lista» al final y visible', () => {
    const movs = [
      mov({ monto: 500, id_cuenta_origen: EF, categoria: 'Gasolina' }),
      mov({ monto: 10, id_cuenta_origen: EF, categoria: 'Financieros', subcategoria: 'Intereses' }),
      mov({ monto: 20, id_cuenta_origen: EF, categoria: 'Costo de producción', subcategoria: 'CHILE' })
    ]
    const cats = egresosPorCategoria(movs, EF, IDX)
    expect(cats.map((c) => c.categoria)).toEqual(['Costo de producción', 'Financieros', FUERA_DE_LISTA])
    expect(cats.at(-1)).toMatchObject({ fuera: true, total: 500 })
    expect(IDX.nCategorias).toBe(2)
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

// ── Rol en CADA pagina (patron de tests/puerta-servidor.spec.ts: leer el fuente vivo) ──
function codigoVivo(texto: string): string {
  return texto
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
}

/**
 * ¿El archivo exige rol de mando ANTES de abrir el cliente de la base? `exigirMatrizV2()`
 * (2026-11-13: lo operativo, abierto tambien a EMPLEADO_ADMIN) cuenta igual: filtra por rol.
 */
function exigeMandoAntesDeLeer(fuente: string): boolean {
  const vivo = codigoVivo(fuente)
  const mando = vivo.indexOf('await exigirMandoV2()')
  const matriz = vivo.indexOf('await exigirMatrizV2()')
  const puerta = mando < 0 ? matriz : matriz < 0 ? mando : Math.min(mando, matriz)
  if (puerta < 0) return false
  const lectura = vivo.indexOf('getServerSupabaseClient()')
  return lectura < 0 || puerta < lectura
}

/**
 * Panel unico (2026-10-29): DST y LOC tambien entran a /panel, asi que no toda pagina
 * usa `exigirMandoV2()`. La que usa `exigirSesionV2()` tiene que filtrar por rol
 * justo despues -- un `if (... rol ...) notFound()/redirect(...)` -- y ANTES de
 * abrir el cliente de la base. Las unicas sin filtro por rol son las de
 * PAGINAS_ABIERTAS: abiertas a todo rol a proposito (el RLS o `leer*Visible`
 * recortan lo que ve cada quien).
 */
function exigeSesionYRolAntesDeLeer(fuente: string): boolean {
  const vivo = codigoVivo(fuente)
  const puerta = vivo.indexOf('await exigirSesionV2()')
  if (puerta < 0) return false
  const lectura = vivo.indexOf('getServerSupabaseClient()')
  const filtro = /^\s*if\s*\(.*\brol\b.*\)\s*(notFound\(\)|redirect\()/m.exec(vivo.slice(puerta))
  if (!filtro) return false
  const posFiltro = puerta + filtro.index
  return lectura < 0 || posFiltro < lectura
}

/** Solo la puerta de sesion, sin filtro por rol (para las PAGINAS_ABIERTAS). */
function exigeSesionAntesDeLeer(fuente: string): boolean {
  const vivo = codigoVivo(fuente)
  const puerta = vivo.indexOf('await exigirSesionV2()')
  if (puerta < 0) return false
  const lectura = vivo.indexOf('getServerSupabaseClient()')
  return lectura < 0 || puerta < lectura
}

/** Una pagina sin un solo import no puede leer la base ni pintar nada (los `return null` del slot). */
function noLeeNada(fuente: string): boolean {
  return !/^\s*import\s/m.test(codigoVivo(fuente))
}

/** Abiertas a todo rol con sesion, a proposito. Ruta relativa a app/panel, con '/'. */
const PAGINAS_ABIERTAS = new Set([
  'layout.tsx', // marco comun; cada pagina vuelve a filtrar
  'page.tsx', // el panel unico: Panel.tsx elige PanelMando o PanelNodo por rol
  'default.tsx', // el mismo panel en navegacion dura
  '@modal/m/ticket/[id]/page.tsx', // el RLS oculta el ticket ajeno («Ticket no encontrado»)
  '@modal/m/nodo/[id]/page.tsx', // leerFichaVisible: lo ajeno es 404
  '@modal/m/avisos/page.tsx', // AvisosVista recibe esMando; el RLS recorta
  '@modal/m/ventas/page.tsx', // «Mis ventas»: el RLS recorta
  'red/[id]/page.tsx' // ficha completa: lo ajeno es 404
])

function archivosDeV2(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return archivosDeV2(p)
    return e.name === 'page.tsx' || e.name === 'layout.tsx' || e.name === 'default.tsx' ? [p] : []
  })
}

function puertaCorrecta(relativa: string, fuente: string): boolean {
  if (noLeeNada(fuente)) return true
  if (exigeMandoAntesDeLeer(fuente)) return true
  if (PAGINAS_ABIERTAS.has(relativa)) return exigeSesionAntesDeLeer(fuente)
  return exigeSesionYRolAntesDeLeer(fuente)
}

test.describe('Front v2 · rol ADMIN/SOCIO en el layout y en cada pagina', () => {
  test('solo ADMIN y SOCIO son de mando', () => {
    expect(esRolDeMandoV2('ADMIN')).toBe(true)
    expect(esRolDeMandoV2('SOCIO')).toBe(true)
    for (const r of ['DST', 'LOC', 'SUB-ADMIN', 'EMPLEADO_ADMIN', '', null, undefined]) expect(esRolDeMandoV2(r), String(r)).toBe(false)
  })

  test('EMPLEADO_ADMIN: captura operativa si, finanzas solo con permiso, administracion no', () => {
    expect(puedeCapturarMatriz('EMPLEADO_ADMIN')).toBe(true)
    expect(puedeCapturarMatriz('ADMIN')).toBe(true)
    for (const r of ['SOCIO', 'DST', 'LOC', 'SUB-ADMIN', '', null]) expect(puedeCapturarMatriz(r), String(r)).toBe(false)
    expect(veLaMatriz('EMPLEADO_ADMIN')).toBe(true)
    expect(veLaMatriz('DST')).toBe(false)
    expect(esAdmin('EMPLEADO_ADMIN')).toBe(false)
    expect(esAdmin('ADMIN')).toBe(true)
    expect(puedeVerFinanzas({ rol: 'ADMIN' })).toBe(true)
    expect(puedeVerFinanzas({ rol: 'SOCIO' })).toBe(true)
    expect(puedeVerFinanzas({ rol: 'EMPLEADO_ADMIN', permiso_finanzas: true })).toBe(true)
    expect(puedeVerFinanzas({ rol: 'EMPLEADO_ADMIN', permiso_finanzas: false })).toBe(false)
    expect(puedeVerFinanzas({ rol: 'EMPLEADO_ADMIN' })).toBe(false)
    // El permiso no le sirve a otro rol.
    expect(puedeVerFinanzas({ rol: 'DST', permiso_finanzas: true })).toBe(false)
    expect(puedeVerFinanzas(null)).toBe(false)
  })

  test('etiqueta de accesos: pasa el CHECK ^[a-z0-9_-]{2,24}$ y no repite', () => {
    const CHECK = /^[a-z0-9_-]{2,24}$/
    const casos = ['María José Peña', 'A', '  ', 'Un nombre larguisimo de mas de veinticuatro letras', '¡¡Ñoño!!']
    for (const c of casos) expect(etiquetaDesdeNombre(c, new Set()), c).toMatch(CHECK)
    expect(etiquetaDesdeNombre('María José', new Set())).toBe('maria_jose')
    expect(etiquetaDesdeNombre('María José', new Set(['maria_jose']))).toBe('maria_jose-2')
    expect(etiquetaDesdeNombre('María José', new Set(['maria_jose', 'maria_jose-2']))).toBe('maria_jose-3')
    const larga = etiquetaDesdeNombre('Un nombre larguisimo de mas de veinticuatro letras', new Set(['un_nombre_larguisimo_de']))
    expect(larga).toMatch(CHECK)
    expect(larga.endsWith('-2')).toBe(true)
  })

  test('cada page.tsx, layout.tsx y default.tsx de app/panel pasa por una puerta con chequeo de rol antes de leer la base', () => {
    const raiz = path.join(process.cwd(), 'app', 'panel')
    const archivos = archivosDeV2(raiz)
    expect(archivos.filter((a) => a.endsWith('page.tsx')).length).toBeGreaterThanOrEqual(3)
    const relativas = new Set<string>()
    for (const a of archivos) {
      const rel = path.relative(raiz, a).split(path.sep).join('/')
      relativas.add(rel)
      expect(puertaCorrecta(rel, fs.readFileSync(a, 'utf-8')), a).toBe(true)
    }
    // Una entrada de PAGINAS_ABIERTAS que ya no existe es una excepcion muerta: se quita.
    for (const abierta of PAGINAS_ABIERTAS) expect(relativas.has(abierta), `PAGINAS_ABIERTAS: ${abierta}`).toBe(true)
  })

  test('control negativo: una pagina sin la puerta, con la puerta despues de leer, o sin filtro por rol, no pasa', () => {
    expect(exigeMandoAntesDeLeer('const c = await getServerSupabaseClient()')).toBe(false)
    expect(exigeMandoAntesDeLeer('const c = await getServerSupabaseClient()\nawait exigirMandoV2()')).toBe(false)
    expect(exigeMandoAntesDeLeer('// await exigirMandoV2()\nconst c = await getServerSupabaseClient()')).toBe(false)
    const sinRol = "import x from 'y'\nconst usuario = await exigirSesionV2()\nconst c = await getServerSupabaseClient()"
    expect(puertaCorrecta('@modal/m/gasto/page.tsx', sinRol)).toBe(false)
    const rolTarde =
      "import x from 'y'\nconst usuario = await exigirSesionV2()\nconst c = await getServerSupabaseClient()\nif (usuario.rol !== 'ADMIN') notFound()"
    expect(puertaCorrecta('@modal/m/gasto/page.tsx', rolTarde)).toBe(false)
    const comentado = "import x from 'y'\nconst usuario = await exigirSesionV2()\n// if (usuario.rol !== 'ADMIN') notFound()"
    expect(puertaCorrecta('@modal/m/gasto/page.tsx', comentado)).toBe(false)
    const sinPuerta = "import x from 'y'\nexport default function P() { return <X /> }"
    expect(puertaCorrecta('@modal/m/gasto/page.tsx', sinPuerta)).toBe(false)
    expect(puertaCorrecta('page.tsx', sinPuerta)).toBe(false)
    const bien =
      "import x from 'y'\nconst usuario = await exigirSesionV2()\nif (!puedeCapturarMatriz(usuario.rol)) notFound()\nconst c = await getServerSupabaseClient()"
    expect(puertaCorrecta('@modal/m/gasto/page.tsx', bien)).toBe(true)
  })
})

test.describe('Front v2 · la puerta cubre /panel', () => {
  test('/panel y sus subrutas son protegidas, /panelx no', () => {
    expect(RUTA_BASE).toBe('/panel')
    expect(esRutaProtegida(RUTA_BASE)).toBe(true)
    expect(esRutaProtegida(`${RUTA_BASE}/cartera`)).toBe(true)
    expect(esRutaProtegida(`${RUTA_BASE}x`)).toBe(false)
  })
})
