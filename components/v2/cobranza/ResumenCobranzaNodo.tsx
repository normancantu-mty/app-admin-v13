/**
 * Cobranza v2 — la franja de cobranza en la ficha de un nodo: deuda actual (y con
 * quién), días sin abonar con el color del semáforo, último abono y % pagado.
 * El historial de abonos y entregas ya lo pinta «Movimientos» de la ficha.
 * Escrito el 2026-10-30 por un ejecutor del Socio.
 *
 * Solo para mando (ADMIN/SOCIO): lo decide quien lo monta. Si el nodo no tiene
 * renglón en `v_cartera` (nunca recibió a concesión), no pinta nada.
 *
 * Perf 2026-10-30 (otro ejecutor del Socio): lee SOLO el renglón del nodo, los
 * nombres y los abonos del nodo, en una tanda paralela; y la página la precarga
 * (`precargarCobranzaNodo`) junto con la ficha, en vez de arrancar cuando la
 * ficha ya terminó. Mismas cifras: el filtro de abonos es el de siempre.
 */

import { cache } from 'react'
import { getServerSupabaseClient } from '@/lib/server-session'
import { leerNombresEntidades } from '@/lib/v2/lecturas'
import { fechaMx, mxn } from '@/lib/v2/formato'
import { armarFilasCobranza, leerAbonos, leerCarteraDeNodo, montosUltimoAbono } from './leer'
import { CHIP_BANDA, NOMBRE_BANDA, textoDias, type FilaCobranza } from './semaforo'

/** `null` = el nodo no tiene renglón en `v_cartera`; `fila: undefined` = tiene renglón pero no debe. */
type CobranzaNodo = { fila: FilaCobranza | undefined } | null

/** Una promesa por nodo y por petición (`cache`): la precarga y el componente comparten la misma. */
const leerCobranzaNodo = cache(async (id: string): Promise<CobranzaNodo> => {
  const client = await getServerSupabaseClient()
  const [propia, nombres, abonos] = await Promise.all([leerCarteraDeNodo(client, id), leerNombresEntidades(client), leerAbonos(client, [id])])
  if (propia.length === 0) return null
  return { fila: armarFilasCobranza(propia, montosUltimoAbono(propia, abonos), nombres)[0] }
})

/**
 * Arranca la lectura de la franja sin esperarla. La llama la página ANTES de
 * `leerFichaNodo`, solo si la sesión es de mando (la franja no se pinta a nadie más).
 * Si la ficha termina en notFound la promesa se descarta; su error, si lo hubo, se
 * lanza cuando el componente la espera.
 */
export function precargarCobranzaNodo(id: string): void {
  leerCobranzaNodo(id).catch(() => {})
}

export async function ResumenCobranzaNodo({ id }: { id: string }) {
  const datos = await leerCobranzaNodo(id)
  if (!datos) return null
  const f = datos.fila
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
