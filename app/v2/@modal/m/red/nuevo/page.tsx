/** Paridad v2 — modal «Nuevo miembro de la red» (alta de distribuidor o local). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import Alta from '@/components/v2/red/Alta'

/** Paginas v2: abierto desde `/v2/red`, al guardar vuelve a esa pagina (`?volver=`). Solo paginas de /v2. */
function destinoVolver(v: string | string[] | undefined): string | null {
  const r = Array.isArray(v) ? v[0] : v
  return r && /^\/v2\/[a-z0-9/_-]*$/i.test(r) && !r.startsWith('/v2/m/') ? r : null
}

export default async function ModalAlta({ searchParams }: { searchParams: Promise<{ volver?: string | string[] }> }) {
  const usuario = await exigirSesionV2()
  // Solo ADMIN: lib/entidad-servidor.ts (assertPuedeDarDeAlta) y la RLS entidades_ins_admin
  // rechazan el alta de un DST; la v1 se lo ofrecia y fallaba (defecto anotado ahi).
  if (usuario.rol !== 'ADMIN') notFound()
  const padre = destinoVolver((await searchParams).volver) ?? '/v2/m/red'
  return (
    <Modal titulo="Nuevo miembro de la red" sub="Registro con comisión base global" tam="md" padre={padre}>
      <div className="v1">
        <Alta padre={padre} />
      </div>
    </Modal>
  )
}
