export const INVENTARIO_TIPOS_MOVIMIENTO = [
  'ENTRADA_COMPRA',
  'SALIDA_VENTA',
  'PRODUCCION',
  'MERMA',
  'TRASPASO',
  'DEVOLUCION_FISICA',
  'INGRESO_TRASPASO',
  'EGRESO_TRASPASO',
  'ENTRADA_CONCESION',
  'SALIDA_CONCESION',
  'LIQUIDACION_INTERNA',
  'ANULADO',
  // v2 (2026-11-03): correccion del ADMIN, cantidad CON SIGNO hacia `id_entidad_destino`.
  'AJUSTE_INVENTARIO'
] as const

export type TipoMovimientoInventario = (typeof INVENTARIO_TIPOS_MOVIMIENTO)[number]

export const CUBETAS = ['PAGADO', 'CONSIGNADO'] as const
export type Cubeta = (typeof CUBETAS)[number]

export const TIPOS_MOVIMIENTO_ENTRADA: readonly TipoMovimientoInventario[] = [
  'ENTRADA_COMPRA',
  'PRODUCCION',
  'DEVOLUCION_FISICA',
  'INGRESO_TRASPASO',
  'ENTRADA_CONCESION',
  // v2 (2026-11-03, migracion 20261103120000): el ajuste del ADMIN suma en el destino
  // con su signo (negativo = baja el stock). Misma lista que v_stock_por_cubeta.
  'AJUSTE_INVENTARIO'
]

export const TIPOS_MOVIMIENTO_SALIDA: readonly TipoMovimientoInventario[] = [
  'SALIDA_VENTA',
  'MERMA',
  'TRASPASO',
  'EGRESO_TRASPASO',
  'SALIDA_CONCESION',
  // Si, tambien esta arriba en TIPOS_MOVIMIENTO_ENTRADA, y es a proposito.
  // Ver TIPOS_MOVIMIENTO_TRASLADO aqui abajo.
  'DEVOLUCION_FISICA'
]

/**
 * LOS TRASLADOS: una sola fila que mueve stock de una entidad a otra.
 *
 * Estan en las DOS listas de arriba y eso NO es un error de dedo: suman en
 * `id_entidad_destino` y restan en `id_entidad_origen`. Es exactamente lo que
 * hace la vista `v_stock_por_cubeta` en la base desde la migracion
 * `20260918014009`, y por eso el replay de TypeScript y el SQL siguen dando lo
 * mismo -lo prueba `tests/vistas-equivalencia.spec.ts`-.
 *
 * ERP-15, decidido el 2026-09-17: la devolucion fisica es UNA fila con las dos
 * entidades, no el par SALIDA/ENTRADA. Dos filas se pueden escribir a medias y
 * eso es justo lo que ERP-11 existe para arreglar; una fila es atomica por
 * construccion, y el CHECK `inventario_ledger_entidad_obligatoria` ya rechaza
 * la mitad.
 *
 * ⚠️ LA REGLA PARA QUIEN CONSUMA ESTAS LISTAS, Y ES LA UNICA QUE IMPORTA:
 *
 *   - Si sumas POR ENTIDAD -comparando contra `id_entidad_destino` o
 *     `id_entidad_origen`-, no tienes que hacer nada: cada lado cae en su
 *     entidad y la cuenta sale sola.
 *   - Si sumas un TOTAL GLOBAL, sin mirar entidad, **saltate los traslados**:
 *     no crean ni destruyen producto, solo lo cambian de lugar. Sumarlos infla
 *     el total. Es el unico lugar donde la doble pertenencia muerde, y esta
 *     atendido en `lib/dashboard-utils.ts`.
 *   - Si encadenas `if (entrada) ... else if (salida)`, el `else` te esconde la
 *     mitad del traslado. Decide a proposito, no por el orden de los ifs.
 */
export const TIPOS_MOVIMIENTO_TRASLADO: readonly TipoMovimientoInventario[] = [
  'DEVOLUCION_FISICA'
]

export function isTipoMovimientoEntrada(value: string | null | undefined): value is TipoMovimientoInventario {
  return Boolean(value && TIPOS_MOVIMIENTO_ENTRADA.includes(value as TipoMovimientoInventario))
}

export function isTipoMovimientoSalida(value: string | null | undefined): value is TipoMovimientoInventario {
  return Boolean(value && TIPOS_MOVIMIENTO_SALIDA.includes(value as TipoMovimientoInventario))
}

export function isTipoMovimientoTraslado(value: string | null | undefined): value is TipoMovimientoInventario {
  return Boolean(value && TIPOS_MOVIMIENTO_TRASLADO.includes(value as TipoMovimientoInventario))
}
