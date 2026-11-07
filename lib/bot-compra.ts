/**
 * 2026-11-07 — "COMPRE 50 KG DE CHILE A 1200 DESDE SPIN": LA COMPRA DE INSUMO
 * COMPLETA DESDE EL BOT.
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web).
 *
 * ─── EL DEFECTO QUE CIERRA ──────────────────────────────────────────────────
 * Un gasto de "Costo de produccion / chile" dictado al bot movia el DINERO y
 * nada mas: el chile nunca entraba al almacen. La pantalla de compra
 * (`/dashboard/inventario/compra`) si escribe las dos cosas. Ahora, cuando el
 * gasto es de insumo y se sabe CUAL insumo y CUANTO, la propuesta deja de ser un
 * gasto y pasa a ser una compra, y al VA se escribe con la MISMA funcion que la
 * pantalla (`escribirCompraInsumos`, `lib/compra-insumos.ts`).
 *
 * ─── LO QUE EL MODELO NO DECIDE ─────────────────────────────────────────────
 * El insumo y la cantidad se leen AQUI, sin modelo, del concepto que el
 * enrutador ya extrajo ("50 kg de chile"), contra el catalogo de insumos leido
 * de la base. Dos insumos posibles ("chile": Guajillo o Guajon) no se adivinan:
 * se pregunta UNA vez, con botones. Sin cantidad, se pregunta UNA vez por el
 * numero. Mientras tanto la propuesta sigue siendo el gasto de siempre, con un
 * OJO que dice que solo mueve dinero: nunca se pierde la captura por un dato.
 *
 * Todo aqui es PURO (`tests/bot-compra.spec.ts`).
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import { claves, limpiar, singular, VACIAS } from '@/lib/bot-entrada-insumo'
import { fechaParaPersona } from '@/lib/fechas'
import { CATEGORIA_COMPRA_WEB } from '@/lib/compra-insumos'
import type { MovimientoReciente, PayloadGasto } from '@/lib/bot-gastos'

export interface InsumoDeCompra {
  id: string
  nombre: string
  unidad_medida: string | null
}

/** Las categorias cuyo gasto es, casi siempre, entrada de material al almacen. */
const CATEGORIAS_DE_INSUMO = ['costo de produccion', 'insumos']

function sinAcentos(texto: unknown): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

export function esCategoriaDeInsumo(categoria: unknown): boolean {
  return CATEGORIAS_DE_INSUMO.includes(sinAcentos(categoria))
}

// ─── LA CANTIDAD ────────────────────────────────────────────────────────────

export type UnidadDicha = 'kg' | 'g' | 'ton' | 'pz' | 'l' | null

const UNIDADES: Record<string, Exclude<UnidadDicha, null>> = {
  kg: 'kg', kgs: 'kg', k: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  g: 'g', gr: 'g', grs: 'g', gramo: 'g', gramos: 'g',
  ton: 'ton', tons: 'ton', tonelada: 'ton', toneladas: 'ton',
  pz: 'pz', pza: 'pz', pzas: 'pz', pieza: 'pz', piezas: 'pz', unidad: 'pz', unidades: 'pz',
  l: 'l', lt: 'l', lts: 'l', litro: 'l', litros: 'l'
}

function unidadDe(t: string | undefined): UnidadDicha {
  return t !== undefined && Object.prototype.hasOwnProperty.call(UNIDADES, t) ? UNIDADES[t] : null
}

/** Palabras que, justo antes de un numero, lo vuelven medida o precio y no cantidad. */
const ANTES_DE_NO_CANTIDAD = new Set(['de', 'a', 'por', 'en', 'x'])

export interface CantidadDicha {
  valor: number
  unidad: UnidadDicha
  /** Como lo dijo, para ensenarlo. */
  texto: string
}

function esNumero(t: string): boolean {
  return /^\d+(\.\d+)?$/.test(t)
}

/** Los numeros del texto que pueden ser cantidad, con su unidad y su posicion. */
function candidatosDeCantidad(tokens: string[], monto?: number | null): { i: number; c: CantidadDicha }[] {
  const salida: { i: number; c: CantidadDicha }[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!esNumero(t)) continue
    if (i > 0 && ANTES_DE_NO_CANTIDAD.has(tokens[i - 1])) continue
    const valor = Number(t)
    if (!Number.isFinite(valor) || valor <= 0) continue
    if (monto !== undefined && monto !== null && Math.abs(valor - Number(monto)) < 0.005) continue
    const unidad = unidadDe(tokens[i + 1])
    salida.push({ i, c: { valor, unidad, texto: unidad ? `${t} ${tokens[i + 1]}` : t } })
  }
  return salida
}

/**
 * La cantidad dicha en el concepto: un numero que no sea medida ("de 750"),
 * precio ("a 1200", "por 24") ni el monto del gasto. Gana el primero que trae
 * unidad ("aditivo 1, 5 kilos" son 5 kg, no 1); sin unidad, el primero.
 * **Pura.** `null` si no hay.
 */
export function leerCantidad(texto: unknown, monto?: number | null): CantidadDicha | null {
  const tokens = limpiar(String(texto ?? '')).split(' ').filter((t) => t !== '')
  const candidatos = candidatosDeCantidad(tokens, monto)
  const conUnidad = candidatos.find((x) => x.c.unidad !== null)
  return (conUnidad ?? candidatos[0])?.c ?? null
}

/**
 * Los numeros que nombran QUE insumo ("de 750", "aditivo 1"): ni la cantidad,
 * ni el precio ("a 12"), ni el monto. **Pura.**
 */
function medidasDelTexto(tokens: string[], monto?: number | null): Set<string> {
  const candidatos = candidatosDeCantidad(tokens, monto)
  const cantidad = candidatos.find((x) => x.c.unidad !== null) ?? candidatos[0]
  const medidas = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!esNumero(t) || (cantidad && i === cantidad.i)) continue
    const antes = tokens[i - 1] ?? ''
    if (antes === 'a' || antes === 'por' || antes === 'x' || antes === 'en') continue
    if (monto !== undefined && monto !== null && Math.abs(Number(t) - Number(monto)) < 0.005) continue
    medidas.add(t)
  }
  return medidas
}

const CORTA: Record<string, string> = { KILOGRAMOS: 'kg', PIEZAS: 'pzas', LITROS: 'l', FRACCIONES: 'fracciones' }

export function unidadCorta(unidadMedida: string | null | undefined): string {
  const u = String(unidadMedida ?? '').toUpperCase()
  return CORTA[u] ?? (u ? u.toLowerCase() : 'unidades')
}

function redondear(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * La cantidad en la unidad del insumo. **Pura.** Lo que no se puede convertir
 * sin adivinar (kilos de algo que se cuenta por pieza) se pregunta.
 */
export function aUnidadDelInsumo(
  c: CantidadDicha,
  unidadMedida: string | null | undefined
): { ok: true; cantidad: number } | { ok: false; motivo: string } {
  const u = String(unidadMedida ?? '').toUpperCase()
  const corta = unidadCorta(unidadMedida)
  if (u === 'KILOGRAMOS') {
    if (c.unidad === null || c.unidad === 'kg') return { ok: true, cantidad: redondear(c.valor) }
    if (c.unidad === 'g') return { ok: true, cantidad: redondear(c.valor / 1000) }
    if (c.unidad === 'ton') return { ok: true, cantidad: redondear(c.valor * 1000) }
    return { ok: false, motivo: `dijiste "${c.texto}" y ese insumo se lleva en kg` }
  }
  if (u === 'PIEZAS') {
    if (c.unidad !== null && c.unidad !== 'pz') {
      return { ok: false, motivo: `dijiste "${c.texto}" y ese insumo se lleva en piezas` }
    }
    if (!Number.isInteger(c.valor)) return { ok: false, motivo: `"${c.texto}" no es un numero entero de piezas` }
    return { ok: true, cantidad: c.valor }
  }
  if (u === 'LITROS' && (c.unidad === null || c.unidad === 'l')) return { ok: true, cantidad: redondear(c.valor) }
  if (c.unidad === null) return { ok: true, cantidad: redondear(c.valor) }
  return { ok: false, motivo: `dijiste "${c.texto}" y ese insumo se lleva en ${corta}` }
}

// ─── EL INSUMO ──────────────────────────────────────────────────────────────

export type Eleccion =
  | { tipo: 'uno'; insumo: InsumoDeCompra }
  | { tipo: 'varios'; candidatos: InsumoDeCompra[] }
  | { tipo: 'ninguno' }

/**
 * Que insumo del catalogo nombra el texto. **Pura.** Comparte palabra
 * (singularizada) con su nombre; si el texto trae una medida ("de 750") y el
 * insumo tiene numero, tiene que ser el mismo. Gana el que comparte MAS
 * palabras; un empate son varios, y varios se preguntan.
 */
export function escogerInsumo(
  texto: unknown,
  insumos: readonly InsumoDeCompra[],
  monto?: number | null,
  /** En un nombre ("Aditivo 1", la subcategoria) todo numero es medida, no cantidad. */
  todoEsMedida = false
): Eleccion {
  const tokens = limpiar(String(texto ?? '')).split(' ').filter((t) => t !== '')
  const palabras = new Set(
    tokens.filter((t) => !esNumero(t) && !VACIAS.has(t) && unidadDe(t) === null).map(singular)
  )
  const medidas = todoEsMedida ? new Set(tokens.filter(esNumero)) : medidasDelTexto(tokens, monto)
  if (palabras.size === 0) return { tipo: 'ninguno' }

  let mejor = 0
  let elegidos: InsumoDeCompra[] = []
  for (const insumo of insumos) {
    const k = claves(insumo.nombre)
    const comunes = [...k.palabras].filter((p) => palabras.has(p)).length
    if (comunes === 0) continue
    if (medidas.size > 0 && k.numeros.size > 0 && ![...medidas].some((m) => k.numeros.has(m))) continue
    const puntos = comunes + (medidas.size > 0 && [...medidas].some((m) => k.numeros.has(m)) ? 1 : 0)
    if (puntos > mejor) {
      mejor = puntos
      elegidos = [insumo]
    } else if (puntos === mejor) {
      elegidos.push(insumo)
    }
  }
  if (elegidos.length === 0) return { tipo: 'ninguno' }
  if (elegidos.length === 1) return { tipo: 'uno', insumo: elegidos[0] }
  return { tipo: 'varios', candidatos: elegidos }
}

// ─── LA DECISION: COMPRA O GASTO ────────────────────────────────────────────

export const TOPE_OPCIONES = 8

export type Derivacion =
  | { modo: 'compra'; insumo: InsumoDeCompra; cantidad: number; dicho: CantidadDicha }
  | { modo: 'gasto'; falta: 'insumo'; opciones: InsumoDeCompra[] }
  | { modo: 'gasto'; falta: 'cantidad'; insumo: InsumoDeCompra; motivo: string | null }
  | { modo: 'gasto'; falta: null }

export interface EntradaDerivacion {
  categoria: string | null | undefined
  subcategoria: string | null | undefined
  descripcion: string | null | undefined
  monto: number
  /** El insumo escogido con un boton (id de la lista que el servidor ofrecio). */
  idInsumoElegido?: unknown
  /** La cantidad contestada a "cuantos kg?" (texto tal cual). */
  cantidadContestada?: unknown
  /**
   * El mensaje tal como lo escribio la persona (lo manda el bot). Solo se usa
   * para la CANTIDAD cuando el concepto que extrajo el modelo no la trae; lo
   * que salga de aqui se ensena antes del VA.
   */
  textoDicho?: unknown
  insumos: readonly InsumoDeCompra[]
}

/**
 * ¿Este gasto es una compra de insumo, y alcanza lo dicho para escribirla?
 * **Pura.** Nunca rechaza: lo peor que devuelve es "gasto, falta X".
 */
export function derivarCompra(e: EntradaDerivacion): Derivacion {
  const elegidoId = typeof e.idInsumoElegido === 'string' ? e.idInsumoElegido : ''
  const elegido = elegidoId ? e.insumos.find((i) => i.id === elegidoId) ?? null : null
  // Solo un gasto de categoria de insumo se vuelve compra. Si despues de escoger
  // el insumo le cambian la categoria a otra ("gasolina"), vuelve a ser gasto.
  if (!esCategoriaDeInsumo(e.categoria)) return { modo: 'gasto', falta: null }

  let insumo = elegido
  if (!insumo) {
    let eleccion = escogerInsumo(e.descripcion, e.insumos, e.monto)
    // Sin insumo en el concepto, la subcategoria ("Botellas", "chile") acota.
    if (eleccion.tipo === 'ninguno') eleccion = escogerInsumo(e.subcategoria, e.insumos, null, true)
    // Varios por el concepto ("aditivo"): la subcategoria ("Aditivo 1") desempata
    // entre ESOS candidatos; si tampoco, se pregunta.
    if (eleccion.tipo === 'varios') {
      const porSub = escogerInsumo(e.subcategoria, eleccion.candidatos, null, true)
      if (porSub.tipo === 'uno') eleccion = porSub
    }
    if (eleccion.tipo === 'ninguno') return { modo: 'gasto', falta: null }
    if (eleccion.tipo === 'varios') {
      return { modo: 'gasto', falta: 'insumo', opciones: eleccion.candidatos.slice(0, TOPE_OPCIONES) }
    }
    insumo = eleccion.insumo
  }

  const contestada = String(e.cantidadContestada ?? '').trim()
  const dicho =
    contestada !== ''
      ? leerCantidad(contestada)
      : leerCantidad(e.descripcion, e.monto) ?? leerCantidad(e.textoDicho, e.monto)
  if (!dicho) return { modo: 'gasto', falta: 'cantidad', insumo, motivo: null }
  const convertida = aUnidadDelInsumo(dicho, insumo.unidad_medida)
  if (!convertida.ok) return { modo: 'gasto', falta: 'cantidad', insumo, motivo: convertida.motivo }
  return { modo: 'compra', insumo, cantidad: convertida.cantidad, dicho }
}

// ─── EL BORRADOR Y SU SELLO ─────────────────────────────────────────────────

export interface PayloadCompra {
  id_insumo: string
  cantidad: number
  costo_total: number
  id_cuenta_origen: string
  id_entidad: string
  usuario_creador: string
  categoria: string
  subcategoria: string | null
  descripcion: string
  fecha_movimiento: string
  notas: string
}

export const LLAVES_COMPRA = [
  'cantidad',
  'categoria',
  'costo_total',
  'descripcion',
  'fecha_movimiento',
  'id_cuenta_origen',
  'id_entidad',
  'id_insumo',
  'notas',
  'subcategoria',
  'usuario_creador'
] as const

export function sellarCompra(payload: PayloadCompra): string {
  return sellar(payload, LLAVES_COMPRA)
}

export function selloCompraCoincide(payload: PayloadCompra, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_COMPRA, sello)
}

/**
 * La compra que se va a escribir, armada desde el gasto ya normalizado (monto,
 * fecha, autor y cuenta los decidio `normalizarPropuesta`, no el modelo). **Pura.**
 */
export function payloadDeCompra(
  fila: PayloadGasto,
  d: Extract<Derivacion, { modo: 'compra' }>,
  idEntidad: string
): PayloadCompra {
  // `derivarCompra` solo da compra con categoria de insumo; el respaldo es la
  // categoria que escribe la pantalla.
  const deInsumo = esCategoriaDeInsumo(fila.categoria)
  return {
    id_insumo: d.insumo.id,
    cantidad: d.cantidad,
    costo_total: fila.monto,
    // Exactamente una de las dos columnas trae la cuenta en el gasto.
    id_cuenta_origen: String(fila.id_cuenta_destino ?? fila.id_cuenta_origen ?? ''),
    id_entidad: idEntidad,
    usuario_creador: fila.usuario_creador,
    categoria: deInsumo ? fila.categoria : CATEGORIA_COMPRA_WEB,
    subcategoria: deInsumo ? fila.subcategoria ?? null : null,
    descripcion: fila.descripcion,
    fecha_movimiento: fila.fecha_movimiento,
    notas: `Compra dictada al bot: ${d.dicho.texto} de ${d.insumo.nombre}`
  }
}

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('es-MX') : String(Number(n.toFixed(4)))
}

function pesos(n: number): string {
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export const CIERRE_PROPUESTA = 'Contesta VA para escribirlo, o dime que cambio.'

/** Lo que lee la persona antes del VA de una compra. **Pura.** */
export function mensajeDeCompra(
  p: PayloadCompra,
  insumo: InsumoDeCompra,
  dicho: CantidadDicha,
  contexto: { nombreCuenta: string; nombreEntidad: string },
  avisos: readonly string[]
): string {
  const corta = unidadCorta(insumo.unidad_medida)
  const unitario = p.cantidad > 0 ? p.costo_total / p.cantidad : 0
  const comoLoDijo = dicho.unidad && dicho.unidad !== 'kg' && dicho.unidad !== 'pz' ? `   (dijiste ${dicho.texto})` : ''
  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    'COMPRA DE INSUMO: entra al inventario Y sale el dinero',
    '',
    `INSUMO:     ${insumo.nombre}`,
    `CANTIDAD:   ${num(p.cantidad)} ${corta}${comoLoDijo}`,
    `COSTO:      ${pesos(p.costo_total)}   (${pesos(unitario)} por ${corta === 'pzas' ? 'pieza' : corta})`,
    `CATEGORIA:  ${p.categoria}${p.subcategoria ? ` / ${p.subcategoria}` : ''}`,
    `CONCEPTO:   ${p.descripcion}`,
    `FECHA:      ${fechaParaPersona(p.fecha_movimiento)}`,
    `CUENTA:     ${contexto.nombreCuenta} (el dinero SALE de aqui)`,
    `ENTRA A:    almacen de ${contexto.nombreEntidad}`,
    '',
    `(la cuenta no la elige el modelo: sale de tu alta en ${contexto.nombreEntidad}, y si esta mal la cambias con el boton)`
  ]
  for (const a of avisos) lineas.push('', `OJO: ${a}`)
  lineas.push('', CIERRE_PROPUESTA)
  return lineas.join('\n')
}

/**
 * El OJO que se le agrega a un gasto de insumo que todavia no alcanza para
 * compra. Dice la diferencia (solo dinero) y pide UNA cosa. `null` si no aplica.
 */
export function ojoDeGastoDeInsumo(d: Derivacion): string | null {
  if (d.modo !== 'gasto' || d.falta === null) return null
  if (d.falta === 'insumo') {
    return (
      'Esto solo registra el DINERO; el insumo no entra al inventario. ' +
      'Si es compra de insumo, escoge cual abajo y lo meto tambien al almacen.'
    )
  }
  const corta = unidadCorta(d.insumo.unidad_medida)
  return (
    'Esto solo registra el DINERO; el insumo no entra al inventario' +
    (d.motivo ? ` (${d.motivo})` : '') +
    `. Si quieres que entre, dime cuantos ${corta} de ${d.insumo.nombre} fueron: solo el numero.`
  )
}

/** Mete el OJO justo antes del cierre del mensaje del gasto. **Pura.** */
export function conOjo(mensaje: string, ojo: string | null): string {
  if (!ojo) return mensaje
  const i = mensaje.lastIndexOf(CIERRE_PROPUESTA)
  if (i < 0) return `${mensaje}\n\nOJO: ${ojo}`
  return `${mensaje.slice(0, i)}OJO: ${ojo}\n\n${mensaje.slice(i)}`
}

/**
 * El mismo OJO de duplicado que el gasto (`mensajeDeConfirmacion`), sin el
 * prefijo: `mensajeDeCompra` lo pone. **Pura salvo por el reloj.**
 */
export function avisoDeDuplicado(d: MovimientoReciente, ahora: Date = new Date()): string {
  const hace = Math.max(1, Math.round((ahora.getTime() - new Date(d.fecha_movimiento).getTime()) / 60000))
  const quien = (d.usuario_creador ?? 'alguien').replace('telegram:', '')
  return (
    `hace ${hace} minuto(s) ${quien} registro $${Number(d.monto).toLocaleString('es-MX', { minimumFractionDigits: 2 })} ` +
    `en ${d.categoria}. Es el mismo o es otro?`
  )
}
