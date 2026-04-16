import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export default async function CatalogoPage() {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
      },
    }
  )

  const { data: productos, error } = await supabase
    .from('catalogo_productos')
    .select('id, sku, nombre, tipo')
    .order('nombre', { ascending: true })

  if (error) {
    console.error('Error fetching productos:', error)
    return <div>Error al cargar el catálogo</div>
  }
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Catálogo de Productos y Precios</h1>
      <div className="bg-white rounded-lg shadow overflow-hidden border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Producto</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Precio Público (Base)</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Precio Distribuidor (-20%)</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Precio Local (-15%)</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {productos?.map((producto) => (
              <tr key={producto.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{producto.nombre}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">$0.00</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">$0.00</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-purple-600 font-medium">$0.00</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
