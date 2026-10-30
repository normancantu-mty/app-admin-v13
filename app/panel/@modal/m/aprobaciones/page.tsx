/** Paridad v2 — modal «Aprobaciones» (abonos de DST por aprobar). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import Aprobaciones from '@/components/v2/finanzas/Aprobaciones'

export default async function ModalAprobaciones() {
  const usuario = await exigirSesionV2()
  // Igual que /dashboard/finanzas: el panel solo lo ve ADMIN.
  if (usuario.rol !== 'ADMIN') notFound()
  return (
    <Modal titulo="Aprobaciones" sub="Los abonos no impactan el balance hasta aprobarse" tam="lg">
      <div className="v1">
        <Aprobaciones isSubAdmin={false} />
      </div>
    </Modal>
  )
}
