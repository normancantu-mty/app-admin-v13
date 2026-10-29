import Link from 'next/link'
import { notFound } from 'next/navigation'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { getCurrentUser } from '@/lib/auth-utils'
import { leerCartera, totalesCarteraVista, type FilaCarteraVista } from '@/lib/vistas'

/**
 * Cartera — a quien visitar, cuanto tiene y cuanto debe.
 *
 * Solo lectura: esta pantalla no escribe una sola fila.
 *
 * **La aritmetica ya no vive aqui.** Antes esta pantalla se traia cuatro tablas
 * completas —entidades, inventario_ledger, transacciones_tickets y
 * finanzas_ledger— y armaba las once filas en memoria con `construirCartera`.
 * Ahora lee `v_cartera`, que hace exactamente lo mismo dentro de Postgres:
 * **una consulta en vez de cuatro**, y la misma cifra al centavo (lo prueban
 * `tests/vistas-equivalencia.spec.ts` y `tests/cableado-pantallas.spec.ts`).
 *
 * `construirCartera` NO se borro: sigue siendo la referencia contra la que esas
 * pruebas comparan la vista. Que quede sin usar por las pantallas es el punto.
 *
 * Dos reglas que no se negocian aqui:
 *
 * 1. El cliente de Supabase se arma con `createServerClient` + cookies. El
 *    `@/lib/supabase` del proyecto es un `createBrowserClient`: en un Server
 *    Component viaja sin sesion, consulta como `anon` y —desde que se cerro la
 *    lectura anonima— devuelve `permission denied`. El codigo que no revisa
 *    `error` pinta ceros con cara de dato. Ya paso en el Dashboard General.
 *    La vista es `security_invoker`: aplica el RLS de ESTA sesion, no la del
 *    dueno de la vista, asi que el cliente correcto importa igual que antes.
 * 2. Si una consulta falla, la pantalla **grita**. Nunca un cero que parece un
 *    dato: se muestra el error y no se dibuja la tabla. `leerCartera` lanza en
 *    vez de devolver `[]`, que es justo lo que hace falta aqui.
 */

export const dynamic = 'force-dynamic'

const formateaMoneda = (monto: number): string =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(monto)

const formateaPorcentaje = (fraccion: number | null): string =>
  fraccion === null ? 'n/d' : `${(fraccion * 100).toFixed(1)}%`

const formateaFecha = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City' }) : 'nunca'

type ResultadoCartera = { ok: true; filas: FilaCarteraVista[] } | { ok: false; error: string }

async function cargarCartera(): Promise<ResultadoCartera> {
  const cookieStore = await cookies()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        }
      }
    }
  )

  try {
    // Una sola consulta. `leerCartera` pagina con `.range()` (PostgREST corta en
    // 1000 filas sin avisar) y devuelve las filas ya ordenadas por prioridad de
    // visita, que es el mismo orden que daba `construirCartera`.
    return { ok: true, filas: await leerCartera(supabase) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export default async function CarteraPage() {
  // Corte en el servidor: esta pantalla muestra la cartera completa de la red.
  // Esconder el enlace del menu no es un permiso.
  const usuario = await getCurrentUser()
  if (!usuario || (usuario.rol !== 'ADMIN' && usuario.rol !== 'SOCIO')) {
    notFound()
  }

  const resultado = await cargarCartera()

  if (!resultado.ok) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Cartera</h1>
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950">
          <p className="font-semibold text-red-800 dark:text-red-200">
            No se pudo leer la cartera. No se muestran numeros porque no se pueden garantizar.
          </p>
          <p className="mt-2 break-words font-mono text-sm text-red-700 dark:text-red-300">
            {resultado.error}
          </p>
        </div>
      </div>
    )
  }

  const { filas } = resultado
  const totales = totalesCarteraVista(filas)

  return (
    <div className="p-8">
      <header>
        <h1 className="text-3xl font-bold text-gray-800 dark:text-gray-100">Cartera</h1>
        <p className="mt-1 text-gray-600 dark:text-gray-400">
          A quien visitar, cuanto tiene y cuanto debe. Solo lectura.
        </p>
      </header>

      <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs font-medium uppercase text-gray-500">Total por cobrar</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {formateaMoneda(totales.deuda)}
          </p>
          <p className="mt-1 text-xs text-gray-500">{filas.length} nodos con mercancia recibida</p>
          {totales.deudaConDistribuidor > 0.005 && (
            <p className="mt-1 text-xs text-gray-500" data-prueba="deuda-con-distribuidor">
              No suma {formateaMoneda(totales.deudaConDistribuidor)} que {totales.nodosConDistribuidor}{' '}
              {totales.nodosConDistribuidor === 1 ? 'local le debe' : 'locales le deben'} a su distribuidor:
              esa deuda no es con la matriz.
            </p>
          )}
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs font-medium uppercase text-gray-500">El libro dice que hay fuera</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {totales.libroDice} pzas
          </p>
          <p className="mt-1 text-xs text-gray-500">de {totales.recibidas} recibidas en consignacion</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs font-medium uppercase text-gray-500">Estimado por dinero</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {totales.estimadoEnPiso} pzas
          </p>
          <p className="mt-1 text-xs text-gray-500">segun lo que ya pagaron</p>
        </div>
      </section>

      <section className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">
        <p>
          <strong>Como leer las dos columnas de piezas.</strong> &laquo;Libro dice&raquo; es
          recibidas menos las salidas que el nodo registro. &laquo;Estimado en piso&raquo; es
          recibidas &times; (1 &minus; % pagado): si ya te pago el 80%, vendio ~80%, lo haya
          registrado o no.
        </p>
        <p className="mt-2">
          <strong>
            Donde el nodo nunca registra salidas, cree al dinero. Donde si las registra, cree al
            libro.
          </strong>{' '}
          La pantalla no elige por ti ni ajusta nada: muestra las dos y tu decides segun el caso.
        </p>
        <p className="mt-2 text-gray-600 dark:text-gray-400">
          <strong>Orden de visita:</strong> deuda &times; dias desde el ultimo abono. Arriba queda
          quien junta mucho dinero abierto con mucho tiempo callado, no simplemente quien debe mas.
          Cuando un nodo nunca ha abonado, los dias se cuentan desde que recibio la mercancia.
        </p>
      </section>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-800">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">#</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Nodo</th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                Recibidas
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                Libro dice
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                Estimado en piso
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                % pagado
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                Deuda
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                Ultimo abono
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {filas.map((fila, indice) => (
              <tr key={fila.id_entidad}>
                <td className="px-4 py-3 text-sm text-gray-500">{indice + 1}</td>
                <td className="px-4 py-3 text-sm">
                  <Link
                    href={`/dashboard/distribuidores/${fila.id_entidad}`}
                    className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {fila.nombre}
                  </Link>
                  <span className="ml-2 text-xs text-gray-500">{fila.rol}</span>
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fila.recibidas}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fila.libro_dice}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {fila.estimado_en_piso}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums text-gray-900 dark:text-gray-100">
                  {formateaPorcentaje(fila.porcentaje_pagado)}
                </td>
                <td className="px-4 py-3 text-right text-sm font-medium tabular-nums text-gray-900 dark:text-gray-100">
                  {formateaMoneda(fila.deuda)}
                </td>
                <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                  {formateaFecha(fila.ultimo_abono)}
                  {fila.dias_sin_abono !== null ? (
                    <span className="ml-2 text-xs text-gray-500">
                      {fila.referencia_dias === 'ENTREGA'
                        ? `${fila.dias_sin_abono} d desde la entrega`
                        : `hace ${fila.dias_sin_abono} d`}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <td
                className="px-4 py-3 text-sm font-semibold text-gray-700 dark:text-gray-200"
                colSpan={2}
              >
                Total
              </td>
              <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {totales.recibidas}
              </td>
              <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {totales.libroDice}
              </td>
              <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {totales.estimadoEnPiso}
              </td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-right text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                {formateaMoneda(totales.deuda)}
              </td>
              <td className="px-4 py-3" />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="mt-4 text-xs text-gray-500">
        La deuda sale de <code>calcularSaldoPendienteInventarioConsignacion</code>, la misma formula
        que usa el perfil de cada nodo: si aqui y alla no coinciden, es un error. Suma los{' '}
        <code>CARGO_DEUDA</code> y descuenta los abonos aprobados; los abonos pendientes de
        aprobacion no cuentan.
      </p>
    </div>
  )
}
