/**
 * Front v2 — aritmetica del dinero de la matriz. Escrito el 2026-10-29 por el
 * ejecutor del Front v2 (lanzado por el Socio). PURO: sin red ni base, se prueba
 * en `tests/v2-front-dinero.spec.ts`.
 *
 * LA REGLA ES LA DE `public.saldo_cuenta(uuid)` (migracion 20261028120100), no
 * otra: ingreso si el tipo es de ingreso y la cuenta es DESTINO; egreso si el tipo
 * es de egreso y la cuenta es COALESCE(origen, destino). Solo filas ACTIVO o
 * APPROVED y nunca ABONO_PENDIENTE. Asi la suma de los movimientos que pinta el
 * Front v2 cuadra al centavo con el saldo que da la base, y la pantalla lo
 * comprueba en vivo (`cuadra`).
 */

import { mesMx } from './formato'

/** AJUSTE_SALDO (2026-11-03, migracion 20261103120000): correccion del ADMIN, monto CON SIGNO hacia el destino. */
export const TIPOS_INGRESO = ['INGRESO_VENTA', 'ABONO_DEUDA', 'INGRESO_TRASPASO', 'SALDO_INICIAL', 'AJUSTE_SALDO'] as const
export const TIPOS_EGRESO = [
  'GASTO_OPERATIVO',
  'CARGO_DEUDA',
  'SUBSIDIO_FISCAL',
  'COMPRA_INSUMOS',
  'EGRESO_TRASPASO'
] as const

/** El WHERE de `saldo_cuenta`: status que cuentan y la categoria que nunca cuenta. */
export const STATUS_QUE_CUENTAN = ['ACTIVO', 'APPROVED'] as const
export const CATEGORIA_QUE_NO_CUENTA = 'ABONO_PENDIENTE'

const ING = new Set<string>(TIPOS_INGRESO)
const EGR = new Set<string>(TIPOS_EGRESO)
const STATUS_OK = new Set<string>(STATUS_QUE_CUENTAN)

export interface MovimientoDinero {
  id: string
  tipo_movimiento: string
  monto: number
  status: string
  categoria: string | null
  subcategoria: string | null
  categoria_gasto: string | null
  descripcion: string | null
  fecha_movimiento: string | null
  id_cuenta_origen: string | null
  id_cuenta_destino: string | null
  id_entidad_relacionada: string | null
  usuario_creador: string | null
}

/** ¿La fila cuenta para el saldo? Mismo WHERE que `saldo_cuenta`. */
export function cuentaParaSaldo(m: Pick<MovimientoDinero, 'status' | 'categoria'>): boolean {
  return STATUS_OK.has(m.status) && m.categoria !== CATEGORIA_QUE_NO_CUENTA
}

/** Efecto con signo de una fila sobre UNA cuenta. 0 si no la toca. */
export function efectoEnCuenta(m: MovimientoDinero, idCuenta: string): number {
  if (!cuentaParaSaldo(m)) return 0
  const monto = Number(m.monto) || 0
  if (ING.has(m.tipo_movimiento) && m.id_cuenta_destino === idCuenta) return monto
  if (EGR.has(m.tipo_movimiento) && (m.id_cuenta_origen ?? m.id_cuenta_destino) === idCuenta) return -monto
  return 0
}

/** Efecto con signo sobre el CONJUNTO de cuentas (p. ej. las 4 de la matriz). */
export function efectoEnCuentas(m: MovimientoDinero, cuentas: ReadonlySet<string>): number {
  if (!cuentaParaSaldo(m)) return 0
  const monto = Number(m.monto) || 0
  let total = 0
  if (ING.has(m.tipo_movimiento) && m.id_cuenta_destino && cuentas.has(m.id_cuenta_destino)) total += monto
  const egr = m.id_cuenta_origen ?? m.id_cuenta_destino
  if (EGR.has(m.tipo_movimiento) && egr && cuentas.has(egr)) total -= monto
  return total
}

/** Fecha del corte: el SALDO_INICIAL mas antiguo que trae la base. null si no hay. */
export function corteDeArranque(movs: Pick<MovimientoDinero, 'tipo_movimiento' | 'fecha_movimiento'>[]): string | null {
  const fechas = movs
    .filter((m) => m.tipo_movimiento === 'SALDO_INICIAL' && m.fecha_movimiento)
    .map((m) => m.fecha_movimiento as string)
  if (fechas.length === 0) return null
  return fechas.reduce((a, b) => (new Date(b) < new Date(a) ? b : a))
}

export const TIPOS_GASTO = ['GASTO_OPERATIVO', 'COMPRA_INSUMOS'] as const
const GASTO = new Set<string>(TIPOS_GASTO)

/**
 * Gastos capturados DESDE EL CORTE (fecha >= corte), con el mismo filtro de filas
 * que `saldo_cuenta` (ACTIVO o APPROVED, sin ABONO_PENDIENTE). Antes se contaban
 * solo los del mes en curso y solo ACTIVO, con un rotulo que decia «desde el corte».
 */
export function gastosDesdeCorte(movs: MovimientoDinero[], corte: string): number {
  const desde = new Date(corte)
  return movs.filter(
    (m) => GASTO.has(m.tipo_movimiento) && cuentaParaSaldo(m) && m.fecha_movimiento && new Date(m.fecha_movimiento) >= desde
  ).length
}

/** Saldo de una cuenta reconstruido desde sus movimientos. */
export function saldoDesdeMovimientos(movs: MovimientoDinero[], idCuenta: string): number {
  return redondear(movs.reduce((acc, m) => acc + efectoEnCuenta(m, idCuenta), 0))
}

export function redondear(n: number): number {
  return Math.round(n * 100) / 100
}

/** ¿Dos cifras de dinero son la misma al centavo? */
export function cuadra(a: number, b: number): boolean {
  return Math.abs(redondear(a) - redondear(b)) < 0.005
}

/** Es un traspaso entre cuentas (no es ingreso ni gasto del negocio). */
function esTraspaso(tipo: string): boolean {
  return tipo === 'INGRESO_TRASPASO' || tipo === 'EGRESO_TRASPASO'
}

// ── Categorias: la lista CERRADA de `categorias_movimiento` ──────────────────
// `finanzas_ledger.categoria` es texto libre. Se agrupa contra la lista que lee
// `leerCategoriasEgreso` (tipo EGRESO, activas, por `orden`), con sus etiquetas y
// su orden. Lo que no casa con la lista NO se esconde ni se renombra: va al grupo
// visible «Fuera de la lista», con su texto original como subcategoria.

export interface CategoriaLista {
  categoria: string
  subcategoria: string
  orden: number
}

export const FUERA_DE_LISTA = 'Fuera de la lista'

/** Clave de comparacion: sin acentos, sin espacios de orilla, en minusculas. */
function clave(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
}

export interface IndiceCategorias {
  porClave: Map<string, { nombre: string; orden: number; subs: Map<string, string> }>
  /** cuantas categorias tiene la lista (para rotular, no se escribe fijo) */
  nCategorias: number
}

export function indiceCategorias(lista: CategoriaLista[]): IndiceCategorias {
  const porClave: IndiceCategorias['porClave'] = new Map()
  for (const f of [...lista].sort((a, b) => a.orden - b.orden)) {
    const k = clave(f.categoria)
    const c = porClave.get(k) ?? { nombre: f.categoria, orden: f.orden, subs: new Map<string, string>() }
    c.subs.set(clave(f.subcategoria), f.subcategoria)
    porClave.set(k, c)
  }
  return { porClave, nCategorias: porClave.size }
}

export interface Clasificacion {
  categoria: string
  subcategoria: string
  fuera: boolean
  orden: number
}

/** Categoria y subcategoria de la lista para una fila; o «Fuera de la lista». */
export function clasificarCategoria(
  m: Pick<MovimientoDinero, 'categoria' | 'subcategoria'>,
  idx: IndiceCategorias
): Clasificacion {
  const c = m.categoria ? idx.porClave.get(clave(m.categoria)) : undefined
  if (!c) {
    const texto = m.categoria ? `${m.categoria}${m.subcategoria ? ` / ${m.subcategoria}` : ''}` : 'sin categoría'
    return { categoria: FUERA_DE_LISTA, subcategoria: texto, fuera: true, orden: Number.MAX_SAFE_INTEGER }
  }
  const sub = m.subcategoria ? c.subs.get(clave(m.subcategoria)) : undefined
  return {
    categoria: c.nombre,
    subcategoria: sub ?? (m.subcategoria ? `${m.subcategoria} (fuera de la lista)` : 'sin subcategoría'),
    fuera: false,
    orden: c.orden
  }
}

export interface MesDinero {
  mes: string
  entro: number
  salio: number
  /** egreso por categoria de la lista (solo gastos, sin traspasos) */
  egresoPorCategoria: Record<string, number>
}

/**
 * Entro / salio por mes sobre un conjunto de cuentas. El saldo de arranque NO
 * es entrada del mes (es el punto de partida) y los traspasos internos no son
 * ni entrada ni salida: se excluyen los dos.
 */
export function dineroPorMes(
  movs: MovimientoDinero[],
  cuentas: ReadonlySet<string>,
  meses: string[],
  idx: IndiceCategorias
): MesDinero[] {
  const porMes = new Map<string, MesDinero>(
    meses.map((mes) => [mes, { mes, entro: 0, salio: 0, egresoPorCategoria: {} }])
  )
  for (const m of movs) {
    // AJUSTE_SALDO tampoco: corrige el saldo, no es dinero que entro ni salio en el mes.
    if (!m.fecha_movimiento || m.tipo_movimiento === 'SALDO_INICIAL' || m.tipo_movimiento === 'AJUSTE_SALDO' || esTraspaso(m.tipo_movimiento)) continue
    const fila = porMes.get(mesMx(m.fecha_movimiento))
    if (!fila) continue
    const e = efectoEnCuentas(m, cuentas)
    if (e > 0) fila.entro += e
    if (e < 0) {
      fila.salio += -e
      const cat = clasificarCategoria(m, idx).categoria
      fila.egresoPorCategoria[cat] = (fila.egresoPorCategoria[cat] ?? 0) + -e
    }
  }
  return meses.map((mes) => porMes.get(mes)!)
}

export interface PasoCascada {
  etiqueta: string
  valor: number
  tipo: 'inicio' | 'paso' | 'final'
}

function etiquetaCascada(m: MovimientoDinero, idx: IndiceCategorias): string {
  switch (m.tipo_movimiento) {
    case 'SALDO_INICIAL':
      return 'Saldo de arranque'
    case 'AJUSTE_SALDO':
      return 'Ajustes de saldo'
    case 'INGRESO_VENTA':
      return 'Ventas'
    case 'ABONO_DEUDA':
      return 'Abonos'
    case 'INGRESO_TRASPASO':
    case 'EGRESO_TRASPASO':
      return 'Traspasos (neto)'
    default:
      return clasificarCategoria(m, idx).categoria
  }
}

/**
 * Cascada de caja de un periodo [desde, hasta): Inicio = efecto acumulado antes
 * de `desde`; un paso por concepto; Final = Inicio + pasos. Si el periodo llega
 * a hoy, Final debe ser igual a la suma de `saldo_cuenta` de las cuentas.
 */
export function cascadaDeCaja(
  movs: MovimientoDinero[],
  cuentas: ReadonlySet<string>,
  desde: Date,
  hasta: Date,
  idx: IndiceCategorias
): PasoCascada[] {
  let inicio = 0
  const pasos = new Map<string, number>()
  for (const m of movs) {
    const e = efectoEnCuentas(m, cuentas)
    if (e === 0 || !m.fecha_movimiento) continue
    const f = new Date(m.fecha_movimiento)
    if (f < desde) {
      inicio += e
      continue
    }
    if (f >= hasta) continue
    const k = etiquetaCascada(m, idx)
    pasos.set(k, (pasos.get(k) ?? 0) + e)
  }
  const ordenados = [...pasos.entries()]
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([etiqueta, valor]) => ({ etiqueta, valor: redondear(valor), tipo: 'paso' as const }))
  const final = redondear(inicio + ordenados.reduce((a, p) => a + p.valor, 0))
  return [
    { etiqueta: 'Inicio', valor: redondear(inicio), tipo: 'inicio' },
    ...ordenados,
    { etiqueta: 'Final', valor: final, tipo: 'final' }
  ]
}

export interface CategoriaEgreso {
  categoria: string
  /** true = el grupo «Fuera de la lista» */
  fuera: boolean
  orden: number
  total: number
  movimientos: number
  subcategorias: { subcategoria: string; total: number; movimientos: number }[]
}

/**
 * «En qué se fue el dinero»: egresos de UNA cuenta por categoria y subcategoria
 * de la lista cerrada, en el orden de la lista; «Fuera de la lista» al final.
 */
export function egresosPorCategoria(movs: MovimientoDinero[], idCuenta: string, idx: IndiceCategorias): CategoriaEgreso[] {
  const cats = new Map<string, CategoriaEgreso>()
  for (const m of movs) {
    if (esTraspaso(m.tipo_movimiento)) continue
    const e = efectoEnCuenta(m, idCuenta)
    if (e >= 0) continue
    const k = clasificarCategoria(m, idx)
    const c = cats.get(k.categoria) ?? { categoria: k.categoria, fuera: k.fuera, orden: k.orden, total: 0, movimientos: 0, subcategorias: [] }
    c.total += -e
    c.movimientos += 1
    const s = c.subcategorias.find((x) => x.subcategoria === k.subcategoria)
    if (s) {
      s.total += -e
      s.movimientos += 1
    } else c.subcategorias.push({ subcategoria: k.subcategoria, total: -e, movimientos: 1 })
    cats.set(k.categoria, c)
  }
  return [...cats.values()]
    .map((c) => ({ ...c, total: redondear(c.total), subcategorias: c.subcategorias.sort((a, b) => b.total - a.total) }))
    .sort((a, b) => a.orden - b.orden || b.total - a.total)
}

/**
 * Paginas v2 (2026-10-29, ejecutor del Socio): «En qué se fue el dinero» de VARIAS
 * cuentas a la vez (la pagina de Finanzas con «Todas las cuentas»). Suma el
 * desglose de cada cuenta; los traspasos entre cuentas ya quedan fuera.
 */
export function egresosPorCategoriaVarias(movs: MovimientoDinero[], idsCuentas: string[], idx: IndiceCategorias): CategoriaEgreso[] {
  const cats = new Map<string, CategoriaEgreso>()
  for (const id of idsCuentas) {
    for (const c of egresosPorCategoria(movs, id, idx)) {
      const t = cats.get(c.categoria) ?? { ...c, total: 0, movimientos: 0, subcategorias: [] }
      t.total += c.total
      t.movimientos += c.movimientos
      for (const s of c.subcategorias) {
        const x = t.subcategorias.find((y) => y.subcategoria === s.subcategoria)
        if (x) {
          x.total += s.total
          x.movimientos += s.movimientos
        } else t.subcategorias.push({ ...s })
      }
      cats.set(c.categoria, t)
    }
  }
  return [...cats.values()]
    .map((c) => ({
      ...c,
      total: redondear(c.total),
      subcategorias: c.subcategorias.map((s) => ({ ...s, total: redondear(s.total) })).sort((a, b) => b.total - a.total)
    }))
    .sort((a, b) => a.orden - b.orden || b.total - a.total)
}
