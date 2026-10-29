/** Paridad v2 — modal «Comprar insumos» (transacción dual: inventario y finanzas). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import Compra from '@/components/v2/inventario/Compra'

export default async function ModalCompra() {
  const usuario = await exigirSesionV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  return (
    <Modal titulo="Comprar insumos" sub="Transacción dual: impacta inventario y finanzas" tam="md" padre="/v2">
      <div className="v1">
        <Compra />
      </div>
    </Modal>
  )
}
