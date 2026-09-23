/**
 * AG-05 Fase 3 — EL LOTE. La logica pura de la produccion por Telegram.
 *
 * ─── D-198: EL BOT CAPTURA, NO CALCULA ──────────────────────────────────────
 *
 * **Este archivo no calcula ni un litro de rendimiento.** No suma alcohol
 * absoluto, no convierte al grado objetivo, no dice cuantas botellas salen. Eso
 * ya lo hace `v_lote_rendimiento` (ERP-84c) en SQL, sobre las filas escritas, y
 * es la unica version de esa aritmetica que existe.
 *
 * El endpoint de confirmar **vuelve a leer la vista despues de escribir** y
 * ensena lo que la vista dice. Asi el numero que Norman lee por Telegram es,
 * literalmente, el mismo numero que va a ver en la pantalla: no una copia que
 * pueda divergir, sino la misma fila. Si un dia la regla del grado objetivo
 * cambia, cambia en la vista y el bot se entera solo.
 *
 * ─── D-200: LO UNICO QUE SE CONSERVA ES EL ALCOHOL ABSOLUTO ─────────────────
 *
 * Al mezclar o diluir, los litros no se conservan y el grado tampoco: lo unico
 * que sobrevive es `sum(litros x grado)`. Por eso lo que se captura por tanda
 * son **litros Y grado**, los dos, y no un total ya mezclado. Un total mezclado
 * es informacion destruida: de "300 litros al 25%" no se puede recuperar que
 * eran 200 al 30% y 100 al 15%, y esa diferencia es la que decide si el lote
 * alcanza los 38 grados diluyendo o hay que volver a destilarlo.
 *
 * Una tanda SIN grado se acepta —a veces se mide despues— pero la vista la
 * cuenta en `tandas_sin_grado` y entonces se niega a dar el costo por mililitro.
 * Eso es correcto y no se parcha aqui: un costo calculado sobre un rendimiento
 * incompleto es un margen que miente.
 */

import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { fechaLocal, fechaParaPersona, sumarDias } from '@/lib/fechas'
import { buscarPorNombre, type ResultadoNombre } from '@/lib/bot-nombres'

// ============================================================================
// 1. LO QUE SE CAPTURA
// ============================================================================

export interface InsumoDelCatalogo {
  id: string
  sku: string | null
  nombre: string
  unidad_medida: string
}

export interface FormatoDeBotella {
  id: string
  sku: string | null
  nombre: string
  ml_por_unidad: number
}

export function buscarInsumo(
  dicho: unknown,
  catalogo: readonly InsumoDelCatalogo[]
): ResultadoNombre<InsumoDelCatalogo> {
  return buscarPorNombre(dicho, catalogo, (i) => (i.sku ? [i.nombre, i.sku] : [i.nombre]))
}

export function buscarFormato(
  dicho: unknown,
  formatos: readonly FormatoDeBotella[]
): ResultadoNombre<FormatoDeBotella> {
  return buscarPorNombre(dicho, formatos, (f) => {
    const nombres = [f.nombre]
    if (f.sku) nombres.push(f.sku)
    // "750" y "750ml" son como se dice de verdad. Van como nombres propios del
    // formato para que el empate no dependa de que el nombre del catalogo lleve
    // el numero pegado de una forma o de otra.
    nombres.push(String(f.ml_por_unidad))
    nombres.push(String(f.ml_por_unidad) + 'ml')
    return nombres
  })
}

export interface EntradaLote {
  id_insumo: string
  cantidad: number
}

export interface TandaLote {
  numero_tanda: number
  litros: number
  grado_alcohol: number | null
}

export interface EnvasadoLote {
  id_producto: string
  botellas: number
}

export interface PayloadLote {
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  notas: string
  usuario_creador: string
  entradas: EntradaLote[]
  tandas: TandaLote[]
  envasado: EnvasadoLote[]
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_LOTE = [
  'codigo_lote',
  'entradas',
  'envasado',
  'fecha_fin_fermentacion',
  'fecha_inicio',
  'horas_fermentacion',
  'notas',
  'tandas',
  'usuario_creador'
] as const

export function loteCanonico(payload: PayloadLote): string {
  return canonizar(payload, LLAVES_LOTE)
}

export function sellarLote(payload: PayloadLote): string {
  return sellar(payload, LLAVES_LOTE)
}

export function selloLoteCoincide(payload: PayloadLote, sello: unknown): boolean {
  return selloEmpata(payload, LLAVES_LOTE, sello)
}

// ============================================================================
// 2. LOS TOPES. Todos son "esto no se dicta por chat", no "esto es imposible".
// ============================================================================

/** Una tanda de mas litros que esto es casi siempre un punto decimal perdido. */
export const TOPE_LITROS_TANDA = 5000
/** El grado es un porcentaje. 0 se acepta (agua); arriba de 100 no existe. */
export const GRADO_MAXIMO = 100
export const TOPE_CANTIDAD_INSUMO = 100000
export const TOPE_BOTELLAS = 100000
/** Una fermentacion de mas de un mes no se captura a ciegas. */
export const TOPE_HORAS_FERMENTACION = 24 * 31
export const TOPE_TANDAS = 20

// ============================================================================
// 3. LA FECHA Y EL CODIGO
// ============================================================================

// `fechaLocal` y `sumarDias` viven en `lib/fechas.ts` desde que la cotizacion
// necesito las mismas dos. Se re-exportan aqui porque las rutas y las pruebas
// del lote ya las importaban de este archivo, y porque son parte de su API:
// quien captura un lote captura fechas.
export { fechaLocal, sumarDias } from '@/lib/fechas'

/**
 * El codigo cuando no se dicto uno.
 *
 * **No es inventar un dato: es proponer un default y ensenarlo.** `codigo_lote`
 * es `not null unique` y es lo que va impreso en la etiqueta, asi que tiene que
 * existir; pero tambien es lo unico del lote que Norman quizas ya decidio en
 * papel. Por eso se propone `L-AAAAMMDD`, se ensena en la confirmacion, y hay
 * un boton para cambiarlo antes del "va". La letra al final solo aparece cuando
 * el del dia ya existe — dos lotes el mismo dia son dos, no un error.
 */
export function codigoSugerido(fecha: string, tomados: readonly string[]): string {
  const base = 'L-' + fecha.replace(/-/g, '')
  const usados = new Set(tomados.map((c) => c.trim().toUpperCase()))
  if (!usados.has(base)) return base
  for (let i = 1; i < 26; i++) {
    const conLetra = base + '-' + String.fromCharCode(65 + i)
    if (!usados.has(conLetra)) return conLetra
  }
  // 26 lotes el mismo dia no pasa; si pasara, se detiene en vez de repetir.
  return ''
}

// ============================================================================
// 4. LA PUERTA
// ============================================================================

export interface LineaInsumoPedida {
  insumo: InsumoDelCatalogo
  cantidad: number
}

export interface LineaEnvasadoPedida {
  formato: FormatoDeBotella
  botellas: number
}

export interface ContextoLote {
  etiqueta: string
  ahora: Date
  codigosTomados: readonly string[]
  insumos: readonly LineaInsumoPedida[]
  envasado: readonly LineaEnvasadoPedida[]
}

export interface PropuestaLoteLLM {
  codigo_lote?: unknown
  fecha_inicio?: unknown
  dias_fermentacion?: unknown
  horas_fermentacion?: unknown
  tandas?: unknown
  notas?: unknown
}

export interface DesgloseLote {
  insumos: { nombre: string; cantidad: number; unidad: string }[]
  tandas: { numero: number; litros: number; grado: number | null }[]
  envasado: { nombre: string; botellas: number }[]
}

export interface ResultadoLoteOk {
  ok: true
  payload: PayloadLote
  avisos: string[]
  desglose: DesgloseLote
  codigoSugerido: boolean
}

export interface ResultadoLoteFallido {
  ok: false
  error: string
}

function numero(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === '') return null
  const n = Number(valor)
  return Number.isFinite(n) ? n : null
}

/**
 * Convierte lo que el endpoint resolvio en las filas exactas de las cuatro
 * tablas de ERP-84.
 *
 * Todo lo que se escribe o vino de una lista cerrada (el insumo, el formato de
 * botella) o es una cantidad que la persona dicto y va a leer antes del "va".
 * **No hay ningun campo derivado**: el rendimiento lo calcula la vista.
 */
export function normalizarLote(
  propuesta: PropuestaLoteLLM,
  contexto: ContextoLote
): ResultadoLoteOk | ResultadoLoteFallido {
  const avisos: string[] = []
  const hoy = fechaLocal(contexto.ahora)

  // ── La fecha de inicio ────────────────────────────────────────────────────
  let fechaInicio = String(propuesta.fecha_inicio ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio)) fechaInicio = hoy
  if (fechaInicio > hoy) {
    return { ok: false, error: 'Esa fecha de inicio es en el futuro. No la escribo.' }
  }

  // ── El codigo ─────────────────────────────────────────────────────────────
  const dictado = String(propuesta.codigo_lote ?? '').trim()
  let codigo = dictado
  let esSugerido = false
  if (codigo === '') {
    codigo = codigoSugerido(fechaInicio, contexto.codigosTomados)
    esSugerido = true
    if (codigo === '') {
      return { ok: false, error: 'No pude proponerte un codigo de lote. Dictame uno.' }
    }
  }
  if (codigo.length > 40) {
    return { ok: false, error: 'Ese codigo de lote es larguisimo. Dame uno mas corto.' }
  }
  if (contexto.codigosTomados.some((c) => c.trim().toUpperCase() === codigo.toUpperCase())) {
    return {
      ok: false,
      error: `El lote ${codigo} ya existe. Si es otro lote, dame otro codigo.`
    }
  }

  // ── La fermentacion. Se captura lo que se dijo, no lo que se deduce ───────
  // Si dijo dias, la fecha de fin sale de la de inicio. Si dijo horas, van a su
  // columna. **Decir dias NO rellena las horas** (ni al reves): 3 dias son 72
  // horas solo si nadie paro la fermentacion a media tarde, y ese es justo el
  // dato que la columna de horas existe para guardar.
  const dias = numero(propuesta.dias_fermentacion)
  const horas = numero(propuesta.horas_fermentacion)

  let fechaFin: string | null = null
  if (dias !== null) {
    if (!Number.isInteger(dias) || dias < 0 || dias > 31) {
      return { ok: false, error: 'No entendi cuantos dias de fermentacion.' }
    }
    fechaFin = sumarDias(fechaInicio, dias)
  }
  if (horas !== null) {
    if (horas <= 0 || horas > TOPE_HORAS_FERMENTACION) {
      return { ok: false, error: 'No entendi cuantas horas de fermentacion.' }
    }
  }

  // ── Los insumos ───────────────────────────────────────────────────────────
  const porInsumo = new Map<string, { insumo: InsumoDelCatalogo; cantidad: number }>()
  for (const linea of contexto.insumos) {
    const cantidad = Number(linea.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
      return { ok: false, error: `No entendi cuanto ${linea.insumo.nombre} entro.` }
    }
    if (cantidad > TOPE_CANTIDAD_INSUMO) {
      return { ok: false, error: `${cantidad} de ${linea.insumo.nombre} es demasiado. Revisalo.` }
    }
    const previa = porInsumo.get(linea.insumo.id)
    // `lote_entradas` tiene `unique (id_lote, id_insumo)`: el insumo repetido se
    // SUMA aqui, porque si llegara dos veces la base rechazaria el INSERT entero
    // y el lote se quedaria a medias por una frase mal dicha.
    porInsumo.set(linea.insumo.id, {
      insumo: linea.insumo,
      cantidad: Number(((previa?.cantidad ?? 0) + cantidad).toFixed(4))
    })
    if (previa) {
      avisos.push(`Sume los dos renglones de ${linea.insumo.nombre}.`)
    }
  }

  // ── Las tandas ────────────────────────────────────────────────────────────
  const crudas = Array.isArray(propuesta.tandas) ? propuesta.tandas : []
  const tandas: TandaLote[] = []
  const desgloseTandas: DesgloseLote['tandas'] = []
  if (crudas.length > TOPE_TANDAS) {
    return { ok: false, error: `${crudas.length} tandas es demasiado para capturar por chat.` }
  }
  for (let i = 0; i < crudas.length; i++) {
    const cruda = (crudas[i] ?? {}) as Record<string, unknown>
    const litros = numero(cruda.litros)
    if (litros === null || litros <= 0) {
      return { ok: false, error: `No entendi cuantos litros dio la tanda ${i + 1}.` }
    }
    if (litros > TOPE_LITROS_TANDA) {
      return { ok: false, error: `${litros} litros en una tanda no me cuadra. Revisalo.` }
    }
    const grado = numero(cruda.grado ?? cruda.grado_alcohol)
    if (grado !== null && (grado < 0 || grado > GRADO_MAXIMO)) {
      return { ok: false, error: `Un grado de ${grado} no existe. Revisalo.` }
    }
    tandas.push({
      numero_tanda: i + 1,
      litros: Number(litros.toFixed(3)),
      grado_alcohol: grado === null ? null : Number(grado.toFixed(2))
    })
    desgloseTandas.push({ numero: i + 1, litros, grado })
  }

  // Una tanda sin grado NO se rechaza —a veces se mide despues— pero se avisa,
  // porque mientras falte, `v_lote_rendimiento` se niega a dar el costo por
  // mililitro. Es mejor que la persona sepa por que el numero no va a aparecer.
  if (tandas.some((t) => t.grado_alcohol === null)) {
    avisos.push(
      'Hay tandas sin grado. Las guardo asi, pero hasta que no tengan grado el ' +
        'sistema no puede sacar el rendimiento ni el costo por mililitro.'
    )
  }

  // ── El envasado ───────────────────────────────────────────────────────────
  const porFormato = new Map<string, { formato: FormatoDeBotella; botellas: number }>()
  for (const linea of contexto.envasado) {
    const botellas = Number(linea.botellas)
    if (!Number.isInteger(botellas) || botellas <= 0) {
      return { ok: false, error: `No entendi cuantas botellas de ${linea.formato.nombre}.` }
    }
    if (botellas > TOPE_BOTELLAS) {
      return { ok: false, error: `${botellas} botellas es demasiado. Revisalo.` }
    }
    const previa = porFormato.get(linea.formato.id)
    porFormato.set(linea.formato.id, {
      formato: linea.formato,
      botellas: (previa?.botellas ?? 0) + botellas
    })
    if (previa) avisos.push(`Sume las botellas de ${linea.formato.nombre}.`)
  }

  // ── Lo indispensable ──────────────────────────────────────────────────────
  // Un lote sin NADA no es un lote. Con insumos pero sin tandas si: es un lote
  // que arranco y todavia no destila, y registrarlo el dia que arranca es
  // justamente para lo que sirve `fecha_inicio`.
  //
  // Fase 8 (D81): "el lote se abre con todas sus variables opcionales". Sin
  // hijos se abre IGUAL si se dicto algo de su cabecera (codigo, fecha de
  // inicio, dias u horas de fermentacion); lo que entre despues se agrega con
  // el codigo (`esAgregarALote`). Vacio del todo sigue sin ser un lote.
  const sinHijos = porInsumo.size === 0 && tandas.length === 0 && porFormato.size === 0
  const hayCabecera =
    dias !== null ||
    horas !== null ||
    String(propuesta.fecha_inicio ?? '').trim() !== '' ||
    dictado !== ''
  if (sinHijos && !hayCabecera) {
    return { ok: false, error: 'No entendi que entro ni que salio del lote.' }
  }
  if (sinHijos) {
    avisos.push(
      'Lo abro sin insumos, tandas ni envasado. Me los dices despues con el codigo del lote.'
    )
  }

  const notas = String(propuesta.notas ?? '').trim().slice(0, 500)

  return {
    ok: true,
    avisos,
    codigoSugerido: esSugerido,
    desglose: {
      insumos: [...porInsumo.values()].map((e) => ({
        nombre: e.insumo.nombre,
        cantidad: e.cantidad,
        unidad: e.insumo.unidad_medida
      })),
      tandas: desgloseTandas,
      envasado: [...porFormato.values()].map((e) => ({
        nombre: e.formato.nombre,
        botellas: e.botellas
      }))
    },
    payload: {
      codigo_lote: codigo,
      fecha_inicio: fechaInicio,
      fecha_fin_fermentacion: fechaFin,
      horas_fermentacion: horas,
      notas,
      usuario_creador: `telegram:${contexto.etiqueta}`,
      entradas: [...porInsumo.values()].map((e) => ({
        id_insumo: e.insumo.id,
        cantidad: e.cantidad
      })),
      tandas,
      envasado: [...porFormato.values()].map((e) => ({
        id_producto: e.formato.id,
        botellas: e.botellas
      }))
    }
  }
}

// ============================================================================
// 5. LOS MENSAJES
// ============================================================================

function numeroCorto(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/**
 * Lo que lee la persona antes de decir "va".
 *
 * **No trae ni un numero derivado.** Ni litros al grado objetivo, ni alcohol
 * absoluto, ni botellas teoricas. Todo eso aparece DESPUES de escribir, leido
 * de `v_lote_rendimiento` (ver `mensajeDeRendimiento`), y esa separacion es el
 * punto: lo que se confirma es lo que se capturo, y lo que se calcula lo
 * calcula quien sabe.
 */
export function mensajeDeConfirmacionLote(
  payload: PayloadLote,
  desglose: DesgloseLote,
  avisos: readonly string[],
  codigoEsSugerido: boolean
): string {
  const lineas = [
    'Esto es lo que voy a escribir. Revisalo:',
    '',
    `LOTE ${payload.codigo_lote}${codigoEsSugerido ? '   (codigo que te propongo)' : ''}`,
    `Arranco: ${fechaParaPersona(payload.fecha_inicio)}`
  ]

  if (payload.fecha_fin_fermentacion) {
    lineas.push(`Fermento hasta: ${fechaParaPersona(payload.fecha_fin_fermentacion)}`)
  }
  if (payload.horas_fermentacion !== null) {
    lineas.push(`Horas de fermentacion: ${numeroCorto(payload.horas_fermentacion)}`)
  }

  if (desglose.insumos.length > 0) {
    lineas.push('', 'ENTRO:')
    for (const i of desglose.insumos) {
      lineas.push(`   ${numeroCorto(i.cantidad)} ${i.unidad.toLowerCase()} de ${i.nombre}`)
    }
  }

  if (desglose.tandas.length > 0) {
    lineas.push('', 'SALIO:')
    for (const t of desglose.tandas) {
      const grado = t.grado === null ? 'sin grado todavia' : `${numeroCorto(t.grado)} grados`
      lineas.push(`   Tanda ${t.numero}: ${numeroCorto(t.litros)} L a ${grado}`)
    }
  }

  if (desglose.envasado.length > 0) {
    lineas.push('', 'ENVASADO:')
    for (const e of desglose.envasado) {
      lineas.push(`   ${e.botellas} de ${e.nombre}`)
    }
  }

  for (const aviso of avisos) lineas.push('', `OJO: ${aviso}`)

  lineas.push('', 'Contesta VA para escribirlo, o dime que cambio.')
  return lineas.join('\n')
}

export interface RendimientoDelLote {
  alcohol_absoluto_l: number | null
  litros_al_grado_objetivo: number | null
  botellas_750_teoricas: number | null
  grado_ponderado: number | null
  alcanza_el_grado_diluyendo: boolean | null
  costo_por_ml: number | null
  tandas_sin_grado: number | null
  /** Cuantos insumos del lote tienen `costo_unitario` en cero o nulo. */
  insumos_sin_costo: number | null
  /** Los SKU de esos insumos, tal como los junta la vista: "agua, corcho". */
  faltan_costo: string | null
}

/**
 * Lo que dice `v_lote_rendimiento`, DESPUES de escribir. Ni un numero de aqui
 * lo calculo el bot: todos vienen de la vista (D-198).
 *
 * `alcanza_el_grado_diluyendo` se dice en palabras porque es la unica cifra del
 * lote que cambia lo que hay que hacer manana: si el grado ponderado no llega a
 * 38, agregar agua no lo arregla — o se mezcla con algo mas fuerte o se vuelve
 * a destilar. Un booleano crudo en un chat no lo dice.
 */
export function mensajeDeRendimiento(r: RendimientoDelLote | null): string {
  if (!r) return ''
  const lineas: string[] = []

  if (r.alcohol_absoluto_l !== null) {
    lineas.push(`Alcohol absoluto: ${numeroCorto(r.alcohol_absoluto_l)} L`)
  }
  if (r.litros_al_grado_objetivo !== null) {
    lineas.push(`Al grado objetivo salen ${numeroCorto(r.litros_al_grado_objetivo)} L`)
  }
  if (r.botellas_750_teoricas !== null) {
    lineas.push(`(unas ${numeroCorto(r.botellas_750_teoricas)} botellas de 750)`)
  }
  if (r.alcanza_el_grado_diluyendo === false) {
    lineas.push(
      `Ojo: el lote quedo a ${r.grado_ponderado === null ? '?' : numeroCorto(r.grado_ponderado)} ` +
        'grados, o sea debajo del objetivo. Diluyendo NO llega: hay que mezclarlo con algo ' +
        'mas fuerte o volver a destilarlo.'
    )
  }
  // El costo por ml, o LA RAZON de que no haya. Callarse cuando no sale es lo
  // peor de los dos: quien lee un lote sin costo no puede saber si es que el
  // sistema no lo calcula o que falta capturar algo. La vista ya manda el
  // motivo — `tandas_sin_grado` y `faltan_costo` — asi que se dice.
  if (r.costo_por_ml !== null) {
    lineas.push(`Costo por ml: $${r.costo_por_ml}`)
  } else if ((r.tandas_sin_grado ?? 0) > 0) {
    lineas.push('El costo por ml no sale todavia: faltan grados por medir.')
  } else if ((r.insumos_sin_costo ?? 0) > 0) {
    lineas.push(
      `El costo por ml no sale: no tengo costo de ${r.faltan_costo || 'algun insumo'}.`
    )
  }

  return lineas.join('\n')
}
