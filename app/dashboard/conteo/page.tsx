import { listarEntidadesParaConteoAction } from '@/app/actions/conteo'
import { CapturaConteo } from './CapturaConteo'

// Depende de la sesion: sin esto, Turbopack sirve la lista de otro usuario.
export const dynamic = 'force-dynamic'

export default async function ConteoPage() {
  const resultado = await listarEntidadesParaConteoAction()

  if (!resultado.success) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Conteo fisico</h1>
        <p className="mt-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-950 dark:text-red-300">
          {resultado.error}
        </p>
      </div>
    )
  }

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Conteo fisico</h1>

      <p className="mt-2 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
        Cuantas botellas hay <strong>hoy</strong> en el punto de venta. Esto <strong>no cobra
        nada</strong> y <strong>no mueve la deuda</strong>: solo deja asentado lo que se conto, para
        que la diferencia contra el libro deje de ser invisible.
      </p>
      <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-500">
        Si solo contaste dos productos, captura esos dos. Un conteo parcial vale.
      </p>

      <CapturaConteo entidades={resultado.entidades} />
    </div>
  )
}
