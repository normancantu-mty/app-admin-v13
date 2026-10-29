/** Paridad v2 — modal del ticket (imprimir y compartir). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import Ticket from '@/components/v2/venta/Ticket'

export default async function ModalTicket({ params }: { params: Promise<{ id: string }> }) {
  await exigirSesionV2()
  const { id } = await params
  return (
    <Modal titulo="Ticket" sub="Comprobante de venta" tam="sm">
      <div className="v1">
        <Ticket id={id} />
      </div>
    </Modal>
  )
}
