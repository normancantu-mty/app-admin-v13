/** Paridad v2 — modal «Devolución». Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { leerNodoVisible, padreDeNodo } from '@/lib/v2/nodo'
import { Modal } from '@/components/v2/modal/Modal'
import Devolucion from '@/components/v2/nodo/Devolucion'

export default async function ModalDevolucion({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  // LOC y SOCIO no operan (el RLS de estas escrituras solo deja a ADMIN y DST): 404 aunque llegue por URL.
  if (usuario.rol !== 'ADMIN' && usuario.rol !== 'DST') notFound()
  const { id } = await params
  const e = await leerNodoVisible(id, usuario)
  if (!e) notFound()
  const padre = padreDeNodo(id, usuario)
  return (
    <Modal titulo="Devolución" sub={e.nombre} tam="md" padre={padre}>
      <Devolucion id={id} padre={padre} />
    </Modal>
  )
}
