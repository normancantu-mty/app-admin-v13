/**
 * Front v2 — Cartera completa. Escrito el 2026-10-29 por el ejecutor del Front v2
 * (lanzado por el Socio).
 *
 * Decidido (T6, migracion 20261029120000): la cartera de la MATRIZ no suma la
 * deuda de un local con su distribuidor. Esa va en su propia tabla, con el
 * distribuidor al que se le debe, y el total de la red se muestra aparte.
 *
 * Paridad v2 (2026-10-29): ahora es un MODAL del panel unico (`/panel/m/cartera`),
 * con «Seguimiento» (dias y boton) y «Editar» (porcentajes) por nodo, como pidio
 * Norman. El nombre abre la ficha del nodo en otro modal.
 *
 * Paginas v2 (2026-10-29): el cuerpo vive en `components/v2/red/CarteraVista.tsx`
 * (lo comparte la pagina `/panel/red`); aqui queda el marco y «Toda la red →».
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { Modal } from '@/components/v2/modal/Modal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { CarteraVista } from '@/components/v2/red/CarteraVista'
import { exigirMandoV2 } from '@/lib/v2/puerta'

export const dynamic = 'force-dynamic'

export default async function CarteraV2() {
  await exigirMandoV2()
  return (
    <Modal titulo="Cartera completa" sub="Quién debe, cuánto y desde cuándo" tam="xl" acciones={<VerTodo href={`${RUTA_BASE}/red`}>Toda la red →</VerTodo>}>
      <CarteraVista />
    </Modal>
  )
}
