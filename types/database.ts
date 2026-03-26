export interface Entidad {
  id: string
  nombre: string
  rol: 'ADMIN' | 'DST' | 'LOC' | 'SOCIO'
  id_padre: string | null
  zona: string
  comisiones: {
    base: number
    base_local: number
    hijo_local: number
    logistica: number
  }
}

export interface Producto {
  id: string
  sku: string
  nombre: string
  tipo: 'INSUMO' | 'TERMINADO'
  unidad_medida: string
  costo_unitario: number
}

export interface Ticket {
  id: string
  id_vendedor: string
  subtotal_catalogo: number
  total_cobrado_real: number
  monto_base_ingreso: number
  impuesto_iva_calculado: number
  impuesto_ieps_calculado: number
}

export type EstadoFinanzaLedger = 'APPROVED' | 'PENDING' | 'REJECTED'

export interface FinanzaLedger {
  id: string
  tipo_movimiento: string
  monto: number
  categoria: string | null
  categoria_gasto: string | null
  id_cuenta_destino: string | null
  id_cuenta_origen: string | null
  id_entidad_relacionada: string | null
  fecha_movimiento: string
  status: EstadoFinanzaLedger
}
