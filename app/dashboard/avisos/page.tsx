import Link from 'next/link'
import { listarAvisosAction } from '@/app/actions/avisos'
import { CATALOGO_AVISOS, resumenDiarioAvisos, type TipoAviso } from '@/lib/avisos'
import { AccionesAviso } from './AccionesAviso'

// La cola depende de la sesion: sin esto, Turbopack sirve la de otro usuario.
export const dynamic = 'force-dynamic'

function fechaCorta(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function diasAbierto(iso: string, ahora: Date): number {
  return Math.max(0, Math.floor((ahora.getTime() - new Date(iso).getTime()) / 86_400_000))
}

/** A donde lleva "Ir al movimiento". Solo el ticket tiene pantalla propia. */
function enlaceAlMovimiento(tabla: string | null, idRegistro: string | null): string | null {
  if (!tabla || !idRegistro) return null
  if (tabla === 'transacciones_tickets') return `/ticket/${idRegistro}`
  if (tabla === 'finanzas_ledger') return '/dashboard/finanzas'
  if (tabla === 'inventario_ledger') return '/dashboard/inventario'
  return null
}

export default async function AvisosPage() {
  const resultado = await listarAvisosAction('ABIERTO')
  const ahora = new Date()

  if (!resultado.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Cola de captura</h1>
        <p className="mt-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-950 dark:text-red-300">
          No se pudo leer la cola: {resultado.error}
        </p>
      </div>
    )
  }

  const avisos = resultado.avisos
  const resumen = resumenDiarioAvisos(avisos, ahora)

  return (
    <div className="p-4 md:p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">⚠️ Cola de captura</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-400">
          Lo que el sistema <strong>dejo entrar sin saber del todo</strong>. Ninguna de estas filas
          se rechazo: entraron y quedaron marcadas. Esta lista no es una pantalla bonita — es la
          lista de lo que el sistema no sabe.
        </p>
      </header>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Abiertos</p>
          <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-gray-100">{resumen.total}</p>
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-xs uppercase tracking-wide text-amber-700 dark:text-amber-300">Por revisar</p>
          <p className="mt-1 text-3xl font-bold text-amber-800 dark:text-amber-200">{resumen.revisar}</p>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
          <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            El mas viejo lleva
          </p>
          <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-gray-100">
            {resumen.diasDelMasViejo} <span className="text-base font-normal">dia(s)</span>
          </p>
        </div>
      </div>

      {avisos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 p-10 text-center dark:border-gray-700">
          <p className="text-lg font-medium text-gray-700 dark:text-gray-300">
            No hay nada pendiente.
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            La cola vacia significa que todo lo capturado entro completo.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {avisos.map((aviso) => {
            const definicion = CATALOGO_AVISOS[aviso.tipo as TipoAviso]
            const esRevisar = aviso.severidad === 'REVISAR'
            const enlace = enlaceAlMovimiento(aviso.tabla, aviso.id_registro)

            return (
              <li
                key={aviso.id}
                className={[
                  'rounded-lg border bg-white p-4 dark:bg-gray-900',
                  esRevisar
                    ? 'border-l-4 border-l-amber-500 border-gray-200 dark:border-gray-800'
                    : 'border-l-4 border-l-gray-300 border-gray-200 dark:border-gray-800 dark:border-l-gray-600'
                ].join(' ')}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={[
                      'rounded px-2 py-0.5 text-xs font-semibold',
                      esRevisar
                        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    ].join(' ')}
                  >
                    {aviso.severidad}
                  </span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    {aviso.tipo}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {definicion?.titulo ?? aviso.tipo}
                  </span>
                  <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">
                    {fechaCorta(aviso.creado_en)} · {diasAbierto(aviso.creado_en, ahora)} dia(s) abierto
                  </span>
                </div>

                <p className="mt-2 text-sm text-gray-800 dark:text-gray-200">{aviso.mensaje}</p>

                {definicion ? (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {definicion.consecuencia}
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                  <span>
                    Entidad: <strong>{aviso.nombre_entidad ?? aviso.id_entidad}</strong>
                  </span>
                  <span>Capturo: {aviso.usuario_creador}</span>
                  {aviso.datos_capturados ? (
                    <details className="w-full">
                      <summary className="cursor-pointer">Lo que se capturo</summary>
                      <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-[11px] text-gray-700 dark:bg-gray-950 dark:text-gray-300">
                        {JSON.stringify(aviso.datos_capturados, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {enlace ? (
                    <Link
                      href={enlace}
                      className="rounded border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950"
                    >
                      Ir al movimiento
                    </Link>
                  ) : (
                    <span className="text-xs italic text-gray-400">
                      Sin fila que abrir: este aviso es de la entidad, no de un movimiento.
                    </span>
                  )}
                  <AccionesAviso
                    idAviso={aviso.id}
                    exigeAsignacion={definicion?.exigeAsignacion === true}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
