/** Paridad v2 — modal «Nuevo miembro de la red» (alta de distribuidor o local). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import Alta from '@/components/v2/red/Alta'

export default async function ModalAlta() {
  const usuario = await exigirSesionV2()
  // Solo ADMIN: lib/entidad-servidor.ts (assertPuedeDarDeAlta) y la RLS entidades_ins_admin
  // rechazan el alta de un DST; la v1 se lo ofrecia y fallaba (defecto anotado ahi).
  if (usuario.rol !== 'ADMIN') notFound()
  const padre = '/v2/m/red'
  return (
    <Modal titulo="Nuevo miembro de la red" sub="Registro con comisión base global" tam="md" padre={padre}>
      <div className="v1">
        <Alta padre={padre} />
      </div>
    </Modal>
  )
}
