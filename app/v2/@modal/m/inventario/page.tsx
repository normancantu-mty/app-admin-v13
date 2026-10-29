/** Paridad v2 — modal «Inventario» (stock, concesión, movimientos con anular, merma y logística inversa). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirMandoV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import InventarioVista from '@/components/v2/inventario/InventarioVista'

export const dynamic = 'force-dynamic'

export default async function ModalInventario() {
  await exigirMandoV2()
  return (
    <Modal titulo="Inventario" sub="Control de inventario de la matriz" tam="xl">
      <div className="v1">
        <InventarioVista />
      </div>
    </Modal>
  )
}
