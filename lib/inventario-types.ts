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
  'ANULADO'
] as const

export type TipoMovimientoInventario = (typeof INVENTARIO_TIPOS_MOVIMIENTO)[number]

export const CUBETAS = ['PAGADO', 'CONSIGNADO'] as const
export type Cubeta = (typeof CUBETAS)[number]

export const TIPOS_MOVIMIENTO_ENTRADA: readonly TipoMovimientoInventario[] = [
  'ENTRADA_COMPRA',
  'PRODUCCION',
  'DEVOLUCION_FISICA',
  'INGRESO_TRASPASO',
  'ENTRADA_CONCESION'
]

export const TIPOS_MOVIMIENTO_SALIDA: readonly TipoMovimientoInventario[] = [
  'SALIDA_VENTA',
  'MERMA',
  'TRASPASO',
  'EGRESO_TRASPASO',
  'SALIDA_CONCESION'
]

export function isTipoMovimientoEntrada(value: string | null | undefined): value is TipoMovimientoInventario {
  return Boolean(value && TIPOS_MOVIMIENTO_ENTRADA.includes(value as TipoMovimientoInventario))
}

export function isTipoMovimientoSalida(value: string | null | undefined): value is TipoMovimientoInventario {
  return Boolean(value && TIPOS_MOVIMIENTO_SALIDA.includes(value as TipoMovimientoInventario))
}
