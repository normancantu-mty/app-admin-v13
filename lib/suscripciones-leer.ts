/**
 * Suscripciones — la LECTURA que comparten el bot (`app/api/bot/suscripciones`)
 * y el ERP (`app/panel/@modal/m/suscripciones`). Escrito el 2026-11-09 por el
 * Socio (ejecutor).
 *
 * Una funcion lee las tres cosas que deciden el estado de un mes: el catalogo,
 * las filas `suscripcion_meses` de ese mes (y, ronda 2, las de meses anteriores
 * que no son BAJA), y si los egresos a los que apuntan siguen ACTIVOS. Que bot y ERP lean por aqui es lo que hace que los dos digan
 * lo mismo ("pagada" en uno y "pendiente" en el otro seria el bug).
 *
 * Las tablas no estan en `types/database` (la migracion es del 2026-11-09):
 * cliente sin tipar, solo aqui y en la ruta.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  estadoDelMes,
  pendientesAnteriores,
  totalMensual,
  type MesDeSuscripcion,
  type PendienteAnterior,
  type RenglonDeLista,
  type Suscripcion,
  type TotalMensual
} from '@/lib/suscripciones'

/** ¿El error es "esa tabla no existe" (la migracion aun no se aplica)? */
export function esTablaFaltante(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST205' || error.code === '42P01' || /does not exist|schema cache/i.test(error.message ?? '')
}

export interface EstadoDeSuscripciones {
  subs: Suscripcion[]
  filas: Map<number, MesDeSuscripcion>
  /** Ronda 2: las filas de meses ANTERIORES que no son BAJA (el latido reintenta las POSPUESTA de aqui). */
  filasAnteriores: MesDeSuscripcion[]
  /** Los meses anteriores que siguen sin pagar (no pagados de verdad, no dados de baja, suscripcion activa). */
  anteriores: PendienteAnterior[]
  egresosActivos: Set<string>
  ultimoPagoMxn: Map<number, number>
  renglones: RenglonDeLista[]
  total: TotalMensual
}

export type LecturaDeSuscripciones =
  | { ok: true; datos: EstadoDeSuscripciones }
  | { ok: false; faltanTablas: boolean; error: unknown }

function aSuscripcion(f: Record<string, unknown>): Suscripcion {
  return {
    id: Number(f.id),
    nombre: String(f.nombre ?? ''),
    monto: Number(f.monto),
    moneda: f.moneda === 'USD' ? 'USD' : 'MXN',
    dia_cobro: f.dia_cobro === null || f.dia_cobro === undefined ? null : Number(f.dia_cobro),
    id_cuenta: f.id_cuenta ? String(f.id_cuenta) : null,
    subcategoria: String(f.subcategoria ?? 'Otras'),
    activa: f.activa === true,
    notas: f.notas ? String(f.notas) : null
  }
}

export const COLUMNAS_FILA =
  'id_suscripcion, mes, estado, preguntada_en, volver_a_preguntar, id_movimiento, monto_pagado, id_mensaje, reenvios, motivo_pospuesta'

export function aFila(f: Record<string, unknown>): MesDeSuscripcion {
  const motivo = f.motivo_pospuesta === 'TODAVIA_NO' || f.motivo_pospuesta === 'ENVIO_FALLIDO' ? f.motivo_pospuesta : null
  return {
    id_suscripcion: Number(f.id_suscripcion),
    mes: String(f.mes),
    estado: String(f.estado) as MesDeSuscripcion['estado'],
    preguntada_en: f.preguntada_en ? String(f.preguntada_en) : null,
    volver_a_preguntar: f.volver_a_preguntar ? String(f.volver_a_preguntar) : null,
    id_movimiento: f.id_movimiento ? String(f.id_movimiento) : null,
    monto_pagado: f.monto_pagado === null || f.monto_pagado === undefined ? null : Number(f.monto_pagado),
    id_mensaje: f.id_mensaje === null || f.id_mensaje === undefined ? null : Number(f.id_mensaje),
    reenvios: Number(f.reenvios ?? 0),
    motivo_pospuesta: motivo
  }
}

/** Ids por tanda: un `in.(...)` con cientos de uuid no cabe en una URL. */
const TANDA_DE_IDS = 100

/**
 * Todo lo de `mes`, mas los meses anteriores que siguen pendientes. `hoy`
 * (AAAA-MM-DD, Mexico) decide 'por_cobrar' contra 'pendiente'. Solo lectura.
 */
export async function leerSuscripciones(supabase: SupabaseClient, mes: string, hoy: string): Promise<LecturaDeSuscripciones> {
  const [rSubs, rFilas, rPagos] = await Promise.all([
    supabase.from('suscripciones').select('id, nombre, monto, moneda, dia_cobro, id_cuenta, subcategoria, activa, notas').order('nombre'),
    supabase.from('suscripcion_meses').select(COLUMNAS_FILA).eq('mes', mes),
    // El ultimo cobro EN PESOS de cada una: la unica referencia de tipo de cambio
    // que el sistema tiene sin inventarla.
    supabase
      .from('suscripcion_meses')
      .select('id_suscripcion, mes, monto_pagado')
      .eq('estado', 'PAGADA')
      .not('monto_pagado', 'is', null)
      .order('mes', { ascending: false })
      .limit(500)
  ])
  for (const r of [rSubs, rFilas, rPagos]) {
    if (r.error) return { ok: false, faltanTablas: esTablaFaltante(r.error), error: r.error }
  }
  // Ronda 2: los meses anteriores (sin BAJA). Crece ~12 filas por suscripcion al
  // ano; va paginada igual para no truncar en silencio.
  let filasAnteriores: MesDeSuscripcion[]
  try {
    const crudas = await fetchTodasLasFilas<Record<string, unknown>>(
      () => supabase.from('suscripcion_meses').select(COLUMNAS_FILA).lt('mes', mes).neq('estado', 'BAJA').order('mes').order('id_suscripcion'),
      'suscripciones: meses anteriores'
    )
    filasAnteriores = crudas.map(aFila)
  } catch (error) {
    return { ok: false, faltanTablas: esTablaFaltante(error as { message?: string }), error }
  }

  const subs = ((rSubs.data ?? []) as Record<string, unknown>[]).map(aSuscripcion)
  const filas = new Map<number, MesDeSuscripcion>()
  for (const f of (rFilas.data ?? []) as Record<string, unknown>[]) {
    const fila = aFila(f)
    filas.set(fila.id_suscripcion, fila)
  }
  const ultimoPagoMxn = new Map<number, number>()
  for (const p of (rPagos.data ?? []) as Record<string, unknown>[]) {
    const id = Number(p.id_suscripcion)
    if (!ultimoPagoMxn.has(id)) ultimoPagoMxn.set(id, Number(p.monto_pagado))
  }

  const ids = [...new Set([...filas.values(), ...filasAnteriores].map((f) => f.id_movimiento).filter((x): x is string => Boolean(x)))]
  const egresosActivos = new Set<string>()
  for (let i = 0; i < ids.length; i += TANDA_DE_IDS) {
    const tanda = ids.slice(i, i + TANDA_DE_IDS)
    // ERP-25: toda lectura multi-fila de un ledger va paginada (tests/paginacion-ledger.spec.ts).
    let egresos: { id: string; status: string }[]
    try {
      egresos = await fetchTodasLasFilas<{ id: string; status: string }>(
        () => supabase.from('finanzas_ledger').select('id, status').in('id', tanda),
        'suscripciones: egresos ligados'
      )
    } catch (error) {
      return { ok: false, faltanTablas: false, error }
    }
    for (const e of egresos) {
      if (e.status === 'ACTIVO') egresosActivos.add(e.id)
    }
  }

  const renglones: RenglonDeLista[] = subs.map((s) => {
    const fila = filas.get(s.id) ?? null
    const activo = fila?.id_movimiento ? egresosActivos.has(fila.id_movimiento) : false
    const estado = estadoDelMes(s, fila, hoy, activo)
    return { s, estado, montoPagado: estado === 'pagada' ? fila?.monto_pagado ?? null : null }
  })
  return {
    ok: true,
    datos: {
      subs,
      filas,
      filasAnteriores,
      anteriores: pendientesAnteriores(subs, filasAnteriores, egresosActivos, mes),
      egresosActivos,
      ultimoPagoMxn,
      renglones,
      total: totalMensual(subs, ultimoPagoMxn)
    }
  }
}
