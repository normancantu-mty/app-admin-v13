/**
 * Cobranza v2 — modal «Cobranza»: a quién falta cobrarle, con semáforo por días sin
 * abonar, filtros, búsqueda y acceso a la ficha y a «Registrar abono» por fila.
 * Lo abre la card «A quién cobrar» del panel (`?banda=rojo|amarillo|verde|gris`,
 * `?alcance=dst`). Escrito el 2026-10-30 por un ejecutor del Socio.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { Modal } from '@/components/v2/modal/Modal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { VistaCobranza } from '@/components/v2/cobranza/VistaCobranza'
import { exigirMandoV2 } from '@/lib/v2/puerta'

export const dynamic = 'force-dynamic'

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function CobranzaModal({ searchParams }: { searchParams: Promise<{ banda?: string | string[]; alcance?: string | string[] }> }) {
  await exigirMandoV2()
  const sp = await searchParams
  return (
    <Modal titulo="Cobranza" sub="A quién falta cobrarle, cuánto y desde cuándo" tam="xl" acciones={<VerTodo href={`${RUTA_BASE}/cobranza`}>Página completa →</VerTodo>}>
      <VistaCobranza banda={uno(sp.banda)} alcance={uno(sp.alcance)} />
    </Modal>
  )
}
