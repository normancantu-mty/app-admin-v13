'use client'

/**
 * Paridad v2 — «Anular» en las tablas de movimientos (fila por fila y en bloque).
 * Escrito el 2026-10-29 por el ejecutor del Socio.
 *
 * Usa las MISMAS acciones de servidor que la v1 (`app/actions/audit.ts`): no
 * borra, marca ANULADO (regla 3). Los permisos (ADMIN todo; DST su red dentro de
 * la ventana de 12 h; SOCIO nada) los decide el servidor; aqui solo se ofrece el
 * boton a quien la pantalla ya sabe que puede.
 */

import { createContext, useContext, useState, useTransition, type ReactNode } from 'react'
import { anularMovimientoFinanzas, anularMovimientoInventario, bulkDeleteMovements } from '@/app/actions/audit'
import { annularTicketHistorialDistribuidorAction } from '@/app/actions/distribuidores'
import { useModalV2 } from '@/components/v2/modal/ProveedorModal'

export type TipoAnulable = 'finanzas' | 'inventario' | 'ticket'

type Sel = { ids: Set<string>; alternar: (id: string) => void; limpiar: () => void }
const CtxSel = createContext<Sel | null>(null)

export function ProveedorSeleccion({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<Set<string>>(new Set())
  const alternar = (id: string) =>
    setIds((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return <CtxSel.Provider value={{ ids, alternar, limpiar: () => setIds(new Set()) }}>{children}</CtxSel.Provider>
}

export function CasillaAnular({ id }: { id: string }) {
  const sel = useContext(CtxSel)
  if (!sel) return null
  return (
    <input
      type="checkbox"
      aria-label="Seleccionar para anular"
      checked={sel.ids.has(id)}
      onChange={() => sel.alternar(id)}
      data-testid={`sel-${id}`}
    />
  )
}

async function anularUno(tipo: TipoAnulable, id: string, perfilEntidadId?: string, idEntidad?: string) {
  if (tipo === 'finanzas') return anularMovimientoFinanzas(id, perfilEntidadId ? { perfilEntidadId } : undefined)
  if (tipo === 'inventario') return anularMovimientoInventario(id)
  return annularTicketHistorialDistribuidorAction(id, idEntidad ?? perfilEntidadId ?? '')
}

export function BarraAnular({ tipo }: { tipo: Exclude<TipoAnulable, 'ticket'> }) {
  const sel = useContext(CtxSel)
  const { refrescar } = useModalV2()
  const [pend, iniciar] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  if (!sel) return null
  const n = sel.ids.size
  return (
    <div className="fila-acc" style={{ margin: '6px 0 10px' }}>
      <button
        type="button"
        className="btn mini peligro"
        disabled={n === 0 || pend}
        data-testid="anular-seleccionados"
        onClick={() => {
          if (!window.confirm(`¿Anular ${n} movimiento(s)? Se marcan ANULADO; no se borran.`)) return
          iniciar(async () => {
            setMsg(null)
            try {
              const ids = [...sel.ids]
              if (tipo === 'finanzas') await bulkDeleteMovements(ids)
              else for (const id of ids) await anularMovimientoInventario(id)
              sel.limpiar()
              refrescar()
            } catch (e) {
              setMsg(e instanceof Error ? e.message : 'No se pudo anular.')
            }
          })
        }}
      >
        {pend ? <i className="giro" /> : null} Anular seleccionados ({n})
      </button>
      {msg ? <span className="neg" style={{ fontSize: 12.5 }}>{msg}</span> : null}
    </div>
  )
}

export function BotonAnular({
  id,
  tipo,
  perfilEntidadId,
  idEntidad,
  etiqueta = 'Anular'
}: {
  id: string
  tipo: TipoAnulable
  perfilEntidadId?: string
  idEntidad?: string
  etiqueta?: string
}) {
  const { refrescar } = useModalV2()
  const [pend, iniciar] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        type="button"
        className="btn mini peligro"
        disabled={pend}
        data-testid={`anular-${id}`}
        onClick={() => {
          if (!window.confirm('¿Anular este movimiento? Se marca ANULADO; no se borra.')) return
          iniciar(async () => {
            setMsg(null)
            try {
              const r = (await anularUno(tipo, id, perfilEntidadId, idEntidad)) as { success?: boolean; error?: string } | undefined
              if (r && r.success === false) throw new Error(r.error ?? 'No se pudo anular.')
              refrescar()
            } catch (e) {
              setMsg(e instanceof Error ? e.message : 'No se pudo anular.')
            }
          })
        }}
      >
        {pend ? <i className="giro" /> : null} {etiqueta}
      </button>
      {msg ? <span className="neg" style={{ fontSize: 12 }}>{msg}</span> : null}
    </span>
  )
}
