/** Paridad v2 — modal «Actividad» (feed de auditoría de la v1). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirMandoV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import Feed from '@/components/v2/actividad/Feed'

export const dynamic = 'force-dynamic'

export default async function ModalActividad() {
  await exigirMandoV2()
  return (
    <Modal titulo="Actividad" sub="Auditoría en tiempo real" tam="lg">
      <div className="v1">
        <Feed />
      </div>
    </Modal>
  )
}
