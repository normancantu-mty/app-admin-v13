/**
 * Cobranza v2 — la vista completa de "a quién falta cobrarle" (cuerpo). La usan el
 * modal `/v2/m/cobranza` y la pagina `/v2/cobranza`. Escrito el 2026-10-30 por un
 * ejecutor del Socio. Solo lectura: lo unico que escribe es lo que ya escribian
 * «Registrar abono», «Seguimiento» y «Editar», que se abren desde cada fila.
 *
 * Servidor: lee `v_cartera`, los nombres (para el acreedor de los locales), la red
 * (dias de seguimiento y datos para «Editar») y el monto del ultimo abono; la
 * tabla con filtros y busqueda es de cliente (`TablaCobranza`).
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { leerCartera } from '@/lib/vistas'
import { leerNombresEntidades } from '@/lib/v2/lecturas'
import { leerRed } from '@/lib/v2/red'
import { fechaHoraMx } from '@/lib/v2/formato'
import type { FilaRed } from '@/lib/v2/red-tipos'
import { armarFilasCobranza, leerMontosUltimoAbono } from './leer'
import { BANDAS, type Banda } from './semaforo'
import TablaCobranza, { type Alcance } from './TablaCobranza'

export async function VistaCobranza({ banda, alcance }: { banda?: string; alcance?: string }) {
  const usuario = await exigirMandoV2()
  const client = await getServerSupabaseClient()
  const [cartera, nombres, red] = await Promise.all([leerCartera(client), leerNombresEntidades(client), leerRed(client, usuario)])
  const montos = await leerMontosUltimoAbono(client, cartera)
  const filas = armarFilasCobranza(cartera, montos, nombres)
  const puedeOperar = usuario.rol === 'ADMIN'
  const filasRed: Record<string, FilaRed> = {}
  const seguimiento: Record<string, number | null> = {}
  for (const r of red) {
    seguimiento[r.id] = r.diasSeguimiento
    if (puedeOperar) filasRed[r.id] = r
  }
  const bandaInicial: Banda | 'todas' = BANDAS.includes(banda as Banda) ? (banda as Banda) : 'todas'
  const alcanceInicial: Alcance = alcance === 'dst' ? 'dst' : 'matriz'

  return (
    <div className="cob-vista" data-testid="vista-cobranza">
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Orden del ERP: deuda × días sin abonar · días desde el último abono o, si nunca abonó, desde la última entrega ·
        v_cartera, leída {fechaHoraMx(cartera[0]?.calculado_en ?? null)}
      </p>
      <TablaCobranza
        key={`${bandaInicial}-${alcanceInicial}`}
        filas={filas}
        seguimiento={seguimiento}
        filasRed={filasRed}
        puedeOperar={puedeOperar}
        bandaInicial={bandaInicial}
        alcanceInicial={alcanceInicial}
      />
    </div>
  )
}
