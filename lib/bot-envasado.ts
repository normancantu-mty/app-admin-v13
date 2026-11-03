/**
 * Fase 8, Bloque D — ENVASAR a un lote que ya existe (D81), lo que eso le hace
 * al inventario (D82), y cuantas botellas se hicieron (D83). Todo puro.
 *
 * ─── D82: LA MISMA ARITMETICA EN DOS LADOS, Y UNA PRUEBA QUE LOS AMARRA ─────
 *
 * Lo que escribe es `registrar_en_lote` (Postgres, una transaccion), que le
 * pide los renglones a `movimientos_de_envasado`. Aqui vive la version pura de
 * esa misma funcion, `movimientosDeEnvasado`, por una razon: la PROPUESTA tiene
 * que decir antes del VA que se va a mover y si falta empaque, y en ensayo el
 * cliente de la ruta no puede llamar ningun `rpc` (`lib/bot-ensayo.ts`). Dos
 * versiones de lo mismo divergen solas; por eso `tests/envasado-inventario.spec.ts`
 * las compara renglon por renglon sobre la receta real de la base.
 *
 * Ambas copian a `registrarProduccionAction` (app/actions/inventario.ts:173-203):
 * +N PRODUCCION del terminado y un TRASPASO de `cantidad_requerida x N` por
 * insumo de la receta. **Cero botellas no mueve nada.**
 */

import { fechaParaPersona, sumarDias } from '@/lib/fechas'
import { sellar, selloEmpata } from '@/lib/bot-sello'
import type { EntradaLote, EnvasadoLote, TandaLote } from '@/lib/bot-lotes'

// ============================================================================
// D82 — EL MOVIMIENTO
// ============================================================================

export interface RenglonReceta {
  id_insumo: string | null
  cantidad_requerida: number
}

export interface MovimientoEnvasado {
  id_producto: string
  tipo_movimiento: 'PRODUCCION' | 'TRASPASO'
  cantidad: number
}

/** Lo que un envasado le hace al inventario. Espejo de `movimientos_de_envasado`. */
export function movimientosDeEnvasado(
  idProducto: string,
  botellas: number,
  receta: readonly RenglonReceta[]
): MovimientoEnvasado[] {
  if (!Number.isInteger(botellas) || botellas <= 0) return []
  const salida: MovimientoEnvasado[] = [
    { id_producto: idProducto, tipo_movimiento: 'PRODUCCION', cantidad: botellas }
  ]
  for (const r of receta) {
    // La receta es DECIMAL(10,4) y las botellas enteras: el producto exacto
    // tiene 4 decimales a lo mas. Sin redondear, 0.0666 x 24 da
    // 1.5984000000000003 en JS y 1.5984 en Postgres (lo cazo la equivalencia).
    const cantidad = Math.round(Number(r.cantidad_requerida) * botellas * 10000) / 10000
    if (!r.id_insumo || !Number.isFinite(cantidad) || cantidad <= 0) continue
    salida.push({ id_producto: r.id_insumo, tipo_movimiento: 'TRASPASO', cantidad })
  }
  return salida
}

/**
 * El empaque que NO alcanza, dicho en palabras. No bloquea (Norman decide);
 * se ensena en la propuesta ANTES del VA.
 *
 * `stock` es el de la matriz, sumando cubetas, tal como lo da
 * `v_stock_por_cubeta`. Un insumo que no aparece tiene 0.
 */
export function faltantesDeEmpaque(
  movimientos: readonly MovimientoEnvasado[],
  stock: ReadonlyMap<string, number>,
  nombres: ReadonlyMap<string, string>
): string[] {
  // Dos renglones del mismo insumo (dos formatos que comparten lamina) suman.
  const pedido = new Map<string, number>()
  for (const m of movimientos) {
    if (m.tipo_movimiento !== 'TRASPASO') continue
    pedido.set(m.id_producto, (pedido.get(m.id_producto) ?? 0) + m.cantidad)
  }
  const avisos: string[] = []
  for (const [id, ocupa] of pedido) {
    const hay = stock.get(id) ?? 0
    if (hay + 1e-9 < ocupa) {
      avisos.push(
        `Falta ${nombres.get(id) ?? 'un insumo'}: ocupas ${numeroCorto(ocupa)} y hay ` +
          `${numeroCorto(hay)}. Si le das VA, el inventario de ese insumo queda en ` +
          `${numeroCorto(hay - ocupa)}.`
      )
    }
  }
  return avisos
}

// ============================================================================
// D92 (Fase 9) — SIN EMPAQUE NO SE ENVASA: SE BLOQUEA Y SE PREGUNTA
// ============================================================================

/**
 * Los tipos que suman y los que restan: la MISMA regla de
 * `v_stock_por_cubeta` y de `stock_de_insumos` (migracion
 * `20260923075244_fase9_d92_envasado_no_deja_negativo.sql`).
 */
const ENTRA = new Set(['ENTRADA_COMPRA', 'PRODUCCION', 'DEVOLUCION_FISICA', 'INGRESO_TRASPASO', 'ENTRADA_CONCESION', 'AJUSTE_INVENTARIO'])
const SALE = new Set(['SALIDA_VENTA', 'MERMA', 'TRASPASO', 'EGRESO_TRASPASO', 'SALIDA_CONCESION', 'DEVOLUCION_FISICA'])

export interface FilaLedgerStock {
  id_producto: string
  tipo_movimiento: string
  cantidad: number | string
  id_entidad_origen: string | null
  id_entidad_destino: string | null
  status: string
}

/**
 * El stock de cada producto de una entidad, desde las filas del ledger. Espejo
 * puro de `stock_de_insumos` (la propuesta corre en ensayo, donde no hay
 * `rpc`). `v_stock_por_cubeta` NO sirve para esto: filtra `TERMINADO` y
 * `having > 0`, asi que para un insumo siempre decia 0 — por eso la Fase 8
 * avisaba falta de empaque aunque hubiera.
 */
export function stockDesdeLedger(
  filas: readonly FilaLedgerStock[],
  idEntidad: string
): Map<string, number> {
  const stock = new Map<string, number>()
  for (const f of filas) {
    if (f.status !== 'ACTIVO' && f.status !== 'APPROVED') continue
    if (f.id_entidad_destino !== idEntidad && f.id_entidad_origen !== idEntidad) continue
    const n = Number(f.cantidad)
    if (!Number.isFinite(n)) continue
    let delta = 0
    if (f.id_entidad_destino === idEntidad && ENTRA.has(f.tipo_movimiento)) delta += n
    if (f.id_entidad_origen === idEntidad && SALE.has(f.tipo_movimiento)) delta -= n
    stock.set(f.id_producto, Math.round(((stock.get(f.id_producto) ?? 0) + delta) * 10000) / 10000)
  }
  return stock
}

export interface FaltanteEmpaque {
  id_insumo: string
  nombre: string
  ocupa: number
  hay: number
  falta: number
}

/**
 * Lo que falta, por insumo, sumando TODO el envasado (dos formatos comparten
 * lamina). Vacio = alcanza. La MISMA cuenta que `registrar_en_lote` hace antes
 * de escribir; si esta dice que alcanza y la base no, la base gana y el VA
 * contesta el error.
 */
export function faltantesDelEnvasado(
  movimientos: readonly MovimientoEnvasado[],
  stock: ReadonlyMap<string, number>,
  nombres: ReadonlyMap<string, string>
): FaltanteEmpaque[] {
  const pedido = new Map<string, number>()
  for (const m of movimientos) {
    if (m.tipo_movimiento !== 'TRASPASO') continue
    pedido.set(m.id_producto, (pedido.get(m.id_producto) ?? 0) + m.cantidad)
  }
  const salida: FaltanteEmpaque[] = []
  for (const [id, ocupaCrudo] of pedido) {
    const ocupa = Math.round(ocupaCrudo * 10000) / 10000
    const hay = stock.get(id) ?? 0
    if (hay + 1e-9 < ocupa) {
      salida.push({
        id_insumo: id,
        nombre: nombres.get(id) ?? 'un insumo',
        ocupa,
        hay,
        falta: Math.round((ocupa - hay) * 10000) / 10000
      })
    }
  }
  return salida.sort((a, b) => a.nombre.localeCompare(b.nombre))
}

/**
 * El mensaje que NO se queda en "no se puede": dice que falta, cuanto, y
 * pregunta que paso (Norman, D92).
 */
export function mensajeFaltaEmpaque(
  envasado: readonly { nombre: string; botellas: number }[],
  faltantes: readonly FaltanteEmpaque[],
  /** Cazador F0 (WP-6): para un TRABAJADOR, sin el stock (`tengo N`). */
  sinCifras = false
): string {
  const que = envasado.map((e) => `${e.botellas} de ${e.nombre}`).join(' y ')
  const lineas = [`Para envasar ${que} me falta empaque registrado:`]
  for (const f of faltantes) {
    if (sinCifras) {
      lineas.push(`   ${f.nombre}: ocupo ${numeroCorto(f.ocupa)}; no alcanza lo registrado.`)
      continue
    }
    lineas.push(
      `   ${f.nombre}: ocupo ${numeroCorto(f.ocupa)}, tengo ${numeroCorto(f.hay)} ` +
        `-> faltan ${numeroCorto(f.falta)}`
    )
  }
  lineas.push(
    '',
    'No lo escribo: dejaria el inventario en negativo.',
    'Que paso: llego una compra, o ya lo tenias y no esta capturado? Dime cuanto hay, ' +
      'por ejemplo: "llegaron 500 botellas de 750" o "tengo 300 corchos".'
  )
  return lineas.join('\n')
}

// ============================================================================
// D81 — A QUE LOTE VA
// ============================================================================

/**
 * Un lote "abierto" es uno que arranco hace 30 dias o menos. `lotes` no tiene
 * columna de estado; 30 dias cubren fermentacion + destilado + reposo con
 * holgura. DECISION de la Fase 8, dicha en el informe: si Norman un dia cierra
 * lotes de forma explicita, esto se cambia por esa columna.
 */
export const VENTANA_LOTE_ABIERTO_DIAS = 30

export interface LoteExistente {
  id: string
  codigo_lote: string
  fecha_inicio: string
}

export type LoteDestino =
  | { ok: true; lote: LoteExistente; porDefault: boolean }
  | { ok: false; error: string; motivo: MotivoSinDestino }

/**
 * Cazador F0 (WP-7a): POR QUE no hay destino. `sin_abiertos` es el caso
 * "envasamos 40 chicas y no hay lote abierto": la ruta ya no contesta 422,
 * ofrece abrir el lote. `no_existe` (una errata) y `varios` siguen siendo error.
 */
export type MotivoSinDestino = 'no_existe' | 'sin_abiertos' | 'varios'

/**
 * - Dijo el codigo -> ese lote, o error si no existe (no se crea uno nuevo
 *   por una errata).
 * - No dijo -> el unico lote abierto. Si hay varios, SE PREGUNTA con los
 *   codigos a la vista; si no hay ninguno, se dice.
 */
export function elegirLoteDestino(
  dicho: string | null,
  lotes: readonly LoteExistente[],
  hoy: string
): LoteDestino {
  const codigo = (dicho ?? '').trim()
  if (codigo !== '') {
    const lote = lotes.find((l) => l.codigo_lote.trim().toUpperCase() === codigo.toUpperCase())
    return lote
      ? { ok: true, lote, porDefault: false }
      : { ok: false, motivo: 'no_existe', error: `No tengo el lote ${codigo}. Dime el codigo como esta escrito.` }
  }
  const desde = sumarDias(hoy, -VENTANA_LOTE_ABIERTO_DIAS)
  const abiertos = lotes
    .filter((l) => l.fecha_inicio >= desde && l.fecha_inicio <= hoy)
    .sort((a, b) => (a.fecha_inicio < b.fecha_inicio ? 1 : a.fecha_inicio > b.fecha_inicio ? -1 : 0))
  if (abiertos.length === 1) return { ok: true, lote: abiertos[0], porDefault: true }
  if (abiertos.length === 0) {
    return {
      ok: false,
      motivo: 'sin_abiertos',
      error:
        `No tengo ningun lote abierto (de los ultimos ${VENTANA_LOTE_ABIERTO_DIAS} dias). ` +
        'Dime de que lote es, o dictame el lote nuevo.'
    }
  }
  return {
    ok: false,
    motivo: 'varios',
    error:
      `Tengo ${abiertos.length} lotes abiertos: ` +
      abiertos.map((l) => l.codigo_lote).join(', ') +
      '. Dimelo con el lote, por ejemplo: "envasamos 24 de 750 del lote ' +
      abiertos[0].codigo_lote +
      '".'
  }
}

/**
 * ¿La peticion de lote es para AGREGAR a uno que ya existe? Si el codigo
 * dictado ya existe, si. Si no dicto codigo y lo unico que trae es envasado
 * (ni insumos, ni tandas, ni fermentacion), tambien: "hoy envasamos 24 de 750"
 * no abre un lote, envasa uno.
 */
export function esAgregarALote(p: {
  codigoDictado: string | null
  codigosTomados: readonly string[]
  hayInsumos: boolean
  hayTandas: boolean
  hayEnvasado: boolean
  hayFermentacion: boolean
}): boolean {
  const codigo = (p.codigoDictado ?? '').trim().toUpperCase()
  if (codigo !== '') return p.codigosTomados.some((c) => c.trim().toUpperCase() === codigo)
  return p.hayEnvasado && !p.hayInsumos && !p.hayTandas && !p.hayFermentacion
}

// ============================================================================
// D83 — CUANTAS BOTELLAS SE HICIERON
// ============================================================================

export interface FilaEnvasado {
  fecha: string
  codigo_lote: string
  producto: string
  botellas: number
}

export type PeriodoProduccion =
  | { tipo: 'dia'; desde: string; hasta: string; etiqueta: string }
  | { tipo: 'semana'; desde: string; hasta: string; etiqueta: string }
  | { tipo: 'mes'; desde: string; hasta: string; etiqueta: string }
  | { tipo: 'lote'; codigo: string; etiqueta: string }

/** Lunes de la semana de `fecha` (AAAA-MM-DD), la semana como se dice en Mexico. */
export function lunesDe(fecha: string): string {
  const d = new Date(fecha + 'T12:00:00Z')
  const dia = d.getUTCDay() // 0 domingo
  return sumarDias(fecha, -((dia + 6) % 7))
}

/**
 * Lo que el modelo puso en `filtro`: "hoy", "ayer", "semana", "mes" o el
 * codigo de un lote. Nada -> hoy. `hoy` ya viene en hora de Mexico (D69).
 */
export function periodoDeProduccion(filtro: string | null, hoy: string): PeriodoProduccion {
  const f = (filtro ?? '').trim().toLowerCase()
  if (f === '' || f === 'hoy') return { tipo: 'dia', desde: hoy, hasta: hoy, etiqueta: 'hoy' }
  if (f === 'ayer') {
    const ayer = sumarDias(hoy, -1)
    return { tipo: 'dia', desde: ayer, hasta: ayer, etiqueta: 'ayer' }
  }
  if (f.includes('semana')) {
    return { tipo: 'semana', desde: lunesDe(hoy), hasta: hoy, etiqueta: 'esta semana' }
  }
  if (f.includes('mes')) {
    return { tipo: 'mes', desde: hoy.slice(0, 8) + '01', hasta: hoy, etiqueta: 'este mes' }
  }
  const codigo = (filtro ?? '').trim()
  return { tipo: 'lote', codigo, etiqueta: `el lote ${codigo}` }
}

export function filasDelPeriodo(
  filas: readonly FilaEnvasado[],
  periodo: PeriodoProduccion
): FilaEnvasado[] {
  if (periodo.tipo === 'lote') {
    const c = periodo.codigo.toUpperCase()
    return filas.filter((f) => f.codigo_lote.trim().toUpperCase() === c)
  }
  return filas.filter((f) => f.fecha >= periodo.desde && f.fecha <= periodo.hasta)
}

export function textoProduccion(filas: readonly FilaEnvasado[], periodo: PeriodoProduccion): string {
  // "hoy" y "ayer" van solos; "esta semana", "este mes", "el lote X" llevan "en".
  const cuando = periodo.tipo === 'dia' ? periodo.etiqueta : 'en ' + periodo.etiqueta
  if (filas.length === 0) {
    return `No hay envasado registrado ${cuando}.`
  }
  const porProducto = new Map<string, number>()
  for (const f of filas) porProducto.set(f.producto, (porProducto.get(f.producto) ?? 0) + f.botellas)
  const total = [...porProducto.values()].reduce((a, b) => a + b, 0)
  const lineas = [
    `Envasado ${cuando}: ${total} botella${total === 1 ? '' : 's'}.`
  ]
  for (const [producto, n] of [...porProducto].sort((a, b) => b[1] - a[1])) {
    lineas.push(`   ${n} de ${producto}`)
  }
  if (periodo.tipo !== 'dia') {
    const dias = [...new Set(filas.map((f) => f.fecha))].sort()
    lineas.push(`(${dias.length} dia${dias.length === 1 ? '' : 's'} con envasado, ` +
      `del ${fechaParaPersona(dias[0])} al ${fechaParaPersona(dias[dias.length - 1])})`)
  }
  return lineas.join('\n')
}

// ============================================================================
// EL BORRADOR DE "AGREGAR A UN LOTE" Y SU SELLO (D81)
// ============================================================================

/**
 * Lo que se guarda en `bot_borradores` y lo UNICO que la ruta de confirmar
 * escribe. Mismo esquema de sello que el lote nuevo (`lib/bot-sello.ts`).
 */
export interface PayloadAgregar {
  id_lote: string
  codigo_lote: string
  usuario_creador: string
  entradas: EntradaLote[]
  tandas: TandaLote[]
  envasado: EnvasadoLote[]
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_AGREGAR = [
  'codigo_lote',
  'entradas',
  'envasado',
  'id_lote',
  'tandas',
  'usuario_creador'
] as const

export function sellarAgregar(payload: PayloadAgregar): string {
  return sellar(payload, LLAVES_AGREGAR)
}

export function selloAgregarCoincide(payload: PayloadAgregar, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_AGREGAR, sello)
}

// ============================================================================
// EL MENSAJE DE LA PROPUESTA (D81)
// ============================================================================

export interface DesgloseAgregar {
  insumos: { nombre: string; cantidad: number; unidad: string }[]
  tandas: { litros: number; grado: number | null }[]
  envasado: { nombre: string; botellas: number }[]
  movimientos: { nombre: string; tipo: 'PRODUCCION' | 'TRASPASO'; cantidad: number }[]
}

function numeroCorto(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

export function mensajeDeAgregarALote(
  lote: LoteExistente,
  porDefault: boolean,
  desglose: DesgloseAgregar,
  avisos: readonly string[]
): string {
  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `AL LOTE ${lote.codigo_lote}${porDefault ? '   (el unico abierto)' : ''} ` +
      `(arranco ${fechaParaPersona(lote.fecha_inicio)})`
  ]
  if (desglose.insumos.length > 0) {
    lineas.push('', 'ENTRO (se suma a lo que ya tenia):')
    for (const i of desglose.insumos) {
      lineas.push(`   ${numeroCorto(i.cantidad)} ${i.unidad.toLowerCase()} de ${i.nombre}`)
    }
  }
  if (desglose.tandas.length > 0) {
    lineas.push('', 'SALIO (tandas nuevas):')
    for (const t of desglose.tandas) {
      const grado = t.grado === null ? 'sin grado todavia' : `${numeroCorto(t.grado)} grados`
      lineas.push(`   ${numeroCorto(t.litros)} L a ${grado}`)
    }
  }
  if (desglose.envasado.length > 0) {
    lineas.push('', 'ENVASADO:')
    for (const e of desglose.envasado) lineas.push(`   ${e.botellas} de ${e.nombre}`)
    lineas.push('', 'INVENTARIO DE LA MATRIZ:')
    for (const m of desglose.movimientos) {
      lineas.push(`   ${m.tipo === 'PRODUCCION' ? '+' : '-'}${numeroCorto(m.cantidad)} ${m.nombre}`)
    }
  }
  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)
  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}
