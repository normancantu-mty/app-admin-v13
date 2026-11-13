/**
 * Paridad v2 — modal «Lotes» (pedido de Norman, T72 L265: «un botón en Abrir que
 * haga referencia a los lotes»). Escrito el 2026-10-29 por el ejecutor del Socio.
 * Paginas v2 (2026-10-29): la tabla vive en `components/v2/inventario/Lotes.tsx`
 * (la comparte `/panel/inventario`); «Ver todo →» lleva a esa pagina.
 * Lotes v2 (2026-10-30, ejecutor del Socio): «Ver todo →» lleva al apartado
 * `/panel/lotes` (alta, edicion y detalle); ADMIN tiene aqui mismo «Nuevo lote».
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { Modal } from '@/components/v2/modal/Modal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { LotesVista } from '@/components/v2/inventario/Lotes'

export const dynamic = 'force-dynamic'

export default async function ModalLotes() {
  const usuario = await exigirMatrizV2()
  return (
    <Modal
      titulo="Lotes"
      sub="Estado, rendimiento y costo por lote · v_lote_rendimiento"
      tam="xl"
      acciones={
        <>
          {puedeCapturarMatriz(usuario.rol) ? (
            <AbrirModal className="btn p" href={`${RUTA_BASE}/m/lote/nuevo`} titulo="Nuevo lote" tam="lg" data-testid="lotes-nuevo-modal">
              + Nuevo lote
            </AbrirModal>
          ) : null}
          <VerTodo href={`${RUTA_BASE}/lotes`} />
        </>
      }
    >
      <LotesVista />
    </Modal>
  )
}
