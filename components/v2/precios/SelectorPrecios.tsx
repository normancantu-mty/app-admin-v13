'use client'

/** Paridad v2 — selector del catálogo: cobro simulado y, para la matriz, Distribuidor/Local (Q7). Escrito el 2026-10-29 por el ejecutor del Socio. */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

type Opcion = { id: string; nombre: string; rol: string }

export function SelectorPrecios({
  fiscalidad,
  tipo,
  entidadId,
  opciones,
  conTipo
}: {
  fiscalidad: string
  tipo: 'DST' | 'LOC'
  entidadId: string
  opciones: Opcion[]
  /** La matriz elige Distribuidor o Local; el DST solo ve sus locales. */
  conTipo: boolean
}) {
  const router = useRouter()
  const [pend, iniciar] = useTransition()
  const [fis, setFis] = useState(fiscalidad)
  const [t, setT] = useState<'DST' | 'LOC'>(tipo)
  const [ent, setEnt] = useState(entidadId)
  const visibles = conTipo ? opciones.filter((o) => o.rol === t) : opciones

  function aplicar(nf = fis, nt = t, ne = ent) {
    const q = new URLSearchParams()
    if (nf !== 'LIBRE') q.set('fiscalidad', nf)
    if (conTipo) q.set('tipo', nt)
    if (ne) q.set('localId', ne)
    const s = q.toString()
    iniciar(() => router.replace(`/v2/m/precios${s ? `?${s}` : ''}`, { scroll: false }))
  }

  return (
    <div className="fila-acc" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12, marginBottom: 16 }} data-testid="selector-precios">
      <label className="campo" style={{ minWidth: 220 }}>
        <span className="lbl">Simular cobro en</span>
        <select value={fis} onChange={(e) => setFis(e.target.value)} data-testid="precios-fiscalidad">
          <option value="LIBRE">Efectivo (sin impuestos)</option>
          <option value="FULL_TAX">Cuenta Fresnillo (IVA + IEPS)</option>
          <option value="IVA_ONLY">Solo IVA</option>
        </select>
      </label>
      {conTipo && (
        <div className="campo">
          <span className="lbl">Vender a</span>
          <div className="seg" role="group" aria-label="Distribuidor o local">
            {(['DST', 'LOC'] as const).map((r) => (
              <button
                key={r}
                type="button"
                className={t === r ? 'on' : ''}
                aria-pressed={t === r}
                data-testid={`precios-tipo-${r}`}
                onClick={() => {
                  setT(r)
                  setEnt('')
                }}
              >
                {r === 'DST' ? 'Distribuidor' : 'Local'}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="campo" style={{ minWidth: 240 }}>
        <span className="lbl">{conTipo ? (t === 'DST' ? 'Distribuidor' : 'Local') : 'Tu local'}</span>
        <select value={ent} onChange={(e) => setEnt(e.target.value)} data-testid="precios-entidad">
          <option value="">Sin entidad seleccionada</option>
          {visibles.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nombre}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="btn p" disabled={pend} onClick={() => aplicar()} data-testid="precios-aplicar">
        {pend ? <i className="giro" /> : null} Aplicar
      </button>
    </div>
  )
}
