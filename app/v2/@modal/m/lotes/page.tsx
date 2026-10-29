/** Paridad v2 — modal «Lotes» (pedido de Norman, T72 L265: «un botón en Abrir que haga referencia a los lotes»). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { exigirMandoV2 } from '@/lib/v2/puerta'
import { getServerSupabaseClient } from '@/lib/server-session'
import { Modal } from '@/components/v2/modal/Modal'
import { fechaMx, mxn, num } from '@/lib/v2/formato'

export const dynamic = 'force-dynamic'

type FilaLote = {
  id: string
  codigo_lote: string
  fecha_inicio: string
  fecha_fin_fermentacion: string | null
  kg_chile: number | null
  litros_producidos: number | null
  tandas: number | null
  grado_ponderado: number | null
  botellas: number | null
  litros_por_kg_chile: number | null
  costo_insumos_conocido: number | null
  costo_por_ml: number | null
  faltan_costo: string | null
}

const n = (v: number | null) => (v === null || v === undefined ? '—' : num(Number(v)))

export default async function ModalLotes() {
  await exigirMandoV2()
  const supabase = await getServerSupabaseClient()
  // Solo lectura de la vista que ya usa el bot (/api/bot/consulta). El RLS de `lotes` deja ver a ADMIN y SOCIO.
  const { data, error } = await supabase
    .from('v_lote_rendimiento')
    .select('id, codigo_lote, fecha_inicio, fecha_fin_fermentacion, kg_chile, litros_producidos, tandas, grado_ponderado, botellas, litros_por_kg_chile, costo_insumos_conocido, costo_por_ml, faltan_costo')
    .order('fecha_inicio', { ascending: false })
  const lotes = (data ?? []) as FilaLote[]
  return (
    <Modal titulo="Lotes" sub="Rendimiento por lote · v_lote_rendimiento (los registra el bot)" tam="xl">
      {error ? (
        <div className="msg mal">No se pudieron leer los lotes: {error.message}</div>
      ) : lotes.length === 0 ? (
        <div className="vacio" data-testid="lotes-vacio">
          <b>Aún no hay lotes registrados</b>
          Cuando el bot registre el primer lote (entradas, tandas y envasado), aparece aquí con su rendimiento y su costo.
        </div>
      ) : (
        <div className="tabla-w">
          <table className="t" data-testid="tabla-lotes">
            <thead>
              <tr>
                <th>Lote</th>
                <th>Inicio</th>
                <th>Fin fermentación</th>
                <th className="r">Kg chile</th>
                <th className="r">Litros</th>
                <th className="r">Tandas</th>
                <th className="r">Grado</th>
                <th className="r">Botellas</th>
                <th className="r">L/kg</th>
                <th className="r">Costo insumos</th>
                <th className="r">$/ml</th>
              </tr>
            </thead>
            <tbody>
              {lotes.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.codigo_lote}</b>
                    {l.faltan_costo ? <div className="muted" style={{ fontSize: 11 }}>Sin costo: {l.faltan_costo}</div> : null}
                  </td>
                  <td>{fechaMx(l.fecha_inicio)}</td>
                  <td>{fechaMx(l.fecha_fin_fermentacion)}</td>
                  <td className="r">{n(l.kg_chile)}</td>
                  <td className="r">{n(l.litros_producidos)}</td>
                  <td className="r">{n(l.tandas)}</td>
                  <td className="r">{l.grado_ponderado === null ? '—' : `${Number(l.grado_ponderado).toFixed(1)}°`}</td>
                  <td className="r">{n(l.botellas)}</td>
                  <td className="r">{l.litros_por_kg_chile === null ? '—' : Number(l.litros_por_kg_chile).toFixed(3)}</td>
                  <td className="r">{l.costo_insumos_conocido === null ? '—' : mxn(Number(l.costo_insumos_conocido))}</td>
                  <td className="r">{l.costo_por_ml === null ? '—' : `$${Number(l.costo_por_ml).toFixed(4)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
