/** Paridad v2 — modal del ticket (imprimir y compartir). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeVerFinanzas } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import Ticket from '@/components/v2/venta/Ticket'

export default async function ModalTicket({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  // Mismo criterio que el modal de ventas: el ticket es dinero.
  if (usuario.rol === 'EMPLEADO_ADMIN' && !puedeVerFinanzas(usuario)) notFound()
  const { id } = await params
  return (
    <Modal titulo="Ticket" sub="Comprobante de venta" tam="sm">
      <div className="v1">
        <Ticket id={id} />
      </div>
    </Modal>
  )
}
