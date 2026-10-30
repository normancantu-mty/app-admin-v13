/**
 * Paridad v2 — modal «Catálogo y precios» (waterfall de la v1 con selector
 * Distribuidor/Local, Q7; para el DST, sus locales, Q16). Escrito el 2026-10-29
 * por el ejecutor del Socio. Paginas v2 (2026-10-29): el cuerpo vive en
 * `components/v2/precios/PreciosVista.tsx` (lo comparte `/panel/catalogo`), y el
 * encabezado lleva «Ver todo →» a la pagina completa.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { Modal } from '@/components/v2/modal/Modal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { PreciosVista, rolDePrecios, type SpPrecios } from '@/components/v2/precios/PreciosVista'

export const dynamic = 'force-dynamic'

export default async function ModalPrecios({ searchParams }: { searchParams: Promise<SpPrecios> }) {
  const usuario = await exigirSesionV2()
  if (usuario.rol === 'SUB-ADMIN') notFound()
  const sp = await searchParams
  const rolActual = rolDePrecios(usuario.rol)
  return (
    <Modal
      titulo={rolActual === 'ADMIN' ? 'Catálogo y precios' : 'Precios para mí'}
      sub="Waterfall de precio: público, impuestos, tu costo y lo que ganas"
      tam="xl"
      acciones={<VerTodo href={`${RUTA_BASE}/catalogo`} />}
    >
      <PreciosVista usuario={usuario} sp={sp} ruta={`${RUTA_BASE}/m/precios`} />
    </Modal>
  )
}
