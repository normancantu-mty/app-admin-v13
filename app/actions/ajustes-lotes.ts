'use server'

/**
 * Correccion de la cabecera de un lote (apartado «Lotes» de la ruta escondida
 * de correcciones). Escrito el 2026-11-18 por el agente (Cuartel).
 *
 * Tres puertas antes de escribir, las tres de servidor (como ajustes-admin.ts):
 *   1. sesion resuelta por `auth_id` (`getCurrentUser`) y rol ADMIN;
 *   2. las DOS confirmaciones y el motivo (`validarSolicitudLote`) y los rangos
 *      de siempre (`validarLote`, los mismos topes que el bot y la pantalla de
 *      lotes);
 *   3. en Postgres: `ajustar_lote` vuelve a exigir ADMIN, bloquea la fila,
 *      compara lo visto contra lo actual (CAMBIO_CONCURRENTE) y escribe. El
 *      renombre deja ALIAS (trigger) y la bitacora guarda el motivo.
 * Corre con la sesion del usuario (no service role).
 */

import { revalidatePath } from 'next/cache'
import { getCurrentUser } from '@/lib/auth-utils'
import { getServerSupabaseClient } from '@/lib/server-session'
import { RUTA_BASE } from '@/lib/v2/rutas'
import { fechaLocal } from '@/lib/fechas'
import { validarLote } from '@/components/v2/lotes/validar'
import type { Json } from '@/types/database'
import { esEstadoLote } from '@/components/v2/lotes/estado'
import { CAMPOS_LOTE, MOTIVO_MINIMO, mensajeDeErrorLote, validarSolicitudLote, type CabeceraLote, type SolicitudLote } from '@/lib/ajustes-lotes'

export type ResultadoAjusteLote =
  | { ok: true; antes: CabeceraLote; despues: CabeceraLote; cambios: string[]; alias: string[]; avisos: string[] }
  | { ok: false; error: string }

function limpia(c: CabeceraLote | undefined | null): CabeceraLote {
  const o = (c ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
  return {
    codigo_lote: String(o.codigo_lote ?? ''),
    fecha_inicio: String(o.fecha_inicio ?? ''),
    fecha_fin_fermentacion: o.fecha_fin_fermentacion ? String(o.fecha_fin_fermentacion) : null,
    horas_fermentacion: num(o.horas_fermentacion),
    brix_chile: num(o.brix_chile),
    brix_final: num(o.brix_final),
    notas: o.notas === null || o.notas === undefined ? null : String(o.notas),
    ...(esEstadoLote(o.estado_proceso) ? { estado_proceso: o.estado_proceso } : {})
  }
}

export async function ajustarLoteAction(solicitud: SolicitudLote): Promise<ResultadoAjusteLote> {
  try {
    const usuario = await getCurrentUser()
    if (!usuario || usuario.rol !== 'ADMIN') return { ok: false, error: 'No autorizado.' }

    const s: SolicitudLote = {
      id: String(solicitud?.id ?? ''),
      visto: limpia(solicitud?.visto),
      nuevo: limpia(solicitud?.nuevo),
      motivo: String(solicitud?.motivo ?? ''),
      paso1: solicitud?.paso1 === true,
      confirmacion: String(solicitud?.confirmacion ?? '')
    }
    const invalida = validarSolicitudLote(s)
    if (invalida) return { ok: false, error: invalida }

    // Los rangos de siempre (codigo <=40, inicio no futuro, fin>=inicio, horas, Brix).
    const v = validarLote({ ...s.nuevo, notas: s.nuevo.notas ?? '', entradas: [], tandas: [] }, fechaLocal(new Date()))
    if (!v.ok) return { ok: false, error: v.error }
    const nuevo: CabeceraLote = {
      codigo_lote: v.lote.codigo_lote,
      fecha_inicio: v.lote.fecha_inicio,
      fecha_fin_fermentacion: v.lote.fecha_fin_fermentacion,
      horas_fermentacion: v.lote.horas_fermentacion,
      brix_chile: v.lote.brix_chile,
      brix_final: v.lote.brix_final,
      notas: v.lote.notas,
      // El estado viaja solo si lo visto lo trae (la RPC lo compara contra lo actual).
      ...(s.visto.estado_proceso && s.nuevo.estado_proceso ? { estado_proceso: s.nuevo.estado_proceso } : {})
    }

    const supabase = await getServerSupabaseClient()
    const { data, error } = await supabase.rpc('ajustar_lote', {
      p_id: s.id,
      p_visto: s.visto as unknown as Json,
      p_nuevo: nuevo as unknown as Json,
      p_motivo: s.motivo.trim()
    })
    if (error) return { ok: false, error: mensajeDeErrorLote(error.message) }

    const r = (data ?? {}) as { antes?: CabeceraLote; despues?: CabeceraLote; cambios?: string[]; alias?: string[] }
    revalidatePath(`${RUTA_BASE}/correcciones`)
    revalidatePath(`${RUTA_BASE}/lotes`)
    return {
      ok: true,
      antes: limpia(r.antes),
      despues: limpia(r.despues),
      cambios: (r.cambios ?? []).filter((c) => (CAMPOS_LOTE as readonly string[]).includes(c)),
      alias: r.alias ?? [],
      avisos: v.avisos
    }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error inesperado' }
  }
}

export type ResultadoEliminarLote = { ok: true; codigo_lote: string; entradas: number; salidas: number; etapas: number } | { ok: false; error: string }

const UUID_LOTE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Eliminar un lote (2026-11-19). SOLO ADMIN. La RPC `eliminar_lote` (SECURITY
 * DEFINER, migracion 20261119221815) vuelve a exigir ADMIN, compara el codigo
 * tecleado, RECHAZA si el lote ya movio inventario (envasado ligado) y si no
 * borra en una transaccion (etapas, insumos, tandas, alias en cascada) dejando
 * la foto completa en auditoria_logs (operacion DELETE) con el motivo.
 */
export async function eliminarLoteAction(p: { id: string; confirmacion: string; motivo: string }): Promise<ResultadoEliminarLote> {
  try {
    const usuario = await getCurrentUser()
    if (!usuario || usuario.rol !== 'ADMIN') return { ok: false, error: 'No autorizado.' }
    const id = String(p?.id ?? '')
    if (!UUID_LOTE.test(id)) return { ok: false, error: 'Lote inválido.' }
    const motivo = String(p?.motivo ?? '').trim()
    if (motivo.length < MOTIVO_MINIMO) return { ok: false, error: `El motivo es obligatorio (mínimo ${MOTIVO_MINIMO} caracteres).` }
    const confirmacion = String(p?.confirmacion ?? '').trim()
    if (!confirmacion) return { ok: false, error: 'Escribe el código del lote para confirmar.' }

    const supabase = await getServerSupabaseClient()
    // eliminar_lote no esta en types/database.ts: se llama sin tipos, en la frontera.
    const db = supabase as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
    const { data, error } = await db.rpc('eliminar_lote', { p_id: id, p_confirmacion: confirmacion, p_motivo: motivo })
    if (error) {
      const m = error.message
      if (m.includes('LOTE_CON_ENVASADO')) return { ok: false, error: m.replace(/^.*LOTE_CON_ENVASADO:\s*/, '') }
      if (m.includes('CONFIRMACION')) return { ok: false, error: m.replace(/^.*CONFIRMACION:\s*/, '') }
      return { ok: false, error: mensajeDeErrorLote(m) }
    }
    const r = (data ?? {}) as { codigo_lote?: string; entradas?: number; salidas?: number; etapas?: number }
    revalidatePath(`${RUTA_BASE}/correcciones`)
    revalidatePath(`${RUTA_BASE}/lotes`)
    return { ok: true, codigo_lote: String(r.codigo_lote ?? ''), entradas: Number(r.entradas ?? 0), salidas: Number(r.salidas ?? 0), etapas: Number(r.etapas ?? 0) }
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : 'Error inesperado' }
  }
}
