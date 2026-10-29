/** Paridad v2 — modal «Conteo físico» dentro de la ficha (Q14). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { leerNodoVisible, padreDeNodo } from '@/lib/v2/nodo'
import { listarEntidadesParaConteoAction } from '@/app/actions/conteo'
import { Modal } from '@/components/v2/modal/Modal'
import { CapturaConteo } from '@/components/v2/nodo/Conteo'

export default async function ModalConteo({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  if (usuario.rol === 'SOCIO') notFound()
  const { id } = await params
  const e = await leerNodoVisible(id, usuario)
  if (!e) notFound()
  const padre = padreDeNodo(id, usuario)
  const r = await listarEntidadesParaConteoAction()
  return (
    <Modal titulo="Conteo físico" sub={e.nombre} tam="md" padre={padre}>
      <div className="v1">
        <p className="nota" style={{ marginTop: 0 }}>
          Cuántas botellas hay <b>hoy</b> en el punto de venta. Esto <b>no cobra nada</b> y <b>no mueve la deuda</b>: solo deja
          asentado lo que se contó. Un conteo parcial vale.
        </p>
        {r.success ? (
          <CapturaConteo entidades={r.entidades.filter((x) => x.id === id)} fija={id} />
        ) : (
          <div className="msg mal">{r.error}</div>
        )}
      </div>
    </Modal>
  )
}
