/**
 * Correccion de la CABECERA de un lote (ruta escondida `/panel/correcciones`,
 * apartado «Lotes»). Escrito el 2026-11-18 por el agente (Cuartel).
 *
 * PURO: sin red, sin base, sin React. Lo usan el formulario (cliente), la
 * server action (servidor) y `tests/ajustes-lotes.spec.ts`. Las reglas de rango
 * (fechas, horas, Brix) son las de `components/v2/lotes/validar.ts`, que la
 * server action vuelve a correr; aqui NO se importan porque ese archivo trae
 * `node:crypto` (via lib/bot-lotes) y esto corre tambien en el cliente.
 *
 * LA DOBLE CONFIRMACION (como lib/ajustes-admin.ts):
 *   1. revisar: el dialogo muestra campo por campo antes -> despues, con motivo.
 *   2. confirmar: hay que TECLEAR el codigo del lote como quedara. El servidor
 *      vuelve a comprobar las dos cosas (`validarSolicitudLote`).
 *
 * La RPC `ajustar_lote` (migracion 20261118192907) compara lo que el usuario VIO
 * contra lo actual y rechaza con CAMBIO_CONCURRENTE. Al renombrar, el nombre
 * anterior queda como ALIAS (trigger), y el bot encuentra el lote por los dos.
 */

import { mensajeDeErrorRpc, MOTIVO_MINIMO } from '@/lib/ajustes-admin'
import { normalizarNombreLote } from '@/lib/lote-alias'

export { MOTIVO_MINIMO }

/** Las 7 llaves de la cabecera que se corrigen (las mismas de la RPC). */
export const CAMPOS_LOTE = [
  'codigo_lote',
  'fecha_inicio',
  'fecha_fin_fermentacion',
  'horas_fermentacion',
  'brix_chile',
  'brix_final',
  'notas'
] as const

export type CampoLote = (typeof CAMPOS_LOTE)[number]

export interface CabeceraLote {
  codigo_lote: string
  fecha_inicio: string
  /** NULL = la fermentacion sigue en curso. */
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  brix_chile: number | null
  brix_final: number | null
  notas: string | null
}

export const ETIQUETA_CAMPO: Record<CampoLote, string> = {
  codigo_lote: 'Código (nombre)',
  fecha_inicio: 'Inicio de fermentación',
  fecha_fin_fermentacion: 'Fin de fermentación',
  horas_fermentacion: 'Horas de fermentación',
  brix_chile: 'Brix chile',
  brix_final: 'Brix final',
  notas: 'Notas'
}

/** Lo que escribe el formulario (todo texto) + el toggle de «terminada». */
export interface FormCabecera {
  codigo_lote: string
  fecha_inicio: string
  terminada: boolean
  fecha_fin_fermentacion: string
  horas_fermentacion: string
  brix_chile: string
  brix_final: string
  notas: string
}

export function formDesdeCabecera(c: CabeceraLote): FormCabecera {
  const t = (n: number | null) => (n === null ? '' : String(n))
  return {
    codigo_lote: c.codigo_lote,
    fecha_inicio: c.fecha_inicio,
    terminada: c.fecha_fin_fermentacion !== null,
    fecha_fin_fermentacion: c.fecha_fin_fermentacion ?? '',
    horas_fermentacion: t(c.horas_fermentacion),
    brix_chile: t(c.brix_chile),
    brix_final: t(c.brix_final),
    notas: c.notas ?? ''
  }
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

function numeroONulo(s: string): number | null | undefined {
  const t = String(s ?? '').trim()
  if (t === '') return null
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined
  return Number(t)
}

/**
 * Formulario -> cabecera, o el error. Solo FORMA (fecha valida, numero que se
 * entiende, fin >= inicio, terminada exige fecha); los topes los pone
 * `validarLote` en el servidor. «En curso» QUITA la fecha de fin.
 */
export function cabeceraDesdeForm(f: FormCabecera): { ok: true; cabecera: CabeceraLote } | { ok: false; error: string } {
  const codigo = String(f.codigo_lote ?? '').trim()
  if (!codigo) return { ok: false, error: 'El código del lote no puede quedar vacío.' }
  if (codigo.length > 40) return { ok: false, error: 'El código va de 1 a 40 caracteres.' }
  const inicio = String(f.fecha_inicio ?? '').trim()
  if (!FECHA.test(inicio)) return { ok: false, error: 'La fecha de inicio no es válida.' }
  let fin: string | null = null
  if (f.terminada) {
    fin = String(f.fecha_fin_fermentacion ?? '').trim()
    if (!FECHA.test(fin)) return { ok: false, error: 'Si la fermentación terminó, pon la fecha de fin.' }
    if (fin < inicio) return { ok: false, error: 'La fermentación no puede terminar antes de empezar.' }
  }
  const horas = numeroONulo(f.horas_fermentacion)
  const brixChile = numeroONulo(f.brix_chile)
  const brixFinal = numeroONulo(f.brix_final)
  if (horas === undefined || brixChile === undefined || brixFinal === undefined) {
    return { ok: false, error: 'Horas y Brix van con punto decimal, sin letras.' }
  }
  const notas = String(f.notas ?? '').trim()
  return {
    ok: true,
    cabecera: {
      codigo_lote: codigo,
      fecha_inicio: inicio,
      fecha_fin_fermentacion: fin,
      horas_fermentacion: horas,
      brix_chile: brixChile,
      brix_final: brixFinal,
      notas: notas === '' ? null : notas
    }
  }
}

function igual(campo: CampoLote, a: unknown, b: unknown): boolean {
  if (campo === 'notas') return String(a ?? '').trim() === String(b ?? '').trim()
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null)
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  return String(a) === String(b)
}

export interface Cambio {
  campo: CampoLote
  antes: CabeceraLote[CampoLote]
  despues: CabeceraLote[CampoLote]
}

/** Campo por campo, lo que cambia. Vacio = no hay nada que corregir. */
export function cambiosDeLote(antes: CabeceraLote, despues: CabeceraLote): Cambio[] {
  return CAMPOS_LOTE.filter((c) => !igual(c, antes[c], despues[c])).map((c) => ({ campo: c, antes: antes[c], despues: despues[c] }))
}

/** ¿El renombre deja alias? Solo si cambia de verdad (no solo mayusculas/espacios), como el trigger. */
export function renombraDeVerdad(antes: string, despues: string): boolean {
  return normalizarNombreLote(antes) !== normalizarNombreLote(despues)
}

/** Segunda confirmacion: el codigo como quedara, tecleado otra vez (exacto, sin espacios de los extremos). */
export function confirmacionLoteCasa(tecleado: string, codigoNuevo: string): boolean {
  return String(tecleado ?? '').trim() !== '' && String(tecleado ?? '').trim() === String(codigoNuevo ?? '').trim()
}

/** Lo que el formulario manda a la server action. */
export interface SolicitudLote {
  id: string
  /** La cabecera que el usuario VIO (el servidor rechaza si cambio). */
  visto: CabeceraLote
  nuevo: CabeceraLote
  motivo: string
  paso1: boolean
  /** El codigo nuevo tecleado otra vez. */
  confirmacion: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function esCabecera(c: unknown): c is CabeceraLote {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return CAMPOS_LOTE.every((k) => k in o) && typeof o.codigo_lote === 'string' && typeof o.fecha_inicio === 'string'
}

/** La puerta de la server action. El rol ADMIN se valida aparte (sesion). */
export function validarSolicitudLote(s: SolicitudLote): string | null {
  if (!UUID.test(String(s?.id ?? ''))) return 'Lote inválido.'
  if (!esCabecera(s.visto) || !esCabecera(s.nuevo)) return 'Datos del lote incompletos.'
  if (s.paso1 !== true) return 'Falta la primera confirmación.'
  if (!confirmacionLoteCasa(s.confirmacion, s.nuevo.codigo_lote)) return 'La segunda confirmación no coincide con el código del lote.'
  if (String(s.motivo ?? '').trim().length < MOTIVO_MINIMO) return `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).`
  if (cambiosDeLote(s.visto, s.nuevo).length === 0) return 'No hay nada que corregir.'
  return null
}

/** Mensaje legible para los errores de `ajustar_lote`. */
export function mensajeDeErrorLote(mensaje: string): string {
  if (mensaje.includes('NOMBRE_OCUPADO')) return mensaje.replace(/^.*NOMBRE_OCUPADO:\s*/, '')
  if (mensaje.includes('CAMBIO_CONCURRENTE')) {
    return `${mensaje.replace(/^.*CAMBIO_CONCURRENTE:\s*/, '')} (no se escribió nada)`
  }
  return mensajeDeErrorRpc(mensaje)
}
