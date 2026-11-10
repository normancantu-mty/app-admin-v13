/**
 * 2026-11-08 — LA FOTO DE UNA FACTURA O COTIZACION DE VARIAS LINEAS -> UNA COMPRA.
 *
 * Escrito el 2026-11-08 por el ejecutor del Socio (bot: compra desde foto, multilinea).
 *
 * Norman, por voz: "quiero poder poner esta imagen en el ERP bot para que haga
 * todo el conteo de todo lo que dice, botellas, tapas y todo eso, y ya nada mas
 * me diga en que cuenta lo voy a aplicar".
 *
 * ─── EL DEFECTO QUE CIERRA (medido el 2026-11-08, 17:12) ────────────────────
 * La cotizacion 95691 de Solo Vidrio (5 insumos + flete) se propuso como UN
 * gasto `SIN_CATEGORIZAR` de $21,093.71: ni una botella entraba al almacen. El
 * OCR solo devolvia el total; las lineas no existian para el bot.
 *
 * ─── LO QUE EL MODELO NO DECIDE ─────────────────────────────────────────────
 * El OCR (`bot/ocr_ticket.py`) copia las lineas TAL CUAL (cantidad, descripcion,
 * precio, importe). QUE insumo es cada linea se decide AQUI, sin modelo, contra
 * el catalogo leido de la base. Lo que no empata con confianza no se adivina ni
 * se crea: se marca en el resumen y se pregunta con botones, en ese mismo
 * mensaje.
 *
 * ─── LAS REGLAS DE EMPATE (todas con prueba en tests/bot-compra-documento.spec.ts)
 *  1. QUE ES la linea lo dice su PRIMERA palabra con sentido, sin lo que va entre
 *     parentesis: "MEZCALERA 750 ML (CORCHO)" es una botella, no un corcho
 *     (Norman, 2026-11-08: "solo no trae sus corchos la de 750 ml"). Una linea
 *     que empieza con otra cosa ("CAJA PARA BOTELLA 750") NO se empata por la
 *     palabra de en medio: se pregunta.
 *  2. Botella: el volumen en ml tiene que ser el numero del insumo (50/250/750).
 *  3. Tapa: el catalogo las nombra por la BOTELLA (Tapa 50, Tapa 250) y el
 *     proveedor por la ROSCA (18-400, 28). Se resuelve, en este orden: por un
 *     numero del insumo dicho en la linea; por la rosca de una botella del MISMO
 *     documento ("ANFORA 250ML 28-350" + "TAPA ROSCA 28"); por la cantidad, si
 *     una sola botella del documento trae exactamente las mismas piezas (880
 *     tapas, 880 botellas de 50). El motivo se ENSENA en el resumen. Si nada de
 *     eso alcanza, se pregunta.
 *  4. Envio / flete / paqueteria: no entra al almacen. La compra de la web no
 *     tiene regla de flete (`lib/compra-insumos.ts`), asi que va como GASTO
 *     aparte (`Logistica y envios / Fletes`), ligado a la compra.
 *
 * ─── EL DINERO ──────────────────────────────────────────────────────────────
 * La web registra en `costoTotal` lo que SALE de la cuenta, IVA incluido: no
 * tiene campo de IVA. Aqui se hace lo mismo, repartido: cada fila lleva su
 * importe mas su parte proporcional del IVA (y del descuento), y los centavos de
 * redondeo van a la linea mas grande, de modo que las filas suman EXACTO el
 * total del documento. No es una regla contable nueva: es la de la web, partida.
 *
 * Todo aqui es PURO.
 */

import { sellar, selloEmpata } from '@/lib/bot-sello'
import { claves, limpiar, singular, VACIAS } from '@/lib/bot-entrada-insumo'
import { unidadCorta, type InsumoDeCompra } from '@/lib/bot-compra'
import { CATEGORIA_SIN_CATEGORIZAR_BOT, desactivarTextoFiscal, type CategoriaDelCatalogo } from '@/lib/bot-gastos'
import { marcaDeCompra } from '@/lib/compra-grupo'
import { fechaParaPersona, instanteDeFechaDictada } from '@/lib/fechas'

// ─── LO QUE LLEGA DEL OCR ───────────────────────────────────────────────────

export type TipoDocumento = 'ticket' | 'factura' | 'cotizacion' | 'nota' | 'remision' | 'otro'
const TIPOS: readonly TipoDocumento[] = ['ticket', 'factura', 'cotizacion', 'nota', 'remision', 'otro']

export interface LineaDocumento {
  cantidad: number | null
  descripcion: string
  precio_unitario: number | null
  importe: number | null
}

export interface DocumentoDeCompra {
  tipo_documento: TipoDocumento
  proveedor: string | null
  folio: string | null
  fecha: string | null
  lineas: LineaDocumento[]
  subtotal: number | null
  descuento: number | null
  iva: number | null
  total: number | null
  /**
   * Ronda 2 (2026-11-08): de que CAMPOS dudo el OCR. Lista cerrada
   * (`TEMAS_DE_DUDA`, la misma de `ocr_ticket.temas_de_duda`): la prosa del
   * modelo no llega a la voz del bot, igual que en el resumen del ticket.
   */
  temas_duda: string[]
  /** El documento traia texto que parece una orden (el OCR lo ignoro). */
  trae_instrucciones: boolean
}

export const TEMAS_DE_DUDA = [
  'proveedor', 'fecha', 'hora', 'subtotal', 'IVA', 'total', 'categoria', 'RFC', 'folio',
  'forma de pago', 'datos para facturar', 'otro dato'
] as const

export const TOPE_LINEAS = 40
export const TOPE_OPCIONES_LINEA = 24
export const TOLERANCIA_CUADRE = 0.05
const TOPE_TEXTO = 120

function texto(v: unknown, tope = TOPE_TEXTO): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, tope) : null
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null
}

function centavos(n: number): number {
  return Math.round(n * 100)
}

/** Lo que mando el bot -> lo que se usa. Texto recortado, numeros o null. **Pura.** */
export function normalizarDocumento(entrada: unknown): DocumentoDeCompra {
  const d = (entrada && typeof entrada === 'object' ? entrada : {}) as Record<string, unknown>
  const tipo = String(d.tipo_documento ?? '').toLowerCase() as TipoDocumento
  const lineas = (Array.isArray(d.lineas) ? d.lineas : []).slice(0, TOPE_LINEAS).map((l) => {
    const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>
    return {
      cantidad: numero(x.cantidad),
      descripcion: texto(x.descripcion) ?? '',
      precio_unitario: numero(x.precio_unitario),
      importe: numero(x.importe)
    }
  })
  return {
    tipo_documento: TIPOS.includes(tipo) ? tipo : 'otro',
    proveedor: texto(d.proveedor, 80),
    folio: texto(d.folio, 40),
    fecha: texto(d.fecha, 10),
    lineas: lineas.filter((l) => l.descripcion !== '' || l.importe !== null),
    subtotal: numero(d.subtotal),
    descuento: numero(d.descuento),
    iva: numero(d.iva),
    total: numero(d.total),
    temas_duda: [
      ...new Set(
        (Array.isArray(d.temas_duda) ? d.temas_duda : [])
          .map((x) => String(x ?? ''))
          .filter((x) => (TEMAS_DE_DUDA as readonly string[]).includes(x))
      )
    ],
    trae_instrucciones: d.trae_instrucciones === true
  }
}

// ─── QUE ES CADA LINEA ──────────────────────────────────────────────────────

export type Clase = 'botella' | 'tapa' | 'corcho' | 'etiqueta' | 'flete'

const CLASE_DE_PALABRA: Record<string, Clase> = {
  botella: 'botella', tequilera: 'botella', mezcalera: 'botella', anfora: 'botella',
  vinatera: 'botella', licorera: 'botella', frasco: 'botella', petaca: 'botella',
  tapa: 'tapa', tapon: 'tapa', taparrosca: 'tapa', casquillo: 'tapa',
  corcho: 'corcho',
  etiqueta: 'etiqueta',
  envio: 'flete', flete: 'flete', paqueteria: 'flete', guia: 'flete', transporte: 'flete',
  maniobra: 'flete', acarreo: 'flete'
}

/** La descripcion sin lo que va entre parentesis. **Pura.** */
export function sinParentesis(descripcion: string): string {
  return String(descripcion ?? '').replace(/\([^)]*\)?/g, ' ')
}

/** Las palabras con sentido (sin numeros, unidades ni vacias), en orden. */
function palabras(descripcion: string): string[] {
  return limpiar(descripcion)
    .split(' ')
    .filter((t) => t !== '' && !/^\d/.test(t) && !VACIAS.has(t) && t !== 'ml' && t.length > 1)
    .map(singular)
}

/** La PRIMERA palabra con sentido, fuera de parentesis. **Pura.** */
export function primeraPalabra(descripcion: string): string | null {
  return palabras(sinParentesis(descripcion))[0] ?? null
}

/** Regla 1: que es la linea, por su primera palabra. **Pura.** */
export function claseDeLinea(descripcion: string): Clase | null {
  const p = primeraPalabra(descripcion)
  return p ? CLASE_DE_PALABRA[p] ?? null : null
}

/** El volumen en ml dicho en la linea ("50 ML", "250ML"), o null. **Pura.** */
export function volumenMl(descripcion: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*ml\b/i.exec(sinParentesis(descripcion))
  return m ? Number(m[1].replace(',', '.')) : null
}

/** La rosca: "18-400" -> "18", "28-350" -> "28", "ROSCA 28" -> "28", "28 PP" -> "28". **Pura.** */
export function roscaDe(descripcion: string): string | null {
  const t = String(descripcion ?? '')
  const conGuion = /\b(\d{2})\s*-\s*\d{3}\b/.exec(t)
  if (conGuion) return conGuion[1]
  const rosca = /\brosca\s+(\d{2})\b/i.exec(t)
  if (rosca) return rosca[1]
  const mm = /\b(\d{2})\s*(?:mm|pp)\b/i.exec(t)
  return mm ? mm[1] : null
}

/** El corcho entre parentesis de una botella: la boca, no el corcho. **Pura.** */
export function hablaDeCorcho(descripcion: string): boolean {
  return /corcho/i.test(String(descripcion ?? ''))
}

// ─── EL EMPATE CON EL CATALOGO ──────────────────────────────────────────────

export type Empate =
  | { tipo: 'insumo'; insumo: InsumoDeCompra; razon: string }
  | { tipo: 'flete' }
  | { tipo: 'gasto' }
  | { tipo: 'desconocida'; motivo: string; opciones: InsumoDeCompra[] }

function delaClase(insumos: readonly InsumoDeCompra[], palabra: string): InsumoDeCompra[] {
  return insumos.filter((i) => claves(i.nombre).palabras.has(palabra))
}

function conNumero(insumos: readonly InsumoDeCompra[], n: number | string): InsumoDeCompra[] {
  return insumos.filter((i) => claves(i.nombre).numeros.has(String(n)))
}

function corta(descripcion: string, largo = 28): string {
  const s = String(descripcion ?? '').trim()
  return s.length <= largo ? s : s.slice(0, largo - 1) + '…'
}

interface BotellaDelDocumento {
  indice: number
  ml: number
  rosca: string | null
  cantidad: number | null
  descripcion: string
}

function empatarBotella(l: LineaDocumento, insumos: readonly InsumoDeCompra[]): Empate {
  const botellas = delaClase(insumos, 'botella')
  const ml = volumenMl(l.descripcion)
  if (ml === null) {
    return { tipo: 'desconocida', motivo: 'es botella pero no dice de cuantos ml', opciones: botellas }
  }
  const una = conNumero(botellas, ml)
  if (una.length !== 1) {
    return { tipo: 'desconocida', motivo: `no tengo botella de ${ml} ml en el catalogo`, opciones: botellas }
  }
  const razon = `${ml} ml` + (hablaDeCorcho(l.descripcion) ? '; SIN corchos (es la boca de la botella)' : '')
  return { tipo: 'insumo', insumo: una[0], razon }
}

function empatarTapa(
  indice: number,
  l: LineaDocumento,
  insumos: readonly InsumoDeCompra[],
  botellasDoc: readonly BotellaDelDocumento[],
  tapasDoc: readonly { indice: number; cantidad: number | null }[]
): Empate {
  const tapas = delaClase(insumos, 'tapa')
  if (tapas.length === 0) return { tipo: 'desconocida', motivo: 'no tengo tapas en el catalogo', opciones: [] }
  // a) un numero del insumo dicho en la linea, fuera de la rosca ("TAPA 250").
  const sinRosca = sinParentesis(l.descripcion).replace(/\b\d{2}\s*-\s*\d{3}\b/g, ' ')
  const numeros = limpiar(sinRosca).split(' ').filter((t) => /^\d+$/.test(t))
  for (const n of numeros) {
    const una = conNumero(tapas, n)
    if (una.length === 1) return { tipo: 'insumo', insumo: una[0], razon: `dice ${n}` }
  }
  // b) la rosca de una botella del mismo documento.
  const rosca = roscaDe(l.descripcion)
  if (rosca) {
    const mismas = botellasDoc.filter((b) => b.rosca === rosca)
    if (mismas.length === 1) {
      const una = conNumero(tapas, mismas[0].ml)
      if (una.length === 1) {
        return {
          tipo: 'insumo',
          insumo: una[0],
          razon: `rosca ${rosca}, la misma de la linea ${mismas[0].indice + 1} (${corta(mismas[0].descripcion)})`
        }
      }
    }
  }
  // c) la cantidad: una sola botella del documento con las mismas piezas, y
  //    ninguna otra tapa del documento con esas mismas piezas.
  if (l.cantidad !== null) {
    const mismas = botellasDoc.filter((b) => b.cantidad === l.cantidad)
    const otrasTapas = tapasDoc.filter((t) => t.indice !== indice && t.cantidad === l.cantidad)
    if (mismas.length === 1 && otrasTapas.length === 0) {
      const una = conNumero(tapas, mismas[0].ml)
      if (una.length === 1) {
        return {
          tipo: 'insumo',
          insumo: una[0],
          razon: `misma cantidad que las botellas de ${mismas[0].ml} ml (linea ${mismas[0].indice + 1})`
        }
      }
    }
  }
  return { tipo: 'desconocida', motivo: 'no se para cual botella es esta tapa', opciones: tapas }
}

function empatarGenerico(l: LineaDocumento, insumos: readonly InsumoDeCompra[], clase: Clase | null): Empate {
  const primera = primeraPalabra(l.descripcion)
  if (clase === 'corcho' || clase === 'etiqueta') {
    const deLaClase = delaClase(insumos, clase)
    const numeros = limpiar(sinParentesis(l.descripcion)).split(' ').filter((t) => /^\d+$/.test(t))
    const conNum = deLaClase.filter((i) => numeros.some((n) => claves(i.nombre).numeros.has(n)))
    if (conNum.length === 1) return { tipo: 'insumo', insumo: conNum[0], razon: 'por el nombre' }
    const sinNum = deLaClase.filter((i) => claves(i.nombre).numeros.size === 0)
    if (sinNum.length === 1 && deLaClase.length === 1) return { tipo: 'insumo', insumo: sinNum[0], razon: 'por el nombre' }
    return { tipo: 'desconocida', motivo: `no se cual ${clase} es`, opciones: deLaClase }
  }
  // Ronda 2 (auditoria 2026-11-08): fuera de las 5 clases NO hay empate
  // automatico. "CHILE RELLENO" (restaurante) se iba solo a Chile Guajillo y
  // "LUZ CONSUMO BIMESTRAL" (CFE) a Luz LED. Se PREGUNTA: primero los insumos
  // que comparten la primera palabra (si hay), y siempre el boton "Gasto".
  const candidatos = primera ? insumos.filter((i) => claves(i.nombre).palabras.has(primera)) : []
  return {
    tipo: 'desconocida',
    motivo: 'no es botella, tapa, corcho, etiqueta ni flete: dime si es un insumo o un gasto',
    opciones: candidatos
  }
}

/** Regla de cada linea contra el catalogo, con el contexto del documento. **Pura.** */
export function empatarLineas(lineas: readonly LineaDocumento[], insumos: readonly InsumoDeCompra[]): Empate[] {
  const clases = lineas.map((l) => claseDeLinea(l.descripcion))
  const botellasDoc: BotellaDelDocumento[] = []
  lineas.forEach((l, i) => {
    const ml = clases[i] === 'botella' ? volumenMl(l.descripcion) : null
    if (ml !== null) {
      botellasDoc.push({ indice: i, ml, rosca: roscaDe(l.descripcion), cantidad: l.cantidad, descripcion: l.descripcion })
    }
  })
  const tapasDoc = lineas.map((l, i) => ({ indice: i, cantidad: l.cantidad })).filter((_t, i) => clases[i] === 'tapa')
  return lineas.map((l, i) => {
    const clase = clases[i]
    if (clase === 'flete') return { tipo: 'flete' }
    if (clase === 'botella') return empatarBotella(l, insumos)
    if (clase === 'tapa') return empatarTapa(i, l, insumos, botellasDoc, tapasDoc)
    return empatarGenerico(l, insumos, clase)
  })
}

export const ELECCION_GASTO = 'gasto'

/**
 * Lo que la persona escogio con un boton para una linea: un id de insumo (de la
 * lista cerrada del catalogo) o `gasto` (no entra al almacen). **Pura.**
 */
export function aplicarElecciones(
  empates: readonly Empate[],
  elecciones: unknown,
  insumos: readonly InsumoDeCompra[]
): Empate[] {
  const mapa = (elecciones && typeof elecciones === 'object' ? elecciones : {}) as Record<string, unknown>
  return empates.map((e, i) => {
    if (e.tipo === 'flete') return e
    const elegida = mapa[String(i)]
    if (elegida === ELECCION_GASTO) return { tipo: 'gasto' }
    if (typeof elegida === 'string') {
      const insumo = insumos.find((x) => x.id === elegida)
      if (insumo) return { tipo: 'insumo', insumo, razon: 'lo escogiste tu' }
    }
    return e
  })
}

// ─── EL CUADRE ──────────────────────────────────────────────────────────────

export interface Cuadre {
  ok: boolean
  problemas: string[]
  sumaLineas: number
  /** Subtotal - descuento + IVA, o el total si no hay desglose. Lo que sale de la cuenta. */
  total: number | null
}

function pesos(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?'
  return '$' + n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * La suma de las lineas tiene que dar el subtotal del documento, cada linea su
 * cantidad por precio, y subtotal - descuento + IVA el total. Lo que no cuadra
 * se dice y NO se registra. **Pura.**
 */
export function cuadrar(doc: DocumentoDeCompra): Cuadre {
  const problemas: string[] = []
  if (doc.lineas.length === 0) problemas.push('no lei ninguna linea')
  doc.lineas.forEach((l, i) => {
    const n = i + 1
    if (l.importe === null || l.importe <= 0) problemas.push(`linea ${n}: no lei su importe`)
    if (l.cantidad === null || l.cantidad <= 0) problemas.push(`linea ${n}: no lei su cantidad`)
    if (l.importe !== null && l.cantidad !== null && l.precio_unitario !== null) {
      const esperado = l.cantidad * l.precio_unitario
      if (Math.abs(esperado - l.importe) > Math.max(TOLERANCIA_CUADRE, Math.abs(l.importe) * 0.0005)) {
        problemas.push(`linea ${n}: ${l.cantidad} x ${pesos(l.precio_unitario)} da ${pesos(esperado)}, no ${pesos(l.importe)}`)
      }
    }
  })
  const sumaLineas = centavos(doc.lineas.reduce((s, l) => s + (l.importe ?? 0), 0)) / 100
  const subtotal = doc.subtotal ?? (doc.total !== null && doc.iva === null && !doc.descuento ? doc.total : null)
  if (subtotal === null) {
    problemas.push('no lei el subtotal del documento')
  } else if (Math.abs(sumaLineas - subtotal) > TOLERANCIA_CUADRE) {
    problemas.push(`la suma de las lineas da ${pesos(sumaLineas)} y el subtotal dice ${pesos(subtotal)}`)
  }
  let total: number | null = null
  if (subtotal !== null) {
    const calculado = centavos(subtotal - (doc.descuento ?? 0) + (doc.iva ?? 0)) / 100
    if (doc.total === null) {
      problemas.push('no lei el total del documento')
    } else if (Math.abs(calculado - doc.total) > TOLERANCIA_CUADRE) {
      problemas.push(`subtotal - descuento + IVA da ${pesos(calculado)} y el total dice ${pesos(doc.total)}`)
    } else {
      total = doc.total
    }
  }
  return { ok: problemas.length === 0, problemas, sumaLineas, total }
}

/**
 * Reparte `total` entre los importes en proporcion, al centavo, y los centavos
 * de redondeo los absorbe el importe mas grande: la suma da EXACTO el total.
 * **Pura.**
 */
export function prorratear(importes: readonly number[], total: number): number[] {
  const suma = importes.reduce((s, x) => s + x, 0)
  if (importes.length === 0 || !(suma > 0)) return importes.map(() => 0)
  const metaC = centavos(total)
  const partes = importes.map((x) => centavos((x * total) / suma))
  const diferencia = metaC - partes.reduce((s, x) => s + x, 0)
  let mayor = 0
  importes.forEach((x, i) => {
    if (x > importes[mayor]) mayor = i
  })
  partes[mayor] += diferencia
  return partes.map((c) => c / 100)
}

// ─── EL PLAN Y EL BORRADOR ──────────────────────────────────────────────────

export interface Pregunta {
  indice: number
  descripcion: string
  motivo: string
  opciones: { id: string; nombre: string }[]
}

export interface PlanDeCompra {
  doc: DocumentoDeCompra
  empates: Empate[]
  cuadre: Cuadre
  preguntas: Pregunta[]
  /** Hay al menos una linea que entra al almacen (o que se pregunta como insumo). */
  esCompraDeInsumos: boolean
  /** Cuadra, no queda nada por preguntar y las piezas son enteras: se puede registrar. */
  listo: boolean
  avisos: string[]
}

export function planearCompra(
  doc: DocumentoDeCompra,
  insumos: readonly InsumoDeCompra[],
  elecciones?: unknown
): PlanDeCompra {
  const crudos = empatarLineas(doc.lineas, insumos)
  const empates = aplicarElecciones(crudos, elecciones, insumos)
  const cuadre = cuadrar(doc)
  const avisos: string[] = []
  empates.forEach((e, i) => {
    if (e.tipo !== 'insumo') return
    const l = doc.lineas[i]
    const u = String(e.insumo.unidad_medida ?? '').toUpperCase()
    if (u === 'PIEZAS' && l.cantidad !== null && !Number.isInteger(l.cantidad)) {
      empates[i] = {
        tipo: 'desconocida',
        motivo: `${l.cantidad} no es un numero entero de piezas`,
        opciones: [e.insumo]
      }
    } else if (u !== 'PIEZAS') {
      avisos.push(`linea ${i + 1}: tome ${l.cantidad} tal cual, en ${unidadCorta(e.insumo.unidad_medida)} de ${e.insumo.nombre}.`)
    }
  })
  const preguntas: Pregunta[] = []
  empates.forEach((e, i) => {
    if (e.tipo === 'desconocida') {
      preguntas.push({
        indice: i,
        descripcion: doc.lineas[i].descripcion,
        motivo: e.motivo,
        // Sin candidatos de su clase, la lista entera: escoger es mejor que adivinar.
        opciones: (e.opciones.length ? e.opciones : insumos).slice(0, TOPE_OPCIONES_LINEA).map((o) => ({ id: o.id, nombre: o.nombre }))
      })
    }
  })
  // Ronda 2: entra al flujo de compra SOLO si alguna linea es de una clase de
  // insumo (botella, tapa, corcho, etiqueta). Un ticket de fonda o de la CFE se
  // va al gasto de siempre. Y si, ya contestadas las preguntas, NINGUNA linea
  // entra al almacen (todo "Gasto": "BOTELLA AGUA 1L", "TAPA DE REGISTRO"), no
  // es compra de insumos: tambien el gasto de siempre, nunca un resumen sin botones.
  const conClase = doc.lineas.some((l) => {
    const c = claseDeLinea(l.descripcion)
    return c !== null && c !== 'flete'
  })
  const todoAcaboEnGasto = preguntas.length === 0 && !empates.some((e) => e.tipo === 'insumo')
  // Ronda 3: si NO cuadra y ninguna linea empato SOLA como insumo (OXXO "BOTELLA
  // AGUA 1L" sin subtotal), no hay compra que defender: el gasto de siempre, como
  // antes de la rama. Con insumos empatados se queda el "NO CUADRA, no lo registro".
  const empatoSola = empates.some((e, i) => e.tipo === 'insumo' && crudos[i].tipo === 'insumo')
  const noCuadraSinInsumos = !cuadre.ok && !empatoSola
  const esCompraDeInsumos = conClase && !todoAcaboEnGasto && !noCuadraSinInsumos
  return {
    doc,
    empates,
    cuadre,
    preguntas,
    esCompraDeInsumos,
    listo: cuadre.ok && preguntas.length === 0 && empates.some((e) => e.tipo === 'insumo'),
    avisos
  }
}

export interface LineaSellada {
  indice: number
  id_inventario: string
  id_finanzas: string
  id_insumo: string
  insumo: string
  unidad: string
  cantidad: number
  importe: number
  costo_total: number
  descripcion: string
  notas: string
}

export interface GastoSellado {
  indice: number
  id_finanzas: string
  clase: 'flete' | 'gasto'
  categoria: string
  subcategoria: string | null
  importe: number
  monto: number
  descripcion: string
}

export interface PayloadCompraDocumento {
  id_grupo: string
  marca: string
  id_entidad: string
  usuario_creador: string
  fecha_movimiento: string
  tipo_documento: TipoDocumento
  proveedor: string | null
  folio: string | null
  subtotal: number
  descuento: number
  iva: number
  total: number
  lineas: LineaSellada[]
  gastos: GastoSellado[]
  /** Las cuentas que se ensenaron como botones: el clic solo puede escoger de aqui. */
  cuentas: string[]
}

export const LLAVES_COMPRA_DOCUMENTO = [
  'cuentas',
  'descuento',
  'fecha_movimiento',
  'folio',
  'gastos',
  'id_entidad',
  'id_grupo',
  'iva',
  'lineas',
  'marca',
  'proveedor',
  'subtotal',
  'tipo_documento',
  'total',
  'usuario_creador'
] as const

export function sellarCompraDocumento(p: PayloadCompraDocumento): string {
  return sellar(p, LLAVES_COMPRA_DOCUMENTO)
}

export function selloCompraDocumentoCoincide(p: PayloadCompraDocumento, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_COMPRA_DOCUMENTO, sello)
}

const NOMBRE_DOC: Record<TipoDocumento, string> = {
  ticket: 'ticket',
  factura: 'factura',
  cotizacion: 'cotizacion',
  nota: 'nota',
  remision: 'remision',
  otro: 'documento'
}

/** La pareja de flete del catalogo vivo (`Logistica y envios / Fletes`), o SIN_CATEGORIZAR. **Pura.** */
export function categoriaDeFlete(catalogo: readonly CategoriaDelCatalogo[]): { categoria: string; subcategoria: string | null } {
  const norm = (s: unknown) => limpiar(String(s ?? ''))
  const pareja =
    catalogo.find((c) => norm(c.subcategoria) === 'fletes' || norm(c.subcategoria) === 'flete') ??
    catalogo.find((c) => norm(c.categoria).startsWith('logistica') && /envio/.test(norm(c.subcategoria)))
  if (pareja?.categoria) return { categoria: pareja.categoria, subcategoria: pareja.subcategoria ?? null }
  return { categoria: CATEGORIA_SIN_CATEGORIZAR_BOT, subcategoria: null }
}

/**
 * Ronda 2: la fecha con que se escribe. Una COTIZACION se da por pagada al
 * tocar la cuenta: su fecha es la del clic (ahora), no la del papel. Factura,
 * nota, ticket: la del documento (con las reglas de `instanteDeFechaDictada`).
 * **Pura.**
 */
export function fechaDelMovimiento(doc: Pick<DocumentoDeCompra, 'tipo_documento' | 'fecha'>, ahora: Date): string {
  if (doc.tipo_documento === 'cotizacion') return ahora.toISOString()
  return (instanteDeFechaDictada(doc.fecha, ahora)?.instante ?? ahora).toISOString()
}

/** "2026-11-02" -> "11/02/2026" si el dia tambien puede ser mes; si no, null. **Pura.** */
export function fechaAlReves(fecha: string | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(fecha ?? ''))
  if (!m) return null
  const [, y, mes, dia] = m
  if (Number(dia) > 12 || dia === mes) return null
  return `${mes}/${dia}/${y}`
}

function referencia(doc: Pick<DocumentoDeCompra, 'tipo_documento' | 'folio' | 'proveedor'>): string {
  const partes = [NOMBRE_DOC[doc.tipo_documento] + (doc.folio ? ' ' + doc.folio : '')]
  if (doc.proveedor) partes.push(doc.proveedor)
  return desactivarTextoFiscal(partes.join(' de '))
}

/**
 * El borrador sellado. Los ids de las filas nacen AQUI (`nuevoId`): un segundo
 * clic choca con la llave primaria y no duplica (como el traspaso). **Pura.**
 */
export function payloadDeCompraDocumento(
  plan: PlanDeCompra,
  ctx: {
    idGrupo: string
    nuevoId: () => string
    idEntidad: string
    usuarioCreador: string
    fechaMovimiento: string
    flete: { categoria: string; subcategoria: string | null }
    cuentas: readonly string[]
  }
): PayloadCompraDocumento {
  const { doc, empates } = plan
  const total = plan.cuadre.total ?? 0
  const importes = doc.lineas.map((l) => l.importe ?? 0)
  const montos = prorratear(importes, total)
  const nEntradas = empates.filter((e) => e.tipo === 'insumo').length
  const nDinero = empates.filter((e) => e.tipo === 'insumo' || e.tipo === 'flete' || e.tipo === 'gasto').length
  const marca = marcaDeCompra(ctx.idGrupo, nEntradas, nDinero)
  const ref = referencia(doc)
  const lineas: LineaSellada[] = []
  const gastos: GastoSellado[] = []
  empates.forEach((e, i) => {
    const l = doc.lineas[i]
    const original = desactivarTextoFiscal(l.descripcion)
    if (e.tipo === 'insumo') {
      const unidad = unidadCorta(e.insumo.unidad_medida)
      lineas.push({
        indice: i,
        id_inventario: ctx.nuevoId(),
        id_finanzas: ctx.nuevoId(),
        id_insumo: e.insumo.id,
        insumo: e.insumo.nombre,
        unidad,
        cantidad: Number(l.cantidad),
        importe: Number(l.importe),
        costo_total: montos[i],
        descripcion: `${e.insumo.nombre}: ${l.cantidad} ${unidad} - ${ref} [${marca}]`.slice(0, 300),
        notas: `${marca} | ${ref}, linea ${i + 1}: ${original}`.slice(0, 300)
      })
    } else if (e.tipo === 'flete' || e.tipo === 'gasto') {
      const cat = e.tipo === 'flete' ? ctx.flete : { categoria: CATEGORIA_SIN_CATEGORIZAR_BOT, subcategoria: null }
      gastos.push({
        indice: i,
        id_finanzas: ctx.nuevoId(),
        clase: e.tipo,
        categoria: cat.categoria,
        subcategoria: cat.subcategoria,
        importe: Number(l.importe),
        monto: montos[i],
        descripcion: `${e.tipo === 'flete' ? 'Flete' : 'Gasto'}: ${original} - ${ref} [${marca}]`.slice(0, 300)
      })
    }
  })
  return {
    id_grupo: ctx.idGrupo,
    marca,
    id_entidad: ctx.idEntidad,
    usuario_creador: ctx.usuarioCreador,
    fecha_movimiento: ctx.fechaMovimiento,
    tipo_documento: doc.tipo_documento,
    proveedor: doc.proveedor,
    folio: doc.folio,
    subtotal: doc.subtotal ?? plan.cuadre.sumaLineas,
    descuento: doc.descuento ?? 0,
    iva: doc.iva ?? 0,
    total,
    lineas,
    gastos,
    cuentas: [...ctx.cuentas]
  }
}

function num(n: number | null): string {
  if (n === null) return '?'
  return Number.isInteger(n) ? n.toLocaleString('es-MX') : String(n)
}

export const PIE_CUENTA =
  'De que cuenta salio el dinero? Toca la cuenta y lo registro TODO junto (dinero + almacen); ' +
  'si despues lo anulas, se anula todo junto.'

/**
 * El UNICO resumen que ve la persona. Las frases son del codigo; las
 * descripciones de las lineas son texto del proveedor, copiado. **Pura.**
 */
export function mensajeDeCompraDocumento(
  plan: PlanDeCompra,
  ctx: { nombreEntidad: string; fechaMovimiento: string; flete: { categoria: string; subcategoria: string | null } }
): string {
  const { doc, empates, cuadre } = plan
  const total = cuadre.total
  const montos = total !== null ? prorratear(doc.lineas.map((l) => l.importe ?? 0), total) : doc.lineas.map(() => null)
  const encabezado =
    `${NOMBRE_DOC[doc.tipo_documento].toUpperCase()}${doc.folio ? ' ' + doc.folio : ''}` +
    `${doc.proveedor ? ' de ' + doc.proveedor : ''} (${fechaParaPersona(doc.fecha ?? ctx.fechaMovimiento)})`
  const r: string[] = [encabezado]
  const esCotizacion = doc.tipo_documento === 'cotizacion'
  if (esCotizacion) {
    r.push('OJO: es una COTIZACION. Si tocas una cuenta, la doy por PAGADA y la registro.')
    r.push('Fecha del movimiento: la del clic (hoy), no la de la cotizacion.')
  } else if (doc.fecha && fechaParaPersona(doc.fecha) !== fechaParaPersona(ctx.fechaMovimiento)) {
    r.push(`Fecha del movimiento: ${fechaParaPersona(ctx.fechaMovimiento)}.`)
  }
  // Ronda 3: la categoria no aplica a una compra de insumos (las filas son
  // `Insumos` y el flete `Fletes`): esa duda aqui es ruido.
  const temas = doc.temas_duda.filter((t) => t !== 'categoria')
  if (temas.length) {
    r.push('No estoy seguro de: ' + temas.join(', ') + '.')
    const alReves = temas.includes('fecha') ? fechaAlReves(doc.fecha) : null
    if (alReves) {
      r.push(
        `La fecha ${fechaParaPersona(doc.fecha)} tambien se puede leer como ${alReves}; tome ${fechaParaPersona(doc.fecha)}` +
          (esCotizacion ? ' (no cambia nada: va con la fecha del clic).' : '. Si es la otra, cancela y dictala.')
      )
    }
  }
  if (doc.trae_instrucciones) {
    r.push('OJO: el documento trae texto que parece una orden. Lo ignore: solo lei la compra, y nada se escribe sin tu clic.')
  }
  const almacen: string[] = []
  const aparte: string[] = []
  const dudas: string[] = []
  empates.forEach((e, i) => {
    const l = doc.lineas[i]
    const n = i + 1
    const conIva = montos[i] !== null ? ` (con IVA ${pesos(montos[i])})` : ''
    if (e.tipo === 'insumo') {
      almacen.push(
        `${n}. ${num(l.cantidad)} ${unidadCorta(e.insumo.unidad_medida)} ${e.insumo.nombre} - ${pesos(l.importe)}${conIva}`,
        `    "${l.descripcion}" -> ${e.razon}`
      )
    } else if (e.tipo === 'flete') {
      aparte.push(
        `${n}. Flete: "${l.descripcion}" - ${pesos(l.importe)}${conIva}`,
        `    gasto ${ctx.flete.categoria}${ctx.flete.subcategoria ? ' / ' + ctx.flete.subcategoria : ''}, no entra al almacen`
      )
    } else if (e.tipo === 'gasto') {
      aparte.push(`${n}. Gasto: "${l.descripcion}" - ${pesos(l.importe)}${conIva}`, '    lo escogiste como gasto: no entra al almacen')
    } else {
      dudas.push(`${n}. ?? "${l.descripcion}" (${num(l.cantidad)}, ${pesos(l.importe)}): ${e.motivo}`)
    }
  })
  if (almacen.length) r.push('', `Entra al almacen de ${ctx.nombreEntidad}:`, ...almacen)
  if (aparte.length) r.push('', 'Gasto aparte, ligado a esta compra:', ...aparte)
  // Ronda 3: si no cuadra no hay botones de linea; no se listan preguntas sin boton.
  if (dudas.length && cuadre.ok) r.push('', 'NO SE QUE ES (escoge abajo, una por una):', ...dudas)

  const piezas = new Map<string, { cantidad: number; unidad: string }>()
  empates.forEach((e, i) => {
    if (e.tipo !== 'insumo') return
    const previo = piezas.get(e.insumo.nombre) ?? { cantidad: 0, unidad: unidadCorta(e.insumo.unidad_medida) }
    previo.cantidad += Number(doc.lineas[i].cantidad ?? 0)
    piezas.set(e.insumo.nombre, previo)
  })
  if (piezas.size) {
    r.push('', 'Piezas por insumo:')
    for (const [nombre, p] of piezas) r.push(`- ${nombre}: ${num(p.cantidad)} ${p.unidad}`)
  }

  r.push('', `Suma de lineas: ${pesos(cuadre.sumaLineas)} | Subtotal: ${pesos(doc.subtotal)}`)
  if (doc.descuento) r.push(`Descuento: ${pesos(doc.descuento)}`)
  r.push(`IVA: ${pesos(doc.iva)} | TOTAL: ${pesos(doc.total)}`)
  if (!cuadre.ok) {
    r.push('', 'NO CUADRA, asi que NO lo registro:', ...cuadre.problemas.map((p) => '- ' + p))
    r.push('', 'Revisa la foto (o mandala mas clara) y vuelve a mandarla.')
    return r.join('\n')
  }
  r.push(
    'Cuadra. Cada fila lleva su parte del IVA: como en la web, el costo es lo que sale de la cuenta.',
    `Sale de la cuenta: ${pesos(total)}.`
  )
  for (const a of plan.avisos) r.push('', 'OJO: ' + a)
  if (plan.preguntas.length) {
    r.push('', 'Antes de la cuenta, dime que es cada linea marcada con ?? (botones abajo).')
  } else {
    r.push('', PIE_CUENTA)
  }
  return r.join('\n')
}

