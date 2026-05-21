'use client'

interface CategoryBreakdownProps {
  categorias: Array<{
    categoria: string
    monto: number
    porcentaje: number
  }>
}

export function CategoryBreakdown({ categorias }: CategoryBreakdownProps) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
      <h3 className="text-lg font-semibold text-gray-800 mb-4">Desglose por Categoría</h3>
      <div className="space-y-4">
        {categorias.map((item) => (
          <div key={item.categoria} className="space-y-1">
            <div className="flex justify-between text-sm">
              <span className="font-medium text-gray-700">{item.categoria}</span>
              <span className="text-gray-500">
                {new Intl.NumberFormat('es-MX', {
                  style: 'currency',
                  currency: 'MXN'
                }).format(item.monto)} ({item.porcentaje}%)
              </span>
            </div>
            <div className="h-2 w-full bg-gray-200 rounded-full">
              <div 
                className="h-2 rounded-full bg-blue-600" 
                style={{ width: `${item.porcentaje}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
