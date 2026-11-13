/** Paridad v2 — modal «Inventario» (stock, concesión, movimientos con anular, merma y logística inversa). Escrito el 2026-10-29 por el ejecutor del Socio. «Ver todo →» lleva a /panel/inventario (Paginas v2, 2026-10-29). */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import InventarioVista from '@/components/v2/inventario/InventarioVista'
import { VerTodo } from '@/components/v2/pagina/Encabezado'

export const dynamic = 'force-dynamic'

export default async function ModalInventario() {
  await exigirMatrizV2()
  return (
    <Modal titulo="Inventario" sub="Control de inventario de la matriz" tam="xl" acciones={<VerTodo href={`${RUTA_BASE}/inventario`} />}>
      <div className="v1">
        <InventarioVista />
      </div>
    </Modal>
  )
}
