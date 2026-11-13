/**
 * Lotes v2 — modal con el detalle de un lote. Escrito el 2026-10-30 por el
 * ejecutor del Socio. ADMIN y SOCIO lo ven (RLS de `lotes`); solo ADMIN edita.
 */

import { notFound } from 'next/navigation'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import DetalleLote from '@/components/v2/lotes/DetalleLote'
import { leerLote } from '@/components/v2/lotes/datos'

export const dynamic = 'force-dynamic'

export default async function ModalLote({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirMatrizV2()
  const { id } = await params
  const lote = await leerLote(id)
  if (!lote) notFound()
  return (
    <Modal titulo={`Lote ${lote.cabecera.codigo_lote}`} sub="Tandas, chile, litros, grado, botellas, costo y rendimiento · v_lote_rendimiento" tam="xl">
      <DetalleLote lote={lote} puedeEditar={puedeCapturarMatriz(usuario.rol)} />
    </Modal>
  )
}
