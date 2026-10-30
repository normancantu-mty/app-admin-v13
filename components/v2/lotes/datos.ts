/**
 * Lotes v2 — lecturas de servidor del apartado de lotes. Escrito el 2026-10-30
 * por el ejecutor del Socio. Solo se importa desde Server Components (lee con la
 * sesion del usuario: el RLS de `lotes*` deja leer a ADMIN y SOCIO; `lote_etapas`
 * solo a ADMIN, asi que a SOCIO las etapas le llegan vacias, sin error).
 *
 * El rendimiento NO se calcula aqui: sale de `v_lote_rendimiento`, la misma vista
 * que lee el bot (D-198). Aqui solo se junta y se deriva el estado.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getServerSupabaseClient } from '@/lib/server-session'
import { fechaLocal } from '@/lib/fechas'
import { diasFermentacion, estadoLote, type EstadoLote } from './estado'

// `lote_etapas` y algunos joins no estan en `types/database.ts`: se leen sin tipos
// y se tipan aqui, en la frontera (mismo patron que lib/v2/lecturas.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClienteLibre = SupabaseClient<any>

export type FilaRendimiento = {
  id: string
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  kg_chile: number | null
  litros_producidos: number | null
  tandas: number | null
  grado_ponderado: number | null
  botellas: number | null
  ml_envasados: number | null
  litros_por_kg_chile: number | null
  merma_envasado: number | null
  costo_insumos_conocido: number | null
  insumos_sin_costo: number | null
  faltan_costo: string | null
  costo_por_ml: number | null
  grado_objetivo: number | null
  alcohol_absoluto_l: number | null
  tandas_sin_grado: number | null
  litros_al_grado_objetivo: number | null
  botellas_750_teoricas: number | null
  costo_por_ml_al_grado_objetivo: number | null
  alcanza_el_grado_diluyendo: boolean | null
}

const COLUMNAS_VISTA =
  'id, codigo_lote, fecha_inicio, fecha_fin_fermentacion, horas_fermentacion, kg_chile, litros_producidos, tandas, grado_ponderado, botellas, ml_envasados, litros_por_kg_chile, merma_envasado, costo_insumos_conocido, insumos_sin_costo, faltan_costo, costo_por_ml, grado_objetivo, alcohol_absoluto_l, tandas_sin_grado, litros_al_grado_objetivo, botellas_750_teoricas, costo_por_ml_al_grado_objetivo, alcanza_el_grado_diluyendo'

export type LoteResumen = FilaRendimiento & {
  estado: EstadoLote
  dias: number
  diasEnCurso: boolean
  fechaDestilacion: string | null
}

export type Etapa = { id: string; etapa: string; fecha: string; registrado_por: string; registrado_en: string; datos: Record<string, unknown> | null }

export function hoyMx(): string {
  return fechaLocal(new Date())
}

function resumir(f: FilaRendimiento, destilaciones: Map<string, string>, hoy: string): LoteResumen {
  const fechaDestilacion = destilaciones.get(f.id) ?? null
  const { dias, enCurso } = diasFermentacion(f.fecha_inicio, f.fecha_fin_fermentacion, fechaDestilacion, hoy)
  return {
    ...f,
    estado: estadoLote(f, fechaDestilacion !== null, hoy),
    dias,
    diasEnCurso: enCurso,
    fechaDestilacion
  }
}

/** Todos los lotes con su rendimiento y su estado, del mas reciente al mas viejo. */
export async function leerLotes(): Promise<{ lotes: LoteResumen[]; error: string | null }> {
  const supabase = await getServerSupabaseClient()
  const db = supabase as unknown as ClienteLibre
  const [vista, etapas] = await Promise.all([
    db.from('v_lote_rendimiento').select(COLUMNAS_VISTA).order('fecha_inicio', { ascending: false }).order('codigo_lote', { ascending: false }),
    db.from('lote_etapas').select('id_lote, fecha').eq('etapa', 'destilacion')
  ])
  if (vista.error) return { lotes: [], error: vista.error.message }
  // Sin etapas (SOCIO no las ve, o la lectura fallo) el estado sale de las tandas y la fecha de fin.
  const destilaciones = new Map<string, string>(((etapas.data ?? []) as { id_lote: string; fecha: string }[]).map((e) => [e.id_lote, e.fecha]))
  const hoy = hoyMx()
  return { lotes: ((vista.data ?? []) as FilaRendimiento[]).map((f) => resumir(f, destilaciones, hoy)), error: null }
}

export type CabeceraLote = {
  id: string
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  horas_fermentacion: number | null
  notas: string | null
  usuario_creador: string
  creado_en: string
  brix_chile: number | null
  brix_final: number | null
}

export type EntradaDetalle = { id: string; id_insumo: string; cantidad: number; nombre: string; sku: string | null; unidad: string; costo_unitario: number | null }
export type SalidaDetalle = { id: string; numero_tanda: number; litros: number | null; grado_alcohol: number | null; peso_kg: number | null; notas: string | null }
export type EnvasadoDetalle = { id: string; id_producto: string; botellas: number; fecha: string; nombre: string; ml_por_unidad: number | null }

export type DetalleLote = {
  cabecera: CabeceraLote
  resumen: LoteResumen | null
  entradas: EntradaDetalle[]
  salidas: SalidaDetalle[]
  envasado: EnvasadoDetalle[]
  etapas: Etapa[]
  errores: string[]
}

type Producto = { nombre: string | null; sku: string | null; unidad_medida: string | null; costo_unitario: number | null; ml_por_unidad?: number | null }
const uno = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

/** Un lote con todo lo que cuelga de el. `null` si no existe o el RLS no lo deja ver. */
export async function leerLote(id: string): Promise<DetalleLote | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const supabase = await getServerSupabaseClient()
  const db = supabase as unknown as ClienteLibre
  const [cab, vista, ent, sal, env, eta] = await Promise.all([
    db.from('lotes').select('id, codigo_lote, fecha_inicio, fecha_fin_fermentacion, horas_fermentacion, notas, usuario_creador, creado_en, brix_chile, brix_final').eq('id', id).maybeSingle(),
    db.from('v_lote_rendimiento').select(COLUMNAS_VISTA).eq('id', id).maybeSingle(),
    db.from('lote_entradas').select('id, id_insumo, cantidad, producto:catalogo_productos(nombre, sku, unidad_medida, costo_unitario)').eq('id_lote', id),
    db.from('lote_salidas').select('id, numero_tanda, litros, grado_alcohol, peso_kg, notas').eq('id_lote', id).order('numero_tanda', { ascending: true }),
    db.from('lote_envasado').select('id, id_producto, botellas, fecha, producto:catalogo_productos(nombre, sku, unidad_medida, costo_unitario, ml_por_unidad)').eq('id_lote', id).order('fecha', { ascending: true }),
    db.from('lote_etapas').select('id, etapa, fecha, registrado_por, registrado_en, datos').eq('id_lote', id).order('fecha', { ascending: true })
  ])
  if (cab.error || !cab.data) return null
  const errores = [vista, ent, sal, env].filter((r) => r.error).map((r) => r.error!.message)

  const etapas = (eta.data ?? []) as Etapa[]
  const destilacion = etapas.find((e) => e.etapa === 'destilacion')
  const destilaciones = new Map<string, string>(destilacion ? [[id, destilacion.fecha]] : [])

  const entradas: EntradaDetalle[] = ((ent.data ?? []) as { id: string; id_insumo: string; cantidad: number; producto: Producto | Producto[] | null }[])
    .map((e) => {
      const p = uno(e.producto)
      return {
        id: e.id,
        id_insumo: e.id_insumo,
        cantidad: Number(e.cantidad),
        nombre: p?.nombre ?? 'Insumo sin dato',
        sku: p?.sku ?? null,
        unidad: p?.unidad_medida ?? '',
        costo_unitario: p?.costo_unitario === null || p?.costo_unitario === undefined ? null : Number(p.costo_unitario)
      }
    })
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

  const envasado: EnvasadoDetalle[] = ((env.data ?? []) as { id: string; id_producto: string; botellas: number; fecha: string; producto: Producto | Producto[] | null }[]).map((v) => {
    const p = uno(v.producto)
    return {
      id: v.id,
      id_producto: v.id_producto,
      botellas: Number(v.botellas),
      fecha: v.fecha,
      nombre: p?.nombre ?? 'Producto sin dato',
      ml_por_unidad: p?.ml_por_unidad === null || p?.ml_por_unidad === undefined ? null : Number(p.ml_por_unidad)
    }
  })

  return {
    cabecera: cab.data as CabeceraLote,
    resumen: vista.data ? resumir(vista.data as FilaRendimiento, destilaciones, hoyMx()) : null,
    entradas,
    salidas: ((sal.data ?? []) as SalidaDetalle[]).map((s) => ({
      ...s,
      litros: s.litros === null ? null : Number(s.litros),
      grado_alcohol: s.grado_alcohol === null ? null : Number(s.grado_alcohol),
      peso_kg: s.peso_kg === null ? null : Number(s.peso_kg)
    })),
    envasado,
    etapas,
    errores
  }
}

export type InsumoLote = { id: string; nombre: string; sku: string | null; unidad_medida: string }

/** Los insumos que pueden entrar a un lote: los `INSUMO` del catalogo (el mismo filtro que el bot, `leerInsumosDeLote`). */
export async function leerInsumosLote(): Promise<InsumoLote[]> {
  const supabase = await getServerSupabaseClient()
  const { data } = await supabase.from('catalogo_productos').select('id, nombre, sku, unidad_medida').eq('tipo', 'INSUMO').order('nombre', { ascending: true })
  return ((data ?? []) as { id: string; nombre: string | null; sku: string | null; unidad_medida: string | null }[]).map((i) => ({
    id: i.id,
    nombre: i.nombre ?? '(sin nombre)',
    sku: i.sku,
    unidad_medida: i.unidad_medida ?? 'PIEZAS'
  }))
}

/** Codigos ya usados (para sugerir `L-AAAAMMDD` sin chocar). */
export async function leerCodigosLote(): Promise<string[]> {
  const supabase = await getServerSupabaseClient()
  const { data } = await supabase.from('lotes').select('codigo_lote')
  return ((data ?? []) as { codigo_lote: string }[]).map((l) => l.codigo_lote)
}
