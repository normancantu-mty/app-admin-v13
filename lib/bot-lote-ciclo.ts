/**
 * Lote v2 — EL CICLO DEL LOTE POR ETAPAS. La logica pura del lado del ERP.
 *
 * Escrito el 2026-10-19 por el ejecutor del Socio (lote v2).
 *
 * El dia de produccion sigue siendo el lote de siempre (`lib/bot-lotes.ts`, con
 * Brix). Lo que viene despues son ETAPAS de un lote que ya existe:
 *
 *   · `aditivo_2`   — el aditivo 2 (SKU opaco, ERP-84) -> `lote_entradas`, en la
 *                     unidad del CATALOGO (Fase 7A: GRAMOS desde 2026-11-07;
 *                     lo dicho en kg o g se convierte, nada mas se adivina).
 *   · `destilacion` — una fila de `lote_salidas` por GARRAFA, con peso (kg) y %
 *                     de alcohol; `litros` va NULL (no hay densidad medida y no
 *                     se inventa una).
 *   · `fin_fermentacion` — Fase 7B (2026-11-07): la fecha en que termino la
 *                     fermentacion (y sus horas, si las dicen). Escribe la
 *                     CABECERA (`lotes.fecha_fin_fermentacion` /
 *                     `horas_fermentacion`), lo mismo que edita la web en
 *                     `guardarLoteAction`; NO va a `lote_etapas` (su CHECK solo
 *                     admite aditivo_2, destilacion y muestra) ni a
 *                     `registrar_etapa_lote`.
 *   · `muestra`     — quien guardo la muestra y cuando. Sin VA: es una
 *                     constancia, no mueve ni una cifra.
 *
 * `aditivo_2` y `destilacion` siguen el patron de siempre: proponer -> sello ->
 * confirmar, con la puerta de aprobacion (lo del TRABAJADOR espera el Aprobar).
 * La escritura es UNA funcion SQL (`registrar_etapa_lote`), todo o nada.
 */

import { canonizar, sellar, selloEmpata } from '@/lib/bot-sello'
import { convertirMasa, unidadCorta } from '@/lib/bot-compra'
import { fechaLocal, fechaParaPersona } from '@/lib/fechas'
import { TOPE_HORAS_FERMENTACION } from '@/lib/bot-lotes'

export const ETAPAS_CON_VA = ['aditivo_2', 'destilacion', 'fin_fermentacion'] as const
export type EtapaConVa = (typeof ETAPAS_CON_VA)[number]
export const TIPOS_RECORDATORIO = ['aditivo_2', 'destilar', 'muestra', 'muestra_2'] as const
export type TipoRecordatorio = (typeof TIPOS_RECORDATORIO)[number]
// Ronda 6: solo Open-Meteo (Norman 2026-10-19: la gente no dicta temperatura).
export const FUENTES_TEMPERATURA = ['open-meteo exterior'] as const

/** Topes DUROS del servidor ("esto no se dicta por chat"). Los rangos que solo AVISAN viven en el YAML del bot. */
export const TOPE_GARRAFAS = 50
export const TOPE_PESO_GARRAFA_KG = 1000
export const TOPE_KG_ADITIVO = 100000
export const GRADO_MAXIMO = 100

export interface EntradaEtapa {
  id_insumo: string
  cantidad: number
}

export interface GarrafaEtapa {
  numero: number
  peso_kg: number
  grado_alcohol: number
}

export interface PayloadEtapa {
  id_lote: string
  codigo_lote: string
  etapa: EtapaConVa
  fecha: string
  telegram_id: number
  usuario_creador: string
  entradas: EntradaEtapa[]
  garrafas: GarrafaEtapa[]
  /**
   * Fase 7A: la unidad corta de `entradas[].cantidad` ('g', 'kg'), la del
   * catalogo. OPCIONAL por la misma razon que `notas`.
   */
  unidad_entrada?: string
  /** Fase 7B, solo `fin_fermentacion`: las horas dichas. OPCIONAL (sellada si viene). */
  horas_fermentacion?: number
  /**
   * Ronda 5: lo que no es de la etapa y se dijo (p. ej. una temperatura: la
   * gente no la dicta, sale de Open-Meteo). OPCIONAL: `canonizar` omite la
   * llave ausente, asi que un borrador sin notas sella igual que antes.
   */
  notas?: string
}

/** El orden es parte del sello. Ver `lib/bot-sello.ts`. */
export const LLAVES_ETAPA = [
  'codigo_lote',
  'entradas',
  'etapa',
  'fecha',
  'garrafas',
  'horas_fermentacion',
  'id_lote',
  'notas',
  'telegram_id',
  'usuario_creador'
] as const

export function etapaCanonica(p: PayloadEtapa): string {
  return canonizar(p, LLAVES_ETAPA)
}
export function sellarEtapa(p: PayloadEtapa): string {
  return sellar(p, LLAVES_ETAPA)
}
export function selloEtapaCoincide(p: PayloadEtapa, sello: unknown): boolean {
  return selloEmpata(p, LLAVES_ETAPA, sello)
}

export function esEtapaConVa(v: unknown): v is EtapaConVa {
  return typeof v === 'string' && (ETAPAS_CON_VA as readonly string[]).includes(v)
}
export function esTipoRecordatorio(v: unknown): v is TipoRecordatorio {
  return typeof v === 'string' && (TIPOS_RECORDATORIO as readonly string[]).includes(v)
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export interface PedidoEtapa {
  etapa: unknown
  /** Lo dicho del aditivo 2. `cantidad` + `unidad` ('kg'|'g'); `kg` es el campo viejo (= cantidad en kg). */
  cantidad?: unknown
  unidad?: unknown
  kg?: unknown
  /** Solo `fin_fermentacion`: 'YYYY-MM-DD' (hoy si no viene) y horas opcionales. */
  fecha?: unknown
  horas?: unknown
  garrafas?: unknown
  notas?: unknown
}

export interface ContextoEtapa {
  idLote: string
  codigoLote: string
  fechaInicio: string
  telegramId: number
  etiqueta: string
  ahora: Date
  /** El insumo del aditivo 2 ya resuelto por SKU (solo para `aditivo_2`). */
  idInsumoAditivo?: string | null
  /** Su `unidad_medida` del catalogo. Sin ella se asume KILOGRAMOS (lo de antes de la Fase 7A). */
  unidadAditivo?: string | null
  /** Solo `fin_fermentacion`: la fecha de fin que el lote YA tiene (no se pisa desde el chat). */
  finActual?: string | null
}

export type ResultadoEtapa =
  | { ok: true; payload: PayloadEtapa }
  | { ok: false; error: string }

/**
 * Lo pedido por el bot -> las filas exactas que escribe `registrar_etapa_lote`.
 * Topes duros aqui; los rangos "fuera de lo normal" ya los aviso el bot sin
 * bloquear (Brix, % alcohol, peso de garrafa, kilos de aditivo: YAML).
 */
export function normalizarEtapa(pedido: PedidoEtapa, ctx: ContextoEtapa): ResultadoEtapa {
  if (!esEtapaConVa(pedido.etapa)) return { ok: false, error: 'No se que etapa es esa.' }
  if (pedido.etapa === 'fin_fermentacion') return normalizarFin(pedido, ctx)
  const fecha = fechaLocal(ctx.ahora)
  if (fecha < ctx.fechaInicio) {
    return { ok: false, error: `El lote ${ctx.codigoLote} arranca despues de hoy. No lo escribo.` }
  }
  const base = {
    id_lote: ctx.idLote,
    codigo_lote: ctx.codigoLote,
    etapa: pedido.etapa,
    fecha,
    telegram_id: ctx.telegramId,
    usuario_creador: `telegram:${ctx.etiqueta}`,
    ...(String(pedido.notas ?? '').trim() !== '' ? { notas: String(pedido.notas).trim().slice(0, 500) } : {})
  }
  if (pedido.etapa === 'aditivo_2') {
    const conCantidad = pedido.cantidad !== undefined && pedido.cantidad !== null && pedido.cantidad !== ''
    const valor = numero(conCantidad ? pedido.cantidad : pedido.kg)
    const dicha = conCantidad ? String(pedido.unidad ?? '').trim().toLowerCase() : 'kg'
    if (valor === null || valor <= 0) return { ok: false, error: 'No entendi cuanto aditivo 2 le pusieron.' }
    if (dicha !== 'kg' && dicha !== 'g') {
      return { ok: false, error: 'Dime si el aditivo 2 fue en gramos o en kilos (por ejemplo "800 g" o "1.5 kg").' }
    }
    const kgEquivalentes = dicha === 'g' ? valor / 1000 : valor
    if (kgEquivalentes > TOPE_KG_ADITIVO) return { ok: false, error: `${valor} ${dicha} de aditivo es demasiado. Revisalo.` }
    if (!ctx.idInsumoAditivo) return { ok: false, error: 'No encontre el insumo del aditivo 2 en el catalogo.' }
    const unidadCatalogo = ctx.unidadAditivo ?? 'KILOGRAMOS'
    const conv = convertirMasa(valor, dicha, unidadCatalogo)
    if (!conv.ok) return { ok: false, error: `No lo convierto: ${conv.motivo}.` }
    return {
      ok: true,
      payload: {
        ...base,
        entradas: [{ id_insumo: ctx.idInsumoAditivo, cantidad: conv.cantidad }],
        garrafas: [],
        unidad_entrada: unidadCorta(unidadCatalogo)
      }
    }
  }
  const crudas = Array.isArray(pedido.garrafas) ? pedido.garrafas : []
  if (crudas.length === 0) return { ok: false, error: 'No oi ninguna garrafa.' }
  if (crudas.length > TOPE_GARRAFAS) return { ok: false, error: `${crudas.length} garrafas es demasiado para el chat.` }
  const garrafas: GarrafaEtapa[] = []
  for (let i = 0; i < crudas.length; i++) {
    const g = (crudas[i] ?? {}) as Record<string, unknown>
    const peso = numero(g.peso_kg)
    const grado = numero(g.grado_alcohol ?? g.grado)
    if (peso === null || peso <= 0) return { ok: false, error: `No entendi el peso de la garrafa ${i + 1}.` }
    if (peso > TOPE_PESO_GARRAFA_KG) return { ok: false, error: `${peso} kg en una garrafa no me cuadra. Revisalo.` }
    if (grado === null || grado < 0 || grado > GRADO_MAXIMO) {
      return { ok: false, error: `No entendi el % de alcohol de la garrafa ${i + 1}.` }
    }
    garrafas.push({ numero: i + 1, peso_kg: Number(peso.toFixed(3)), grado_alcohol: Number(grado.toFixed(2)) })
  }
  return { ok: true, payload: { ...base, entradas: [], garrafas } }
}

/** Fase 7B: el fin de la fermentacion -> la fecha y las horas que van a la cabecera. */
function normalizarFin(pedido: PedidoEtapa, ctx: ContextoEtapa): ResultadoEtapa {
  const hoy = fechaLocal(ctx.ahora)
  if (ctx.finActual) {
    return {
      ok: false,
      error: `El lote ${ctx.codigoLote} ya tiene fin de fermentacion (${fechaParaPersona(ctx.finActual)}). Si hay que corregirlo, es en la web: Lotes > editar.`
    }
  }
  const dicha = String(pedido.fecha ?? '').trim()
  if (dicha !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dicha)) return { ok: false, error: 'No entendi la fecha del fin de la fermentacion.' }
  const fecha = dicha || hoy
  if (fecha > hoy) return { ok: false, error: 'Esa fecha de fin es en el futuro. No la escribo.' }
  if (fecha < ctx.fechaInicio) {
    return { ok: false, error: `El fin no puede ser antes del inicio del lote ${ctx.codigoLote} (${fechaParaPersona(ctx.fechaInicio)}).` }
  }
  const horas = numero(pedido.horas)
  if (horas !== null && (horas <= 0 || horas > TOPE_HORAS_FERMENTACION)) {
    return { ok: false, error: 'No entendi cuantas horas de fermentacion.' }
  }
  return {
    ok: true,
    payload: {
      id_lote: ctx.idLote,
      codigo_lote: ctx.codigoLote,
      etapa: 'fin_fermentacion',
      fecha,
      telegram_id: ctx.telegramId,
      usuario_creador: `telegram:${ctx.etiqueta}`,
      entradas: [],
      garrafas: [],
      ...(horas !== null ? { horas_fermentacion: Number(horas.toFixed(2)) } : {}),
      ...(String(pedido.notas ?? '').trim() !== '' ? { notas: String(pedido.notas).trim().slice(0, 500) } : {})
    }
  }
}

const NOMBRE_ETAPA: Record<EtapaConVa, string> = {
  aditivo_2: 'ADITIVO 2',
  destilacion: 'DESTILACION',
  fin_fermentacion: 'FIN DE FERMENTACION'
}

function corto(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/** Lo que el servidor devuelve como `mensaje` de la propuesta (el bot ensena el suyo). */
export function mensajeDeEtapa(p: PayloadEtapa, fechaInicio?: string): string {
  const lineas = [`LOTE ${p.codigo_lote} — ${NOMBRE_ETAPA[p.etapa]}`, `Fecha: ${fechaParaPersona(p.fecha)}`]
  if (p.etapa === 'fin_fermentacion' && fechaInicio) {
    lineas.push(`Fermento ${diasEntre(fechaInicio, p.fecha)} dia(s): del ${fechaParaPersona(fechaInicio)} al ${fechaParaPersona(p.fecha)}`)
  }
  if (p.horas_fermentacion !== undefined) lineas.push(`Horas de fermentacion: ${corto(p.horas_fermentacion)}`)
  for (const e of p.entradas) {
    lineas.push(p.unidad_entrada ? `Aditivo 2: ${corto(e.cantidad)} ${p.unidad_entrada}` : `Kilos de aditivo 2: ${corto(e.cantidad)}`)
  }
  if (p.garrafas.length) lineas.push(`Garrafas: ${p.garrafas.length}`)
  for (const g of p.garrafas) lineas.push(`   Garrafa ${g.numero}: ${corto(g.peso_kg)} kg a ${corto(g.grado_alcohol)}%`)
  if (p.notas) lineas.push(`Notas: ${p.notas}`)
  return lineas.join('\n')
}

// ============================================================================
// LA TEMPERATURA DE LA FERMENTACION
// ============================================================================

export interface DiaTemperatura {
  fecha: string
  fuente: string
  t_min: number
  t_max: number
  t_prom: number
}

export interface ResumenTemperatura {
  fuente: string
  dias_con_dato: number
  min: number
  max: number
  prom: number
}

/** Dias de calendario entre dos `AAAA-MM-DD` (fin - inicio). */
export function diasEntre(inicio: string, fin: string): number {
  const a = Date.UTC(+inicio.slice(0, 4), +inicio.slice(5, 7) - 1, +inicio.slice(8, 10))
  const b = Date.UTC(+fin.slice(0, 4), +fin.slice(5, 7) - 1, +fin.slice(8, 10))
  return Math.round((b - a) / 86400000)
}

/**
 * Min de los minimos, max de los maximos y promedio de los promedios diarios
 * del periodo [desde, hasta], por fuente. Lo que no tiene dato no cuenta (y se
 * dice cuantos dias SI tienen).
 */
export function resumenTemperatura(dias: readonly DiaTemperatura[], desde: string, hasta: string): ResumenTemperatura[] {
  const porFuente = new Map<string, DiaTemperatura[]>()
  for (const d of dias) {
    if (d.fecha < desde || d.fecha > hasta) continue
    porFuente.set(d.fuente, [...(porFuente.get(d.fuente) ?? []), d])
  }
  return [...porFuente.entries()].map(([fuente, ds]) => ({
    fuente,
    dias_con_dato: ds.length,
    min: Math.min(...ds.map((d) => Number(d.t_min))),
    max: Math.max(...ds.map((d) => Number(d.t_max))),
    prom: Number((ds.reduce((a, d) => a + Number(d.t_prom), 0) / ds.length).toFixed(1))
  }))
}

export function mensajeDeFermentacion(
  fechaInicio: string,
  fechaFin: string,
  resumen: readonly ResumenTemperatura[]
): string {
  const n = diasEntre(fechaInicio, fechaFin)
  const lineas = [`Fermentacion: ${n} dia${n === 1 ? '' : 's'} (${fechaParaPersona(fechaInicio)} a ${fechaParaPersona(fechaFin)}).`]
  if (resumen.length === 0) lineas.push('Temperatura: todavia sin dato (queda pendiente).')
  for (const r of resumen) {
    lineas.push(`Temperatura ${r.fuente}: min ${r.min}, max ${r.max}, promedio ${r.prom} C (${r.dias_con_dato} dia${r.dias_con_dato === 1 ? '' : 's'} con dato).`)
  }
  return lineas.join('\n')
}

/** Valida un dia de temperatura que manda el bot. `null` si no sirve. */
export function diaDeTemperatura(v: unknown): (DiaTemperatura & { latitud: number | null; longitud: number | null }) | null {
  const d = (v ?? {}) as Record<string, unknown>
  const fecha = String(d.fecha ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null
  const fuente = String(d.fuente ?? '')
  if (!(FUENTES_TEMPERATURA as readonly string[]).includes(fuente)) return null
  const t_min = numero(d.t_min), t_max = numero(d.t_max), t_prom = numero(d.t_prom)
  if (t_min === null || t_max === null || t_prom === null) return null
  if (!(t_min <= t_prom && t_prom <= t_max) || t_min < -60 || t_max > 70) return null
  return { fecha, fuente, t_min, t_max, t_prom, latitud: numero(d.latitud), longitud: numero(d.longitud) }
}
