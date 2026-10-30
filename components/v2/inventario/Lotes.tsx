/**
 * Paginas v2 — tabla de lotes (rendimiento por lote, v_lote_rendimiento). Sacada
 * del modal `/panel/m/lotes` el 2026-10-29 por el ejecutor del Socio: la comparten
 * ese modal y la pagina `/panel/inventario`.
 *
 * Lotes v2 (2026-10-30, ejecutor del Socio): resumen compacto. Estado de cada lote
 * (en fermentacion / terminado / envasado), clic en el codigo abre su detalle
 * (`/panel/m/lote/<id>`), y el apartado completo con alta y edicion vive en
 * `/panel/lotes`. Las lecturas son de `components/v2/lotes/datos.ts`.
 * Exige mando (el RLS de `lotes` deja ver a ADMIN y SOCIO).
 */

import { RUTA_BASE } from '@/lib/v2/rutas'
import { exigirMandoV2 } from '@/lib/v2/puerta'
import { fechaParaPersona } from '@/lib/fechas'
import { AbrirModal } from '@/components/v2/modal/AbrirModal'
import { VerTodo } from '@/components/v2/pagina/Encabezado'
import { leerLotes } from '@/components/v2/lotes/datos'
import { CHIP_ESTADO, ESTADOS_LOTE, ETIQUETA_ESTADO } from '@/components/v2/lotes/estado'
import { cant2 } from './formato-inv'

export async function LotesVista({ limite }: { limite?: number } = {}) {
  await exigirMandoV2()
  const { lotes, error } = await leerLotes()
  const visibles = limite ? lotes.slice(0, limite) : lotes
  return (
    <>
      {error ? (
        <div className="msg mal">No se pudieron leer los lotes: {error}</div>
      ) : lotes.length === 0 ? (
        <div className="vacio" data-testid="lotes-vacio">
          <b>Aún no hay lotes registrados</b>
          Se registran por el bot o con «Nuevo lote» en el apartado de lotes; aquí aparecen con su estado, rendimiento y costo.
        </div>
      ) : (
        <>
          <div className="inv-filtros">
            {ESTADOS_LOTE.map((e) => (
              <span key={e} className={`chip ${CHIP_ESTADO[e]}`}>
                {lotes.filter((l) => l.estado === e).length} {ETIQUETA_ESTADO[e].toLowerCase()}
              </span>
            ))}
          </div>
          <div className="inv-scroll">
            <table className="t inv-t" data-testid="tabla-lotes">
              <thead>
                <tr>
                  <th>Lote</th>
                  <th>Estado</th>
                  <th className="r">Días</th>
                  <th className="r">Litros</th>
                  <th className="r inv-opc">Grado</th>
                  <th className="r inv-opc">Botellas</th>
                  <th className="r inv-opc-lg">$/ml</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((l) => (
                  <tr key={l.id}>
                    <td>
                      <AbrirModal href={`${RUTA_BASE}/m/lote/${l.id}`} titulo={`Lote ${l.codigo_lote}`} className="enlace-pg">
                        <b>{l.codigo_lote}</b>
                      </AbrirModal>
                      <div className="inv-sub">Inicio {fechaParaPersona(l.fecha_inicio)}</div>
                    </td>
                    <td>
                      <span className={`chip ${CHIP_ESTADO[l.estado]}`}>{ETIQUETA_ESTADO[l.estado]}</span>
                    </td>
                    <td className="r">
                      {l.dias}
                      {l.diasEnCurso ? <span className="inv-sub"> en curso</span> : null}
                    </td>
                    <td className="r">{cant2(l.litros_producidos)}</td>
                    <td className="r inv-opc">{l.grado_ponderado === null ? '—' : `${Number(l.grado_ponderado).toFixed(1)}°`}</td>
                    <td className="r inv-opc">{cant2(l.botellas)}</td>
                    <td className="r inv-opc-lg">{l.costo_por_ml === null ? '—' : `$${Number(l.costo_por_ml).toFixed(4)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="inv-pie">
        <span>
          {limite && lotes.length > visibles.length ? `Mostrando ${visibles.length} de ${lotes.length} · ` : ''}v_lote_rendimiento
        </span>
        <VerTodo href={`${RUTA_BASE}/lotes`} className="btn mini">
          Apartado de lotes →
        </VerTodo>
      </div>
    </>
  )
}
