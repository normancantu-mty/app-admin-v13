/** Paridad v2 — modal «Registrar envasado» (producción con descuento de insumos por receta). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import Envasado from '@/components/v2/inventario/Envasado'

export default async function ModalEnvasado() {
  const usuario = await exigirSesionV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  return (
    <Modal titulo="Registrar envasado" sub="Deducción automática de insumos según la receta (BOM)" tam="md">
      <div className="v1">
        <Envasado />
      </div>
    </Modal>
  )
}
