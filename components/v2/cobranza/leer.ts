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
import { esDeudaConLaMatriz, ordenarCartera, type FilaCarteraVista } from '@/lib/vistas'
import { bandaDe, type FilaCobranza } from './semaforo'

type Cliente = SupabaseClient<Database>
// `es_entrega_efectivo` no esta en `types/database.ts`: se lee sin tipos y se tipa aqui.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const libre = (c: Cliente) => c as unknown as SupabaseClient<any>

export interface FilaAbono {
  id_entidad_relacionada: string | null
  monto: number
  fecha_movimiento: string | null
  categoria: string | null
  status: string | null
  es_entrega_efectivo: boolean | null
}

/**
 * Las filas ABONO_DEUDA de los nodos dados, o de TODOS si no se dan ids: sin ids
 * la lectura no depende de `v_cartera` y sale en la misma tanda (perf 2026-10-30).
 * El filtro fino (fecha del ultimo abono, ANULADO, pendiente, D112) lo hace
 * `montosUltimoAbono`, igual en los dos casos.
 */
export async function leerAbonos(client: Cliente, ids?: string[]): Promise<FilaAbono[]> {
  if (ids && ids.length === 0) return []
  return fetchTodasLasFilas<FilaAbono>(() => {
    const q = libre(client)
      .from('finanzas_ledger')
      .select('id_entidad_relacionada, monto, fecha_movimiento, categoria, status, es_entrega_efectivo')
      .eq('tipo_movimiento', 'ABONO_DEUDA')
    return (ids ? q.in('id_entidad_relacionada', ids) : q).order('id')
  }, 'finanzas_ledger (abonos)')
}

/** Monto del ultimo abono por nodo, con la fecha que ya dio `v_cartera`. Leer ya hecho: no consulta. */
export function montosUltimoAbono(cartera: FilaCarteraVista[], filas: FilaAbono[]): Map<string, number> {
  const fechaPorNodo = new Map<string, number>()
  for (const f of cartera) if (f.ultimo_abono) fechaPorNodo.set(f.id_entidad, new Date(f.ultimo_abono).getTime())
  const montos = new Map<string, number>()
  if (fechaPorNodo.size === 0) return montos
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

/** Monto del ultimo abono por nodo: lee solo los abonos de los nodos que tienen fecha de ultimo abono. */
export async function leerMontosUltimoAbono(client: Cliente, cartera: FilaCarteraVista[]): Promise<Map<string, number>> {
  const ids = [...new Set(cartera.filter((f) => f.ultimo_abono).map((f) => f.id_entidad))]
  if (ids.length === 0) return new Map()
  return montosUltimoAbono(cartera, await leerAbonos(client, ids))
}

/**
 * El renglon (o renglones) de `v_cartera` de UN nodo, en el orden de `ordenarCartera`.
 * Lo mismo que filtrar `leerCartera` por `id_entidad`, sin traer la red entera.
 */
export async function leerCarteraDeNodo(client: Cliente, id: string): Promise<FilaCarteraVista[]> {
  const filas = await fetchTodasLasFilas<FilaCarteraVista>(
    () => libre(client).from('v_cartera').select('*').eq('id_entidad', id),
    'v_cartera (nodo)'
  )
  return ordenarCartera(filas)
}

export interface FilaEntrega {
  id_entidad_destino: string | null
  fecha_movimiento: string | null
  status: string | null
}

/**
 * Todas las filas ENTRADA_CONCESION. Sin filtro por nodo a proposito: asi no
 * depende de `v_cartera` y el panel la pide en la misma tanda que el tablero
 * (perf 2026-10-30). `v_cartera` calcula `ultima_entrega` en su CTE `piso` pero
 * NO la expone en su SELECT final (migracion 20261029120000; columnas verificadas
 * en la base local el 2026-10-30), por eso esta lectura sigue existiendo.
 */
async function leerEntregasConcesion(client: Cliente): Promise<FilaEntrega[]> {
  return fetchTodasLasFilas<FilaEntrega>(
    () =>
      libre(client)
        .from('inventario_ledger')
        .select('id_entidad_destino, fecha_movimiento, status')
        .eq('tipo_movimiento', 'ENTRADA_CONCESION')
        .order('id'),
    'inventario_ledger (entregas a concesion)'
  )
}

/**
 * Fecha de la ultima entrega a concesion de cada nodo de `ids`. La misma regla que
 * `piso.ultima_entrega` de `v_cartera` (migracion 20261029120000):
 * ENTRADA_CONCESION hacia el nodo, sin las ANULADO. Leer ya hecho: no consulta.
 */
export function ultimasEntregas(filas: FilaEntrega[], ids: string[]): Map<string, string> {
  const pedidos = new Set(ids)
  const ultima = new Map<string, string>()
  for (const e of filas) {
    if (!e.id_entidad_destino || !e.fecha_movimiento) continue
    if (!pedidos.has(e.id_entidad_destino)) continue
    if ((e.status ?? 'ACTIVO') === 'ANULADO') continue
    const previa = ultima.get(e.id_entidad_destino)
    if (!previa || new Date(e.fecha_movimiento).getTime() > new Date(previa).getTime()) ultima.set(e.id_entidad_destino, e.fecha_movimiento)
  }
  return ultima
}

/** Lo que la card «A quién cobrar» lee aparte de `v_cartera`, crudo y sin esperarla. */
export interface CrudoCobranzaPanel {
  abonos: FilaAbono[]
  entregas: FilaEntrega[]
}

/**
 * Abonos y entregas a concesion de toda la red, en paralelo. El panel lo pide en
 * el MISMO `Promise.all` que `leerTablero` (antes salia despues, cuando la card
 * ya tenia `v_cartera`: un viaje mas en serie). El recorte por nodo lo hacen
 * `montosUltimoAbono` y `ultimasEntregas`: mismas cifras.
 */
export async function leerCrudoCobranzaPanel(client: Cliente): Promise<CrudoCobranzaPanel> {
  const [abonos, entregas] = await Promise.all([leerAbonos(client), leerEntregasConcesion(client)])
  return { abonos, entregas }
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
