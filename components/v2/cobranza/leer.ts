/**
 * Cobranza v2 — lecturas de servidor (SOLO LECTURA). Escrito el 2026-10-30 por un
 * ejecutor del Socio.
 *
 * `v_cartera` trae la fecha del ultimo abono (`ultimo_abono`) pero no su monto.
 * El monto se lee de `finanzas_ledger` con EL MISMO filtro que la vista usa para
 * `abonado` y `ultimo_abono` (migracion 20261029120000, CTE `ajustes`):
 * ABONO_DEUDA, status distinto de ANULADO, categoria distinta de ABONO_PENDIENTE
 * y sin las entregas de efectivo (D112). Si un abono se capturo en varias filas
 * con la misma fecha (p. ej. dos filas del mismo abono), se suman.
 *
 * Falla cerrada, como el resto de la v2: un error de lectura se lanza.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import { esDeudaConLaMatriz, type FilaCarteraVista } from '@/lib/vistas'
import { bandaDe, type FilaCobranza } from './semaforo'

type Cliente = SupabaseClient<Database>
// `es_entrega_efectivo` no esta en `types/database.ts`: se lee sin tipos y se tipa aqui.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const libre = (c: Cliente) => c as unknown as SupabaseClient<any>

interface FilaAbono {
  id_entidad_relacionada: string | null
  monto: number
  fecha_movimiento: string | null
  categoria: string | null
  status: string | null
  es_entrega_efectivo: boolean | null
}

/** Monto del ultimo abono por nodo, con la fecha que ya dio `v_cartera`. */
export async function leerMontosUltimoAbono(client: Cliente, cartera: FilaCarteraVista[]): Promise<Map<string, number>> {
  const fechaPorNodo = new Map<string, number>()
  for (const f of cartera) if (f.ultimo_abono) fechaPorNodo.set(f.id_entidad, new Date(f.ultimo_abono).getTime())
  const montos = new Map<string, number>()
  if (fechaPorNodo.size === 0) return montos
  const filas = await fetchTodasLasFilas<FilaAbono>(
    () =>
      libre(client)
        .from('finanzas_ledger')
        .select('id_entidad_relacionada, monto, fecha_movimiento, categoria, status, es_entrega_efectivo')
        .eq('tipo_movimiento', 'ABONO_DEUDA')
        .in('id_entidad_relacionada', [...fechaPorNodo.keys()])
        .order('id'),
    'finanzas_ledger (abonos)'
  )
  for (const a of filas) {
    if (!a.id_entidad_relacionada || !a.fecha_movimiento) continue
    if ((a.status ?? 'ACTIVO') === 'ANULADO') continue
    if (a.categoria === 'ABONO_PENDIENTE') continue
    if (a.es_entrega_efectivo) continue
    if (new Date(a.fecha_movimiento).getTime() !== fechaPorNodo.get(a.id_entidad_relacionada)) continue
    montos.set(a.id_entidad_relacionada, (montos.get(a.id_entidad_relacionada) ?? 0) + Number(a.monto))
  }
  return montos
}

interface FilaEntrega {
  id_entidad_destino: string | null
  fecha_movimiento: string | null
  status: string | null
}

/**
 * Fecha de la ultima entrega a concesion por nodo. La misma regla que
 * `v_cartera.ultima_entrega` (migracion 20261029120000, CTE `piso`):
 * ENTRADA_CONCESION hacia el nodo, sin las ANULADO. Solo lectura; el panel la
 * pide en paralelo con el monto del ultimo abono.
 */
export async function leerUltimasEntregas(client: Cliente, ids: string[]): Promise<Map<string, string>> {
  const ultima = new Map<string, string>()
  if (ids.length === 0) return ultima
  const filas = await fetchTodasLasFilas<FilaEntrega>(
    () =>
      libre(client)
        .from('inventario_ledger')
        .select('id_entidad_destino, fecha_movimiento, status')
        .eq('tipo_movimiento', 'ENTRADA_CONCESION')
        .in('id_entidad_destino', ids)
        .order('id'),
    'inventario_ledger (entregas a concesion)'
  )
  for (const e of filas) {
    if (!e.id_entidad_destino || !e.fecha_movimiento) continue
    if ((e.status ?? 'ACTIVO') === 'ANULADO') continue
    const previa = ultima.get(e.id_entidad_destino)
    if (!previa || new Date(e.fecha_movimiento).getTime() > new Date(previa).getTime()) ultima.set(e.id_entidad_destino, e.fecha_movimiento)
  }
  return ultima
}

/**
 * Las filas con deuda > 0, en el orden del ERP (`v_cartera` ya viene ordenada por
 * `ordenarCartera`: deuda x dias, deuda, nombre).
 */
export function armarFilasCobranza(
  cartera: FilaCarteraVista[],
  montos: Map<string, number>,
  nombres?: Map<string, { nombre: string }>,
  entregas?: Map<string, string>
): FilaCobranza[] {
  return cartera
    .filter((f) => Number(f.deuda) > 0)
    .map((f) => {
      const dias = f.dias_sin_abono === null || f.dias_sin_abono === undefined ? null : Number(f.dias_sin_abono)
      const conMatriz = esDeudaConLaMatriz(f)
      return {
        id: f.id_entidad,
        nombre: f.nombre,
        rol: f.rol,
        deuda: Number(f.deuda),
        generado: Number(f.generado),
        abonado: Number(f.abonado),
        // La vista trae FRACCION 0-1 (E-243): se multiplica aqui, una sola vez.
        pct: f.porcentaje_pagado === null || f.porcentaje_pagado === undefined ? null : Math.round(Number(f.porcentaje_pagado) * 100),
        dias,
        referencia: f.referencia_dias,
        ultimoAbono: f.ultimo_abono,
        ultimoAbonoMonto: f.ultimo_abono ? montos.get(f.id_entidad) ?? null : null,
        ultimaEntrega: entregas?.get(f.id_entidad) ?? null,
        enPiso: Number(f.estimado_en_piso),
        recibidas: Number(f.recibidas),
        prioridad: Number(f.prioridad),
        banda: bandaDe(dias),
        acreedor: conMatriz ? null : (f.id_acreedor && nombres?.get(f.id_acreedor)?.nombre) || 'su distribuidor'
      }
    })
}
