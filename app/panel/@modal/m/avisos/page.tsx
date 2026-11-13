/** Paridad v2 — modal «Avisos» (cola de captura: resolver e ignorar). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeVerFinanzas } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import AvisosVista from '@/components/v2/avisos/AvisosVista'

export const dynamic = 'force-dynamic'

export default async function ModalAvisos() {
  const usuario = await exigirSesionV2()
  return (
    <Modal titulo="Avisos" sub="Cola de captura: lo que el sistema dejó entrar sin saber del todo" tam="lg">
      <div className="v1">
        <AvisosVista esMando={puedeVerFinanzas(usuario)} />
      </div>
    </Modal>
  )
}
