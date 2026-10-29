/** Paridad v2 — modal de la ficha de un nodo (Q6, Q14). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { leerFichaNodo } from '@/lib/v2/nodo'
import { Modal } from '@/components/v2/modal/Modal'
import { FichaVista } from '@/components/v2/nodo/FichaVista'

export default async function ModalNodo({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  const { id } = await params
  const ficha = await leerFichaNodo(id, usuario)
  if (!ficha) notFound()
  return (
    <Modal titulo={ficha.entidad.nombre} sub="Ficha del nodo" tam="xl">
      <FichaVista ficha={ficha} usuario={usuario} />
    </Modal>
  )
}
