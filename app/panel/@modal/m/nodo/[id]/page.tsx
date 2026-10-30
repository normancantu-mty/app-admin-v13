/** Paridad v2 — modal de la ficha de un nodo (Q6, Q14). Escrito el 2026-10-29 por el ejecutor del Socio. «Ficha completa →» lleva a /panel/red/<id> (Paginas v2, 2026-10-29). */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirSesionV2 } from '@/lib/v2/puerta'
import { leerFichaNodo } from '@/lib/v2/nodo'
import { esRolDeMandoV2 } from '@/lib/v2/roles'
import { precargarCobranzaNodo } from '@/components/v2/cobranza/ResumenCobranzaNodo'
import { Modal } from '@/components/v2/modal/Modal'
import { FichaVista } from '@/components/v2/nodo/FichaVista'
import { VerTodo } from '@/components/v2/pagina/Encabezado'

export default async function ModalNodo({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirSesionV2()
  const { id } = await params
  // La franja de cobranza (solo mando) arranca junto con la ficha, no despues.
  if (esRolDeMandoV2(usuario.rol)) precargarCobranzaNodo(id)
  const ficha = await leerFichaNodo(id, usuario)
  if (!ficha) notFound()
  return (
    <Modal titulo={ficha.entidad.nombre} sub="Ficha del nodo" tam="xl" acciones={<VerTodo href={`${RUTA_BASE}/red/${id}`}>Ficha completa →</VerTodo>}>
      <FichaVista ficha={ficha} usuario={usuario} />
    </Modal>
  )
}
