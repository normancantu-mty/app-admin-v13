/**
 * PREGUNTAS DE LOTES DESDE EL BOT — el lado puro (Fase 7B, 2026-11-07).
 *
 * Escrito el 2026-11-07 por el ejecutor del Socio (bot con paridad de la web,
 * Fase 7B). Sin red ni base: se prueba en `tests/bot-pregunta-lote.spec.ts` y,
 * de punta a punta, en `tests/bot-lote-trazabilidad.spec.ts`.
 *
 * Igual que `lib/bot-pregunta.ts`: **aqui no hay modelo**. El texto se compara
 * contra palabras fijas y un codigo de lote; las cifras salen de la base.
 *
 *  - `trazabilidad_lote`  "trazabilidad del lote L-12-10.1" -> la linea de tiempo entera
 *  - `etapa_lote`         "en que etapa va el lote L-12-10.1"
 *  - `lotes_abiertos`     "lotes abiertos" (= sin destilar)
 *  - `produccion_mes`     "cuanto se produjo este mes"
 *
 * Lo que la base NO tiene y por eso no se inventa:
 *  - `lote_entradas` no tiene fecha: los insumos van al DIA DE PRODUCCION
 *    (`lotes.fecha_inicio`), salvo el aditivo 2, cuya fecha sale de
 *    `lote_etapas` (etapa `aditivo_2`).
 *  - El envasado diario va SIN lote (decision de Norman, 2026-10-19): las
 *    botellas de un lote son solo las que quedaron ligadas a el.
 *  - "Kilos de alcohol puro" = peso x grado. El grado es % en VOLUMEN, asi que
 *    es un CALCULO aproximado y se dice.
 */

import { fechaParaPersona } from '@/lib/fechas'

export type PreguntaLote =
  | { tipo: 'trazabilidad_lote'; codigo: string | null }
  | { tipo: 'etapa_lote'; codigo: string | null }
  | { tipo: 'lotes_abiertos' }
  | { tipo: 'produccion_mes'; periodo: { etiqueta: string; desde: string; hasta: string } }

/** El SKU del aditivo 2 en produccion (YAML `aditivo_2_sku`). */
export const SKU_ADITIVO_2 = 'aditivo-2'

const CODIGO = /\b(l-?\d{1,2}-\d{1,2}\.\d{1,3}|l-?\d{3,5})\b/i

/** "l-12-10.1" / "L12-10.1" / "l1017" -> "L-12-10.1" / "L-1017". null si no hay. */
export function codigoDeLote(texto: string): string | null {
  const m = CODIGO.exec(String(texto ?? ''))
  if (!m) return null
  const c = m[1].toUpperCase()
  return c.startsWith('L-') ? c : 'L-' + c.slice(1)
}

function plano(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const PIDE_TRAZABILIDAD =
  /\b(trazabilidad|trazar|historia|historial|linea de tiempo|todo (lo )?del lote|detalle del lote|datos del lote|info(rmacion)? del lote|resumen del lote)\b/
const PIDE_ETAPA = /\b(en que etapa|que etapa|en que va|como va|en que paso|en que quedo|como esta) (va |esta |anda )?(el )?lote\b|\betapa del lote\b/
const PIDE_ABIERTOS =
  /\blotes? (abiertos?|activos?|en proceso|en fermentacion|fermentando|sin destilar|pendientes?)\b|\bque lotes (hay|tenemos|estan|van)\b|\blotes (hay|tenemos) (abiertos|activos)\b/
const PIDE_PRODUCCION =
  /\b(cuanto|que) (se )?(produjo|producimos|produjimos|hemos producido|se ha producido|llevamos producido)\b|\bproduccion (de|del|este) (mes|este mes|el mes pasado|mes pasado)\b|\bcuanto destilamos\b|\bcuanto se destilo\b/

/**
 * `periodo`: el que ya leyo `periodoDe` de `lib/bot-pregunta.ts` (o null).
 * `hoy`: `AAAA-MM-DD` de Mexico. **Pura.**
 */
export function interpretarLote(
  texto: string,
  periodo: { etiqueta: string; desde: string; hasta: string } | null,
  hoy: string
): PreguntaLote | null {
  const t = plano(texto)
  if (t === '') return null
  const codigo = codigoDeLote(t)
  if (PIDE_TRAZABILIDAD.test(t) && (codigo || /\blote\b/.test(t))) return { tipo: 'trazabilidad_lote', codigo }
  if (PIDE_ETAPA.test(t)) return { tipo: 'etapa_lote', codigo }
  if (codigo && /\b(etapa|como va|en que va)\b/.test(t)) return { tipo: 'etapa_lote', codigo }
  if (PIDE_ABIERTOS.test(t)) return { tipo: 'lotes_abiertos' }
  if (PIDE_PRODUCCION.test(t)) {
    return { tipo: 'produccion_mes', periodo: periodo ?? { etiqueta: 'este mes', desde: hoy.slice(0, 8) + '01', hasta: hoy } }
  }
  return null
}

// ─── Lo que se lee de la base (sin tipos de Supabase: frontera) ─────────────

export interface CabeceraDeLote {
  id: string
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  brix_chile?: number | null
  brix_final?: number | null
  notas?: string | null
}

export interface EntradaDeLote {
  id_insumo: string
  cantidad: number
  nombre: string
  sku: string | null
  unidad: string | null
}

export interface EtapaDeLote {
  etapa: string
  fecha: string
  datos: Record<string, unknown> | null
}

export interface SalidaDeLote {
  numero_tanda: number
  litros: number | null
  grado_alcohol: number | null
  peso_kg: number | null
}

export interface EnvasadoDeLote {
  fecha: string
  botellas: number
  nombre: string
}

export interface DatosDeLote {
  lote: CabeceraDeLote
  entradas: EntradaDeLote[]
  etapas: EtapaDeLote[]
  salidas: SalidaDeLote[]
  envasado: EnvasadoDeLote[]
}

// ─── Calculos ───────────────────────────────────────────────────────────────

export function diasEntreFechas(inicio: string, fin: string): number {
  const a = Date.UTC(+inicio.slice(0, 4), +inicio.slice(5, 7) - 1, +inicio.slice(8, 10))
  const b = Date.UTC(+fin.slice(0, 4), +fin.slice(5, 7) - 1, +fin.slice(8, 10))
  return Math.round((b - a) / 86400000)
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

const CORTA: Record<string, string> = { KILOGRAMOS: 'kg', GRAMOS: 'g', LITROS: 'L', MILILITROS: 'ml', PIEZAS: 'pzas' }

/** "8000 g (8 kg)" / "40 kg" / "3 pzas". */
export function cantidadConUnidad(cantidad: number, unidad: string | null): string {
  const u = unidad ? (CORTA[unidad] ?? unidad.toLowerCase()) : ''
  if (unidad === 'GRAMOS' && cantidad >= 1000) return `${num(cantidad)} g (${num(cantidad / 1000)} kg)`
  return u ? `${num(cantidad)} ${u}` : num(cantidad)
}

export interface Garrafas {
  n: number
  kgTotal: number
  /** Suma de peso x grado / 100 de las que tienen los dos. null si ninguna. */
  kgAlcohol: number | null
  sinGrado: number
}

/** Las garrafas (o tandas) con peso. Las de litros sin peso no suman kilos. */
export function resumenGarrafas(salidas: readonly SalidaDeLote[]): Garrafas {
  let kgTotal = 0
  let kgAlcohol = 0
  let conAlcohol = 0
  let sinGrado = 0
  for (const s of salidas) {
    const peso = s.peso_kg === null ? null : Number(s.peso_kg)
    if (peso !== null && Number.isFinite(peso)) {
      kgTotal += peso
      if (s.grado_alcohol !== null && Number.isFinite(Number(s.grado_alcohol))) {
        kgAlcohol += (peso * Number(s.grado_alcohol)) / 100
        conAlcohol++
      } else sinGrado++
    }
  }
  return { n: salidas.length, kgTotal: Number(kgTotal.toFixed(3)), kgAlcohol: conAlcohol ? Number(kgAlcohol.toFixed(2)) : null, sinGrado }
}

export type EtapaActual = 'fermentando' | 'aditivo_2' | 'fermentacion_terminada' | 'destilado' | 'envasado'

export function etapaActual(d: Pick<DatosDeLote, 'lote' | 'etapas' | 'salidas' | 'envasado'>): EtapaActual {
  if (d.envasado.some((e) => Number(e.botellas) > 0)) return 'envasado'
  if (d.salidas.length > 0 || d.etapas.some((e) => e.etapa === 'destilacion')) return 'destilado'
  if (d.lote.fecha_fin_fermentacion) return 'fermentacion_terminada'
  if (d.etapas.some((e) => e.etapa === 'aditivo_2')) return 'aditivo_2'
  return 'fermentando'
}

/** Abierto = todavia no se destila (sin etapa `destilacion` y sin garrafas/tandas). */
export function estaAbierto(d: Pick<DatosDeLote, 'lote' | 'etapas' | 'salidas' | 'envasado'>): boolean {
  const e = etapaActual(d)
  return e === 'fermentando' || e === 'aditivo_2' || e === 'fermentacion_terminada'
}

function fermentacion(d: DatosDeLote, hoy: string): string {
  const l = d.lote
  const destilacion = d.etapas.find((e) => e.etapa === 'destilacion')?.fecha ?? null
  const horas = l.horas_fermentacion !== null && l.horas_fermentacion !== undefined ? ` (${num(Number(l.horas_fermentacion))} h)` : ''
  if (l.fecha_fin_fermentacion) {
    const dias = diasEntreFechas(l.fecha_inicio, l.fecha_fin_fermentacion)
    return `Fermento ${dias} dia(s)${horas}: del ${fechaParaPersona(l.fecha_inicio)} al ${fechaParaPersona(l.fecha_fin_fermentacion)}`
  }
  if (destilacion) {
    return `Sin fin de fermentacion anotado; hasta la destilacion fueron ${diasEntreFechas(l.fecha_inicio, destilacion)} dia(s)${horas}`
  }
  return `Sigue fermentando: lleva ${Math.max(0, diasEntreFechas(l.fecha_inicio, hoy))} dia(s)${horas}`
}

function esAditivo2(e: EntradaDeLote): boolean {
  return e.sku === SKU_ADITIVO_2
}

const ETIQUETA_ETAPA: Record<EtapaActual, string> = {
  fermentando: 'fermentando',
  aditivo_2: 'fermentando, ya con aditivo 2',
  fermentacion_terminada: 'fermentacion terminada, falta destilar',
  destilado: 'destilado',
  envasado: 'envasado (tiene botellas ligadas)'
}

// ─── Textos ─────────────────────────────────────────────────────────────────

export const NOTA_ENVASADO =
  'El envasado diario no se liga a un lote (decision del 2026-10-19): aqui solo salen las botellas que quedaron ligadas a este lote.'

export const NOTA_ALCOHOL = 'calculo: peso x grado; el grado es % en volumen, asi que es aproximado'

export function textoFaltaCodigo(): string {
  return 'De cual lote? Dimelo con el codigo, por ejemplo: trazabilidad del lote L-12-10.1'
}

export function textoNoHayLote(codigo: string): string {
  return `No tengo el lote ${codigo}. Pregunta "lotes abiertos" para ver los que van.`
}

export interface EventoDeLote {
  /** `AAAA-MM-DD`, o null si la base no la tiene (una destilacion sin etapa). */
  fecha: string | null
  titulo: string
  detalle: string[]
}

/**
 * La linea de tiempo de un lote, ordenada por fecha. La usan el bot
 * (`textoTrazabilidad`) y la web (`components/v2/lotes/DetalleLote.tsx`): la
 * misma lista en los dos lados. **Pura.**
 */
export function lineaDeTiempo(d: DatosDeLote): EventoDeLote[] {
  const l = d.lote
  const etapaAd2 = d.etapas.find((e) => e.etapa === 'aditivo_2') ?? null
  const destil = d.etapas.find((e) => e.etapa === 'destilacion') ?? null
  const muestra = d.etapas.find((e) => e.etapa === 'muestra') ?? null
  const delDia = d.entradas.filter((e) => !(etapaAd2 && esAditivo2(e)))
  const ad2 = etapaAd2 ? d.entradas.filter(esAditivo2) : []

  const eventos: (EventoDeLote & { orden: number })[] = []

  const dia: string[] = []
  if (delDia.length === 0) dia.push('(sin insumos anotados)')
  for (const e of [...delDia].sort((a, b) => a.nombre.localeCompare(b.nombre))) {
    dia.push(`${e.nombre}: ${cantidadConUnidad(Number(e.cantidad), e.unidad)}`)
  }
  if (l.brix_chile !== null && l.brix_chile !== undefined) dia.push(`Brix del chile: ${num(Number(l.brix_chile))}`)
  eventos.push({ fecha: l.fecha_inicio, orden: 0, titulo: 'Dia de produccion', detalle: dia })

  if (etapaAd2) {
    const detalle: string[] = []
    if (ad2.length) for (const e of ad2) detalle.push(`${e.nombre}: ${cantidadConUnidad(Number(e.cantidad), e.unidad)}`)
    else {
      // Sin fila en lote_entradas (no deberia pasar): lo que guardo la etapa.
      const datos = etapaAd2.datos ?? {}
      const c = datos.cantidad ?? datos.kg
      const u = datos.cantidad !== undefined ? String(datos.unidad ?? '') : 'kg'
      detalle.push(c !== undefined && c !== null ? `Aditivo 2: ${String(c)} ${u}`.trimEnd() : '(sin cantidad anotada)')
    }
    eventos.push({ fecha: etapaAd2.fecha, orden: 1, titulo: 'Aditivo 2', detalle })
  }

  if (l.fecha_fin_fermentacion) {
    const dias = diasEntreFechas(l.fecha_inicio, l.fecha_fin_fermentacion)
    const horas = l.horas_fermentacion !== null && l.horas_fermentacion !== undefined ? ` (${num(Number(l.horas_fermentacion))} h)` : ''
    eventos.push({ fecha: l.fecha_fin_fermentacion, orden: 2, titulo: 'Fin de fermentacion', detalle: [`Fermento ${dias} dia(s)${horas}`] })
  }

  if (destil || d.salidas.length) {
    const g = resumenGarrafas(d.salidas)
    const detalle: string[] = []
    for (const s of [...d.salidas].sort((a, b) => a.numero_tanda - b.numero_tanda)) {
      const peso = s.peso_kg !== null ? `${num(Number(s.peso_kg))} kg` : s.litros !== null ? `${num(Number(s.litros))} L` : 'sin peso'
      const grado = s.grado_alcohol !== null ? ` al ${num(Number(s.grado_alcohol))}%` : ' (sin grado)'
      detalle.push(`Garrafa ${s.numero_tanda}: ${peso}${grado}`)
    }
    if (g.kgTotal > 0) detalle.push(`Total: ${num(g.kgTotal)} kg`)
    if (g.kgAlcohol !== null) {
      detalle.push(`Alcohol puro: ~${num(g.kgAlcohol)} kg (${NOTA_ALCOHOL})${g.sinGrado ? `; ${g.sinGrado} garrafa(s) sin grado no cuentan` : ''}`)
    }
    eventos.push({ fecha: destil?.fecha ?? null, orden: 3, titulo: `Destilacion: ${d.salidas.length} garrafa(s)`, detalle })
  }

  if (muestra) eventos.push({ fecha: muestra.fecha, orden: 4, titulo: 'Muestra guardada', detalle: [] })

  for (const e of d.envasado) {
    eventos.push({ fecha: e.fecha, orden: 5, titulo: `Envasado: ${num(Number(e.botellas))} de ${e.nombre}`, detalle: [] })
  }

  const clave = (e: { fecha: string | null }) => e.fecha ?? '9999-12-31'
  eventos.sort((a, b) => (clave(a) === clave(b) ? a.orden - b.orden : clave(a) < clave(b) ? -1 : 1))
  return eventos.map(({ fecha, titulo, detalle }) => ({ fecha, titulo, detalle }))
}

/** "Envasado: 40 de Destilado 750" -> "ENVASADO: 40 de Destilado 750" (solo el nombre del paso). */
function titular(titulo: string): string {
  const i = titulo.indexOf(':')
  return i < 0 ? titulo.toUpperCase() : titulo.slice(0, i).toUpperCase() + titulo.slice(i)
}

/** La linea de tiempo entera de un lote, como texto del bot. **Pura.** */
export function textoTrazabilidad(d: DatosDeLote, hoy: string): string {
  const l = d.lote
  const botellas = d.envasado.reduce((s, e) => s + Number(e.botellas), 0)
  const salida = [
    `LOTE ${l.codigo_lote} — trazabilidad`,
    `Etapa: ${ETIQUETA_ETAPA[etapaActual(d)]}`,
    fermentacion(d, hoy),
    '',
    ...lineaDeTiempo(d).flatMap((e) => [
      `${e.fecha ? fechaParaPersona(e.fecha) : '(sin fecha)'} — ${titular(e.titulo)}`,
      ...e.detalle.map((x) => '   ' + x)
    ]),
    '',
    `Botellas ligadas al lote: ${botellas}`,
    NOTA_ENVASADO
  ]
  if (l.notas) salida.push(`Notas: ${l.notas}`)
  return salida.join('\n')
}

/** "en que etapa va el lote X". **Pura.** */
export function textoEtapaLote(d: DatosDeLote, hoy: string): string {
  const e = etapaActual(d)
  const lineas = [`LOTE ${d.lote.codigo_lote}: ${ETIQUETA_ETAPA[e]}.`, fermentacion(d, hoy)]
  const ad2 = d.etapas.find((x) => x.etapa === 'aditivo_2')
  if (ad2) lineas.push(`Aditivo 2: ${fechaParaPersona(ad2.fecha)}`)
  const destil = d.etapas.find((x) => x.etapa === 'destilacion')
  if (destil || d.salidas.length) {
    const g = resumenGarrafas(d.salidas)
    lineas.push(`Destilacion: ${destil ? fechaParaPersona(destil.fecha) : '(sin fecha)'}, ${d.salidas.length} garrafa(s), ${num(g.kgTotal)} kg`)
  }
  lineas.push(`Para todo el detalle: trazabilidad del lote ${d.lote.codigo_lote}`)
  return lineas.join('\n')
}

/** "lotes abiertos". `lotes`: todos, cada uno con sus etapas y salidas. **Pura.** */
export function textoLotesAbiertos(lotes: readonly Pick<DatosDeLote, 'lote' | 'etapas' | 'salidas' | 'envasado'>[], hoy: string): string {
  const abiertos = lotes.filter(estaAbierto).sort((a, b) => (a.lote.fecha_inicio < b.lote.fecha_inicio ? -1 : a.lote.fecha_inicio > b.lote.fecha_inicio ? 1 : a.lote.codigo_lote.localeCompare(b.lote.codigo_lote)))
  if (abiertos.length === 0) return 'No hay lotes abiertos: todos ya se destilaron.'
  const lineas = [`Lotes abiertos (sin destilar): ${abiertos.length}`]
  for (const d of abiertos) {
    const dias = Math.max(0, diasEntreFechas(d.lote.fecha_inicio, d.lote.fecha_fin_fermentacion ?? hoy))
    lineas.push(`- ${d.lote.codigo_lote}: desde ${fechaParaPersona(d.lote.fecha_inicio)}, ${dias} dia(s); ${ETIQUETA_ETAPA[etapaActual(d)]}`)
  }
  return lineas.join('\n')
}

export interface ProduccionDelPeriodo {
  /** Lotes con `fecha_inicio` en el periodo. */
  iniciados: { codigo_lote: string; kgChile: number | null }[]
  /** Lotes con etapa `destilacion` en el periodo, con sus garrafas. */
  destilados: { codigo_lote: string; salidas: SalidaDeLote[] }[]
  /** Botellas envasadas en el periodo (con o sin lote), por producto. */
  envasado: { nombre: string; botellas: number }[]
}

/** "cuanto se produjo este mes". **Pura.** */
export function textoProduccionMes(periodo: { etiqueta: string }, p: ProduccionDelPeriodo): string {
  const lineas = [`PRODUCCION — ${periodo.etiqueta}`]
  const kgChile = p.iniciados.reduce((s, l) => s + (l.kgChile ?? 0), 0)
  lineas.push(`Lotes iniciados: ${p.iniciados.length}${p.iniciados.length ? ` (${p.iniciados.map((l) => l.codigo_lote).join(', ')})` : ''}`)
  if (p.iniciados.length) lineas.push(`   Chile metido: ${num(Number(kgChile.toFixed(3)))} kg`)
  const todas = p.destilados.flatMap((d) => d.salidas)
  const g = resumenGarrafas(todas)
  lineas.push(`Lotes destilados: ${p.destilados.length}${p.destilados.length ? ` (${p.destilados.map((d) => d.codigo_lote).join(', ')})` : ''}`)
  if (p.destilados.length) {
    lineas.push(`   Garrafas: ${todas.length}, ${num(g.kgTotal)} kg`)
    if (g.kgAlcohol !== null) lineas.push(`   Alcohol puro: ~${num(g.kgAlcohol)} kg (${NOTA_ALCOHOL})`)
  }
  const botellas = p.envasado.reduce((s, e) => s + e.botellas, 0)
  lineas.push(`Botellas envasadas: ${botellas}`)
  for (const e of [...p.envasado].sort((a, b) => b.botellas - a.botellas)) lineas.push(`   ${e.nombre}: ${num(e.botellas)}`)
  return lineas.join('\n')
}
