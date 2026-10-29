/**
 * Paridad v2 — modal «Lotes» (pedido de Norman, T72 L265: «un botón en Abrir que
 * haga referencia a los lotes»). Escrito el 2026-10-29 por el ejecutor del Socio.
 * Paginas v2 (2026-10-29): la tabla vive en `components/v2/inventario/Lotes.tsx`
 * (la comparte `/v2/inventario`); «Ver todo →» lleva a esa pagina.
 */

import { exigirMandoV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { LotesVista } from '@/components/v2/inventario/Lotes'

export const dynamic = 'force-dynamic'

export default async function ModalLotes() {
  await exigirMandoV2()
  return (
    <Modal titulo="Lotes" sub="Rendimiento por lote · v_lote_rendimiento (los registra el bot)" tam="xl" acciones={<VerTodo href="/v2/inventario#lotes">Todo el inventario →</VerTodo>}>
      <LotesVista />
    </Modal>
  )
}
