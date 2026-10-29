/** Paridad v2 — modal «Ventas» (ventas por mes; el RLS recorta lo que ve cada rol). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import VentasVista from '@/components/v2/ventas/VentasVista'

export const dynamic = 'force-dynamic'

export default async function ModalVentas() {
  const usuario = await exigirSesionV2()
  return (
    <Modal titulo={usuario.rol === 'DST' || usuario.rol === 'LOC' ? 'Mis ventas' : 'Ventas'} sub="Ventas por mes, sin anulados, en hora de México" tam="lg">
      <div className="v1">
        <VentasVista />
      </div>
    </Modal>
  )
}
