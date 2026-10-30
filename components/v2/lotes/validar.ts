/**
 * Lotes v2 — validacion de la captura de un lote desde el ERP. Escrito el
 * 2026-10-30 por el ejecutor del Socio. PURO, pero importa los topes del bot
 * (`lib/bot-lotes.ts`, que trae `node:crypto`): se usa SOLO en el servidor
 * (`app/actions/lotes-v2.ts`), nunca en un componente de cliente.
 *
 * Los topes son los MISMOS del bot, importados y no copiados: "esto no se
 * captura a ciegas" vale igual por Telegram que por pantalla.
 */

import { GRADO_MAXIMO, TOPE_CANTIDAD_INSUMO, TOPE_HORAS_FERMENTACION, TOPE_LITROS_TANDA } from '@/lib/bot-lotes'
import { TOPE_GARRAFAS, TOPE_PESO_GARRAFA_KG } from '@/lib/bot-lote-ciclo'

export interface EntradaForm {
  id_insumo: string
  cantidad: number
}

export interface TandaForm {
  /** id de `lote_salidas` si la tanda ya existe (edicion). */
  id?: string | null
  litros: number | null
  grado_alcohol: number | null
  peso_kg: number | null
  notas?: string | null
}

export interface LoteForm {
  /** id de `lotes` para editar; vacio = lote nuevo. */
  id?: string | null
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  brix_chile: number | null
  brix_final: number | null
  notas: string
  entradas: EntradaForm[]
  tandas: TandaForm[]
}

export interface LoteLimpio {
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  brix_chile: number | null
  brix_final: number | null
  notas: string | null
  entradas: EntradaForm[]
  tandas: { id: string | null; litros: number | null; grado_alcohol: number | null; peso_kg: number | null; notas: string | null }[]
}

export type ResultadoValidacion = { ok: true; lote: LoteLimpio; avisos: string[] } | { ok: false; error: string }

const FECHA = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f-]{36}$/i

function numeroONulo(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function redondear(n: number, decimales: number): number {
  return Number(n.toFixed(decimales))
}

/**
 * Limpia y valida lo que llego del formulario. `hoy` es la fecha de Mexico
 * (`fechaLocal`). No toca la base: la existencia de los insumos y la unicidad
 * del codigo las revisa la accion.
 */
export function validarLote(f: LoteForm, hoy: string): ResultadoValidacion {
  const avisos: string[] = []
  const codigo = String(f.codigo_lote ?? '').trim()
  if (!codigo) return { ok: false, error: 'Falta el código del lote (el que va impreso en la etiqueta).' }
  if (codigo.length > 40) return { ok: false, error: 'Ese código de lote es larguísimo. Usa uno de 40 caracteres o menos.' }

  const inicio = String(f.fecha_inicio ?? '').trim()
  if (!FECHA.test(inicio)) return { ok: false, error: 'La fecha de inicio no es válida.' }
  if (inicio > hoy) return { ok: false, error: 'La fecha de inicio es en el futuro. No la escribo.' }

  const finCruda = String(f.fecha_fin_fermentacion ?? '').trim()
  const fin = finCruda === '' ? null : finCruda
  if (fin !== null && !FECHA.test(fin)) return { ok: false, error: 'La fecha de fin de fermentación no es válida.' }
  if (fin !== null && fin < inicio) return { ok: false, error: 'La fermentación no puede terminar antes de empezar.' }

  const horas = numeroONulo(f.horas_fermentacion)
  if (horas === undefined || (horas !== null && (horas <= 0 || horas > TOPE_HORAS_FERMENTACION))) {
    return { ok: false, error: `Las horas de fermentación van de más de 0 a ${TOPE_HORAS_FERMENTACION}.` }
  }

  const brix: { brix_chile: number | null; brix_final: number | null } = { brix_chile: null, brix_final: null }
  for (const llave of ['brix_chile', 'brix_final'] as const) {
    const v = numeroONulo(f[llave])
    if (v === undefined || (v !== null && (v < 0 || v > 100))) return { ok: false, error: 'El Brix es un porcentaje: de 0 a 100.' }
    brix[llave] = v === null ? null : redondear(v, 2)
  }

  const notas = String(f.notas ?? '').trim().slice(0, 500)

  // Insumos: el repetido se SUMA (unique id_lote,id_insumo), igual que el bot.
  const porInsumo = new Map<string, number>()
  for (const e of Array.isArray(f.entradas) ? f.entradas : []) {
    if (!e || !UUID.test(String(e.id_insumo ?? ''))) return { ok: false, error: 'Hay un renglón de insumo sin insumo elegido.' }
    const c = numeroONulo(e.cantidad)
    if (c === null || c === undefined || c <= 0) return { ok: false, error: 'Cada insumo necesita una cantidad mayor que 0.' }
    if (c > TOPE_CANTIDAD_INSUMO) return { ok: false, error: `${c} de un insumo es demasiado. Revísalo.` }
    if (porInsumo.has(e.id_insumo)) avisos.push('Sumé dos renglones del mismo insumo.')
    porInsumo.set(e.id_insumo, redondear((porInsumo.get(e.id_insumo) ?? 0) + c, 4))
  }

  // Tandas / garrafas: litros (tanda) o peso (garrafa de destilacion), al menos uno.
  const crudas = Array.isArray(f.tandas) ? f.tandas : []
  if (crudas.length > TOPE_GARRAFAS) return { ok: false, error: `${crudas.length} tandas es demasiado para una captura.` }
  const tandas: LoteLimpio['tandas'] = []
  for (let i = 0; i < crudas.length; i++) {
    const t = crudas[i] ?? ({} as TandaForm)
    const litros = numeroONulo(t.litros)
    const grado = numeroONulo(t.grado_alcohol)
    const peso = numeroONulo(t.peso_kg)
    if (litros === undefined || grado === undefined || peso === undefined) return { ok: false, error: `La tanda ${i + 1} tiene un número que no se entiende.` }
    if (litros === null && peso === null) return { ok: false, error: `La tanda ${i + 1} necesita litros o peso (kg).` }
    if (litros !== null && (litros <= 0 || litros > TOPE_LITROS_TANDA)) return { ok: false, error: `Los litros de la tanda ${i + 1} van de más de 0 a ${TOPE_LITROS_TANDA}.` }
    if (peso !== null && (peso <= 0 || peso > TOPE_PESO_GARRAFA_KG)) return { ok: false, error: `El peso de la tanda ${i + 1} va de más de 0 a ${TOPE_PESO_GARRAFA_KG} kg.` }
    if (grado !== null && (grado < 0 || grado > GRADO_MAXIMO)) return { ok: false, error: `Un grado de ${grado} no existe (tanda ${i + 1}).` }
    const id = t.id && UUID.test(String(t.id)) ? String(t.id) : null
    tandas.push({
      id,
      litros: litros === null ? null : redondear(litros, 3),
      grado_alcohol: grado === null ? null : redondear(grado, 2),
      peso_kg: peso === null ? null : redondear(peso, 3),
      notas: String(t.notas ?? '').trim().slice(0, 300) || null
    })
  }
  if (tandas.some((t) => t.grado_alcohol === null)) {
    avisos.push('Hay tandas sin grado: hasta que lo tengan, el sistema no saca el rendimiento ni el costo por mililitro.')
  }

  return {
    ok: true,
    avisos,
    lote: {
      codigo_lote: codigo,
      fecha_inicio: inicio,
      fecha_fin_fermentacion: fin,
      horas_fermentacion: horas === null ? null : redondear(horas, 2),
      ...brix,
      notas: notas || null,
      entradas: [...porInsumo.entries()].map(([id_insumo, cantidad]) => ({ id_insumo, cantidad })),
      tandas
    }
  }
}
