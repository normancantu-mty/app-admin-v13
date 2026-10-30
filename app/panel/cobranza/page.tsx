/**
 * Cobranza v2 — página completa `/panel/cobranza` (mismo cuerpo que el modal
 * `/panel/m/cobranza`). La ficha y «Registrar abono» se abren como modal encima.
 * Escrito el 2026-10-30 por un ejecutor del Socio.
 */

import { EncabezadoPagina } from '@/components/v2/pagina/Encabezado'
import { VistaCobranza } from '@/components/v2/cobranza/VistaCobranza'
import { exigirMandoV2 } from '@/lib/v2/puerta'

export const dynamic = 'force-dynamic'

const uno = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

export default async function CobranzaV2({ searchParams }: { searchParams: Promise<{ banda?: string | string[]; alcance?: string | string[] }> }) {
  await exigirMandoV2()
  const sp = await searchParams
  return (
    <>
      <EncabezadoPagina titulo="Cobranza" sub="A quién falta cobrarle, cuánto y desde cuándo · semáforo por días sin abonar" />
      <section className="card">
        <VistaCobranza banda={uno(sp.banda)} alcance={uno(sp.alcance)} />
      </section>
    </>
  )
}
