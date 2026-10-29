import Link from 'next/link'
import AuditFeed from '@/components/dashboard/AuditFeed'
import {
  getFinanzasDashboard,
  getLiderazgoRed,
  getAspectosUrgentes,
  calcularFechasPorRango,
  getLiquidezPorCuenta,
  getTransferenciasResumen,
  DIAS_SEMAFORO_AMARILLO,
  DIAS_SEMAFORO_ROJO
} from '@/lib/dashboard-utils'
import { getCurrentUser } from '@/lib/auth-utils'
import TransferenciasCard from '@/components/dashboard/TransferenciasCard'

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN'
  }).format(amount)
}

// Mismo umbral que el directorio (`getSemaforoMovimiento`): 7 / 14 dias.
// Antes esta pantalla usaba 15 / 30 y pintaba de verde a un nodo que el
// directorio ya tenia en rojo, el mismo dia.
function getTrafficLightColor(dias: number): string {
  if (dias > DIAS_SEMAFORO_ROJO) return 'bg-red-500'
  if (dias >= DIAS_SEMAFORO_AMARILLO) return 'bg-yellow-500'
  return 'bg-green-500'
}



export const dynamic = 'force-dynamic'

import { cookies } from 'next/headers'

export default async function DashboardGeneralPage() {
  const cookieStore = await cookies()
  const rango = cookieStore.get('global_rango')?.value || 'ESTE_MES'
  const { fechaInicio, fechaFin } = calcularFechasPorRango(rango)

  // `getLiderazgoRed` se calcula UNA vez y se pasa a `getAspectosUrgentes`:
  // antes corria dos veces por carga y se traia tickets y ledger completos 2x.
  // Se le pasa la PROMESA, no el resultado: sus propias lecturas arrancan ya,
  // en paralelo con las demas, en lugar de esperar al liderazgo.
  const liderazgoPromesa = getLiderazgoRed()
  const [finanzasPeriodo, liderazgoHistorico, currentUser, liquidezHistorica, urgentes, transferencias] = await Promise.all([
    getFinanzasDashboard(fechaInicio, fechaFin),
    liderazgoPromesa,
    getCurrentUser(),
    getLiquidezPorCuenta(),
    getAspectosUrgentes(liderazgoPromesa),
    getTransferenciasResumen()
  ])

  const canMutate = currentUser?.rol !== 'SOCIO'

  const calcularPorcentaje = (valor: number, total: number) => {
    return total > 0 ? Math.round((valor / total) * 100) : 0
  }

  const pctVentaRed = calcularPorcentaje(finanzasPeriodo.desgloseIngresos.ventaRed, finanzasPeriodo.totalIngresos)
  const pctVentaDirecta = calcularPorcentaje(finanzasPeriodo.desgloseIngresos.ventaDirecta, finanzasPeriodo.totalIngresos)
  const pctAbonos = calcularPorcentaje(finanzasPeriodo.desgloseIngresos.abonos, finanzasPeriodo.totalIngresos)

  const pctInsumos = calcularPorcentaje(finanzasPeriodo.desgloseEgresos.insumos, finanzasPeriodo.totalEgresos)
  const pctRenta = calcularPorcentaje(finanzasPeriodo.desgloseEgresos.renta, finanzasPeriodo.totalEgresos)
  const pctLogistica = calcularPorcentaje(finanzasPeriodo.desgloseEgresos.logistica, finanzasPeriodo.totalEgresos)

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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide font-semibold text-gray-500">Liquidez Efectivo</p>
          <p className="text-2xl font-bold text-gray-900 mt-2">{formatCurrency(liquidezHistorica.EFECTIVO)}</p>
          <p className="text-xs text-gray-500 mt-1">Cuenta: EFECTIVO</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide font-semibold text-gray-500">Liquidez Cuenta Gilberto</p>
          <p className="text-2xl font-bold text-gray-900 mt-2">{formatCurrency(liquidezHistorica.CUENTA_PERSONAL)}</p>
          <p className="text-xs text-gray-500 mt-1">Cuenta: Cuenta Gilberto</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide font-semibold text-gray-500">Liquidez Fresnillo</p>
          <p className="text-2xl font-bold text-gray-900 mt-2">{formatCurrency(liquidezHistorica.CUENTA_FRESNILLO)}</p>
          <p className="text-xs text-gray-500 mt-1">Cuenta: CUENTA_FRESNILLO</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
          <p className="text-xs uppercase tracking-wide font-semibold text-gray-500">Liquidez Transferencias</p>
          <p className="text-2xl font-bold text-gray-900 mt-2">{formatCurrency(liquidezHistorica.TRANSFERENCIAS)}</p>
          <p className="text-xs text-gray-500 mt-1">Cuenta: TRANSFERENCIAS</p>
        </div>
      </div>

      {transferencias && <TransferenciasCard resumen={transferencias} canMutate={canMutate} />}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* COLUMNA IZQUIERDA - 75% (3 de 4 columnas) */}
        <div className="md:col-span-3 space-y-6">
          

          {/* FINANZAS - 2 Tarjetas con Mini-Barras */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200 p-6">
            <h2 className="text-xl font-semibold text-gray-800 mb-6">💰 Finanzas</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Ingresos */}
              <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                <h3 className="text-sm font-medium text-green-800 mb-2">Ingresos</h3>
                <p className="text-3xl font-bold text-green-900 mb-1">{formatCurrency(finanzasPeriodo.totalIngresos)}</p>
                <p className="text-xs text-green-800 mb-3">En este periodo</p>
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
                <p className="text-3xl font-bold text-red-900 mb-1">{formatCurrency(finanzasPeriodo.totalEgresos)}</p>
                <p className="text-xs text-red-800 mb-3">En este periodo</p>
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
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">🌟 Liderazgo de Red (Nodos Alfa)</h2>
              <p className="text-sm text-gray-500">Distribuidores y Locales Directos</p>
            </div>
            <div className="hidden w-full overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entidad</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ingreso Neto Empresa</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Saldo Pendiente (consignación)</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Última Actividad</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {liderazgoHistorico.nodosAlfa.map((nodo) => (
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
                        {formatCurrency(nodo.saldoPendiente)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-1 gap-4 p-4 md:hidden">
              {liderazgoHistorico.nodosAlfa.map((nodo) => (
                <div key={nodo.id} className="space-y-3 rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
                  <div className="flex items-start gap-2">
                    <div className={`mt-1 h-3 w-3 shrink-0 rounded-full ${getTrafficLightColor(nodo.diasSinActividad)}`} />
                    <div>
                      <p className="text-xs font-medium text-gray-500">Entidad</p>
                      <p className="text-base font-semibold text-gray-900">{nodo.nombre}</p>
                      <p className="text-xs text-gray-500">{nodo.rol} — Línea Directa</p>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Ingreso Neto Empresa:</span>
                      <span className="font-semibold text-green-600">{formatCurrency(nodo.ingresoNetoEmpresa)}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Saldo Pendiente (consignación):</span>
                      <span className="text-gray-900">{formatCurrency(nodo.saldoPendiente)}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Última Actividad:</span>
                      <span className="text-gray-600">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* LIDERAZGO DE RED - Sub-nodos (Con Patrocinador) */}
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-200">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">🔗 Liderazgo de Red (Sub-nodos)</h2>
              <p className="text-sm text-gray-500">Locales con Patrocinador</p>
            </div>
            <div className="hidden w-full overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Entidad</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Ingreso Neto Empresa</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Saldo Pendiente (consignación)</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Última Actividad</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {liderazgoHistorico.subNodos.map((nodo) => (
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
                        {formatCurrency(nodo.saldoPendiente)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-1 gap-4 p-4 md:hidden">
              {liderazgoHistorico.subNodos.map((nodo) => (
                <div key={nodo.id} className="space-y-3 rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:border dark:border-gray-700 dark:text-gray-200">
                  <div className="flex items-start gap-2">
                    <div className={`mt-1 h-3 w-3 shrink-0 rounded-full ${getTrafficLightColor(nodo.diasSinActividad)}`} />
                    <div>
                      <p className="text-xs font-medium text-gray-500">Entidad</p>
                      <p className="text-base font-semibold text-gray-900">{nodo.nombre}</p>
                      <p className="text-xs text-gray-500">
                        {nodo.rol} — Patrocinado por {nodo.patrocinador}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Ingreso Neto Empresa:</span>
                      <span className="font-semibold text-green-600">{formatCurrency(nodo.ingresoNetoEmpresa)}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Saldo Pendiente (consignación):</span>
                      <span className="text-gray-900">{formatCurrency(nodo.saldoPendiente)}</span>
                    </p>
                    <p className="flex justify-between gap-2">
                      <span className="font-medium text-gray-500">Última Actividad:</span>
                      <span className="text-gray-600">
                        {nodo.diasSinActividad < 999 ? `Hace ${nodo.diasSinActividad} días` : 'Sin actividad'}
                      </span>
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* COLUMNA DERECHA - 25% (1 de 4 columnas) */}
        <div className="md:col-span-1 space-y-6">
          
          {/* ASPECTOS URGENTES - Alertas Consolidadas */}
          <div className="bg-white rounded-lg shadow-sm border-2 border-yellow-400 p-6 dark:bg-gray-800 dark:border-yellow-600 dark:text-gray-200">
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
                        <p className="text-xs text-red-600 font-semibold">Consignación: {formatCurrency(semaforo.saldoPendiente)}</p>
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
                        <p className="text-xs text-yellow-600 font-semibold">Consignación: {formatCurrency(semaforo.saldoPendiente)}</p>
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
