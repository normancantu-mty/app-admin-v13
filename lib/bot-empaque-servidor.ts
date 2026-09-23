/**
 * Fase 8 (D82) / Fase 9 (D92): lo que un envasado le va a hacer al inventario
 * de la matriz, y el empaque que no alcanza. Solo LEE (receta, nombres,
 * ledger): corre igual en ensayo. La usan la propuesta de lote (que bloquea si
 * falta) y la propuesta de entrada de insumo (que ofrece como candidatos
 * justo los insumos de ese envasado).
 *
 * Vivia dentro de `app/api/bot/lote/proponer/route.ts`; se mudo aqui en la
 * Fase 9 para que las dos rutas lean el MISMO stock, no dos copias.
 */

import type { ClienteServicio } from '@/lib/bot-servidor'
import { fetchTodasLasFilas } from '@/lib/paginacion'
import {
  faltantesDelEnvasado,
  movimientosDeEnvasado,
  stockDesdeLedger,
  type FaltanteEmpaque,
  type FilaLedgerStock,
  type MovimientoEnvasado
} from '@/lib/bot-envasado'

export interface InventarioDelEnvasado {
  movimientos: MovimientoEnvasado[]
  nombres: Map<string, string>
  /** Stock registrado en la matriz de cada producto movido. */
  hay: Map<string, number>
  faltantes: FaltanteEmpaque[]
  idAdmin: string | null
}

export async function inventarioDelEnvasado(
  supabase: ClienteServicio,
  envasado: readonly { id_producto: string; botellas: number }[]
): Promise<InventarioDelEnvasado> {
  if (envasado.length === 0) {
    return { movimientos: [], nombres: new Map(), hay: new Map(), faltantes: [], idAdmin: null }
  }
  const ids = envasado.map((e) => e.id_producto)
  const [{ data: receta }, { data: admin }] = await Promise.all([
    supabase
      .from('recetas_produccion')
      .select('id_producto_terminado, id_insumo, cantidad_requerida')
      .in('id_producto_terminado', ids),
    supabase.from('entidades').select('id').eq('rol', 'ADMIN').limit(1).maybeSingle()
  ])
  const movimientos = envasado.flatMap((e) =>
    movimientosDeEnvasado(
      e.id_producto,
      e.botellas,
      (receta ?? [])
        .filter((r) => r.id_producto_terminado === e.id_producto)
        .map((r) => ({ id_insumo: r.id_insumo, cantidad_requerida: Number(r.cantidad_requerida) }))
    )
  )
  const idsMovidos = [...new Set(movimientos.map((m) => m.id_producto))]
  const { data: productos } = await supabase
    .from('catalogo_productos')
    .select('id, nombre')
    .in('id', idsMovidos)
  // D92: el stock del empaque sale del LEDGER, no de `v_stock_por_cubeta` —
  // esa vista filtra TERMINADO y para un insumo siempre decia 0. Misma regla
  // que `stock_de_insumos`, que es la que manda al escribir
  // (`registrar_en_lote`). ERP-25: paginado.
  const idAdmin = admin?.id ?? null
  const filas = idAdmin
    ? await fetchTodasLasFilas<FilaLedgerStock>(
        () =>
          supabase
            .from('inventario_ledger')
            .select('id, id_producto, tipo_movimiento, cantidad, id_entidad_origen, id_entidad_destino, status')
            .in('id_producto', idsMovidos)
            .or(`id_entidad_destino.eq.${idAdmin},id_entidad_origen.eq.${idAdmin}`)
            .order('id', { ascending: true }),
        'stock del empaque'
      )
    : []
  const nombres = new Map((productos ?? []).map((p) => [p.id, p.nombre] as [string, string]))
  const hay = idAdmin ? stockDesdeLedger(filas ?? [], idAdmin) : new Map<string, number>()
  return {
    movimientos,
    nombres,
    hay,
    faltantes: faltantesDelEnvasado(movimientos, hay, nombres),
    idAdmin
  }
}
