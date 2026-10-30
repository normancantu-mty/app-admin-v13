/** Paridad v2 — modal «Nueva venta» (el POS de la v1). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { puedeVender } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import Venta from '@/components/v2/venta/Venta'

export default async function ModalVenta({ searchParams }: { searchParams: Promise<{ vendedor?: string | string[] }> }) {
  const usuario = await exigirSesionV2()
  if (!puedeVender(usuario.rol)) notFound()
  const v = (await searchParams).vendedor
  const vendedor = Array.isArray(v) ? v[0] : v
  return (
    <Modal titulo="Nueva venta" sub="Punto de venta" tam="xl">
      <Venta vendedor={vendedor ?? null} />
    </Modal>
  )
}
