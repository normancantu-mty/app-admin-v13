// Paridad v2: copia de app/dashboard/ventas/page.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.
import { getServerSupabaseClient } from '@/lib/server-session'
import { leerVentasPorMes } from '@/lib/vistas'
import {
  conTendencia,
  esMesEnCurso,
  mesesEnCaida,
  nombreDelMes,
  totalVendido
} from '@/lib/ventas-mes'

// Depende de la sesion y del RLS: un DST ve lo suyo, el ADMIN ve la red.
export const dynamic = 'force-dynamic'

const pesos = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  maximumFractionDigits: 0
})

function hoyEnMexico(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date())
}

function porcentaje(valor: number): string {
  const signo = valor > 0 ? '+' : ''
  return `${signo}${(valor * 100).toFixed(0)}%`
}

export default async function VentasVista() {
  const supabase = await getServerSupabaseClient()

  let filas
  try {
    filas = await leerVentasPorMes(supabase)
  } catch (error) {
    const detalle = error instanceof Error ? error.message : 'error desconocido'
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900">Ventas por mes</h1>
        <p className="mt-4 rounded-lg bg-red-50 p-4 text-red-700">
          No se pudieron leer las ventas: {detalle}
        </p>
      </div>
    )
  }

  const hoy = hoyEnMexico()
  const renglones = conTendencia(filas).reverse()
  const racha = mesesEnCaida(filas)
  const total = totalVendido(filas)

  return (
    <div>

      <p className="mt-2 max-w-2xl text-sm text-gray-600">
        Lo vendido cada mes, sin los tickets anulados. Agrupado en{' '}
        <strong>hora de México</strong>, no en la del servidor.
      </p>

      {renglones.length === 0 ? (
        <p className="mt-6 rounded-lg bg-gray-50 p-4 text-gray-600">
          Todavía no hay ventas capturadas que puedas ver.
        </p>
      ) : (
        <>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-gray-200 p-4">
              <p className="text-xs uppercase tracking-wide text-gray-500">Vendido en total</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900">
                {pesos.format(total)}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {renglones.length} {renglones.length === 1 ? 'mes' : 'meses'} con movimiento
              </p>
            </div>

            <div className="rounded-lg border border-gray-200 p-4 sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-gray-500">Racha</p>
              {racha > 0 ? (
                <p className="mt-1 text-lg font-semibold text-amber-700">
                  {racha} {racha === 1 ? 'mes' : 'meses'} seguidos vendiendo menos que el anterior
                </p>
              ) : (
                <p className="mt-1 text-lg font-semibold text-gray-900">
                  El último mes no cayó contra el anterior
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                Ojo: esto mide <strong>venta capturada</strong>, no botellas vendidas. Un mes que se
                capturó tarde se ve igual que un mes que se vendió poco.
              </p>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="p-3 font-medium text-gray-700">Mes</th>
                  <th className="p-3 text-right font-medium text-gray-700">
                    Vendido
                  </th>
                  <th className="p-3 text-right font-medium text-gray-700">
                    vs. mes anterior
                  </th>
                  <th className="p-3 text-right font-medium text-gray-700">
                    Tickets
                  </th>
                  <th className="p-3 text-right font-medium text-gray-700">
                    Promedio
                  </th>
                  <th className="p-3 text-right font-medium text-gray-700">
                    Compradores
                  </th>
                </tr>
              </thead>
              <tbody>
                {renglones.map((fila) => {
                  const enCurso = esMesEnCurso(fila.mes, hoy)
                  return (
                    <tr key={fila.mes} className="border-t border-gray-200">
                      <td className="p-3 text-gray-900">
                        {nombreDelMes(fila.mes)}
                        {enCurso && (
                          <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">
                            en curso
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right font-semibold tabular-nums text-gray-900">
                        {pesos.format(fila.vendido)}
                      </td>
                      <td className="p-3 text-right tabular-nums">
                        {fila.cambio === null ? (
                          <span className="text-gray-400">—</span>
                        ) : (
                          <span
                            className={
                              fila.cambio < 0
                                ? 'text-red-600'
                                : 'text-green-700'
                            }
                          >
                            {pesos.format(fila.cambio)}
                            {fila.cambioRelativo !== null && (
                              <span className="ml-1 text-xs">
                                ({porcentaje(fila.cambioRelativo)})
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums text-gray-600">
                        {fila.tickets}
                        {fila.tickets_concesion > 0 && (
                          <span className="ml-1 text-xs text-gray-400">
                            ({fila.tickets_concesion} consig.)
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums text-gray-600">
                        {pesos.format(fila.ticketPromedio)}
                      </td>
                      <td className="p-3 text-right tabular-nums text-gray-600">
                        {fila.compradores}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-gray-500">
            El mes marcado <strong>en curso</strong> todavía no termina: su caída contra el mes
            pasado no es comparable hasta que cierre.
          </p>
        </>
      )}
    </div>
  )
}
