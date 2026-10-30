'use client'

/**
 * Inventario v2 compacto — stock por producto en una tabla densa con altura
 * maxima y filtro Terminados / Insumos / Todo. Escrito el 2026-10-30 por el
 * ejecutor del Socio. Los numeros llegan calculados del servidor
 * (`InventarioVista`, contra todo el ledger); aqui solo se filtra y se pinta.
 */

import { useMemo, useState } from 'react'
import { cant } from './formato-inv'

export type FilaStock = {
  id: string
  sku: string
  nombre: string
  tipo: 'INSUMO' | 'TERMINADO'
  unidad_medida: string
  stock_actual: number
}

type Filtro = 'TERMINADO' | 'INSUMO' | ''

/** La v1 marcaba en rojo todo stock <= 10; se conserva el mismo umbral. */
const UMBRAL_BAJO = 10

export function TablaStock({ productos }: { productos: FilaStock[] }) {
  const hayTerminados = productos.some((p) => p.tipo === 'TERMINADO')
  const [filtro, setFiltro] = useState<Filtro>(hayTerminados ? 'TERMINADO' : '')
  const [busca, setBusca] = useState('')
  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase()
    return productos.filter(
      (p) => (!filtro || p.tipo === filtro) && (!q || p.nombre.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q))
    )
  }, [productos, filtro, busca])
  const cuenta = (t: Filtro) => productos.filter((p) => !t || p.tipo === t).length
  const bajos = visibles.filter((p) => p.stock_actual <= UMBRAL_BAJO).length

  return (
    <div>
      <div className="inv-filtros">
        <div className="seg" role="group" aria-label="Tipo de producto">
          {(
            [
              ['TERMINADO', 'Terminados'],
              ['INSUMO', 'Insumos'],
              ['', 'Todo']
            ] as [Filtro, string][]
          ).map(([v, l]) => (
            <button key={l} type="button" className={filtro === v ? 'on' : ''} onClick={() => setFiltro(v)}>
              {l} <span className="inv-cuenta">{cuenta(v)}</span>
            </button>
          ))}
        </div>
        <input className="in inv-busca" type="search" placeholder="Buscar producto o SKU" value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Buscar producto" />
        {bajos > 0 ? <span className="chip crit">{bajos} con {UMBRAL_BAJO} o menos</span> : null}
      </div>
      {visibles.length === 0 ? (
        <div className="vacio">
          <b>Sin productos con ese filtro</b>
        </div>
      ) : (
        <div className="inv-scroll">
          <table className="t inv-t" data-testid="inv-tabla-stock">
            <thead>
              <tr>
                <th>Producto</th>
                <th className="inv-opc">Tipo</th>
                <th className="inv-opc">Unidad</th>
                <th className="r">Stock</th>
              </tr>
            </thead>
            <tbody>
              {visibles.map((p) => (
                <tr key={p.id}>
                  <td>
                    <b>{p.nombre}</b>
                    <div className="inv-sub mono">{p.sku}</div>
                  </td>
                  <td className="inv-opc">
                    <span className={`chip ${p.tipo === 'TERMINADO' ? 'info' : ''}`}>{p.tipo === 'TERMINADO' ? 'Terminado' : 'Insumo'}</span>
                  </td>
                  <td className="inv-opc inv-sub">{p.unidad_medida}</td>
                  <td className={`r ${p.stock_actual <= UMBRAL_BAJO ? 'neg' : ''}`} style={{ fontWeight: 700 }}>
                    {cant(p.stock_actual)}
                    <span className="inv-solo-chico inv-sub"> {p.unidad_medida}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
