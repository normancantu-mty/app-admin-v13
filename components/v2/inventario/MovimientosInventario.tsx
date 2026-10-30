'use client'
// Paridad v2: copia de app/dashboard/inventario/MovimientosTable.tsx (2026-10-29, ejecutor del Socio). La v1 queda intacta.
// Inventario compacto (2026-10-30, ejecutor del Socio): una sola tabla densa del sistema
// visual v2 (sin tarjetas por fila en movil), altura maxima con scroll interno, filtro por
// tipo y busqueda. Las columnas secundarias (entidad, creado por) se pliegan en pantallas
// chicas y quedan como subtitulo del producto. La regla de anulacion no cambio.

import { useMemo, useState, useTransition } from 'react'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'
import { deleteInventarioMovement } from '@/app/actions/audit'
import { isTipoMovimientoEntrada, isTipoMovimientoSalida } from '@/lib/inventario-types'
import { formatFechaHoraMX } from '@/lib/utils'
import { VENTANA_EDICION_MS } from '@/lib/constants'
import { cant, tipoMovLegible } from './formato-inv'

interface MovimientoInventario {
  id: string
  producto_nombre: string
  entidad_nombre?: string
  es_entidad_admin?: boolean
  status?: string | null
  tipo_movimiento: string
  cantidad: number
  fecha_movimiento: string
  usuario_creador?: string | null
}

function canDeleteMovement(
  movimiento: MovimientoInventario,
  sessionEmail: string | null,
  sessionRole: string | null
): boolean {
  const role = (sessionRole || '').toUpperCase()
  const isAnulado = movimiento.status === 'ANULADO'
  if (role === 'ADMIN') return !isAnulado
  if (!sessionEmail) return false
  if (movimiento.usuario_creador !== sessionEmail) return false
  if (isAnulado) return false

  const createdAt = new Date(movimiento.fecha_movimiento).getTime()
  if (!Number.isFinite(createdAt)) return false

  // Espejo exacto de `assertAnnullmentAllowed` en `app/actions/audit.ts`.
  return Date.now() - createdAt <= VENTANA_EDICION_MS
}

type Clase = 'entrada' | 'salida' | 'merma' | 'devolucion' | 'otro'

function claseDe(tipo: string): Clase {
  if (tipo === 'MERMA') return 'merma'
  if (tipo === 'DEVOLUCION_FISICA') return 'devolucion'
  if (isTipoMovimientoEntrada(tipo)) return 'entrada'
  if (isTipoMovimientoSalida(tipo)) return 'salida'
  return 'otro'
}

const CHIP: Record<Clase, string> = { entrada: 'good', salida: 'crit', merma: 'crit', devolucion: 'warn', otro: '' }
const FILTROS: [Clase | '', string][] = [
  ['', 'Todo'],
  ['entrada', 'Entradas'],
  ['salida', 'Salidas'],
  ['merma', 'Mermas']
]
const TANDA = 25

export default function MovimientosTable({
  movimientos,
  sessionEmail,
  sessionRole,
  canMutate
}: {
  movimientos: MovimientoInventario[]
  sessionEmail: string | null
  sessionRole: string | null
  canMutate: boolean
}) {
  const { refrescar } = useModalV2()
  const [isPending, startTransition] = useTransition()
  const [visibleRows, setVisibleRows] = useState(TANDA)
  const [filtro, setFiltro] = useState<Clase | ''>('')
  const [busca, setBusca] = useState('')

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return movimientos.filter(
      (m) =>
        (!filtro || claseDe(m.tipo_movimiento) === filtro) &&
        (!q ||
          m.producto_nombre.toLowerCase().includes(q) ||
          (m.entidad_nombre ?? '').toLowerCase().includes(q) ||
          (m.usuario_creador ?? '').toLowerCase().includes(q))
    )
  }, [movimientos, filtro, busca])
  const visibleMovimientos = filtrados.slice(0, visibleRows)

  const anular = (id: string) => {
    if (!window.confirm('¿Anular este movimiento? Queda en el historial como anulado.')) return
    startTransition(async () => {
      try {
        const result = await deleteInventarioMovement(id)
        if (!result.success) {
          throw new Error('No se pudo anular el movimiento.')
        }
        refrescar()
      } catch (error) {
        alert(error instanceof Error ? error.message : 'Error al anular movimiento.')
      }
    })
  }

  if (movimientos.length === 0) {
    return (
      <div className="vacio">
        <b>Sin movimientos en el rango</b>
        Cambia el rango global para ver otros días.
      </div>
    )
  }

  return (
    <div>
      <div className="inv-filtros">
        <div className="seg" role="group" aria-label="Tipo de movimiento">
          {FILTROS.map(([v, l]) => (
            <button
              key={l}
              type="button"
              className={filtro === v ? 'on' : ''}
              onClick={() => {
                setFiltro(v)
                setVisibleRows(TANDA)
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <input
          className="in inv-busca"
          type="search"
          placeholder="Buscar producto, entidad o autor"
          value={busca}
          onChange={(e) => {
            setBusca(e.target.value)
            setVisibleRows(TANDA)
          }}
          aria-label="Buscar movimiento"
        />
      </div>

      {filtrados.length === 0 ? (
        <div className="vacio">
          <b>Ningún movimiento con ese filtro</b>
        </div>
      ) : (
        <div className="inv-scroll">
          <table className="t inv-t" data-testid="inv-tabla-movimientos">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Tipo</th>
                <th className="r">Cantidad</th>
                <th className="inv-opc">Entidad</th>
                <th className="inv-opc-lg">Creado por</th>
                {canMutate && <th className="r">Anular</th>}
              </tr>
            </thead>
            <tbody>
              {visibleMovimientos.map((mov) => {
                const isAnulado = mov.status === 'ANULADO'
                const canDelete = canDeleteMovement(mov, sessionEmail, sessionRole)
                const entidad = mov.entidad_nombre || (mov.es_entidad_admin ? 'Admin' : 'Sin entidad')
                const autor = mov.usuario_creador || 'Legacy / Sistema'
                return (
                  <tr key={mov.id} className={isAnulado ? 'anulado' : undefined}>
                    <td className="inv-fecha">{formatFechaHoraMX(mov.fecha_movimiento)}</td>
                    <td>
                      {mov.producto_nombre}
                      <div className="inv-sub inv-solo-chico">
                        {entidad} · {autor}
                      </div>
                    </td>
                    <td>
                      <span className={`chip ${CHIP[claseDe(mov.tipo_movimiento)]}`} title={mov.tipo_movimiento}>
                        {tipoMovLegible(mov.tipo_movimiento)}
                      </span>
                    </td>
                    <td className="r" style={{ fontWeight: 700 }}>
                      {cant(mov.cantidad)}
                    </td>
                    <td className="inv-opc">{mov.es_entidad_admin ? <span className="chip">{entidad}</span> : entidad}</td>
                    <td className="inv-opc-lg inv-sub mono">{autor}</td>
                    {canMutate && (
                      <td className="r">
                        {canDelete ? (
                          <button type="button" disabled={isPending} onClick={() => anular(mov.id)} className="btn mini peligro">
                            Anular
                          </button>
                        ) : (
                          <span className="inv-sub">{isAnulado ? 'Anulado' : 'Bloqueado'}</span>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="inv-pie">
        <span>
          Mostrando {visibleMovimientos.length} de {filtrados.length}
          {filtrados.length !== movimientos.length ? ` (${movimientos.length} en el rango)` : ''}
        </span>
        {visibleRows < filtrados.length && (
          <button type="button" onClick={() => setVisibleRows((prev) => prev + TANDA)} className="btn mini">
            Cargar más ({Math.min(TANDA, filtrados.length - visibleRows)})
          </button>
        )}
      </div>
    </div>
  )
}
