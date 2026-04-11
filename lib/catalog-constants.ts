export const CATALOGO_PRODUCTOS = [
  {
    id: 'platino-250ml',
    nombre: 'Destilado Plata 250ml',
    precioBase: 299,
    categoria: 'INSUMOS',
    subcategoria: 'PLATINOS',
    taxType: 'FULL_TAX' as const,
  },
  {
    id: 'platino-750ml',
    nombre: 'Destilado Plata 750ml',
    precioBase: 480,
    categoria: 'INSUMOS',
    subcategoria: 'PLATINOS', 
    taxType: 'FULL_TAX' as const,
  }
] as const;

export const SUBCATEGORIAS = {
  GASTO_OPERATIVO: ['LOGISTICA', 'MANTENIMIENTO', 'ADMINISTRACION'],
  INGRESO_VENTA: ['MAYOREO', 'MENUDEO', 'EVENTOS'],
  INSUMOS: ['BOTELLAS', 'ETIQUETAS', 'TAPAS', 'LIQUIDOS'],
} as const;
