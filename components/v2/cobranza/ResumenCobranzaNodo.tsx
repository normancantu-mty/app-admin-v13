/**
 * Cobranza v2 — la franja de cobranza en la ficha de un nodo: deuda actual (y con
 * quién), días sin abonar con el color del semáforo, último abono y % pagado.
 * El historial de abonos y entregas ya lo pinta «Movimientos» de la ficha.
 * Escrito el 2026-10-30 por un ejecutor del Socio.
 *
 * Solo para mando (ADMIN/SOCIO): lo decide quien lo monta. Si el nodo no tiene
 * renglón en `v_cartera` (nunca recibió a concesión), no pinta nada.
 */

import { getServerSupabaseClient } from '@/lib/server-session'
import { leerCartera } from '@/lib/vistas'
import { leerNombresEntidades } from '@/lib/v2/lecturas'
import { fechaMx, mxn } from '@/lib/v2/formato'
import { armarFilasCobranza, leerMontosUltimoAbono } from './leer'
import { CHIP_BANDA, NOMBRE_BANDA, textoDias } from './semaforo'

export async function ResumenCobranzaNodo({ id }: { id: string }) {
  const client = await getServerSupabaseClient()
  const [cartera, nombres] = await Promise.all([leerCartera(client), leerNombresEntidades(client)])
  const propia = cartera.filter((f) => f.id_entidad === id)
  if (propia.length === 0) return null
  const montos = await leerMontosUltimoAbono(client, propia)
  const f = armarFilasCobranza(propia, montos, nombres)[0]
  if (!f) {
    return (
      <div className="cob-ficha verde" data-testid="cob-ficha">
        <span>
          <span className="cob-ficha-t">Cobranza</span>
          <b className="cob-ficha-v">Sin deuda</b>
        </span>
      </div>
    )
  }
  return (
    <div className={`cob-ficha ${f.banda}`} data-testid="cob-ficha">
      <span>
        <span className="cob-ficha-t">Deuda actual{f.acreedor ? ` con ${f.acreedor}` : ' con la matriz'}</span>
        <b className="cob-ficha-v">{mxn(f.deuda)}</b>
      </span>
      <span>
        <span className="cob-ficha-t">Sin abonar</span>
        <span className={`chip ${CHIP_BANDA[f.banda]}`} title={NOMBRE_BANDA[f.banda]}>
          {textoDias(f)}
        </span>
      </span>
      <span>
        <span className="cob-ficha-t">Último abono</span>
        {f.ultimoAbono ? `${fechaMx(f.ultimoAbono)}${f.ultimoAbonoMonto !== null ? ` · ${mxn(f.ultimoAbonoMonto)}` : ''}` : 'Nunca ha abonado'}
      </span>
      <span>
        <span className="cob-ficha-t">Pagado</span>
        {f.pct === null ? 'Sin dato' : `${f.pct}%`} · {mxn(f.abonado)} de {mxn(f.generado)}
      </span>
    </div>
  )
}
