/** Paridad v2 — modal «Red de distribución» (directorio: seguimiento, editar, eliminar, alta). Escrito el 2026-10-29 por el ejecutor del Socio. «Ver todo →» lleva a la pagina /v2/red (Paginas v2, 2026-10-29). */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { getServerSupabaseClient } from '@/lib/server-session'
import { leerRed } from '@/lib/v2/red'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { Modal } from '@/components/v2/modal/Modal'
import Directorio from '@/components/v2/red/Directorio'
import { VerTodo } from '@/components/v2/pagina/Encabezado'

export const dynamic = 'force-dynamic'

export default async function ModalRed() {
  const usuario = await exigirSesionV2()
  if (usuario.rol !== 'ADMIN' && usuario.rol !== 'SOCIO' && usuario.rol !== 'DST') notFound()
  const filas = await leerRed(await getServerSupabaseClient(), usuario)
  const esAdmin = usuario.rol === 'ADMIN'
  const dst = filas.filter((f) => f.rol === 'DST').length
  const loc = filas.filter((f) => f.rol === 'LOC').length
  return (
    <Modal
      titulo="Red de distribución"
      sub="Directorio de la red · saldos de v_saldo_entidad"
      tam="xl"
      acciones={
        <>
          <VerTodo href="/v2/red" />
          {/* Solo ADMIN da altas (red/nuevo le da 404 a DST y SOCIO): sin boton muerto. */}
          {esAdmin ? (
            <AbrirModal className="btn p" href="/v2/m/red/nuevo" titulo="Nuevo miembro" tam="md" data-testid="red-alta">
              + Nuevo miembro
            </AbrirModal>
          ) : null}
        </>
      }
    >
      <div className="kpis k3" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <span className="t">Total red</span>
          <span className="v">{filas.length}</span>
        </div>
        <div className="kpi">
          <span className="t">Distribuidores</span>
          <span className="v">{dst}</span>
        </div>
        <div className="kpi">
          <span className="t">Locales</span>
          <span className="v">{loc}</span>
        </div>
      </div>
      {filas.length === 0 ? (
        <div className="vacio">
          <b>No hay miembros en la red</b>
        </div>
      ) : (
        <div className="v1 card" style={{ padding: 0 }}>
          <Directorio rows={filas} canEdit={esAdmin} canDeleteEntity={esAdmin} showZonaColumn={esAdmin} />
        </div>
      )}
    </Modal>
  )
}
