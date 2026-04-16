export const SUBCATEGORIAS = {
  GASTO_OPERATIVO: ['LOGISTICA', 'MANTENIMIENTO', 'ADMINISTRACION'],
  INGRESO_VENTA: ['MAYOREO', 'MENUDEO', 'EVENTOS'],
  INSUMOS: ['BOTELLAS', 'ETIQUETAS', 'TAPAS', 'LIQUIDOS'],
} as const;

export const CATEGORIAS_INGRESOS = [
  { value: 'Venta_Directa', label: 'Venta Directa' },
  { value: 'Venta_Red_DST', label: 'Venta Red DST' },
  { value: 'Aportacion_Capital', label: 'Aportación Capital' },
  { value: 'Abono_Deuda', label: 'Abono Deuda' }
] as const;

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
] as const;
