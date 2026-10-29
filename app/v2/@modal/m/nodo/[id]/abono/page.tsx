/** Paridad v2 — modal «Registrar abono» (transferencia manual de la v1). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { leerNodoVisible, padreDeNodo } from '@/lib/v2/nodo'
import { Modal } from '@/components/v2/modal/Modal'
import Abono from '@/components/v2/nodo/Abono'

export default async function ModalAbono({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  if (usuario.rol === 'SOCIO') notFound()
  const { id } = await params
  const e = await leerNodoVisible(id, usuario)
  if (!e) notFound()
  const padre = padreDeNodo(id, usuario)
  return (
    <Modal titulo="Registrar abono" sub={e.nombre} tam="md" padre={padre}>
      <Abono id={id} padre={padre} />
    </Modal>
  )
}
