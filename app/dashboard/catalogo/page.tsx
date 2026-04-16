import { CATALOGO_PRODUCTOS } from '@/lib/catalog-constants';

export const dynamic = 'force-dynamic';

export default function CatalogoPage() {
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
            {CATALOGO_PRODUCTOS.map((producto) => (
              <tr key={producto.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{producto.nombre}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">${producto.precioBase.toFixed(2)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">${(producto.precioBase * 0.8).toFixed(2)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-purple-600 font-medium">${(producto.precioBase * 0.85).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
import { CATALOGO_PRODUCTOS } from '@/lib/catalog-constants';

export const dynamic = 'force-dynamic';

export default function CatalogoPage() {
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
            {CATALOGO_PRODUCTOS.map((producto) => (
              <tr key={producto.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{producto.nombre}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">${producto.precioBase.toFixed(2)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">${(producto.precioBase * 0.8).toFixed(2)}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-purple-600 font-medium">${(producto.precioBase * 0.85).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
