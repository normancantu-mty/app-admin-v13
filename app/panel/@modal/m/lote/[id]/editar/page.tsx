/**
 * Lotes v2 — modal «Editar lote», anidado sobre el detalle. Escrito el 2026-10-30
 * por el ejecutor del Socio. Solo ADMIN. Los insumos y tandas ya escritos se
 * corrigen, no se quitan; las etapas y el envasado no se editan aqui.
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { notFound } from 'next/navigation'
import { exigirMatrizV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { Modal } from '@/components/v2/modal/Modal'
import FormLote from '@/components/v2/lotes/FormLote'
import { hoyMx, leerInsumosLote, leerLote } from '@/components/v2/lotes/datos'

export const dynamic = 'force-dynamic'

export default async function ModalEditarLote({ params }: { params: Promise<{ id: string }> }) {
  const usuario = await exigirMatrizV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  const { id } = await params
  const [lote, insumos] = await Promise.all([leerLote(id), leerInsumosLote()])
  if (!lote) notFound()
  const c = lote.cabecera
  const padre = `${RUTA_BASE}/m/lote/${id}`
  return (
    <Modal titulo={`Editar ${c.codigo_lote}`} sub="Cabecera, insumos y tandas" tam="lg" padre={padre}>
      <FormLote
        hoy={hoyMx()}
        insumos={insumos}
        inicial={{
          id: c.id,
          codigo_lote: c.codigo_lote,
          fecha_inicio: c.fecha_inicio,
          fecha_fin_fermentacion: c.fecha_fin_fermentacion,
          horas_fermentacion: c.horas_fermentacion === null ? null : Number(c.horas_fermentacion),
          brix_chile: c.brix_chile === null ? null : Number(c.brix_chile),
          brix_final: c.brix_final === null ? null : Number(c.brix_final),
          notas: c.notas,
          entradas: lote.entradas.map((e) => ({ id_insumo: e.id_insumo, cantidad: e.cantidad })),
          tandas: lote.salidas
        }}
      />
    </Modal>
  )
}
