/**
 * Lotes v2 — modal «Nuevo lote». Escrito el 2026-10-30 por el ejecutor del Socio.
 * Solo ADMIN (puedeCapturarMatriz): el RLS de `lotes` solo deja escribir a ADMIN,
 * y SOCIO es de solo lectura. Guarda con `guardarLoteAction` (sesion del usuario).
 */

import { notFound } from 'next/navigation'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { puedeCapturarMatriz } from '@/lib/v2/roles'
import { codigoSugerido } from '@/lib/bot-lotes'
import { Modal } from '@/components/v2/modal/Modal'
import FormLote from '@/components/v2/lotes/FormLote'
import { hoyMx, leerCodigosLote, leerInsumosLote } from '@/components/v2/lotes/datos'

export const dynamic = 'force-dynamic'

export default async function ModalNuevoLote() {
  const usuario = await exigirMandoV2()
  if (!puedeCapturarMatriz(usuario.rol)) notFound()
  const hoy = hoyMx()
  const [insumos, codigos] = await Promise.all([leerInsumosLote(), leerCodigosLote()])
  return (
    <Modal titulo="Nuevo lote" sub="Fermentación, insumos y tandas · lo derivado lo calcula v_lote_rendimiento" tam="lg">
      <FormLote
        hoy={hoy}
        insumos={insumos}
        inicial={{
          id: null,
          codigo_lote: codigoSugerido(hoy, codigos),
          fecha_inicio: hoy,
          fecha_fin_fermentacion: null,
          horas_fermentacion: null,
          brix_chile: null,
          brix_final: null,
          notas: null,
          entradas: [],
          tandas: []
        }}
      />
    </Modal>
  )
}
