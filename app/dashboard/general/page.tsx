import Link from 'next/link'
import DateFilter from '@/components/dashboard/DateFilter'
import AuditFeed from '@/components/dashboard/AuditFeed'
import { getFinanzasDashboard, getLiderazgoRed, getAspectosUrgentes } from '@/lib/dashboard-utils'
import { getCurrentUser } from '@/lib/auth-utils'

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

function getTrafficLightColor(dias: number): string {
  if (dias > 30) return 'bg-red-500'
  if (dias > 15) return 'bg-yellow-500'
  return 'bg-green-500'
}


function calcularFechasPorRango(rango: string) {
  const hoy = new Date()
  const inicioMes = new Date(hoy.getFullYear(), hoy.getMonth(), 1)
  
  switch (rango) {
    case 'HOY':
      return {
        fechaInicio: hoy.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    case 'ESTE_MES':
      return {
        fechaInicio: inicioMes.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    case 'TRIMESTRE':
      const inicioTrimestre = new Date(hoy.getFullYear(), hoy.getMonth() - 2, 1)
      return {
        fechaInicio: inicioTrimestre.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
    default:
      return {
        fechaInicio: inicioMes.toISOString().split('T')[0],
        fechaFin: hoy.toISOString().split('T')[0]
      }
  }
}

export const dynamic = 'force-dynamic'

import { cookies } from 'next/headers'

export default async function DashboardGeneralPage() {
  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)

  const [finanzas, liderazgo, urgentes, currentUser] = await Promise.all([
    getFinanzasDashboard(fechaInicio, fechaFin),
    getLiderazgoRed(fechaInicio, fechaFin),
    getAspectosUrgentes(),
    getCurrentUser()
  ])

  const canMutate = currentUser?.rol !== 'SOCIO'

  const calcularPorcentaje = (valor: number, total: number) => {
    return total > 0 ? Math.round((valor / total) * 100) : 0
  }

  const pctVentaRed = calcularPorcentaje(finanzas.desgloseIngresos.ventaRed, finanzas.totalIngresos)
  const pctVentaDirecta = calcularPorcentaje(finanzas.desgloseIngresos.ventaDirecta, finanzas.totalIngresos)
  const pctAbonos = calcularPorcentaje(finanzas.desgloseIngresos.abonos, finanzas.totalIngresos)

  const pctInsumos = calcularPorcentaje(finanzas.desgloseEgresos.insumos, finanzas.totalEgresos)
  const pctRenta = calcularPorcentaje(finanzas.desgloseEgresos.renta, finanzas.totalEgresos)
  const pctLogistica = calcularPorcentaje(finanzas.desgloseEgresos.logistica, finanzas.totalEgresos)

  return (
    <div className="p-8 space-y-6">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-800">Dashboard</h1>
        {canMutate && (
          <div className="flex gap-2">
            <Link
              href="/pos"
              className="bg-slate-800 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-slate-900"
            >
              📦 Ir al POS
            </Link>
            <Link
              href="/dashboard/finanzas/nuevo"
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700"
            >
              + Nuevo Movimiento
            </Link>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* COLUMNA IZQUIERDA - 75% (3 de 4 columnas) */}
        <div className="md:col-span-3 space-y-6">
          

          {/* FINANZAS - 2 Tarjetas con Mini-Barras */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">💰 Finanzas</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Ingresos */}
              <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                <h3 className="text-sm font-medium text-green-800 mb-2">Ingresos</h3>
                <p className="text-3xl font-bold text-green-900 mb-4">{formatCurrency(finanzas.totalIngresos)}</p>
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Venta Red</span>
                      <span>{pctVentaRed}%</span>
                    </div>
                    <div className="w-full bg-green-200 rounded-full h-2">
                      <div className="bg-green-600 h-2 rounded-full" style={{ width: `${pctVentaRed}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Venta Directa</span>
                      <span>{pctVentaDirecta}%</span>
                    </div>
                    <div className="w-full bg-green-200 rounded-full h-2">
                      <div className="bg-green-600 h-2 rounded-full" style={{ width: `${pctVentaDirecta}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Abonos</span>
                      <span>{pctAbonos}%</span>
                    </div>
                    <div className="w-full bg-green-200 rounded-full h-2">
                      <div className="bg-green-600 h-2 rounded-full" style={{ width: `${pctAbonos}%` }}></div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Egresos */}
              <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                <h3 className="text-sm font-medium text-red-800 mb-2">Egresos</h3>
                <p className="text-3xl font-bold text-red-900 mb-4">{formatCurrency(finanzas.totalEgresos)}</p>
                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Insumos</span>
                      <span>{pctInsumos}%</span>
                    </div>
                    <div className="w-full bg-red-200 rounded-full h-2">
                      <div className="bg-red-600 h-2 rounded-full" style={{ width: `${pctInsumos}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Renta</span>
                      <span>{pctRenta}%</span>
                    </div>
                    <div className="w-full bg-red-200 rounded-full h-2">
                      <div className="bg-red-600 h-2 rounded-full" style={{ width: `${pctRenta}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs text-gray-600 mb-1">
                      <span>Logística</span>
                      <span>{pctLogistica}%</span>
                    </div>
                    <div className="w-full bg-red-200 rounded-full h-2">
                      <div className="bg-red-600 h-2 rounded-full" style={{ width: `${pctLogistica}%` }}></div>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </div>

          {/* LIDERAZGO DE RED - Nodos Alfa (Directos) */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">🌟 Liderazgo de Red (Nodos Alfa)</h2>
              <p className="text-sm text-gray-500">Distribuidores y Locales Directos</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entidad</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ingreso Neto Empresa</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Deuda Actual</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Última Actividad</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {liderazgo.nodosAlfa.map((nodo) => (
                    <tr key={nodo.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className={`h-3 w-3 rounded-full ${getTrafficLightColor(nodo.diasSinActividad)}`}></div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">{nodo.nombre}</div>
                            <div className="text-xs text-gray-500">{nodo.rol} - Línea Directa</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-green-600">
                        {formatCurrency(nodo.ingresoNetoEmpresa)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatCurrency(nodo.deudaActual)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* LIDERAZGO DE RED - Sub-nodos (Con Patrocinador) */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">🔗 Liderazgo de Red (Sub-nodos)</h2>
              <p className="text-sm text-gray-500">Locales con Patrocinador</p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entidad</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ingreso Neto Empresa</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Deuda Actual</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Última Actividad</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {liderazgo.subNodos.map((nodo) => (
                    <tr key={nodo.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <div className={`h-3 w-3 rounded-full ${getTrafficLightColor(nodo.diasSinActividad)}`}></div>
                          <div>
                            <div className="text-sm font-medium text-gray-900">{nodo.nombre}</div>
                            <div className="text-xs text-gray-500">{nodo.rol} - Patrocinado por {nodo.patrocinador}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-semibold text-green-600">
                        {formatCurrency(nodo.ingresoNetoEmpresa)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {formatCurrency(nodo.deudaActual)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>

        {/* COLUMNA DERECHA - 25% (1 de 4 columnas) */}
        <div className="md:col-span-1 space-y-6">
          
          {/* ASPECTOS URGENTES - Alertas Consolidadas */}
          <div className="bg-white rounded-lg shadow-sm border-2 border-yellow-400 p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">⚠️ Aspectos Urgentes</h2>
            <div className="space-y-3">
              
              {/* Semáforos Rojos */}
              {urgentes.semaforosRojos.length > 0 && (
                <div className="border-l-4 border-red-500 pl-3 py-2">
                  <p className="text-sm font-semibold text-red-900">🔴 Semáforos Rojos</p>
                  <div className="mt-2 space-y-2">
                    {urgentes.semaforosRojos.map((semaforo) => (
                      <div key={semaforo.id} className="p-2 bg-red-50 rounded">
                        <p className="text-xs font-medium text-red-900">{semaforo.nombre}</p>
                        <p className="text-xs text-red-700">{semaforo.diasSinActividad} días sin actividad</p>
                        <p className="text-xs text-red-600 font-semibold">Deuda: {formatCurrency(semaforo.deudaActual)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Semáforos Amarillos */}
              {urgentes.semaforosAmarillos.length > 0 && (
                <div className="border-l-4 border-yellow-500 pl-3 py-2">
                  <p className="text-sm font-semibold text-yellow-900">� Semáforos Amarillos</p>
                  <div className="mt-2 space-y-2">
                    {urgentes.semaforosAmarillos.map((semaforo) => (
                      <div key={semaforo.id} className="p-2 bg-yellow-50 rounded">
                        <p className="text-xs font-medium text-yellow-900">{semaforo.nombre}</p>
                        <p className="text-xs text-yellow-700">{semaforo.diasSinActividad} días sin actividad</p>
                        <p className="text-xs text-yellow-600 font-semibold">Deuda: {formatCurrency(semaforo.deudaActual)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Inventario Crítico */}
              {urgentes.alertasInventario.length > 0 && (
                <div className="border-l-4 border-orange-500 pl-3 py-2">
                  <p className="text-sm font-semibold text-orange-900">📦 Inventario Crítico</p>
                  <div className="mt-2 space-y-2">
                    {urgentes.alertasInventario.map((alerta) => (
                      <div key={alerta.id} className="p-2 bg-orange-50 rounded">
                        <p className="text-xs font-medium text-orange-900">{alerta.nombre}</p>
                        <p className="text-xs text-orange-700">
                          {alerta.stockActual === 0 
                            ? 'Stock agotado' 
                            : `${alerta.stockActual} unidades (mín: ${alerta.minimoRequerido})`
                          }
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* AUDIT FEED - Natural Language Timeline with Pagination */}
          <AuditFeed />

        </div>
      </div>
    </div>
  )
}
