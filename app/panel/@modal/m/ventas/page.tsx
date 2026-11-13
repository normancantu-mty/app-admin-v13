/** Paridad v2 — modal «Ventas» (ventas por mes; el RLS recorta lo que ve cada rol). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeVerFinanzas } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import VentasVista from '@/components/v2/ventas/VentasVista'

export const dynamic = 'force-dynamic'

export default async function ModalVentas() {
  const usuario = await exigirSesionV2()
  // El RLS le deja ver todos los tickets al EMPLEADO_ADMIN (app movil): aqui, solo con permiso de finanzas.
  if (usuario.rol === 'EMPLEADO_ADMIN' && !puedeVerFinanzas(usuario)) notFound()
  return (
    <Modal titulo={usuario.rol === 'DST' || usuario.rol === 'LOC' ? 'Mis ventas' : 'Ventas'} sub="Ventas por mes, sin anulados, en hora de México" tam="lg">
      <div className="v1">
        <VentasVista />
      </div>
    </Modal>
  )
}
