const SUBCATEGORIAS_GASTO_OPERATIVO = ['LOGISTICA', 'MANTENIMIENTO', 'ADMINISTRACION'] as const
const SUBCATEGORIAS_INGRESO_VENTA = ['MAYOREO', 'MENUDEO', 'EVENTOS'] as const
const SUBCATEGORIAS_INSUMOS = ['BOTELLAS', 'ETIQUETAS', 'TAPAS', 'LIQUIDOS'] as const

export const SUBCATEGORIAS = {
  GASTO_OPERATIVO: SUBCATEGORIAS_GASTO_OPERATIVO,
  INGRESO_VENTA: SUBCATEGORIAS_INGRESO_VENTA,
  INSUMOS: SUBCATEGORIAS_INSUMOS,
  Compra_Insumos: SUBCATEGORIAS_INSUMOS,
  Venta_Directa: SUBCATEGORIAS_INGRESO_VENTA,
  Logistica_Envios: SUBCATEGORIAS_GASTO_OPERATIVO,
} as const

export const CATEGORIAS_INGRESOS = [
  { value: 'Venta_Directa', label: 'Venta Directa' },
  { value: 'Venta_Red_DST', label: 'Venta Red DST' },
  { value: 'Aportacion_Capital', label: 'Aportación Capital' },
  { value: 'Abono_Deuda', label: 'Abono Deuda' }
] as const

export const CATEGORIAS_EGRESOS = [
  { value: 'Compra_Insumos', label: 'Compra Insumos' },
  { value: 'Nomina_y_Honorarios', label: 'Nómina y Honorarios' },
  { value: 'Logistica_Envios', label: 'Logística Envíos' },
  { value: 'Marketing_y_Relaciones', label: 'Marketing y Relaciones' },
  { value: 'Servicios_Basicos', label: 'Servicios Básicos' },
  { value: 'Fuga_Fiscal_IVA', label: 'Fuga Fiscal IVA' },
  { value: 'Fuga_Fiscal_IEPS', label: 'Fuga Fiscal IEPS' },
  { value: 'Gastos_Personales_Socio', label: 'Gastos Personales Socio' },
  { value: 'Ajuste_Caja', label: 'Ajuste Caja' }
] as const
